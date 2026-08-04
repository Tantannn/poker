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
import { netPot, rakeOn, type Rake } from '../../engine/rake';

export interface Combo {
  cards: [Card, Card];
  w: number; // range weight (0..1+)
}

/** NODE LOCK. Villain's strategy is FIXED to a fold-frequency read instead of being
 *  solved, and hero best-responds to it. This is the point of a lock: an equilibrium
 *  villain is unexploitable by construction, so as long as CFR solves both sides the
 *  answer to "he over-folds the river" is always "nothing changes". Locking villain
 *  is what turns a read into a strategy.
 *
 *  `foldToBet` is the range-averaged fold frequency at the REFERENCE size below; the
 *  policy scales it across sizes by pot odds so a locked villain still folds more to
 *  bigger bets, like a real player. */
export interface VillainNodeLock {
  /** 0..1, range-averaged fold frequency vs a reference-sized bet */
  foldToBet: number;
  /** 0..1, MEASURED fold frequency when his own bet gets raised (observed.ts: foldToRaise).
   *  Only used at facing-a-bet nodes, where villain's remaining decision IS fold-or-call a
   *  raise. Absent → that rate is re-derived from `foldToBet` through pot odds, which is a
   *  model; this is the observation, so it wins when present. */
  foldToRaise?: number;
}

/** Bet size (fraction of pot) the locked `foldToBet` is quoted at. ¾ pot is the
 *  size the observed counters mostly sample, and the size the lock slider describes. */
const LOCK_REF_FRAC = 0.75;

/** Minimum-defence frequency vs a bet of `frac` pot — the balanced continue rate. */
const mdf = (frac: number) => 1 / (1 + frac);

/** Pot-odds fraction a MEASURED fold-to-raise is treated as quoted at: villain bets the ¾-pot
 *  reference (b = 0.75Q) and gets raised to the smaller grid size (r = b + ½(Q + 2b)), so he
 *  pays 1.25Q to win 3.75Q. The modal raise geometry, which is what the observation samples. */
const REF_RAISE_PRICE = 1 / 3;

/**
 * Locked villain's continue fraction vs each bet size. Anchored so that at
 * LOCK_REF_FRAC he continues `1 - foldToBet`, then scaled by the MDF ratio so bigger
 * bets fold out more. A villain who folds 70% to ¾-pot continues ~30% there, less to
 * a pot bet and more to a ⅓ stab — which is what makes barrelling him print.
 */
export function lockedContinueBySize(foldToBet: number, betFracs: number[]): number[] {
  const anchor = Math.max(0.02, Math.min(1, 1 - foldToBet));
  const refMdf = mdf(LOCK_REF_FRAC);
  return betFracs.map((f) => Math.max(0.01, Math.min(1, (anchor * mdf(f)) / refMdf)));
}

/**
 * Build villain's locked strategy: vs each size, CONTINUE with the top `cont(s)` of
 * the range by weight, ordered by showdown strength, and fold the rest. A threshold
 * policy, not a mix — an exploitable player is exactly one who calls his best hands
 * and folds the rest at the wrong frequency, and a mixed lock would blur the very
 * thing hero is supposed to attack.
 *
 * Returns `[foldProb, callProb]` per (size, villain combo), same shape as the solved
 * strategy it replaces, so the hero regret update and the EV pass need no changes.
 * The combo AT the threshold gets the fractional remainder so the range-averaged
 * continue rate hits the target exactly rather than landing on a combo boundary.
 */
export function lockedVillainStrategy(V: Combo[], villScore: number[], contBySize: number[]): number[][][] {
  const weights = V.map((v) => v.w);
  return contBySize.map((cont) => lockedThresholdPolicy(weights, villScore, cont));
}

/** The threshold policy itself, over bare weights — so the facing-a-bet solvers (which hold
 *  weight arrays, not Combos) pin villain with the same rule the hero-first solvers use. */
export function lockedThresholdPolicy(weights: number[], strength: number[], cont: number): number[][] {
  const order = weights.map((_, j) => j).sort((a, b) => strength[b] - strength[a]); // strongest first
  let totalW = 0;
  for (const w of weights) totalW += w;
  const target = cont * totalW;
  const out: number[][] = weights.map(() => [1, 0]); // default fold
  let acc = 0;
  for (const j of order) {
    const w = weights[j];
    if (w <= 0) continue;
    if (acc + w <= target) {
      out[j] = [0, 1]; // fully continues
      acc += w;
    } else {
      const part = Math.max(0, Math.min(1, (target - acc) / w));
      out[j] = [1 - part, part];
      break;
    }
  }
  return out;
}

