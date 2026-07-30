// Range-vs-range TURN solver (Tier-2, Stage 2). The turn has a chance layer — the
// river card — so a showdown is no longer deterministic. v1 keeps the same
// hero-first betting tree as the river (check / bet-sizes → villain fold/call) but
// replaces the showdown sign with hero's EQUITY over every possible river runout,
// enumerated exactly. That captures the turn-specific dynamics the per-hand model
// muddles: value-betting, protection (charging draws), and semi-bluffing air that
// has outs. Full river-subgame nesting (river betting) is a later increment.

import type { Card } from '../../engine/cards';
import { evaluate7 } from '../../engine/evaluator';
import { solveRiver, lockedContinueBySize, lockedVillainStrategy, type Combo, type VillainNodeLock } from './riverSolver';
import { solveVsBetEquity, type VsBetResult } from './vsBet';

export interface TurnInput {
  heroRange: Combo[];
  villainRange: Combo[];
  board: Card[]; // exactly 4 (turn)
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot
  iterations?: number;
  /** Nest a real river subgame on the CHECK line instead of scoring a check as an
   *  instant turn showdown. Default true. When false, check = static showdown (the
   *  old v1 behaviour) — kept as an A/B escape hatch and for cheap unit tests. */
  nestRiverForCheck?: boolean;
  /** CFR iterations for each nested per-river-card solve (default 200). */
  riverNestIterations?: number;
  /** NODE LOCK. Pins villain to a fold-frequency read instead of solving him, so hero's
   *  CFR converges to a BEST RESPONSE (see riverSolver's VillainNodeLock). The lock rides
   *  down into the nested river subgames on the check line too, so both the bet line and
   *  the check line best-respond to the SAME villain — otherwise the check would be valued
   *  against an equilibrium river while the bet line exploits the read. */
  villainLock?: VillainNodeLock;
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

/** Per-hero-combo EV (chips) of CHECKING the turn, valued as a real river subgame
 *  instead of an instant showdown. For every river card, the check line is a
 *  hero-first river node (hero checked the turn → OOP, acts first again) between
 *  hero's and villain's full ranges — exactly what `solveRiver` models — so nesting
 *  it credits the check with the river value the flat `equity × pot` payoff omits:
 *  betting for value when the draw lands, bluffing good cards, giving up cheaply
 *  when it bricks. Independent of the turn CFR (a check faces no prior turn bet), so
 *  it's computed ONCE up front and fed in as the check payoff.
 *
 *  APPROXIMATION (v1.5): the river subgame uses hero's FULL range, not just the
 *  hands that actually check the turn. Since strong hands tend to bet the turn, this
 *  slightly over-credits hero's river bluffs (a capped checking range can't credibly
 *  bluff as much). It is still far closer than the instant-showdown baseline it
 *  replaces, and it only nudges the check UP toward its true value — the direction
 *  that fixes the over-betting bias. Full reach-weighted nesting is a later step. */
function checkLineRiverEv(
  H: Combo[],
  V: Combo[],
  board4: Card[],
  P: number,
  effStack: number,
  betSizes: number[],
  riverIters: number,
  villainLock?: VillainNodeLock,
): number[] {
  const nH = H.length;
  const acc = new Array(nH).fill(0);
  const cnt = new Array(nH).fill(0);
  for (let rank = 2; rank <= 14; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      const rid = rank * 4 + suit;
      if (board4.some((c) => id(c) === rid)) continue;
      const river = { rank, suit };
      // combos that don't use the river card, with a back-map to the original index.
      const Hr: Combo[] = [];
      const hMap: number[] = [];
      for (let i = 0; i < nH; i++) {
        if (id(H[i].cards[0]) === rid || id(H[i].cards[1]) === rid) continue;
        Hr.push(H[i]);
        hMap.push(i);
      }
      const Vr = V.filter((c) => id(c.cards[0]) !== rid && id(c.cards[1]) !== rid);
      if (!Hr.length || !Vr.length) continue;
      const res = solveRiver({
        heroRange: Hr,
        villainRange: Vr,
        board: [...board4, river],
        pot: P,
        effStack,
        betSizes,
        iterations: riverIters,
        villainLock,
      });
      // hero's equilibrium value for each combo = its strategy-weighted action EV.
      for (let k = 0; k < Hr.length; k++) {
        const strat = res.heroStrategy[k];
        const evs = res.heroActionEv[k];
        let node = 0;
        for (let a = 0; a < strat.length; a++) node += strat[a].freq * evs[a];
        acc[hMap[k]] += node;
        cnt[hMap[k]] += 1;
      }
    }
  }
  return acc.map((v, i) => (cnt[i] > 0 ? v / cnt[i] : NaN));
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

