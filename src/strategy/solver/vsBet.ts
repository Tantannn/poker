// Generic FACING-A-BET solver core (fold / call / raise), shared by the turn and flop.
// It generalises solveRiverVsBet (riverSolver.ts) to streets with cards to come: the only
// thing that changes street-to-street is the terminal payoff, which here is driven by a
// precomputed hero-equity matrix (0..1 over the remaining runouts) instead of the river's
// exact showdown sign. The betting tree is the same single-raise tree:
//
//   hero: fold ───────────────────────► villain wins (hero util 0)
//         call(invest b) ─────────────► equity showdown, both in b
//         raise→r(invest r) ─► villain: fold ─► hero wins Q+b
//                                       call ─► equity showdown, both in r
//
// The caller (solveTurnVsBet / solveFlopVsBet) owns the runout enumeration that fills `eq`;
// this module is pure game math, so it has no board or evaluator dependency.

export interface VsBetEquityInput {
  eq: Float64Array[]; // [heroI][villJ] hero equity over remaining runouts, 0..1
  valid: Uint8Array[]; // [heroI][villJ] card-removal validity
  heroW: number[];
  villW: number[];
  potBeforeBet: number; // Q — dead money before villain's bet
  bet: number; // b — villain's bet
  raiseTo: number; // r — total chips hero commits if raising
  iterations?: number;
}

export interface VsBetResult {
  /** hero strategy per combo: {fold, call, raise} frequencies (parallel to heroRange). */
  heroStrategy: { fold: number; call: number; raise: number }[];
  /** per-combo EV (chips) of fold / call / raise vs the solved villain response. */
  heroEv: { fold: number; call: number; raise: number }[];
  /** villain's call-the-raise frequency, range-averaged (diagnostic). */
  villainCallRaiseFreq: number;
}

function sfr(regret: number[]): number[] {
  let sum = 0;
  const s = regret.map((r) => (r > 0 ? r : 0));
  for (const v of s) sum += v;
  if (sum <= 0) return regret.map(() => 1 / regret.length);
  return s.map((v) => v / sum);
}

export function solveVsBetEquity(inp: VsBetEquityInput): VsBetResult {
  const { eq, valid, heroW, villW } = inp;
  const Q = inp.potBeforeBet;
  const b = inp.bet;
  const r = Math.max(inp.raiseTo, b + 1);
  const iters = inp.iterations ?? 1200;
  const nH = heroW.length;
  const nV = villW.length;

  // hero net chips (dead pot Q). At an equity showdown for total invested x the final pot
  // is Q + 2x, so hero's EV = e·(Q + 2x) − x (e=1 → Q+x win, e=0 → −x, e=½ → Q/2 tie).
  const heroCall = (e: number) => e * (Q + 2 * b) - b;
  const heroRaiseCalled = (e: number) => e * (Q + 2 * r) - r;
  const HERO_RAISE_FOLD = Q + b; // villain folds to the raise → hero takes dead pot + bet
  const villFold = -b; // villain forfeits his bet
  const villCall = (e: number) => (1 - e) * (Q + 2 * r) - r; // villain's EV calling the raise

  const regretH = Array.from({ length: nH }, () => [0, 0, 0]); // fold, call, raise
  const stratSumH = Array.from({ length: nH }, () => [0, 0, 0]);
  const regretV = Array.from({ length: nV }, () => [0, 0]); // fold, call (facing the raise)
  const stratSumV = Array.from({ length: nV }, () => [0, 0]);

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(sfr);
    const vS = regretV.map(sfr);

    // villain regret — only hero's RAISE reaches this node.
    for (let j = 0; j < nV; j++) {
      let vF = 0;
      let vC = 0;
      for (let i = 0; i < nH; i++) {
        if (!valid[i][j]) continue;
        const reach = heroW[i] * hS[i][2];
        if (reach === 0) continue;
        vF += reach * villFold;
        vC += reach * villCall(eq[i][j]);
      }
      const st = vS[j];
      const node = st[0] * vF + st[1] * vC;
      const cf = villW[j];
      regretV[j][0] += cf * (vF - node);
      regretV[j][1] += cf * (vC - node);
      stratSumV[j][0] += cf * st[0];
      stratSumV[j][1] += cf * st[1];
    }

    // hero regret.
    for (let i = 0; i < nH; i++) {
      const aFold = 0;
      let aCall = 0;
      let aRaise = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const w = villW[j];
        aCall += w * heroCall(eq[i][j]);
        aRaise += w * (vS[j][0] * HERO_RAISE_FOLD + vS[j][1] * heroRaiseCalled(eq[i][j]));
      }
      const st = hS[i];
      const node = st[0] * aFold + st[1] * aCall + st[2] * aRaise;
      const cf = heroW[i];
      regretH[i][0] += cf * (aFold - node);
      regretH[i][1] += cf * (aCall - node);
      regretH[i][2] += cf * (aRaise - node);
      stratSumH[i][0] += cf * st[0];
      stratSumH[i][1] += cf * st[1];
      stratSumH[i][2] += cf * st[2];
    }
  }

  const heroStrategy = stratSumH.map((row) => {
    const s = row[0] + row[1] + row[2] || 1;
    return { fold: row[0] / s, call: row[1] / s, raise: row[2] / s };
  });
  const vFinal = stratSumV.map((row) => {
    const s = row[0] + row[1] || 1;
    return [row[0] / s, row[1] / s];
  });
  const heroEv = heroW.map((_, i) => {
    let vw = 0;
    let call = 0;
    let raise = 0;
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      vw += villW[j];
      call += villW[j] * heroCall(eq[i][j]);
      raise += villW[j] * (vFinal[j][0] * HERO_RAISE_FOLD + vFinal[j][1] * heroRaiseCalled(eq[i][j]));
    }
    const inv = vw > 0 ? 1 / vw : 0;
    return { fold: 0, call: call * inv, raise: raise * inv };
  });
  let cwSum = 0;
  let ccSum = 0;
  for (let j = 0; j < nV; j++) {
    cwSum += villW[j];
    ccSum += vFinal[j][1] * villW[j];
  }
  return { heroStrategy, heroEv, villainCallRaiseFreq: cwSum > 0 ? ccSum / cwSum : 0 };
}
