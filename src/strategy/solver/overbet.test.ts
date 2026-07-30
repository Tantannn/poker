import { describe, it, expect } from 'vitest';
import { betSizeGrid, OVERBET_FRAC } from './betSizeGrid';
import { solveRiver, type Combo } from './riverSolver';
import { solveRiverNode } from './riverAdapter';
import { getNodeStrategy } from '../index';
import { rangeFromSet } from '../../engine/range';
import { RFI_RANGES } from '../../ai/preflop';
import { parseCard, type Card } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);

describe('betSizeGrid', () => {
  it('offers the polar overbet only when asked, and only in the turn/river grid', () => {
    const base = betSizeGrid(30, 300);
    const polar = betSizeGrid(30, 300, true);
    expect(base.ids).toEqual(['bet33', 'bet50', 'bet75', 'betpot']);
    expect(polar.ids).toEqual(['bet33', 'bet50', 'bet75', 'betpot', 'bet150']);
    expect(polar.fracs[4]).toBe(OVERBET_FRAC);
  });

  it('collapses every size at or past the stack into ONE all-in slot', () => {
    // pot 30, only 20 behind: ¾ pot (23) and up are all jams. Two sizes rounding to the
    // same chips would split one decision across identical actions and halve its freq.
    const g = betSizeGrid(30, 20);
    expect(g.ids).toEqual(['bet33', 'bet50', 'allin']);
    const chips = g.fracs.map((f) => Math.round(f * 30));
    expect(chips).toEqual([10, 15, 20]);
    expect(new Set(chips).size).toBe(chips.length);
  });

  it('never offers a size bigger than the stack, overbet included', () => {
    const g = betSizeGrid(100, 120, true);
    for (const f of g.fracs) expect(Math.round(f * 100)).toBeLessThanOrEqual(120);
    expect(g.ids).not.toContain('bet150'); // 150 > 120 → the jam is the polar size here
    expect(g.ids.filter((i) => i === 'allin')).toHaveLength(1);
  });

  it('all four parallel arrays stay the same length', () => {
    for (const g of [betSizeGrid(30, 300, true), betSizeGrid(30, 20), betSizeGrid(0, 300)]) {
      expect(g.ids).toHaveLength(g.fracs.length);
      expect(g.labels).toHaveLength(g.fracs.length);
      expect(g.fracLabels).toHaveLength(g.fracs.length);
    }
  });
});

describe('the overbet slot changes the solved line', () => {
  // Polar toy: hero has the nuts (trip aces) or air; villain holds a pure bluff-catcher.
  // A polar range beats a bluff-catcher harder the bigger the size, so the nuts must take
  // the overbet — the line the pot-capped grid could never recommend.
  const heroRange: Combo[] = [
    { cards: C('As Ac'), w: 1 },
    { cards: C('3c 4d'), w: 1 },
  ];
  const villainRange: Combo[] = [{ cards: C('Jd Jh'), w: 1 }];
  const b = board('Ah Kd Qc 7s 2h');

  it('the nuts move frequency off pot and onto the overbet', () => {
    const grid = betSizeGrid(30, 300, true);
    const r = solveRiver({ heroRange, villainRange, board: b, pot: 30, effStack: 300, betSizes: grid.fracs, iterations: 4000 });
    const nuts = r.heroStrategy[0];
    const freqOf = (id: string) => nuts.find((a) => a.action === id)!.freq;
    const over = freqOf(`bet:${grid.ids.indexOf('bet150')}`);
    const pot = freqOf(`bet:${grid.ids.indexOf('betpot')}`);
    console.log(`nuts: pot=${(pot * 100).toFixed(0)}%  overbet=${(over * 100).toFixed(0)}%`);
    expect(over).toBeGreaterThan(0.2);
  });

  it('villain folds MORE to the overbet than to pot (MDF falls as size grows)', () => {
    const grid = betSizeGrid(30, 300, true);
    const r = solveRiver({ heroRange, villainRange, board: b, pot: 30, effStack: 300, betSizes: grid.fracs, iterations: 4000 });
    const callVsPot = r.villainCallFreq[grid.ids.indexOf('betpot')];
    const callVsOver = r.villainCallFreq[grid.ids.indexOf('bet150')];
    expect(callVsOver).toBeLessThan(callVsPot + 0.02);
  });
});

describe('adapter + live wiring expose the overbet as a real option', () => {
  it('solveRiverNode returns a bet150 option with an executable amount', () => {
    const strat = solveRiverNode({
      heroCards: [...C('As Ac')],
      board: board('Ah 7d 2c 9h Jd'),
      pot: 30,
      effStack: 300,
      heroRange: rangeFromSet(RFI_RANGES.BTN),
      villainRange: rangeFromSet(RFI_RANGES.BTN),
      bigBlind: 2,
    })!;
    expect(strat).not.toBeNull();
    const over = strat.options.find((o) => o.id === 'bet150')!;
    expect(over).toBeDefined();
    expect(over.amount).toBe(45); // 1.5 × pot 30
    expect(over.sizePct).toBe(150);
    expect(Number.isFinite(over.ev)).toBe(true);
    // the mix is still a probability distribution over the wider grid
    const total = strat.options.reduce((a, o) => a + o.freq, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });

  it('a live hero-first river node offers the overbet, and the nuts prefer a big size', () => {
    const st = {
      handNumber: 1,
      buttonIndex: 0,
      board: board('Ah 7d 2c 9h Jd'),
      street: 'river',
      currentBet: 0,
      toAct: 0,
      lastAggressor: -1,
      bigBlind: 2,
      log: [],
      players: [
        { id: 0, name: 'You', isHero: true, holeCards: [...C('As Ac')], stack: 300, committed: 0, totalCommitted: 15, folded: false },
        { id: 1, name: 'V', isHero: false, holeCards: [], stack: 300, committed: 0, totalCommitted: 15, folded: false },
      ],
    } as unknown as GameState;
    const strat = getNodeStrategy(st, 0);
    expect(strat.note).toContain('River solver');
    expect(strat.options.map((o) => o.id)).toContain('bet150');
    const check = strat.options.find((o) => o.id === 'check')!;
    const best = strat.options.find((o) => o.id === strat.bestId)!;
    expect(best.ev).toBeGreaterThan(check.ev); // trip aces value-bet, they don't check
    console.log(`live river AA: best=${strat.bestId} | ${strat.options.filter((o) => o.freq > 0.01).map((o) => `${o.id}:${(o.freq * 100).toFixed(0)}%`).join(' ')}`);
  });
});