/** Locked villain's continue rate when he faces a RAISE to `r` after betting `b` into dead
 *  pot `Q`: he adds r − b to win Q + b + r, so his pot-odds size is (r − b)/(Q + b + r).
 *  Quoted through the same ¾-pot-referenced curve as the bet locks, so ONE observed read
 *  drives every node — and because a raise gives him a better price relative to the enlarged
 *  pot than the reference bet does, the curve correctly folds him LESS here than a bare
 *  fold-to-bet number would suggest. */
export function lockedContinueVsRaise(
  foldToBet: number,
  Q: number,
  b: number,
  r: number,
  foldToRaise?: number,
): number {
  const price = (r - b) / Math.max(1e-9, Q + b + r);
  if (foldToRaise == null) return lockedContinueBySize(foldToBet, [price])[0];
  // A measured fold-to-raise is quoted at whatever raise prices he actually faced, so re-anchor
  // it to the ¾-pot reference the size curve is built around and let the same curve spread it
  // across the raise grid — a jam still folds him out more than a min-raise.
  const anchor = ((1 - foldToRaise) * mdf(LOCK_REF_FRAC)) / mdf(REF_RAISE_PRICE);
  return lockedContinueBySize(1 - anchor, [price])[0];
}

/** Share of a locked villain's CONTINUING range that re-raises rather than calls. A fold
 *  read says nothing about his 3-bet frequency, but pinning it to zero would hand hero a
 *  raise branch that can never be punished and turn every bluff-raise into free money — so
 *  his strongest continues 3-bet. A disclosed abstraction, not a measured statistic. */
export const LOCKED_THREEBET_SHARE = 0.3;

/** Villain's raise-TO vs hero's bet = his call plus this fraction of the pot he would then be
 *  playing. Matches the ½–1× family `raiseSizeGrid` offers hero facing a bet; a single size
 *  keeps the hero-first tree affordable (the check line already nests a subgame). */
const VILLAIN_RAISE_FRAC = 0.75;

/** Villain's raise-TO total per hero bet size, in chips. Exported so the exploitability
 *  harness measures the SAME tree the solver plays; it still derives every payoff itself. */
export function villainRaiseSizes(pot: number, effStack: number, bets: number[]): number[] {
  return bets.map((b) => Math.min(effStack, Math.max(2 * b, Math.round(b + VILLAIN_RAISE_FRAC * (pot + 2 * b)))));
}

/** Locked villain facing a raise: [fold, call, 3bet] per combo. Both slices are threshold
 *  policies over the SAME strength ordering, so the 3-betting hands are a subset of the
 *  continuing hands by construction — his best hands raise, the next best call, the rest fold. */
export function locked3BetPolicy(
  weights: number[],
  strength: number[],
  cont: number,
  threeBetShare = LOCKED_THREEBET_SHARE,
): number[][] {
  const continues = lockedThresholdPolicy(weights, strength, cont);
  const threeBets = lockedThresholdPolicy(weights, strength, cont * threeBetShare);
  return weights.map((_, j) => {
    const c = continues[j][1];
    const t = Math.min(threeBets[j][1], c);
    return [1 - c, c - t, t];
  });
}

