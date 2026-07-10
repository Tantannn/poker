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
  const actionEv: Record<string, number> = {};
  let hw = 0;
  for (let i = 0; i < nH; i++) hw += H[i].w;
  for (let a = 0; a < nHeroActions; a++) {
    let ev = 0;
    for (let i = 0; i < nH; i++) {
      let v = 0;
      let vwSum = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        vwSum += V[j].w;
        if (a === 0) v += V[j].w * heroSD(cmp[i][j], 0);
        else {
          const s = a - 1;
          const b = bets[s];
          const vs = vStratFinal[s][j];
          v += V[j].w * (vs[0] * P + vs[1] * heroSD(cmp[i][j], b));
        }
      }
      ev += H[i].w * (vwSum > 0 ? v / vwSum : 0);
    }
    actionEv[actions[a]] = hw > 0 ? ev / hw : 0;
  }

  return { heroStrategy: hStratAvg, actions, actionEv, villainCallFreq: vCallFreq };
}
