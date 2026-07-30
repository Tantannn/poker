import { describe, it, expect } from 'vitest';
import { depthValueMult, depthNote, shadeForDepth, CHART_DEPTH_BB, SHORT_FLOOR_BB } from './depth';
import { getNodeStrategy } from './index';
import { parseCard } from '../engine/cards';
import type { GameState } from '../engine/table';

const SPECULATIVE = ['22', '54s', '76s', 'A5s', '33'];
const HIGH_CARD = ['AKo', 'AQo', 'KQo', 'AJo', 'QJo'];

describe('depthValueMult', () => {
  it('leaves the ~100bb charts alone — they are authored at that depth', () => {
    for (const code of [...SPECULATIVE, ...HIGH_CARD]) {
      expect(depthValueMult(code, CHART_DEPTH_BB)).toBe(1);
      expect(depthValueMult(code, 60)).toBe(1);
    }
  });

  it('stays out of push/fold territory, which pushFold.ts owns', () => {
    for (const code of [...SPECULATIVE, ...HIGH_CARD]) {
      expect(depthValueMult(code, SHORT_FLOOR_BB)).toBe(1);
      expect(depthValueMult(code, 10)).toBe(1);
    }
  });

  it('SHORT: speculative hands lose value, high-card hands gain', () => {
    for (const code of SPECULATIVE) expect(depthValueMult(code, 22)).toBeLessThan(1);
    for (const code of HIGH_CARD) expect(depthValueMult(code, 22)).toBeGreaterThan(1);
  });

  it('DEEP: the same axis flips — implied odds gain, offsuit broadways get taxed', () => {
    for (const code of SPECULATIVE) expect(depthValueMult(code, 250)).toBeGreaterThan(1);
    for (const code of HIGH_CARD) expect(depthValueMult(code, 250)).toBeLessThan(1);
  });

  it('the shift is monotone in depth on each side of the anchor', () => {
    const at = (bb: number) => depthValueMult('54s', bb);
    expect(at(20)).toBeLessThan(at(30));
    expect(at(30)).toBeLessThan(at(40));
    expect(at(40)).toBeLessThanOrEqual(at(CHART_DEPTH_BB));
    expect(depthValueMult('54s', 300)).toBeGreaterThan(depthValueMult('54s', 180));
  });

  it('a premium tilts like a high-card hand, but shading cannot move a 100% chart cell', () => {
    expect(depthValueMult('AA', 20)).toBeGreaterThan(1); // aces are the best short-stack hand
    const always = [{ id: 'open', freq: 1 }, { id: 'fold', freq: 0 }];
    expect(shadeForDepth(always, depthValueMult('AA', 20))).toEqual(always);
  });

  it('never swings a hand more than the disclosed band', () => {
    for (const bb of [16, 20, 25, 40, 100, 200, 400]) {
      for (const code of [...SPECULATIVE, ...HIGH_CARD, 'AA', 'T9s', 'K9o', '72o']) {
        const m = depthValueMult(code, bb);
        expect(m).toBeGreaterThanOrEqual(0.6);
        expect(m).toBeLessThanOrEqual(1.4);
      }
    }
  });

  it('shrugs off a malformed code instead of throwing', () => {
    expect(depthValueMult('', 25)).toBe(1);
    expect(depthValueMult('?', 25)).toBe(1);
  });
});

