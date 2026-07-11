// Range-vs-range TURN solver (Tier-2, Stage 2). The turn has a chance layer — the
// river card — so a showdown is no longer deterministic. v1 keeps the same
// hero-first betting tree as the river (check / bet-sizes → villain fold/call) but
// replaces the showdown sign with hero's EQUITY over every possible river runout,
// enumerated exactly. That captures the turn-specific dynamics the per-hand model
// muddles: value-betting, protection (charging draws), and semi-bluffing air that
// has outs. Full river-subgame nesting (river betting) is a later increment.

import type { Card } from '../../engine/cards';
import { evaluate7 } from '../../engine/evaluator';
import type { Combo } from './riverSolver';

export interface TurnInput {
  heroRange: Combo[];
  villainRange: Combo[];
  board: Card[]; // exactly 4 (turn)
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot
  iterations?: number;
}

export interface TurnResult {
  heroStrategy: { action: string; freq: number }[][];
  actions: string[];
  heroActionEv: number[][]; // per hero combo, per action (chips)
  villainCallFreq: number[];
}

const id = (c: Card) => c.rank * 4 + c.suit;
const same = (a: Card, b: Card) => a.rank === b.rank && a.suit === b.suit;
const conflict = (a: Combo, b: Combo) =>
  same(a.cards[0], b.cards[0]) || same(a.cards[0], b.cards[1]) || same(a.cards[1], b.cards[0]) || same(a.cards[1], b.cards[1]);

function strat(regret: number[]): number[] {
  let s = 0;
  const p = regret.map((r) => (r > 0 ? r : 0));
  for (const v of p) s += v;
  return s > 0 ? p.map((v) => v / s) : regret.map(() => 1 / regret.length);
}

/** Hero equity (win + ½tie) vs one villain combo, enumerated over all rivers that
 *  don't collide with the board or either hand. */
function equityVsCombo(hero: [Card, Card], vill: [Card, Card], board: Card[]): number {
  const used = new Set<number>([...board, hero[0], hero[1], vill[0], vill[1]].map(id));
  let win = 0;
  let tie = 0;
  let n = 0;
  for (let rank = 2; rank <= 14; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      const rid = rank * 4 + suit;
      if (used.has(rid)) continue;
      const river = { rank, suit };
      const h = evaluate7([hero[0], hero[1], ...board, river]).score;
      const v = evaluate7([vill[0], vill[1], ...board, river]).score;
      if (h > v) win++;
      else if (h === v) tie++;
      n++;
    }
  }
  return n > 0 ? (win + tie / 2) / n : 0.5;
}

export function solveTurn(inp: TurnInput): TurnResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const P = inp.pot;
  const iters = inp.iterations ?? 800;
  const bets = inp.betSizes.map((f) => Math.min(inp.effStack, Math.round(f * P))).filter((b) => b > 0);
  const nSizes = bets.length;
  const nHeroActions = 1 + nSizes;
  const nH = H.length;
  const nV = V.length;

  // Equity matrix (hero i vs villain j over rivers) + card-removal validity.
  const valid: Uint8Array[] = [];
  const eq: Float64Array[] = [];
  for (let i = 0; i < nH; i++) {
    const vr = new Uint8Array(nV);
    const er = new Float64Array(nV);
    for (let j = 0; j < nV; j++) {
      if (conflict(H[i], V[j])) {
        vr[j] = 0;
        continue;
      }
      vr[j] = 1;
      er[j] = equityVsCombo(H[i].cards, V[j].cards, inp.board);
    }
    valid.push(vr);
    eq.push(er);
  }

  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const regretV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));
  const stratSumV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));

  // hero showdown EV given equity e and both invested inv (uses the turn pot P).
  const heroSD = (e: number, inv: number) => e * (P + 2 * inv) - inv;
  const villCall = (e: number, b: number) => (1 - e) * (P + 2 * b) - b; // villain's EV calling a bet b

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(strat);
    const vS = regretV.map((row) => row.map(strat));

    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      for (let j = 0; j < nV; j++) {
        const vFold = 0;
        let vCall = 0;
        for (let i = 0; i < nH; i++) {
          if (!valid[i][j]) continue;
          const reach = H[i].w * hS[i][1 + s];
          if (reach === 0) continue;
          vCall += reach * villCall(eq[i][j], b);
        }
        const st = vS[s][j];
        const node = st[0] * vFold + st[1] * vCall;
        const cf = V[j].w;
        regretV[s][j][0] += cf * (vFold - node);
        regretV[s][j][1] += cf * (vCall - node);
        stratSumV[s][j][0] += cf * st[0];
        stratSumV[s][j][1] += cf * st[1];
      }
    }

    for (let i = 0; i < nH; i++) {
      const av = new Array(nHeroActions).fill(0);
      let vCheck = 0;
      for (let j = 0; j < nV; j++) if (valid[i][j]) vCheck += V[j].w * heroSD(eq[i][j], 0);
      av[0] = vCheck;
      for (let s = 0; s < nSizes; s++) {
        const b = bets[s];
        let vBet = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const vs = vS[s][j];
          vBet += V[j].w * (vs[0] * P + vs[1] * heroSD(eq[i][j], b));
        }
        av[1 + s] = vBet;
      }
      const st = hS[i];
      let node = 0;
      for (let a = 0; a < nHeroActions; a++) node += st[a] * av[a];
      const cf = H[i].w;
      for (let a = 0; a < nHeroActions; a++) {
        regretH[i][a] += cf * (av[a] - node);
        stratSumH[i][a] += cf * st[a];
      }
    }
  }

  const actions = ['check', ...bets.map((_, s) => `bet:${s}`)];
  const heroStrategy = stratSumH.map((row) => {
    const sum = row.reduce((a, v) => a + v, 0) || 1;
    return row.map((v, a) => ({ action: actions[a], freq: v / sum }));
  });
  const vFinal = stratSumV.map((sr) =>
    sr.map((c) => {
      const tot = c[0] + c[1];
      return tot > 0 ? [c[0] / tot, c[1] / tot] : [0.5, 0.5];
    }),
  );
  const heroActionEv: number[][] = [];
  for (let i = 0; i < nH; i++) {
    const av = new Array(nHeroActions).fill(0);
    let vw = 0;
    for (let j = 0; j < nV; j++) if (valid[i][j]) vw += V[j].w;
    const inv = vw > 0 ? 1 / vw : 0;
    let c = 0;
    for (let j = 0; j < nV; j++) if (valid[i][j]) c += V[j].w * heroSD(eq[i][j], 0);
    av[0] = c * inv;
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      let bt = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vFinal[s][j];
        bt += V[j].w * (vs[0] * P + vs[1] * heroSD(eq[i][j], b));
      }
      av[1 + s] = bt * inv;
    }
    heroActionEv.push(av);
  }
  const villainCallFreq = vFinal.map((sr) => {
    let cw = 0;
    let cc = 0;
    for (let j = 0; j < nV; j++) {
      cw += V[j].w;
      cc += sr[j][1] * V[j].w;
    }
    return cw > 0 ? cc / cw : 0;
  });

  return { heroStrategy, actions, heroActionEv, villainCallFreq };
}
