import { describe, it, expect } from 'vitest';
import { icmEquities, icmRead, payoutTable } from './icm';

describe('payoutTable', () => {
  it('scales paid places with field size', () => {
    expect(payoutTable(2)).toEqual([1]);
    expect(payoutTable(5)).toEqual([0.65, 0.35]);
    expect(payoutTable(6)).toEqual([0.5, 0.3, 0.2]);
  });
});

describe('icmEquities', () => {
  it('splits equally for equal stacks', () => {
    const eq = icmEquities([1000, 1000, 1000], [0.5, 0.3, 0.2]);
    for (const e of eq) expect(e).toBeCloseTo(1 / 3, 10);
  });

  it('sums to the total prize fraction', () => {
    const eq = icmEquities([5000, 3000, 1500, 500], [0.5, 0.3, 0.2]);
    expect(eq.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('gives the chip leader LESS than a linear chip share (the ICM tax)', () => {
    // leader holds 60% of chips but payouts cap at 50% for 1st → equity < 0.6
    const eq = icmEquities([6000, 2000, 2000], [0.5, 0.3, 0.2]);
    expect(eq[0]).toBeLessThan(0.6);
    expect(eq[0]).toBeGreaterThan(1 / 3);
    // and the short stacks get MORE than their linear share
    expect(eq[1]).toBeGreaterThan(0.2);
  });

  it('a busted (0-chip) stack has zero equity', () => {
    const eq = icmEquities([4000, 0, 2000], [0.65, 0.35]);
    expect(eq[1]).toBe(0);
    expect(eq[0] + eq[2]).toBeCloseTo(1, 10);
  });

  it('handles a degenerate empty/zero input without NaN', () => {
    expect(icmEquities([], [1])).toEqual([]);
    expect(icmEquities([0, 0], [1])).toEqual([0, 0]);
  });
});

describe('icmRead', () => {
  it('flags the bubble when one elimination remains before the money', () => {
    // 6-entrant SNG pays 3; 4 players left → bubble
    const r = icmRead([3000, 2000, 800, 200], 0, 6);
    expect(r.paid).toBe(3);
    expect(r.onBubble).toBe(true);
    expect(r.inTheMoney).toBe(false);
  });

  it('flags in-the-money once the field is within the paid places', () => {
    const r = icmRead([4000, 1500, 500], 0, 6);
    expect(r.onBubble).toBe(false);
    expect(r.inTheMoney).toBe(true);
  });

  it('reports hero equity in buy-ins against the full pool', () => {
    // equal 3-way in a 6-entrant pool: each has 1/3 of 6 buy-ins = 2
    const r = icmRead([2000, 2000, 2000], 0, 6);
    expect(r.equityBuyins).toBeCloseTo(2, 10);
  });
});
