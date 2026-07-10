// Range-vs-range RIVER solver (Tier-2, Stage 1). Computes an approximate Nash
// equilibrium for a hero-first river node via vector CFR (counterfactual regret
// minimisation). Unlike the per-hand model in postflopModel.ts, this evaluates
// hero's whole RANGE vs villain's whole RANGE, so it recovers the things the
// per-hand model structurally cannot: polar bet/bluff frequencies, capped-range
// exploits, and legitimate overbets.
//
// v1 tree (hero first, no raises — villain only responds to a bet; a hero check
// goes to showdown):
//
//   root(hero):  check ─────────────────────────────► showdown (0,0)
//                bet_s(hero invests b) ─► villain:  fold ─► hero wins pot P
//                                                   call ─► showdown (b,b)
//
// Turn/river raises and villain donks are v2 (see docs/range-vs-range-ev-design.md).

import type { Card } from '../../engine/cards';
import { evaluate7 } from '../../engine/evaluator';

export interface Combo {
  cards: [Card, Card];
  w: number; // range weight (0..1+)
}

export interface RiverInput {
  heroRange: Combo[];
  villainRange: Combo[];
  board: Card[]; // exactly 5
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot, e.g. [0.5, 1.0, 1.5]
  iterations?: number;
}

export interface RiverResult {
  /** hero root strategy per combo: parallel to heroRange, action -> frequency. */
  heroStrategy: { action: string; freq: number }[][];
  /** hero action labels at the root, in column order (['check','bet:0',...]). */
  actions: string[];
  /** chips (in pot units) each root action wins on average over hero's range. */
  actionEv: Record<string, number>;
  /** per-hero-combo EV of each root action (chips), vs the solved villain strategy.
   *  Parallel to heroRange (outer) and `actions` (inner). This is the EV of a
   *  SPECIFIC hero hand — what the NodeStrategy for that hand should report. */
  heroActionEv: number[][];
  /** villain call frequency vs each bet size, range-averaged (diagnostic). */
  villainCallFreq: number[];
}

const cardId = (c: Card) => `${c.rank}${c.suit}`;
const conflict = (a: Combo, b: Combo) =>
  cardId(a.cards[0]) === cardId(b.cards[0]) ||
  cardId(a.cards[0]) === cardId(b.cards[1]) ||
  cardId(a.cards[1]) === cardId(b.cards[0]) ||
  cardId(a.cards[1]) === cardId(b.cards[1]);

/** Regret matching: positive-regret share, uniform if all non-positive. */
function strategyFromRegret(regret: number[]): number[] {
  let sum = 0;
  const s = regret.map((r) => (r > 0 ? r : 0));
  for (const v of s) sum += v;
  if (sum <= 0) return regret.map(() => 1 / regret.length);
  return s.map((v) => v / sum);
}

