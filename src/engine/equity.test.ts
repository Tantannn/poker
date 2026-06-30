import { describe, it, expect } from 'vitest';
import { ruleOf2and4, exactOutsEquity, countOuts } from './equity';
import { parseCard } from './cards';

const cards = (s: string) => s.split(' ').map(parseCard);

describe('ruleOf2and4', () => {
  it('doubles outs with one card to come', () => {
    expect(ruleOf2and4(9, 1)).toBe(18);
    expect(ruleOf2and4(4, 1)).toBe(8);
  });

  it('quadruples (with the big-draw correction) with two cards to come', () => {
    expect(ruleOf2and4(8, 2)).toBe(32);
    expect(ruleOf2and4(9, 2)).toBe(35); // 36 − (9−8) correction
  });

  it('applies the big-draw correction and clamps to 0..100', () => {
    expect(ruleOf2and4(30, 2)).toBe(98); // 120 − (30−8) correction
    expect(ruleOf2and4(31, 2)).toBe(100); // correction still over 100 → clamped
    expect(ruleOf2and4(0, 2)).toBe(0);
  });
});

describe('exactOutsEquity', () => {
  it('matches the hypergeometric truth for a 9-out flush draw', () => {
    expect(exactOutsEquity(9, 2)).toBeCloseTo(34.97, 1); // flop, two to come
    expect(exactOutsEquity(9, 1)).toBeCloseTo(19.57, 1); // turn, river only (÷46)
  });

  it('is zero with no cards to come', () => {
    expect(exactOutsEquity(9, 0)).toBe(0);
  });
});

describe('countOuts', () => {
  it('finds the 9 flush outs of a nut flush draw', () => {
    const out = countOuts(cards('Ah Kh'), cards('Qh 7h 2c'));
    const flush = out.byCategory.find((g) => g.category === 'Flush');
    expect(flush?.cards).toHaveLength(9);
  });

  it('returns no outs once the board is complete (river)', () => {
    const out = countOuts(cards('Ah Kh'), cards('Qh 7h 2c 3d 4s'));
    expect(out.outs).toBe(0);
  });
});
