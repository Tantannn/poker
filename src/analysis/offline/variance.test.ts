import { describe, it, expect } from 'vitest';
import { simulateVariance } from './variance';

describe('simulateVariance', () => {
  it('rounds hands to whole 100-blocks and reports matching EV', () => {
    const r = simulateVariance({ winRate: 5, stdDev: 100, hands: 10000, bankroll: 3000 });
    expect(r.blocks).toBe(100);
    expect(r.hands).toBe(10000);
    expect(r.expected).toBeCloseTo(500, 6); // 5 bb/100 × 100 blocks
    expect(r.stdFinal).toBeCloseTo(1000, 6); // 100 × √100
  });

  it('is deterministic for a fixed seed', () => {
    const a = simulateVariance({ winRate: 3, stdDev: 90, hands: 5000, bankroll: 2000, seed: 42, trials: 500 });
    const b = simulateVariance({ winRate: 3, stdDev: 90, hands: 5000, bankroll: 2000, seed: 42, trials: 500 });
    expect(b.percentiles).toEqual(a.percentiles);
    expect(b.riskOfRuinSim).toBe(a.riskOfRuinSim);
    expect(b.worst).toBe(a.worst);
  });

  it('with zero variance every trial equals the EV exactly', () => {
    const r = simulateVariance({ winRate: 4, stdDev: 0, hands: 10000, bankroll: 1000, trials: 200 });
    expect(r.percentiles.p5).toBeCloseTo(400, 6);
    expect(r.percentiles.p95).toBeCloseTo(400, 6);
    expect(r.worst).toBeCloseTo(400, 6);
    expect(r.probLoss).toBe(0); // a sure winner never finishes negative
    expect(r.riskOfRuinSim).toBe(0);
  });

  it('produces monotonically ordered percentiles', () => {
    const p = simulateVariance({ winRate: 2, stdDev: 100, hands: 20000, bankroll: 2500, trials: 1500 }).percentiles;
    expect(p.p5).toBeLessThanOrEqual(p.p25);
    expect(p.p25).toBeLessThanOrEqual(p.p50);
    expect(p.p50).toBeLessThanOrEqual(p.p75);
    expect(p.p75).toBeLessThanOrEqual(p.p95);
  });

  it('widens the outcome spread as std grows', () => {
    const tight = simulateVariance({ winRate: 5, stdDev: 50, hands: 20000, bankroll: 3000, seed: 7, trials: 1500 });
    const wide = simulateVariance({ winRate: 5, stdDev: 150, hands: 20000, bankroll: 3000, seed: 7, trials: 1500 });
    const spread = (r: typeof tight) => r.percentiles.p95 - r.percentiles.p5;
    expect(spread(wide)).toBeGreaterThan(spread(tight));
  });

  it('risk of ruin falls as the bankroll deepens (both sim and analytic)', () => {
    const shallow = simulateVariance({ winRate: 3, stdDev: 100, hands: 100000, bankroll: 500, seed: 1, trials: 2000 });
    const deep = simulateVariance({ winRate: 3, stdDev: 100, hands: 100000, bankroll: 5000, seed: 1, trials: 2000 });
    expect(deep.riskOfRuinSim).toBeLessThan(shallow.riskOfRuinSim);
    expect(deep.riskOfRuinAnalytic).toBeLessThan(shallow.riskOfRuinAnalytic);
    expect(deep.riskOfRuinAnalytic).toBeGreaterThanOrEqual(0);
    expect(shallow.riskOfRuinAnalytic).toBeLessThanOrEqual(1);
  });

  it('treats a break-even/losing player as certain ruin, a no-bankroll query as none', () => {
    expect(simulateVariance({ winRate: 0, stdDev: 100, hands: 10000, bankroll: 1000 }).riskOfRuinAnalytic).toBe(1);
    expect(simulateVariance({ winRate: -2, stdDev: 100, hands: 10000, bankroll: 1000 }).riskOfRuinAnalytic).toBe(1);
    expect(simulateVariance({ winRate: 5, stdDev: 100, hands: 10000, bankroll: 0 }).riskOfRuinAnalytic).toBe(0);
  });

  it('computes break-even hands = 100·(std/wr)² and null for non-winners', () => {
    const r = simulateVariance({ winRate: 5, stdDev: 100, hands: 1000, bankroll: 1000 });
    expect(r.breakEvenHands).toBe(Math.round(100 * (100 / 5) ** 2)); // 40,000
    expect(simulateVariance({ winRate: 0, stdDev: 100, hands: 1000, bankroll: 1000 }).breakEvenHands).toBeNull();
  });

  it('caps the number of sample paths returned', () => {
    const r = simulateVariance({ winRate: 5, stdDev: 100, hands: 5000, bankroll: 2000, trials: 1000 });
    expect(r.samplePaths.length).toBeLessThanOrEqual(24);
    expect(r.samplePaths[0]).toHaveLength(r.blocks + 1); // includes the 0 start point
  });
});
