import { describe, it, expect } from 'vitest';
import { makeRng, parseCard } from '../engine/cards';
import {
  makeScenario,
  gridCode,
  targetKeep,
  scoreRead,
  rangeMakeup,
  classifyCombo,
  codeConsistency,
} from './handReading';

describe('handReading — grid codes', () => {
  it('maps cells to canonical 169-codes', () => {
    expect(gridCode(0, 0)).toBe('AA');
    expect(gridCode(0, 1)).toBe('AKs'); // upper-right = suited
    expect(gridCode(1, 0)).toBe('AKo'); // lower-left = offsuit
    expect(gridCode(12, 12)).toBe('22');
    expect(gridCode(2, 5)).toBe('Q9s');
  });
});

describe('handReading — scenario + scoring', () => {
  it('is deterministic under a seeded rng and builds a real barrel line', () => {
    const a = makeScenario(makeRng(42));
    const b = makeScenario(makeRng(42));
    expect(a.villainHand).toEqual(b.villainHand);
    expect(a.board.map((c) => c.rank)).toEqual(b.board.map((c) => c.rank));
    // biased toward ≥2 bets so there is a range to narrow
    expect(a.streets.filter((s) => s.action.kind === 'bet').length).toBeGreaterThanOrEqual(2);
  });

  it("the villain's actual hand always survives its own betting line", () => {
    for (const seed of [1, 7, 13, 99, 256]) {
      const sc = makeScenario(makeRng(seed));
      const { surviving } = codeConsistency(handCodeOf(sc.villainHand), sc, 3, sc.profile.bluffMult);
      expect(surviving).toBeGreaterThanOrEqual(1);
    }
  });

  it('a perfect prune scores 100%', () => {
    const sc = makeScenario(makeRng(2024));
    for (const revealed of [1, 2, 3]) {
      const target = targetKeep(sc, revealed);
      const r = scoreRead(sc, revealed, target);
      expect(r.accuracy).toBe(1);
      expect(r.keptWrong).toHaveLength(0);
      expect(r.cutWrong).toHaveLength(0);
    }
  });

  it('keeping the entire range (no prune) leaves value hands wrongly-cut empty but flags loose keeps', () => {
    const sc = makeScenario(makeRng(555));
    const full = new Set(sc.profile.codes);
    const r = scoreRead(sc, 3, full);
    // never removed anything, so cutWrong must be empty; keptWrong = the folds you failed to cut
    expect(r.cutWrong).toHaveLength(0);
    expect(r.keptWrong.length).toBeGreaterThan(0);
  });

  it('rangeMakeup partitions every combo into value/draw/air', () => {
    const sc = makeScenario(makeRng(31));
    const m = rangeMakeup(targetKeep(sc, 3), sc, 3);
    expect(m.value + m.draw + m.air).toBe(m.combos);
    expect(m.combos).toBeGreaterThan(0);
  });

  it('classifyCombo calls a made pair value and unrelated high cards air', () => {
    const board = [parseCard('Qs'), parseCard('7d'), parseCard('2c')];
    expect(classifyCombo([parseCard('Qh'), parseCard('Jh')], board)).toBe('value'); // pair of queens
    expect(classifyCombo([parseCard('9s'), parseCard('4d')], board)).toBe('air');
  });
});

// local helper mirroring ai/preflop.handCode without importing UI — keeps the test
// focused on handReading. Ranks A..2 as chars, suited/offsuit tag.
function handCodeOf(cards: [import('../engine/cards').Card, import('../engine/cards').Card]): string {
  const R = (n: number) => '23456789TJQKA'[n - 2];
  const [a, b] = [...cards].sort((x, y) => y.rank - x.rank);
  if (a.rank === b.rank) return `${R(a.rank)}${R(a.rank)}`;
  return `${R(a.rank)}${R(b.rank)}${a.suit === b.suit ? 's' : 'o'}`;
}