export function solveRiver(inp: RiverInput): RiverResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const P = inp.pot;
  const iters = inp.iterations ?? 1500;
  // bet sizes in chips, capped at the stack (a size ≥ stack becomes a shove).
  const bets = inp.betSizes.map((f) => Math.min(inp.effStack, Math.round(f * P))).filter((b) => b > 0);
  const nSizes = bets.length;
  // hero actions: index 0 = check, 1..nSizes = bet of that size
  const nHeroActions = 1 + nSizes;

  // Precompute showdown sign for every (hero, villain) pair: +1 hero wins, 0 tie,
  // -1 villain wins. Board is fixed on the river, so this never changes.
  const nH = H.length;
  const nV = V.length;
  const valid: Uint8Array[] = [];
  const cmp: Int8Array[] = [];
  const villScore: number[] = V.map((v) => evaluate7([...v.cards, ...inp.board]).score);
  for (let i = 0; i < nH; i++) {
    const hi = evaluate7([...H[i].cards, ...inp.board]).score;
    const vrow = new Uint8Array(nV);
    const crow = new Int8Array(nV);
    for (let j = 0; j < nV; j++) {
      vrow[j] = conflict(H[i], V[j]) ? 0 : 1;
      crow[j] = hi > villScore[j] ? 1 : hi < villScore[j] ? -1 : 0;
    }
    valid.push(vrow);
    cmp.push(crow);
  }

  // Regret + strategy-sum tables.
  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  // villain faces a bet of size s: infoset per (size, villain combo), actions [fold, call]
  const regretV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));
  const stratSumV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));

  // hero showdown utility (hero net chips) given both invested `inv`.
  const heroSD = (sign: number, inv: number) => (sign > 0 ? P + inv : sign < 0 ? -inv : P / 2);
  // villain utility when CALLING a bet b against hero sign (+1 hero wins).
  const villCall = (sign: number, b: number) => (sign < 0 ? P + b : sign > 0 ? -b : P / 2);

  for (let t = 0; t < iters; t++) {
    const hStrat = regretH.map(strategyFromRegret);
    const vStrat = regretV.map((sizeRow) => sizeRow.map(strategyFromRegret));

    // reach into "villain faces bet_s" from each hero combo = w_i * hero P(bet_s)
    // --- Villain regret update (per size) ---
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      for (let j = 0; j < nV; j++) {
        // counterfactual values weighted by hero reach betting this size
        let vFold = 0;
        let vCall = 0;
        for (let i = 0; i < nH; i++) {
          if (!valid[i][j]) continue;
          const reach = H[i].w * hStrat[i][1 + s];
          if (reach === 0) continue;
          vFold += reach * 0; // villain folds → 0
          vCall += reach * villCall(cmp[i][j], b);
        }
        const strat = vStrat[s][j];
        const nodeV = strat[0] * vFold + strat[1] * vCall;
        const cfReach = V[j].w; // villain counterfactual reach = range weight
        regretV[s][j][0] += cfReach * (vFold - nodeV);
        regretV[s][j][1] += cfReach * (vCall - nodeV);
        stratSumV[s][j][0] += cfReach * strat[0];
        stratSumV[s][j][1] += cfReach * strat[1];
      }
    }

    // --- Hero regret update ---
    for (let i = 0; i < nH; i++) {
      const av = new Array(nHeroActions).fill(0);
      // check → showdown, both invested 0
      let vCheck = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        vCheck += V[j].w * heroSD(cmp[i][j], 0);
      }
      av[0] = vCheck;
      // bet_s → villain folds (hero wins pot P) or calls (showdown, invested b)
      for (let s = 0; s < nSizes; s++) {
        const b = bets[s];
        let vBet = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const vs = vStrat[s][j];
          vBet += V[j].w * (vs[0] * P + vs[1] * heroSD(cmp[i][j], b));
        }
        av[1 + s] = vBet;
      }
      const strat = hStrat[i];
      let node = 0;
      for (let a = 0; a < nHeroActions; a++) node += strat[a] * av[a];
      const cfReach = H[i].w;
      for (let a = 0; a < nHeroActions; a++) {
        regretH[i][a] += cfReach * (av[a] - node);
        stratSumH[i][a] += cfReach * strat[a];
      }
    }
  }

  // Average strategies.
  const actions = ['check', ...bets.map((_, s) => `bet:${s}`)];
  const heroStrategy = stratSumH.map((row) => {
    const sum = row.reduce((a, v) => a + v, 0) || 1;
    return row.map((v, a) => ({ action: actions[a], freq: v / sum }));
  });

  // Range-averaged EV per root action + villain call freq per size (diagnostics).
  const hStratAvg = heroStrategy;
  const vCallFreq: number[] = [];
  for (let s = 0; s < nSizes; s++) {
    let cw = 0;
    let cc = 0;
    for (let j = 0; j < nV; j++) {
      const ss = stratSumV[s][j];
      const tot = ss[0] + ss[1];
      if (tot > 0) {
        cc += (ss[1] / tot) * V[j].w;
        cw += V[j].w;
      }
    }
    vCallFreq.push(cw > 0 ? cc / cw : 0);
  }

  // action EV: expected hero chips if the whole range took that action (weighted).
  const vStratFinal = stratSumV.map((sr) =>
    sr.map((cell) => {
      const tot = cell[0] + cell[1];
      return tot > 0 ? [cell[0] / tot, cell[1] / tot] : [0.5, 0.5];
    }),
  );
  // Per-combo action EV vs the solved villain strategy (the EV of a SPECIFIC hero
  // hand), normalised by that combo's valid villain weight — this is what the
  // NodeStrategy should report, not the range average.
  const heroActionEv: number[][] = [];
  for (let i = 0; i < nH; i++) {
    const av = new Array(nHeroActions).fill(0);
    let vw = 0;
    for (let j = 0; j < nV; j++) if (valid[i][j]) vw += V[j].w;
    const inv = vw > 0 ? 1 / vw : 0;
    let vCheck = 0;
    for (let j = 0; j < nV; j++) if (valid[i][j]) vCheck += V[j].w * heroSD(cmp[i][j], 0);
    av[0] = vCheck * inv;
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      let vBet = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vStratFinal[s][j];
        vBet += V[j].w * (vs[0] * P + vs[1] * heroSD(cmp[i][j], b));
      }
      av[1 + s] = vBet * inv;
    }
    heroActionEv.push(av);
  }

  const actionEv: Record<string, number> = {};
  let hw = 0;
  for (let i = 0; i < nH; i++) hw += H[i].w;
  for (let a = 0; a < nHeroActions; a++) {
    let ev = 0;
    for (let i = 0; i < nH; i++) ev += H[i].w * heroActionEv[i][a];
    actionEv[actions[a]] = hw > 0 ? ev / hw : 0;
  }

  return { heroStrategy: hStratAvg, actions, actionEv, heroActionEv, villainCallFreq: vCallFreq };
}

// ─────────────────────────────────────────────────────────────────────────────
// FACING A BET — hero is confronted with villain's bet `b` into a pre-bet pot `Q`.
// Tree (v1, single raise size): hero fold | call | raise-to r; villain then folds
// or calls the raise. This is where the per-hand model is weakest — it can't build
// a polar check-raise/raise range because it scores one hand, not a range.
//
//   hero: fold ───────────────────────────► villain wins (hero util 0)
//         call(invest b) ─────────────────► showdown (hero in b, villain in b)
//         raise→r(invest r) ─► villain: fold ─► hero wins pot (util Q+b)
//                                        call ─► showdown (both in r)
// ─────────────────────────────────────────────────────────────────────────────

