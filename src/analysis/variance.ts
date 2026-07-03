// Bankroll / variance Monte-Carlo. Given a win rate and standard deviation (both
// in bb per 100 hands — the units the Analytics tab already reports), simulate
// many possible futures over N hands to answer the questions net-result alone
// hides: how big are the swings, how likely is a losing stretch, and — for a
// given bankroll — the risk of going broke ("risk of ruin").
//
// Pure + deterministic (seedable), so it unit-tests cleanly and re-runs stably.
// The sim steps in BLOCKS OF 100 HANDS: one block's result is exactly one draw
// from N(winRate, stdDev), which is what those per-100 figures describe — no need
// to model individual hands, and it keeps 100k-hand sims fast.

import { makeRng } from '../engine/cards';

export interface VarianceInput {
  /** win rate, bb per 100 hands (the Analytics "bb/100" number). */
  winRate: number;
  /** standard deviation, bb per 100 hands. ~80–110 is typical for 6-max NLHE. */
  stdDev: number;
  /** number of hands to simulate forward. */
  hands: number;
  /** starting bankroll in bb, for risk-of-ruin. ≤0 disables the ruin path. */
  bankroll: number;
  /** Monte-Carlo trials (independent futures). Default 2000. */
  trials?: number;
  /** PRNG seed for reproducibility. */
  seed?: number;
}

export interface VarianceResult {
  hands: number; // actual hands simulated (rounded to a whole number of 100-blocks)
  blocks: number; // hands / 100
  trials: number;
  expected: number; // EV profit in bb (winRate × blocks)
  stdFinal: number; // std of the final result in bb (stdDev × √blocks)
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  best: number; // best final result across trials (bb)
  worst: number; // worst final result across trials (bb)
  probLoss: number; // fraction of trials finishing below break-even
  riskOfRuinSim: number; // fraction of trials whose running total ever hit −bankroll
  riskOfRuinAnalytic: number; // exp(−2·winRate·bankroll / stdDev²) — closed-form cross-check
  breakEvenHands: number | null; // hands until EV = one std swing (null if winRate ≤ 0)
  samplePaths: number[][]; // a handful of cumulative-bb curves for a spaghetti chart
}

/** Standard normal draws via Box–Muller, fed by a seeded uniform PRNG. */
function makeGauss(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare != null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

export function simulateVariance(inp: VarianceInput): VarianceResult {
  const trials = Math.max(1, Math.min(20000, Math.floor(inp.trials ?? 2000)));
  const blocks = Math.max(1, Math.round(inp.hands / 100));
  const hands = blocks * 100;
  const wr = inp.winRate;
  const sd = Math.max(0, inp.stdDev);
  const B = inp.bankroll;
  const rng = makeRng((inp.seed ?? 0x5eed) >>> 0 || 1);
  const gauss = makeGauss(rng);

  const finals = new Array<number>(trials);
  let ruinCount = 0;
  const wantPaths = Math.min(24, trials);
  const samplePaths: number[][] = [];

  for (let t = 0; t < trials; t++) {
    let cum = 0;
    let ruined = false;
    const keepPath = t < wantPaths;
    const path: number[] = keepPath ? [0] : [];
    for (let b = 0; b < blocks; b++) {
      cum += wr + sd * gauss();
      if (B > 0 && cum <= -B) ruined = true;
      if (keepPath) path.push(cum);
    }
    finals[t] = cum;
    if (ruined) ruinCount++;
    if (keepPath) samplePaths.push(path);
  }

  const sorted = [...finals].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const expected = wr * blocks;
  const stdFinal = sd * Math.sqrt(blocks);
  const probLoss = finals.filter((f) => f < 0).length / trials;
  // Closed-form gambler's-ruin (Brownian, no upper barrier), per-100-hand units:
  //   RoR = exp(−2·μ·B / σ²),  μ = winRate, σ = stdDev, B = bankroll.
  // Only meaningful for a winning player with variance; a break-even/losing player
  // busts eventually (RoR → 1), and no bankroll means no ruin to measure.
  const riskOfRuinAnalytic =
    B <= 0 ? 0 : wr > 0 && sd > 0 ? Math.min(1, Math.exp((-2 * wr * B) / (sd * sd))) : 1;
  const breakEvenHands = wr > 0 && sd > 0 ? Math.round(100 * (sd / wr) * (sd / wr)) : null;

  return {
    hands,
    blocks,
    trials,
    expected,
    stdFinal,
    percentiles: { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) },
    best: sorted[sorted.length - 1],
    worst: sorted[0],
    probLoss,
    riskOfRuinSim: B > 0 ? ruinCount / trials : 0,
    riskOfRuinAnalytic,
    breakEvenHands,
    samplePaths,
  };
}