export interface RiverInput {
  heroRange: Combo[];
  villainRange: Combo[];
  board: Card[]; // exactly 5
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot, e.g. [0.5, 1.0, 1.5]
  iterations?: number;
  /** when set, villain does not learn — his strategy is pinned to this read and hero
   *  best-responds to it (see VillainNodeLock). */
  villainLock?: VillainNodeLock;
  /** house rake in chips, taken off every pot a player collects. Omit for rake-free EV. */
  rake?: Rake;
  /** May villain RAISE hero's bet (default true)? With it off, hero's bet can only be folded
   *  to or called, so every bluff is priced risk-free and the bet line is over-valued. Kept as
   *  a flag purely to A/B that pricing and to let the exploitability harness measure the
   *  simpler tree. */
  villainMayRaise?: boolean;
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
  /** villain's solved [fold, call] — or [fold, call, raise] where he may raise — strategy per
   *  (bet size, villain combo): the average strategy, or the pinned lock. Exposed so the
   *  exploitability harness can best-respond to it independently; unset by the multiway
   *  solvers, which reuse this shape. */
  villainStrategy?: number[][][];
  /** villain's raise frequency vs each bet size, range-averaged (0 where he cannot raise). */
  villainRaiseFreq?: number[];
  /** villain's CONTINUE frequency (call + raise) per bet size — the complement of his fold
   *  frequency, and therefore the number a fold-to-bet read is quoted against.
   *  `villainCallFreq` is calls ONLY, which stopped being the same thing once he can raise. */
  villainContinueFreq?: number[];
  /** hero's solved [fold, call] response to villain's raise, per (bet size, hero combo).
   *  This is the bet-FOLD decision the old tree could not represent at all. */
  heroRaiseResponse?: number[][][];
  /** hero's fold-to-the-raise frequency per bet size, range-averaged — the number the coach
   *  quotes as "if he raises this, you're folding ~X%". */
  heroFoldToRaiseFreq?: number[];
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

  // VILLAIN MAY RAISE. Without this branch hero's bet can only be folded to or called, so a
  // bluff is priced risk-free and hero is never taught to bet-fold. One raise size per bet:
  // villain's raise-TO is his call plus ¾ of the pot he would then be playing (the same
  // family of fractions raiseSizeGrid offers hero facing a bet), floored at a legal min-raise
  // and capped at the stack — where it becomes a jam. A bet already at the stack cannot be
  // raised, so that size keeps the two-action tree.
  const mayRaise = inp.villainMayRaise !== false;
  const raiseTo = villainRaiseSizes(P, inp.effStack, bets);
  const canRaise = bets.map((b, s) => mayRaise && raiseTo[s] > b);
  const nVillActions = canRaise.map((r) => (r ? 3 : 2));

