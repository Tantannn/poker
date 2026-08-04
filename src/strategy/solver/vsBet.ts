// Generic FACING-A-BET solver core (fold / call / raise), shared by the turn and flop.
// It generalises solveRiverVsBet (riverSolver.ts) to streets with cards to come: the only
// thing that changes street-to-street is the terminal payoff, which here is driven by a
// precomputed hero-equity matrix (0..1 over the remaining runouts) instead of the river's
// exact showdown sign. The betting tree is the same single-raise tree:
//
//   hero: fold ───────────────────────► villain wins (hero util 0)
//         call(invest b) ─────────────► equity showdown, both in b
//         raise→r_k ────────► villain: fold ──► hero wins Q+b
//                                       call ──► equity showdown, both in r_k
//                                       3bet→x_k ─► hero: fold ─► hero loses r_k
//                                                         call ─► showdown, both in x_k
//
// The caller (solveTurnVsBet / solveFlopVsBet) owns the runout enumeration that fills `eq`;
// this module is game math over that matrix, so it never touches a board or an evaluator —
// its only import is the shared node-lock policy.

import { locked3BetPolicy, lockedContinueVsRaise, lockedThresholdPolicy } from './riverSolver';
import { netPot, rakeOn, type Rake } from '../../engine/rake';

export interface VsBetEquityInput {
  eq: Float64Array[]; // [heroI][villJ] hero equity over remaining runouts, 0..1
  valid: Uint8Array[]; // [heroI][villJ] card-removal validity
  heroW: number[];
  villW: number[];
  potBeforeBet: number; // Q — dead money before villain's bet
  bet: number; // b — villain's bet
  /** hero's raise-TO totals in chips, one per offered size */
  raiseSizes: number[];
  /** villain's re-raise total per raise size; ≤ the raise disables that branch */
  threeBetTo?: number[];
  iterations?: number;
  /** NODE LOCK: pin villain's fold-or-call vs hero's raise to a read (¾-pot-referenced
   *  fold-to-bet) instead of solving it, so hero best-responds. Omit for the equilibrium. */
  villainFoldToBet?: number;
  /** MEASURED fold-to-raise, when observed. Replaces the pot-odds re-derivation of the above
   *  for this node's raise branches — the observation beats the model. */
  villainFoldToRaise?: number;
  /** house rake in chips, taken off every pot a player collects. Omit for rake-free EV. */
  rake?: Rake;
}

export interface VsBetResult {
  /** hero strategy per combo (parallel to heroRange). `raises` is per raise size; `raise`
   *  is their sum, the frequency of raising AT ALL. */
  heroStrategy: { fold: number; call: number; raise: number; raises: number[] }[];
  /** per-combo EV (chips) vs the solved villain response. `raises` is per size; `raise` is
   *  the best of them — the value of the raise LINE, which is what a scalar summary wants. */
  heroEv: { fold: number; call: number; raise: number; raises: number[] }[];
  /** villain's call-the-raise frequency per raise size, range-averaged (diagnostic). */
  villainCallRaiseFreq: number[];
  /** villain's re-raise frequency per raise size, range-averaged (diagnostic). */
  villain3BetFreq: number[];
  /** hero's fold-to-the-re-raise frequency per raise size, range-averaged (diagnostic). */
  heroFoldTo3BetFreq: number[];
}

/** Each villain combo's equity vs hero's WHOLE range — the strength ordering a threshold
 *  lock needs on a street with cards to come, where a big draw is a legitimate continue and
 *  ranking by current made-hand strength would order his range wrong. */