  // NODE LOCK: pin villain to the read instead of solving him. He continues by a
  // threshold policy ordered by his EQUITY vs hero's range (not made-hand strength —
  // on the turn a strong draw is a legitimate continue), scaled across sizes by pot
  // odds so bigger barrels fold out more. Ordering by equity mirrors the 3-way turn
  // solver's fixed-policy ranking (multiwaySolver.ts strengthT).
  let villEqVsHero: number[] | null = null;
  if (inp.villainLock) {
    villEqVsHero = V.map((_, j) => {
      let acc = 0;
      let den = 0;
      for (let i = 0; i < nH; i++) {
        if (!valid[i][j]) continue;
        acc += H[i].w * (1 - eq[i][j]);
        den += H[i].w;
      }
      return den > 0 ? acc / den : 0.5;
    });
  }
  const locked =
    inp.villainLock && villEqVsHero
      ? lockedVillainStrategy(V, villEqVsHero, lockedContinueBySize(inp.villainLock.foldToBet, bets.map((b) => b / P)))
      : null;

  // Per-combo valid villain weight + the OLD static-showdown check value (avg chips),
  // kept as the fallback. The turn CFR scores actions as villain-weight SUMS, so the
  // check payoff below is rescaled by vwSum[i]; the final per-combo EV table wants the
  // AVERAGE, so it uses checkAvg[i] directly.
  const vwSum = new Array(nH).fill(0);
  const checkStatic = new Array(nH).fill(0);
  for (let i = 0; i < nH; i++) {
    let w = 0;
    let sd = 0;
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      w += V[j].w;
      sd += V[j].w * (eq[i][j] * P); // heroSD(eq, 0) = eq × P
    }
    vwSum[i] = w;
    checkStatic[i] = w > 0 ? sd / w : 0;
  }
  // Deeper model: value a CHECK as a real river subgame (see checkLineRiverEv), not an
  // instant turn showdown. Falls back to the static showdown per combo when disabled
  // or when a runout yields no value (NaN). This is what stops the solver over-betting
  // — a check now realises its river potential instead of being scored as give-up.
  const checkAvg = new Array(nH);
  const nested =
    inp.nestRiverForCheck !== false
      ? checkLineRiverEv(H, V, inp.board, P, inp.effStack, inp.betSizes, inp.riverNestIterations ?? 200, inp.villainLock)
      : null;
  for (let i = 0; i < nH; i++) {
    const v = nested ? nested[i] : NaN;
    checkAvg[i] = Number.isFinite(v) ? v : checkStatic[i];
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
    const vS = locked ?? regretV.map((row) => row.map(strat));

    // villain regret update — skipped when locked (his strategy is fixed to the read).
    if (!locked) for (let s = 0; s < nSizes; s++) {
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
      // check payoff = river-subgame value, put on the villain-weight SUM scale the
      // bet lines use (checkAvg is a per-combo average → × vwSum).
      av[0] = checkAvg[i] * vwSum[i];
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
  // When locked, stratSumV was never accumulated — read the pinned policy directly, or
  // the averaged tables would score hero against an all-zero sum (a 50/50 coin-flip
  // villain that is neither the equilibrium nor the read). Mirrors solveRiver.
  const vFinal =
    locked ??
    stratSumV.map((sr) =>
      sr.map((c) => {
        const tot = c[0] + c[1];
        return tot > 0 ? [c[0] / tot, c[1] / tot] : [0.5, 0.5];
      }),
    );
  const heroActionEv: number[][] = [];
  for (let i = 0; i < nH; i++) {
    const av = new Array(nHeroActions).fill(0);
    const vw = vwSum[i];
    const inv = vw > 0 ? 1 / vw : 0;
    // reported check EV = the river-subgame value (average chips), matching the payoff
    // the CFR optimised against — so the displayed EV and the solved mix agree.
    av[0] = checkAvg[i];
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

// ─────────────────────────────────────────────────────────────────────────────
// FACING A BET on the turn — hero fold / call / raise vs villain's bet. Same tree as
// solveRiverVsBet, but the call and raise-called terminals are equities over every river
// runout (equityVsCombo above) instead of an exact showdown — so a draw with the price
// calls and a big semi-bluff raise is credited its outs. The generic fold/call/raise CFR
// lives in vsBet.ts; this only builds the per-matchup equity matrix.
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnVsBetInput {
  heroRange: Combo[];
  villainRange: Combo[]; // villain's BETTING range (already conditioned)
  board: Card[]; // exactly 4 (turn)
  potBeforeBet: number; // Q
  bet: number; // b
  raiseTo: number; // r (total chips)
  iterations?: number;
}

export function solveTurnVsBet(inp: TurnVsBetInput): VsBetResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const nH = H.length;
  const nV = V.length;
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
  return solveVsBetEquity({
    eq,
    valid,
    heroW: H.map((c) => c.w),
    villW: V.map((c) => c.w),
    potBeforeBet: inp.potBeforeBet,
    bet: inp.bet,
    raiseTo: inp.raiseTo,
    iterations: inp.iterations,
  });
}