describe('shadeForDepth', () => {
  const mix = () => [
    { id: 'open', freq: 0.4 },
    { id: 'call', freq: 0.2 },
    { id: 'fold', freq: 0.4 },
  ];

  it('keeps the mix a probability distribution', () => {
    for (const mult of [0.6, 0.8, 1.2, 1.4]) {
      const total = shadeForDepth(mix(), mult).reduce((a, o) => a + o.freq, 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });

  it('fold absorbs the change — playing less means folding more', () => {
    const tighter = shadeForDepth(mix(), 0.7);
    expect(tighter.find((o) => o.id === 'open')!.freq).toBeCloseTo(0.28, 9);
    expect(tighter.find((o) => o.id === 'fold')!.freq).toBeCloseTo(1 - 0.28 - 0.14, 9);
  });

  it('cannot push a hand past always playing', () => {
    const nearlyAlways = [
      { id: 'open', freq: 0.9 },
      { id: 'fold', freq: 0.1 },
    ];
    const wider = shadeForDepth(nearlyAlways, 1.4);
    expect(wider.find((o) => o.id === 'open')!.freq).toBeLessThanOrEqual(1);
    expect(wider.find((o) => o.id === 'fold')!.freq).toBeGreaterThanOrEqual(0);
    expect(wider.reduce((a, o) => a + o.freq, 0)).toBeCloseTo(1, 9);
  });

  it('leaves a mix with no fold option untouched (a free check)', () => {
    const free = [{ id: 'check', freq: 0.7 }, { id: 'open', freq: 0.3 }];
    expect(shadeForDepth(free, 0.7)).toEqual(free);
  });

  it('is identity at mult 1', () => {
    const m = mix();
    expect(shadeForDepth(m, 1)).toBe(m);
  });
});

describe('depthNote', () => {
  it('says nothing at chart depth and explains itself away from it', () => {
    expect(depthNote('54s', CHART_DEPTH_BB)).toBeUndefined();
    expect(depthNote('54s', 22)).toMatch(/set-min|WORSE/i);
    expect(depthNote('AJo', 22)).toMatch(/BETTER|showdown/i);
    expect(depthNote('AJo', 250)).toMatch(/reverse implied/i);
  });
});

describe('live wiring: the trainer shades its preflop answer by depth', () => {
  function preflopState(heroCards: string, stackBB: number): GameState {
    const bb = 2;
    const stack = stackBB * bb;
    return {
      handNumber: 1,
      buttonIndex: 2, // hero (seat 0) is 3 seats from the button on a 6-max table
      board: [],
      street: 'preflop',
      currentBet: bb,
      lastRaiseSize: bb,
      toAct: 0,
      lastAggressor: -1,
      bigBlind: bb,
      smallBlind: bb / 2,
      seed: 3,
      log: [],
      players: Array.from({ length: 6 }, (_, i) => ({
        id: i,
        name: i === 0 ? 'You' : `V${i}`,
        isHero: i === 0,
        profileId: 'gto',
        holeCards: i === 0 ? heroCards.split(' ').map(parseCard) : [],
        stack,
        committed: i === 4 ? bb / 2 : i === 5 ? bb : 0,
        totalCommitted: i === 4 ? bb / 2 : i === 5 ? bb : 0,
        folded: false,
        allIn: false,
      })),
    } as unknown as GameState;
  }

  const playFreq = (s: ReturnType<typeof getNodeStrategy>) =>
    s.options.filter((o) => o.id !== 'fold').reduce((a, o) => a + o.freq, 0);

  it('opens a suited connector less at 25bb than at 100bb', () => {
    const short = getNodeStrategy(preflopState('7h 6h', 25), 0);
    const normal = getNodeStrategy(preflopState('7h 6h', 100), 0);
    console.log(`76s play freq: 25bb=${(playFreq(short) * 100).toFixed(0)}%  100bb=${(playFreq(normal) * 100).toFixed(0)}%`);
    expect(playFreq(short)).toBeLessThan(playFreq(normal));
    expect(short.note).toContain('Depth');
  });

  it('does not touch the 100bb answer', () => {
    const s = getNodeStrategy(preflopState('7h 6h', 100), 0);
    expect(s.note).not.toContain('Depth');
  });

  it('every shaded mix is still a valid distribution', () => {
    for (const bb of [20, 25, 40, 100, 200, 300]) {
      for (const hand of ['7h 6h', 'Ah Jd', '2c 2d', 'As Ac']) {
        const s = getNodeStrategy(preflopState(hand, bb), 0);
        const total = s.options.reduce((a, o) => a + o.freq, 0);
        expect(total).toBeGreaterThan(0.95);
        expect(total).toBeLessThan(1.05);
      }
    }
  });
});