export function villainEquityVsHeroRange(eq: Float64Array[], valid: Uint8Array[], heroW: number[]): number[] {
  const nV = eq.length ? eq[0].length : 0;
  const out = new Array(nV).fill(0.5);
  for (let j = 0; j < nV; j++) {
    let acc = 0;
    let den = 0;
    for (let i = 0; i < heroW.length; i++) {
      if (!valid[i][j]) continue;
      acc += heroW[i] * (1 - eq[i][j]);
      den += heroW[i];
    }
    if (den > 0) out[j] = acc / den;
  }
  return out;
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
  const R = inp.raiseSizes.map((x) => Math.max(x, b + 1));
  const nR = R.length;
  const X = R.map((rk, k) => Math.max(rk, inp.threeBetTo?.[k] ?? rk)); // villain's re-raise total
  const has3Bet = R.map((rk, k) => X[k] > rk);
  const iters = inp.iterations ?? 1200;
  const nH = heroW.length;
  const nV = villW.length;

  // hero net chips (dead pot Q). At an equity showdown for total invested x the final pot
  // is Q + 2x, so hero's EV = e·(Q + 2x) − x (e=1 → Q+x win, e=0 → −x, e=½ → Q/2 tie).
  // Rake comes off the pot collected, so it scales the win side and leaves the invested
  // chips alone. Every terminal pot is precomputed per size — the showdown lines below are
  // the innermost of the CFR, so a per-leaf function call is worth seconds of wall clock.
  const rake = inp.rake;
  const netAt = (x: number) => netPot(rake, Q + 2 * x);
  const netB = netAt(b);
  const netR = R.map(netAt);
  const netX = X.map(netAt);
  // villain folds to the raise: pot is Q + b + r_k and hero's own raise comes back.
  const heroRaiseFold = R.map((rk) => Q + b - rakeOn(rake, Q + b + rk));
  const villFold = -b; // villain forfeits his bet

  // hero root actions: 0 fold, 1 call, 2 + k raise at size k
  const nHeroActions = 2 + nR;
  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  // villain facing raise k: fold, call, 3bet
  const regretV = Array.from({ length: nR }, () => Array.from({ length: nV }, () => [0, 0, 0]));
  const stratSumV = Array.from({ length: nR }, () => Array.from({ length: nV }, () => [0, 0, 0]));
  // hero facing villain's re-raise of raise k: fold, call
  const regretH3 = Array.from({ length: nR }, () => Array.from({ length: nH }, () => [0, 0]));
  const stratSumH3 = Array.from({ length: nR }, () => Array.from({ length: nH }, () => [0, 0]));

  // NODE LOCK: villain's response to the raise is pinned and never updated, so hero's
  // regrets converge to a BEST RESPONSE to the read rather than to an equilibrium.
  const villStrength = inp.villainFoldToBet != null ? villainEquityVsHeroRange(eq, valid, heroW) : null;
  const locked = villStrength
    ? R.map((rk, k) => {
        const cont = lockedContinueVsRaise(inp.villainFoldToBet as number, Q, b, rk, inp.villainFoldToRaise);
        if (!has3Bet[k]) return lockedThresholdPolicy(villW, villStrength, cont).map(([f, c]) => [f, c, 0]);
        return locked3BetPolicy(villW, villStrength, cont);
      })
    : null;

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(sfr);
    const hS3 = regretH3.map((rows) => rows.map(sfr));
    const vS = locked ?? regretV.map((rows, k) => rows.map((reg) => normaliseVillain(reg, has3Bet[k])));

    for (let k = 0; k < nR; k++) {
      const rk = R[k];
      // hero's response to the re-raise. Only villain's 3-betting hands reach it, so this
      // node is what stops a bluff-raise from being free: hero must fold rk or call xk.
      if (has3Bet[k]) {
        for (let i = 0; i < nH; i++) {
          let aFold = 0;
          let aCall = 0;
          for (let j = 0; j < nV; j++) {
            if (!valid[i][j]) continue;
            const reach = villW[j] * vS[k][j][2];
            if (reach === 0) continue;
            aFold += reach * -rk;
            aCall += reach * (eq[i][j] * netX[k] - X[k]);
          }
          const st = hS3[k][i];
          const node = st[0] * aFold + st[1] * aCall;
          const cf = heroW[i];
          regretH3[k][i][0] += cf * (aFold - node);
          regretH3[k][i][1] += cf * (aCall - node);
          stratSumH3[k][i][0] += cf * st[0];
          stratSumH3[k][i][1] += cf * st[1];
        }
      }

      // villain regret vs raise k — only hero's raise reaches it. Skipped when locked.
      if (!locked) {
        const VILL_3BET_FOLD = Q + rk - rakeOn(rake, Q + rk + X[k]); // hero folds to the re-raise
        for (let j = 0; j < nV; j++) {
          let vF = 0;
          let vC = 0;
          let v3 = 0;
          for (let i = 0; i < nH; i++) {
            if (!valid[i][j]) continue;
            const reach = heroW[i] * hS[i][2 + k];
            if (reach === 0) continue;
            vF += reach * villFold;
            vC += reach * ((1 - eq[i][j]) * netR[k] - rk);
            if (has3Bet[k]) {
              v3 += reach * (hS3[k][i][0] * VILL_3BET_FOLD + hS3[k][i][1] * ((1 - eq[i][j]) * netX[k] - X[k]));
            }
          }
          const st = vS[k][j];
          const node = st[0] * vF + st[1] * vC + st[2] * v3;
          const cf = villW[j];
          regretV[k][j][0] += cf * (vF - node);
          regretV[k][j][1] += cf * (vC - node);
          if (has3Bet[k]) regretV[k][j][2] += cf * (v3 - node);
          stratSumV[k][j][0] += cf * st[0];
          stratSumV[k][j][1] += cf * st[1];
          stratSumV[k][j][2] += cf * st[2];
        }
      }
    }

    // hero root regret.
    for (let i = 0; i < nH; i++) {
      const av = new Array(nHeroActions).fill(0);
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const w = villW[j];
        const e = eq[i][j];
        av[1] += w * (e * netB - b);
        for (let k = 0; k < nR; k++) {
          const vs = vS[k][j];
          const afterRaise = vs[0] * heroRaiseFold[k] + vs[1] * (e * netR[k] - R[k]);
          const after3Bet = has3Bet[k]
            ? vs[2] * (hS3[k][i][0] * -R[k] + hS3[k][i][1] * (e * netX[k] - X[k]))
            : 0;
          av[2 + k] += w * (afterRaise + after3Bet);
        }
      }
      const st = hS[i];
      let node = 0;
      for (let a = 0; a < nHeroActions; a++) node += st[a] * av[a];
      const cf = heroW[i];
      for (let a = 0; a < nHeroActions; a++) {
        regretH[i][a] += cf * (av[a] - node);
        stratSumH[i][a] += cf * st[a];
      }
    }
  }

  const heroStrategy = stratSumH.map((row) => {
    const s = row.reduce((a, v) => a + v, 0) || 1;
    const raises = row.slice(2).map((v) => v / s);
    return { fold: row[0] / s, call: row[1] / s, raise: raises.reduce((a, v) => a + v, 0), raises };
  });
  // Locked → read the pinned policy; the strategy sums were never accumulated, and averaging
  // them would score hero against a coin-flip villain instead of the read.
  const vFinal = locked ?? stratSumV.map((rows, k) => rows.map((row) => normaliseVillain(row, has3Bet[k], true)));
  const hFinal3 = stratSumH3.map((rows) =>
    rows.map((row) => {
      const s = row[0] + row[1];
      return s > 0 ? [row[0] / s, row[1] / s] : [0.5, 0.5];
    }),
  );

  const heroEv = heroW.map((_, i) => {
    let vw = 0;
    let call = 0;
    const raises = new Array(nR).fill(0);
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      const w = villW[j];
      const e = eq[i][j];
      vw += w;
      call += w * (e * netB - b);
      for (let k = 0; k < nR; k++) {
        const vs = vFinal[k][j];
        const after3Bet = has3Bet[k]
          ? vs[2] * (hFinal3[k][i][0] * -R[k] + hFinal3[k][i][1] * (e * netX[k] - X[k]))
          : 0;
        raises[k] += w * (vs[0] * heroRaiseFold[k] + vs[1] * (e * netR[k] - R[k]) + after3Bet);
      }
    }
    const inv = vw > 0 ? 1 / vw : 0;
    const scaled = raises.map((x) => x * inv);
    return { fold: 0, call: call * inv, raise: Math.max(...scaled), raises: scaled };
  });

  const avgOver = (pick: (j: number, k: number) => number) =>
    R.map((_, k) => {
      let w = 0;
      let acc = 0;
      for (let j = 0; j < nV; j++) {
        w += villW[j];
        acc += pick(j, k) * villW[j];
      }
      return w > 0 ? acc / w : 0;
    });
  const heroFoldTo3BetFreq = R.map((_, k) => {
    let w = 0;
    let acc = 0;
    for (let i = 0; i < nH; i++) {
      w += heroW[i];
      acc += hFinal3[k][i][0] * heroW[i];
    }
    return w > 0 ? acc / w : 0;
  });

  return {
    heroStrategy,
    heroEv,
    villainCallRaiseFreq: avgOver((j, k) => vFinal[k][j][1]),
    villain3BetFreq: avgOver((j, k) => vFinal[k][j][2]),
    heroFoldTo3BetFreq,
  };
}

/** Regret-match villain's 3-action infoset, forcing the re-raise to zero where the tree has
 *  no re-raise (hero already jammed). `fromSums` normalises accumulated strategy sums, which
 *  can be all-zero for a size hero never raised — a uniform mix there would invent a villain. */
function normaliseVillain(row: number[], has3Bet: boolean, fromSums = false): number[] {
  const src = fromSums ? row : row.map((v) => (v > 0 ? v : 0));
  const f = src[0];
  const c = src[1];
  const t = has3Bet ? src[2] : 0;
  const s = f + c + t;
  if (s > 0) return [f / s, c / s, t / s];
  return has3Bet ? [1 / 3, 1 / 3, 1 / 3] : [0.5, 0.5, 0];
}
