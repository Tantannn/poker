import { describe, it, expect } from 'vitest';
import { potOdds, mdf, requiredEquityForBet } from './potOdds';

describe('potOdds', () => {
  it('computes required equity and odds for a half-pot call', () => {
    const o = potOdds(100, 50);
    expect(o.potAfter).toBe(150);
    expect(o.requiredEquity).toBeCloseTo(1 / 3, 5); // 50 / 150
    expect(o.oddsRatio).toBe(2); // 100 : 50
  });

  it('is zero when there is nothing to call', () => {
    const o = potOdds(100, 0);
    expect(o.requiredEquity).toBe(0);
    expect(o.oddsRatio).toBe(0);
  });
});

describe('mdf', () => {
  it('defends 50% vs a pot-sized bet, 67% vs half pot', () => {
    expect(mdf(100, 100)).toBeCloseTo(0.5, 5);
    expect(mdf(100, 50)).toBeCloseTo(2 / 3, 5);
  });
});

describe('requiredEquityForBet', () => {
  it('matches the f/(1+2f) cheat-sheet', () => {
    expect(requiredEquityForBet(1)).toBeCloseTo(1 / 3, 5); // pot bet → 33%
    expect(requiredEquityForBet(0.5)).toBeCloseTo(0.25, 5); // half pot → 25%
  });
});
