import { describe, it, expect } from 'vitest';
import { solvePostflop, type PostflopInput } from './postflopModel';
import { parseCard } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import { BB_DEFEND_RANGE } from '../ai/preflop';

const cards = (s: string) => s.split(' ').map(parseCard);
const range = rangeFromSet(BB_DEFEND_RANGE);
const sumFreq = (r: ReturnType<typeof solvePostflop>) => r.options.reduce((a, o) => a + o.freq, 0);

// A hero-first (checked-to) node on a dry ace-high flop with top set.
const base: PostflopInput = {
  hero: cards('As Ad'),
  board: cards('Ah 7c 2d'),
  oppRange: range,
  pot: 12,
  toCall: 0,
  heroCommitted: 0,
  currentBet: 0,
  minRaiseTo: 2,
  maxRaiseTo: 200,
  canCheck: true,
  canRaise: true,
  bigBlind: 2,
  iterations: 1500,
};

describe('solvePostflop — structural invariants', () => {
  it('returns a normalised mixed strategy (freqs in [0,1], sum ≈ 1)', () => {
    const s = solvePostflop(base);
    expect(sumFreq(s)).toBeCloseTo(1, 5);
    for (const o of s.options) {
      expect(o.freq).toBeGreaterThanOrEqual(0);
      expect(o.freq).toBeLessThanOrEqual(1);
    }
  });

  it('reports equity in the unit interval', () => {
    const s = solvePostflop(base);
    expect(s.equity).toBeGreaterThan(0);
    expect(s.equity).toBeLessThanOrEqual(1);
  });

  it('offers a value bet with a strong made hand', () => {
    const s = solvePostflop(base);
    const bets = s.options.filter((o) => o.id.startsWith('bet') || o.id === 'betpot');
    expect(bets.length).toBeGreaterThan(0);
    expect(bets.some((o) => o.kind === 'value')).toBe(true);
  });

  it('surfaces fold and call when facing a bet', () => {
    const s = solvePostflop({ ...base, pot: 24, toCall: 12, currentBet: 12, canCheck: false });
    expect(s.options.some((o) => o.id === 'fold')).toBe(true);
    expect(s.options.some((o) => o.id === 'call')).toBe(true);
    expect(sumFreq(s)).toBeCloseTo(1, 5);
  });
});

describe('solvePostflop — equity ordering (MC-noise-safe gaps)', () => {
  it('rates a strong hand well above a weak one on the same board', () => {
    const strong = solvePostflop(base).equity!;
    const weak = solvePostflop({ ...base, hero: cards('9h 8s'), iterations: 1500 }).equity!;
    expect(strong).toBeGreaterThan(weak + 0.2);
  });
});

describe('solvePostflop — multiway', () => {
  it('flags a multiway pot in the note and stays normalised', () => {
    const mw = solvePostflop({ ...base, oppRanges: [range, range] });
    expect(mw.note.toLowerCase()).toContain('way');
    expect(sumFreq(mw)).toBeCloseTo(1, 5);
  });

  it('lowers equity vs a field compared to heads-up (must beat everyone)', () => {
    // Top pair, top kicker — a made hand whose equity clearly drops multiway.
    const tp = { ...base, hero: cards('As Ks'), board: cards('Ac 7d 2h'), iterations: 3000 };
    const hu = solvePostflop(tp).equity!;
    const field = solvePostflop({ ...tp, oppRanges: [range, range, range] }).equity!;
    expect(field).toBeLessThan(hu);
  });
});