export interface RiverVsBetInput {
  heroRange: Combo[];
  villainRange: Combo[]; // villain's BETTING range (already conditioned)
  board: Card[];
  potBeforeBet: number; // Q — dead money before villain's bet
  bet: number; // b — villain's bet
  raiseTo: number; // r — total hero commits if raising (chips)
  iterations?: number;
}

export interface RiverVsBetResult {
  /** hero strategy per combo: {fold, call, raise} frequencies (parallel to heroRange). */
  heroStrategy: { fold: number; call: number; raise: number }[];
  /** per-combo EV (chips) of fold / call / raise vs the solved villain response. */
  heroEv: { fold: number; call: number; raise: number }[];
  /** villain's call-the-raise frequency, range-averaged (diagnostic). */
  villainCallRaiseFreq: number;
}

export function solveRiverVsBet(inp: RiverVsBetInput): RiverVsBetResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const Q = inp.potBeforeBet;
  const b = inp.bet;
  const r = Math.max(inp.raiseTo, b + 1);
  const iters = inp.iterations ?? 1200;
  const nH = H.length;
  const nV = V.length;

  const valid: Uint8Array[] = [];
  const cmp: Int8Array[] = [];
  const vScore = V.map((v) => evaluate7([...v.cards, ...inp.board]).score);
  for (let i = 0; i < nH; i++) {
    const hi = evaluate7([...H[i].cards, ...inp.board]).score;
    const vr = new Uint8Array(nV);
    const cr = new Int8Array(nV);
    for (let j = 0; j < nV; j++) {
      vr[j] = conflict(H[i], V[j]) ? 0 : 1;
      cr[j] = hi > vScore[j] ? 1 : hi < vScore[j] ? -1 : 0;
    }
    valid.push(vr);
    cmp.push(cr);
  }

  // hero payoffs (net chips), dead pot Q, sign +1 = hero wins.
  const heroCall = (s: number) => (s > 0 ? Q + b : s < 0 ? -b : Q / 2);
  const heroRaiseCalled = (s: number) => (s > 0 ? Q + r : s < 0 ? -r : Q / 2);
  const HERO_RAISE_FOLD = Q + b; // villain folds to the raise
  // villain payoffs when facing the raise (villain wins when hero sign < 0).
  const villFold = -b; // forfeits the bet
  const villCall = (s: number) => (s < 0 ? Q + r : s > 0 ? -r : Q / 2);

  // hero actions: 0 fold, 1 call, 2 raise
  const regretH = Array.from({ length: nH }, () => [0, 0, 0]);
  const stratSumH = Array.from({ length: nH }, () => [0, 0, 0]);
  const regretV = Array.from({ length: nV }, () => [0, 0]); // fold, call
  const stratSumV = Array.from({ length: nV }, () => [0, 0]);

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(strategyFromRegret);
    const vS = regretV.map(strategyFromRegret);

    // villain regret (only hero's RAISE reaches here)
    for (let j = 0; j < nV; j++) {
      let vF = 0;
      let vC = 0;
      for (let i = 0; i < nH; i++) {
        if (!valid[i][j]) continue;
        const reach = H[i].w * hS[i][2];
        if (reach === 0) continue;
        vF += reach * villFold;
        vC += reach * villCall(cmp[i][j]);
      }
      const st = vS[j];
      const node = st[0] * vF + st[1] * vC;
      const cf = V[j].w;
      regretV[j][0] += cf * (vF - node);
      regretV[j][1] += cf * (vC - node);
      stratSumV[j][0] += cf * st[0];
      stratSumV[j][1] += cf * st[1];
    }

    // hero regret
    for (let i = 0; i < nH; i++) {
      let aFold = 0;
      let aCall = 0;
      let aRaise = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const w = V[j].w;
        aCall += w * heroCall(cmp[i][j]);
        aRaise += w * (vS[j][0] * HERO_RAISE_FOLD + vS[j][1] * heroRaiseCalled(cmp[i][j]));
      }
      // aFold stays 0
      const st = hS[i];
      const node = st[0] * aFold + st[1] * aCall + st[2] * aRaise;
      const cf = H[i].w;
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
  const heroEv = H.map((_, i) => {
    let vw = 0;
    let call = 0;
    let raise = 0;
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      vw += V[j].w;
      call += V[j].w * heroCall(cmp[i][j]);
      raise += V[j].w * (vFinal[j][0] * HERO_RAISE_FOLD + vFinal[j][1] * heroRaiseCalled(cmp[i][j]));
    }
    const inv = vw > 0 ? 1 / vw : 0;
    return { fold: 0, call: call * inv, raise: raise * inv };
  });
  let cwSum = 0;
  let ccSum = 0;
  for (let j = 0; j < nV; j++) {
    cwSum += V[j].w;
    ccSum += vFinal[j][1] * V[j].w;
  }
  return { heroStrategy, heroEv, villainCallRaiseFreq: cwSum > 0 ? ccSum / cwSum : 0 };
}