  // Regret + strategy-sum tables.
  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  // villain faces a bet of size s: infoset per (size, villain combo), [fold, call(, raise)]
  const regretV = nVillActions.map((n) => Array.from({ length: nV }, () => new Array(n).fill(0)));
  const stratSumV = nVillActions.map((n) => Array.from({ length: nV }, () => new Array(n).fill(0)));
  // hero faces villain's raise of size s: infoset per (size, hero combo), [fold, call]
  const regretH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));
  const stratSumH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));

  // Payoff tables indexed by showdown sign + 1 (0 = villain wins, 1 = tie, 2 = hero wins),
  // one row per bet size, so the innermost CFR lines index instead of calling. Rake comes
  // off the pot the WINNER collects, never off the loser's investment, so it shrinks the win
  // and tie branches only; the pot at a showdown where both invested `inv` is P + 2·inv.
  const rake = inp.rake;
  const netAt = (inv: number) => netPot(rake, P + 2 * inv);
  const heroPayAt = (inv: number) => [-inv, netAt(inv) / 2 - inv, netAt(inv) - inv];
  const villPayAt = (b: number) => [netAt(b) - b, netAt(b) / 2 - b, -b];
  const heroPayCheck = heroPayAt(0); // check-check: neither invested more
  const heroPayBet = bets.map(heroPayAt);
  const villPayBet = bets.map(villPayAt);
  // villain folds to a bet of b: hero's own bet comes back, so he gains P less the rake.
  const heroFoldWin = bets.map((b) => P - rakeOn(rake, P + b));
  // ...and the raise branch: hero calling it is a showdown with both in `raiseTo`, hero folding
  // to it forfeits only the bet he already made, and villain then collects P + b.
  const heroPayRaise = raiseTo.map(heroPayAt);
  const villPayRaise = raiseTo.map(villPayAt);
  const heroFoldsToRaise = bets.map((b) => -b);
  const villRaiseFoldWin = bets.map((b, s) => P + b - rakeOn(rake, P + b + raiseTo[s]));

  // NODE LOCK: villain's strategy is fixed up front and never updated, so hero's
  // regret update below converges to a BEST RESPONSE to the read rather than to an
  // equilibrium. Computed once — it doesn't depend on hero's strategy.
  // Fractions come from `bets`, not inp.betSizes: sizes that round to 0 are filtered
  // out and a size past the stack is capped to a shove, so only `bets` is guaranteed
  // parallel to nSizes and to carry the fraction actually being offered.
  //   A LOCKED villain still raises: `locked3BetPolicy` gives the strongest
  //   LOCKED_THREEBET_SHARE of his continuing range the raise. Pinning it to zero instead
  //   would hand hero a bet that can never be punished — the same reason the facing-a-bet
  //   lock keeps a re-raise.
  const vWeights = V.map((c) => c.w);
  const lockedCont = inp.villainLock
    ? lockedContinueBySize(inp.villainLock.foldToBet, bets.map((b) => b / P))
    : null;
  const locked = lockedCont
    ? bets.map((_, s) =>
        canRaise[s]
          ? locked3BetPolicy(vWeights, villScore, lockedCont[s])
          : lockedThresholdPolicy(vWeights, villScore, lockedCont[s]),
      )
    : null;

  for (let t = 0; t < iters; t++) {
    const hStrat = regretH.map(strategyFromRegret);
    const vStrat = locked ?? regretV.map((sizeRow) => sizeRow.map(strategyFromRegret));
    const hStrat2 = regretH2.map((rows) => rows.map(strategyFromRegret));

    // --- Hero's response to the raise (per size) — only villain's raising hands reach it,
    // and it is what stops a bluff from being free: hero must give up his bet or pay it off.
    for (let s = 0; s < nSizes; s++) {
      if (!canRaise[s]) continue;
      const hrp = heroPayRaise[s];
      const fold = heroFoldsToRaise[s];
      for (let i = 0; i < nH; i++) {
        let aFold = 0;
        let aCall = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const reach = V[j].w * vStrat[s][j][2];
          if (reach === 0) continue;
          aFold += reach * fold;
          aCall += reach * hrp[cmp[i][j] + 1];
        }
        const st = hStrat2[s][i];
        const node = st[0] * aFold + st[1] * aCall;
        const cf = H[i].w;
        regretH2[s][i][0] += cf * (aFold - node);
        regretH2[s][i][1] += cf * (aCall - node);
        stratSumH2[s][i][0] += cf * st[0];
        stratSumH2[s][i][1] += cf * st[1];
      }
    }

    // reach into "villain faces bet_s" from each hero combo = w_i * hero P(bet_s)
    // --- Villain regret update (per size) — skipped when locked ---
    if (!locked) for (let s = 0; s < nSizes; s++) {
      const vpay = villPayBet[s];
      const vrp = villPayRaise[s];
      const vrf = villRaiseFoldWin[s];
      const raises = canRaise[s];
      for (let j = 0; j < nV; j++) {
        // counterfactual values weighted by hero reach betting this size
        let vFold = 0;
        let vCall = 0;
        let vRaise = 0;
        for (let i = 0; i < nH; i++) {
          if (!valid[i][j]) continue;
          const reach = H[i].w * hStrat[i][1 + s];
          if (reach === 0) continue;
          const sgn = cmp[i][j] + 1;
          vFold += reach * 0; // villain folds → 0
          vCall += reach * vpay[sgn];
          if (raises) {
            const h2 = hStrat2[s][i];
            vRaise += reach * (h2[0] * vrf + h2[1] * vrp[sgn]);
          }
        }
        const strat = vStrat[s][j];
        const nodeV = strat[0] * vFold + strat[1] * vCall + (raises ? strat[2] * vRaise : 0);
        const cfReach = V[j].w; // villain counterfactual reach = range weight
        regretV[s][j][0] += cfReach * (vFold - nodeV);
        regretV[s][j][1] += cfReach * (vCall - nodeV);
        stratSumV[s][j][0] += cfReach * strat[0];
        stratSumV[s][j][1] += cfReach * strat[1];
        if (raises) {
          regretV[s][j][2] += cfReach * (vRaise - nodeV);
          stratSumV[s][j][2] += cfReach * strat[2];
        }
      }
    }

    // --- Hero regret update ---
    for (let i = 0; i < nH; i++) {
      const av = new Array(nHeroActions).fill(0);
      // check → showdown, both invested 0
      let vCheck = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        vCheck += V[j].w * heroPayCheck[cmp[i][j] + 1];
      }
      av[0] = vCheck;
      // bet_s → villain folds (hero wins P), calls (showdown at b), or RAISES (hero then
      // gives up his bet or calls for a showdown at raiseTo).
      for (let s = 0; s < nSizes; s++) {
        const hpay = heroPayBet[s];
        const fw = heroFoldWin[s];
        const hrp = heroPayRaise[s];
        const h2 = hStrat2[s][i];
        const raises = canRaise[s];
        let vBet = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const vs = vStrat[s][j];
          const sgn = cmp[i][j] + 1;
          const afterRaise = raises ? vs[2] * (h2[0] * heroFoldsToRaise[s] + h2[1] * hrp[sgn]) : 0;
          vBet += V[j].w * (vs[0] * fw + vs[1] * hpay[sgn] + afterRaise);
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
  // When locked, stratSumV was never accumulated — read the locked policy directly.
  // Falling through to the averaged tables would score hero against an all-zero sum
  // (which normalises to a 50/50 coin-flip villain), i.e. against a villain who is
  // neither the equilibrium nor the read.
  const vCallFreq: number[] = [];
  for (let s = 0; s < nSizes; s++) {
    let cw = 0;
    let cc = 0;
    for (let j = 0; j < nV; j++) {
      const callP = locked ? locked[s][j][1] : null;
      if (callP != null) {
        cc += callP * V[j].w;
        cw += V[j].w;
        continue;
      }
      const ss = stratSumV[s][j];
      const tot = ss.reduce((a, v) => a + v, 0);
      if (tot > 0) {
        cc += (ss[1] / tot) * V[j].w;
        cw += V[j].w;
      }
    }
    vCallFreq.push(cw > 0 ? cc / cw : 0);
  }

  // action EV: expected hero chips if the whole range took that action (weighted).
  const vStratFinal =
    locked ??
    stratSumV.map((sr) =>
      sr.map((cell) => {
        const tot = cell.reduce((a, v) => a + v, 0);
        return tot > 0 ? cell.map((v) => v / tot) : cell.map(() => 1 / cell.length);
      }),
    );
  // hero's averaged fold/call response to the raise, per size. Uniform where the branch was
  // never reached, so a size villain never raises can't skew the reported EV.
  const hStrat2Final = stratSumH2.map((rows) =>
    rows.map((cell) => {
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
    for (let j = 0; j < nV; j++) if (valid[i][j]) vCheck += V[j].w * heroPayCheck[cmp[i][j] + 1];
    av[0] = vCheck * inv;
    for (let s = 0; s < nSizes; s++) {
      const hpay = heroPayBet[s];
      const fw = heroFoldWin[s];
      const hrp = heroPayRaise[s];
      const h2 = hStrat2Final[s][i];
      const raises = canRaise[s];
      let vBet = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vStratFinal[s][j];
        const sgn = cmp[i][j] + 1;
        const afterRaise = raises ? vs[2] * (h2[0] * heroFoldsToRaise[s] + h2[1] * hrp[sgn]) : 0;
        vBet += V[j].w * (vs[0] * fw + vs[1] * hpay[sgn] + afterRaise);
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

  // Range-averaged raise / fold-to-raise frequencies — the diagnostics the coach quotes.
  const wSum = (w: number[]) => w.reduce((a, v) => a + v, 0) || 1;
  const vRaiseFreq = bets.map((_, s) => {
    if (!canRaise[s]) return 0;
    let acc = 0;
    for (let j = 0; j < nV; j++) acc += V[j].w * (vStratFinal[s][j][2] ?? 0);
    return acc / wSum(vWeights);
  });
  const hFoldToRaise = bets.map((_, s) => {
    if (!canRaise[s]) return 0;
    let acc = 0;
    for (let i = 0; i < nH; i++) acc += H[i].w * hStrat2Final[s][i][0];
    return acc / wSum(H.map((c) => c.w));
  });

  return {
    heroStrategy: hStratAvg,
    actions,
    actionEv,
    heroActionEv,
    villainCallFreq: vCallFreq,
    villainStrategy: vStratFinal,
    villainRaiseFreq: vRaiseFreq,
    villainContinueFreq: vCallFreq.map((c, s) => c + vRaiseFreq[s]),
    heroRaiseResponse: hStrat2Final,
    heroFoldToRaiseFreq: hFoldToRaise,
  };
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
  /** hero's raise-TO totals in chips, one per offered size */
  raiseSizes: number[];
  /** villain's re-raise total per raise size; ≤ the raise disables that branch */
  threeBetTo?: number[];
  iterations?: number;
  /** NODE LOCK. Villain has already bet, so his one remaining decision is fold-or-call vs
   *  hero's raise — pinning it to the read is what makes a bluff-raise price out an
   *  over-folder. Without it CFR solves his response too and the node is unexploitable, so
   *  "he gives up when raised" would change nothing. */
  villainLock?: VillainNodeLock;
  /** house rake in chips, taken off every pot a player collects. Omit for rake-free EV. */
  rake?: Rake;
}

export interface RiverVsBetResult {
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

export function solveRiverVsBet(inp: RiverVsBetInput): RiverVsBetResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const Q = inp.potBeforeBet;
  const b = inp.bet;
  const R = inp.raiseSizes.map((x) => Math.max(x, b + 1));
  const nR = R.length;
  const X = R.map((rk, k) => Math.max(rk, inp.threeBetTo?.[k] ?? rk)); // villain's re-raise total
  const has3Bet = R.map((rk, k) => X[k] > rk);
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

  // Payoff tables indexed by showdown sign + 1 (0 = villain wins, 1 = tie, 2 = hero wins),
  // so the inner loops index instead of branching. Hero net chips, dead pot Q.
  const rake = inp.rake;
  const netAt = (x: number) => netPot(rake, Q + 2 * x); // both invested x → pot Q + 2x
  const heroAt = (x: number) => [-x, netAt(x) / 2 - x, netAt(x) - x];
  const villAt = (x: number) => [netAt(x) - x, netAt(x) / 2 - x, -x];
  const heroCallPay = heroAt(b);
  const heroRaisePay = R.map(heroAt);
  const hero3BetCallPay = X.map(heroAt);
  const villCallPay = R.map(villAt);
  const vill3BetCallPay = X.map(villAt);
  // villain folds to the raise: pot is Q + b + r_k and hero's own raise comes back.
  const heroRaiseFold = R.map((rk) => Q + b - rakeOn(rake, Q + b + rk));
  const villFold = -b; // forfeits the bet

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

  // NODE LOCK: villain's response to the raise is fixed up front and never updated, so
  // hero's regrets converge to a BEST RESPONSE to the read. Ordered by showdown strength —
  // the river is exact, so his strongest hands are exactly the ones that continue.
  const vWeights = V.map((c) => c.w);
  const locked = inp.villainLock
    ? R.map((rk, k) => {
        const cont = lockedContinueVsRaise(inp.villainLock!.foldToBet, Q, b, rk, inp.villainLock!.foldToRaise);
        if (!has3Bet[k]) return lockedThresholdPolicy(vWeights, vScore, cont).map(([f, c]) => [f, c, 0]);
        return locked3BetPolicy(vWeights, vScore, cont);
      })
    : null;

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(strategyFromRegret);
    const hS3 = regretH3.map((rows) => rows.map(strategyFromRegret));
    const vS = locked ?? regretV.map((rows, k) => rows.map((reg) => normaliseVillain(reg, has3Bet[k])));

    for (let k = 0; k < nR; k++) {
      const rk = R[k];
      // hero's response to the re-raise. Only villain's 3-betting hands reach it, so this
      // node is what stops a bluff-raise from being free: hero must fold rk or call xk.
      if (has3Bet[k]) {
        const callPay = hero3BetCallPay[k];
        for (let i = 0; i < nH; i++) {
          let aFold = 0;
          let aCall = 0;
          for (let j = 0; j < nV; j++) {
            if (!valid[i][j]) continue;
            const reach = V[j].w * vS[k][j][2];
            if (reach === 0) continue;
            aFold += reach * -rk;
            aCall += reach * callPay[cmp[i][j] + 1];
          }
          const st = hS3[k][i];
          const node = st[0] * aFold + st[1] * aCall;
          const cf = H[i].w;
          regretH3[k][i][0] += cf * (aFold - node);
          regretH3[k][i][1] += cf * (aCall - node);
          stratSumH3[k][i][0] += cf * st[0];
          stratSumH3[k][i][1] += cf * st[1];
        }
      }

      // villain regret vs raise k (only hero's raise reaches here) — skipped when locked.
      if (!locked) {
        const vCall = villCallPay[k];
        const v3Call = vill3BetCallPay[k];
        const VILL_3BET_FOLD = Q + rk - rakeOn(rake, Q + rk + X[k]); // hero folds to the re-raise
        for (let j = 0; j < nV; j++) {
          let vF = 0;
          let vC = 0;
          let v3 = 0;
          for (let i = 0; i < nH; i++) {
            if (!valid[i][j]) continue;
            const reach = H[i].w * hS[i][2 + k];
            if (reach === 0) continue;
            const sgn = cmp[i][j] + 1;
            vF += reach * villFold;
            vC += reach * vCall[sgn];
            if (has3Bet[k]) v3 += reach * (hS3[k][i][0] * VILL_3BET_FOLD + hS3[k][i][1] * v3Call[sgn]);
          }
          const st = vS[k][j];
          const node = st[0] * vF + st[1] * vC + st[2] * v3;
          const cf = V[j].w;
          regretV[k][j][0] += cf * (vF - node);
          regretV[k][j][1] += cf * (vC - node);
          if (has3Bet[k]) regretV[k][j][2] += cf * (v3 - node);
          stratSumV[k][j][0] += cf * st[0];
          stratSumV[k][j][1] += cf * st[1];
          stratSumV[k][j][2] += cf * st[2];
        }
      }
    }

    // hero root regret
    for (let i = 0; i < nH; i++) {
      const av = new Array(nHeroActions).fill(0);
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const w = V[j].w;
        const sgn = cmp[i][j] + 1;
        av[1] += w * heroCallPay[sgn];
        for (let k = 0; k < nR; k++) {
          const vs = vS[k][j];
          const afterRaise = vs[0] * heroRaiseFold[k] + vs[1] * heroRaisePay[k][sgn];
          const after3Bet = has3Bet[k]
            ? vs[2] * (hS3[k][i][0] * -R[k] + hS3[k][i][1] * hero3BetCallPay[k][sgn])
            : 0;
          av[2 + k] += w * (afterRaise + after3Bet);
        }
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

  const heroStrategy = stratSumH.map((row) => {
    const s = row.reduce((a, v) => a + v, 0) || 1;
    const raises = row.slice(2).map((v) => v / s);
    return { fold: row[0] / s, call: row[1] / s, raise: raises.reduce((a, v) => a + v, 0), raises };
  });
  // When locked, stratSumV was never accumulated — read the pinned policy, or hero would be
  // scored against an all-zero sum (a coin-flip villain that is neither the equilibrium nor
  // the read). Mirrors solveRiver.
  const vFinal =
    locked ??
    stratSumV.map((rows, k) => rows.map((row) => normaliseVillain(row, has3Bet[k], true)));
  const hFinal3 = stratSumH3.map((rows) =>
    rows.map((row) => {
      const s = row[0] + row[1];
      return s > 0 ? [row[0] / s, row[1] / s] : [0.5, 0.5];
    }),
  );

  const heroEv = H.map((_, i) => {
    let vw = 0;
    let call = 0;
    const raises = new Array(nR).fill(0);
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      const w = V[j].w;
      const sgn = cmp[i][j] + 1;
      vw += w;
      call += w * heroCallPay[sgn];
      for (let k = 0; k < nR; k++) {
        const vs = vFinal[k][j];
        const after3Bet = has3Bet[k]
          ? vs[2] * (hFinal3[k][i][0] * -R[k] + hFinal3[k][i][1] * hero3BetCallPay[k][sgn])
          : 0;
        raises[k] += w * (vs[0] * heroRaiseFold[k] + vs[1] * heroRaisePay[k][sgn] + after3Bet);
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
        w += V[j].w;
        acc += pick(j, k) * V[j].w;
      }
      return w > 0 ? acc / w : 0;
    });
  const heroFoldTo3BetFreq = R.map((_, k) => {
    let w = 0;
    let acc = 0;
    for (let i = 0; i < nH; i++) {
      w += H[i].w;
      acc += hFinal3[k][i][0] * H[i].w;
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
