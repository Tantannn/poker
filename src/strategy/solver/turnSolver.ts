// Range-vs-range TURN solver (Tier-2, Stage 2). The turn has a chance layer — the
// river card — so a showdown is no longer deterministic. v1 keeps the same
// hero-first betting tree as the river (check / bet-sizes → villain fold/call) but
// replaces the showdown sign with hero's EQUITY over every possible river runout,
// enumerated exactly. That captures the turn-specific dynamics the per-hand model
// muddles: value-betting, protection (charging draws), and semi-bluffing air that
// has outs. Full river-subgame nesting (river betting) is a later increment.

import type { Card } from '../../engine/cards';
import { evaluate7 } from '../../engine/evaluator';
import {
  solveRiver,
  STAB_FRAC,
  lockedContinueBySize,
  locked3BetPolicy,
  lockedThresholdPolicy,
  villainRaiseSizes,
  type Combo,
  type VillainNodeLock,
} from './riverSolver';
import { solveVsBetEquity, type VsBetResult } from './vsBet';
import { netPot, rakeOn, type Rake } from '../../engine/rake';
import { textureBuckets } from './cardTexture';

export interface TurnInput {
  heroRange: Combo[];
  villainRange: Combo[];
  board: Card[]; // exactly 4 (turn)
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot
  /** Sizes for the nested river subgames on the check line; defaults to `betSizes`. Kept
   *  separate so the turn root can offer a polar overbet while the check line — where
   *  hero's range is capped, the one range an overbet can't represent — does not pay for
   *  a 5th size in the solve's dominant cost. */
  checkLineBetSizes?: number[];
  iterations?: number;
  /** Nest a real river subgame on the CHECK line instead of scoring a check as an
   *  instant turn showdown. Default true. When false, check = static showdown (the
   *  old v1 behaviour) — kept as an A/B escape hatch and for cheap unit tests. */
  nestRiverForCheck?: boolean;
  /** CFR iterations for each nested per-river-card solve (default 200). */
  riverNestIterations?: number;
  /** Nest a real river subgame on the bet-CALLED line too (default true). Off = the called
   *  line is a static showdown, which under-values betting (see calledLineRiverFuture). */
  nestRiverForCall?: boolean;
  /** pass → nest rounds before the final pass (default CALLED_NEST_ROUNDS). */
  calledNestRounds?: number;
  /** Also return `pairEv` (see RiverResult) — the flop solver prices its called line with it. */
  wantPairEv?: boolean;
  /** May villain bet when hero checks the turn (default true)? See riverSolver STAB_FRAC. */
  villainMayStab?: boolean;
  /** May hero CHECK-RAISE villain's bet into his check (default true)? Rides into the nested
   *  subgames. Off = hero only folds or calls, so villain's stabs can never be punished. */
  heroMayCheckRaise?: boolean;
  /** NODE LOCK. Pins villain to a fold-frequency read instead of solving him, so hero's
   *  CFR converges to a BEST RESPONSE (see riverSolver's VillainNodeLock). The lock rides
   *  down into the nested river subgames on the check line too, so both the bet line and
   *  the check line best-respond to the SAME villain — otherwise the check would be valued
   *  against an equilibrium river while the bet line exploits the read. */
  villainLock?: VillainNodeLock;
  /** house rake in chips; rides into the nested river subgames too. Omit for rake-free EV. */
  rake?: Rake;
  /** May villain RAISE hero's bet (default true)? See riverSolver — off prices every bluff
   *  as risk-free. Rides into the nested river subgames so both streets model the same tree. */
  villainMayRaise?: boolean;
}

export interface TurnResult {
  heroStrategy: { action: string; freq: number }[][];
  actions: string[];
  heroActionEv: number[][]; // per hero combo, per action (chips)
  villainCallFreq: number[];
  /** villain's raise frequency per bet size (0 where he cannot raise), and call + raise =
   *  the CONTINUE frequency a fold read is quoted against. */
  villainRaiseFreq?: number[];
  villainContinueFreq?: number[];
  /** hero's solved [fold, call] response to the raise, per (size, hero combo), plus its
   *  range average — the bet-fold decision the two-action tree could not express. */
  heroRaiseResponse?: number[][][];
  heroFoldToRaiseFreq?: number[];
  /** hero EV per (hero combo, villain combo) under the solved strategies; `wantPairEv` only. */
  pairEv?: Float64Array[];
  /** villain's bet-when-checked-to size in chips (0 = none), his [check, bet] per combo,
   *  hero's [fold, call] to it per combo, and their range averages. */
  stabSize?: number;
  villainStabStrategy?: number[][];
  heroStabResponse?: number[][];
  villainStabFreq?: number;
  heroFoldToStabFreq?: number;
  /** hero's check-raise total (0 = none), villain's [fold, call] to it per combo, and their
   *  range averages. heroStabResponse is then [fold, call, check-raise] per hero combo. */
  checkRaiseTo?: number;
  villainCheckRaiseResponse?: number[][];
  heroCheckRaiseFreq?: number;
  villainFoldToCheckRaiseFreq?: number;
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

/** Per-combo average of a strategy-sum row; uniform when the row never accumulated. */
export const normalized = (row: number[]): number[] => {
  const t = row.reduce((a, v) => a + v, 0);
  return t > 0 ? row.map((v) => v / t) : row.map(() => 1 / row.length);
};

/** Keeps a combo that never bets / never calls in a nested game at a token weight, so it
 *  still gets a best-response EV of its own (regret matching is scale-invariant per combo). */
export const REACH_FLOOR = 1e-3;

/** pass → nest rounds before the final pass. One is not enough: the static first pass
 *  under-bluffs, so the nested villain folds every river and air gets phantom future value. */
export const CALLED_NEST_ROUNDS = 3;

/** Cost bound on the called-line nests: only the heaviest river textures are solved (the
 *  weighted mean renormalises over them, as multiwaySolver's NEST_BUCKETS) at half the
 *  check line's iterations — a future value is an average, so per-solve noise washes out. */
const FUTURE_NEST_BUCKETS = 8;
const futureIters = (riverIters: number) => Math.max(60, Math.round(riverIters / 2));

const everyRiver = (board4: Card[]): { card: Card; weight: number }[] => {
  const out: { card: Card; weight: number }[] = [];
  for (let rank = 2; rank <= 14; rank++)
    for (let suit = 0; suit < 4; suit++)
      if (!board4.some((c) => id(c) === rank * 4 + suit)) out.push({ card: { rank, suit }, weight: 1 });
  return out;
};

/** Hero value per (hero, villain) matchup of a river subgame at `pot`, averaged over every
 *  river card neither hand blocks — or, with `bucketed`, over one representative per river
 *  texture (cardTexture.ts), the flop solver's abstraction one street later; it is what keeps
 *  the called-line nests affordable. NaN where no river was solvable. */
export function nestedRiverPairEv(
  H: Combo[],
  V: Combo[],
  board4: Card[],
  pot: number,
  effStack: number,
  betSizes: number[],
  riverIters: number,
  villainLock?: VillainNodeLock,
  rake?: Rake,
  villainMayRaise?: boolean,
  bucketed = false,
  villainMayStab?: boolean,
  heroMayCheckRaise?: boolean,
): Float64Array[] {
  const nV = V.length;
  const acc = H.map(() => new Float64Array(nV));
  const cnt = H.map(() => new Float64Array(nV));
  const rivers = bucketed
    ? [...textureBuckets(board4)].sort((a, b) => b.weight - a.weight).slice(0, FUTURE_NEST_BUCKETS)
    : everyRiver(board4);
  for (const { card: river, weight } of rivers) {
    const rid = id(river);
    const blocks = (c: Combo) => id(c.cards[0]) === rid || id(c.cards[1]) === rid;
    const hMap = H.map((_, i) => i).filter((i) => !blocks(H[i]));
    const vMap = V.map((_, j) => j).filter((j) => !blocks(V[j]));
    if (!hMap.length || !vMap.length) continue;
    const res = solveRiver({
      heroRange: hMap.map((i) => H[i]),
      villainRange: vMap.map((j) => V[j]),
      board: [...board4, river],
      pot,
      effStack,
      betSizes,
      iterations: riverIters,
      villainLock,
      rake,
      villainMayRaise,
      villainMayStab,
      heroMayCheckRaise,
      wantPairEv: true,
    });
    hMap.forEach((i, k) =>
      vMap.forEach((j, l) => {
        if (conflict(H[i], V[j])) return;
        acc[i][j] += weight * res.pairEv![k][l];
        cnt[i][j] += weight;
      }),
    );
  }
  return acc.map((row, i) => row.map((v, j) => (cnt[i][j] > 0 ? v / cnt[i][j] : NaN)));
}

/** ½ previous + ½ new, per (size, hero, villain): the damping that stops the rounds oscillating. */
export const dampFuture = (prev: Float64Array[][], next: Float64Array[][]): Float64Array[][] =>
  next.map((rows, s) => rows.map((row, i) => row.map((v, j) => 0.5 * (prev[s][i][j] + v))));

/** Fills every live size's future from the solved reference sizes, linear in the bet. */
export function interpolateFuture(
  fut: Float64Array[][],
  solved: Map<number, Float64Array[]>,
  refs: number[],
  live: number[],
  bets: number[],
): void {
  const lo = solved.get(refs[0])!;
  const hi = solved.get(refs[refs.length - 1])!;
  const span = bets[refs[refs.length - 1]] - bets[refs[0]];
  for (const s of live) {
    const own = solved.get(s);
    const t = span > 0 ? (bets[s] - bets[refs[0]]) / span : 0;
    fut[s].forEach((row, i) => {
      for (let j = 0; j < row.length; j++) row[j] = own ? own[i][j] : lo[i][j] + t * (hi[i][j] - lo[i][j]);
    });
  }
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
  // VILLAIN MAY RAISE hero's bet (see riverSolver — without it a bluff is priced risk-free
  // and hero is never taught to bet-fold). Same single raise size, and a locked villain still
  // raises the strong end of what he keeps.
  const mayRaise = inp.villainMayRaise !== false;
  const raiseTo = villainRaiseSizes(P, inp.effStack, bets);
  const canRaise = bets.map((b, s) => mayRaise && raiseTo[s] > b);
  const lockedCont = inp.villainLock
    ? lockedContinueBySize(inp.villainLock.foldToBet, bets.map((b) => b / P))
    : null;
  const locked =
    lockedCont && villEqVsHero
      ? bets.map((_, s) =>
          canRaise[s]
            ? locked3BetPolicy(V.map((c) => c.w), villEqVsHero!, lockedCont[s])
            : lockedThresholdPolicy(V.map((c) => c.w), villEqVsHero!, lockedCont[s]),
        )
      : null;

  // Per-combo valid villain weight: the CFR scores actions as villain-weight SUMS, the
  // reported per-combo EVs divide it back out.
  const vwSum = H.map((_, i) => V.reduce((a, c, j) => a + (valid[i][j] ? c.w : 0), 0));
  const netP = netPot(inp.rake, P);
  const staticPair = (i: number, j: number) => eq[i][j] * netP;
  const riverIters = inp.riverNestIterations ?? 200;
  const nestedFutureAt = (hw: number[], vw: number[], pot: number, stack: number): Float64Array[] => {
    const Hs = H.map((c, i) => ({ cards: c.cards, w: c.w * (hw[i] + REACH_FLOOR) }));
    const Vs = V.map((c, j) => ({ cards: c.cards, w: c.w * (vw[j] + REACH_FLOOR) }));
    const nested = nestedRiverPairEv(Hs, Vs, inp.board, pot, stack, inp.betSizes, futureIters(riverIters), inp.villainLock, inp.rake, inp.villainMayRaise, true, inp.villainMayStab, inp.heroMayCheckRaise);
    const np = netPot(inp.rake, pot);
    return nested.map((row, i) => row.map((v, j) => (valid[i][j] && Number.isFinite(v) ? v - eq[i][j] * np : 0)));
  };
  // CHECK-CHECK value per matchup: a real river subgame at pot P (full ranges — a disclosed
  // approximation, the checking ranges are strategy-dependent), else the static showdown.
  const checkPair: Float64Array[] =
    inp.nestRiverForCheck !== false
      ? nestedRiverPairEv(H, V, inp.board, P, inp.effStack, inp.checkLineBetSizes ?? inp.betSizes, riverIters, inp.villainLock, inp.rake, inp.villainMayRaise, false, inp.villainMayStab, inp.heroMayCheckRaise).map(
          (row, i) => row.map((v, j) => (Number.isFinite(v) ? v : staticPair(i, j))),
        )
      : H.map((_, i) => Float64Array.from(V, (_, j) => staticPair(i, j)));

  // VILLAIN STAB: after hero checks the turn villain checks back or bets `stab`; hero folds
  // calls or check-raises. Without it a turn check was a free river card for hero.
  const stab = inp.villainMayStab !== false ? Math.min(inp.effStack, Math.round(STAB_FRAC * P)) : 0;
  const canStab = stab > 0;
  const netStab = netPot(inp.rake, P + 2 * stab);
  const villStabFoldWin = P - rakeOn(inp.rake, P + stab);
  const heroStabCall = (i: number, j: number, futStab: Float64Array[] | null) =>
    eq[i][j] * netStab - stab + (futStab ? futStab[i][j] : 0);
  // HERO CHECK-RAISE of the stab (villain's raise formula), villain folds or calls. The called
  // check-raise borrows the stab-called future scaled by called pot — a disclosed abstraction,
  // the same one the bet-raise line uses — and none when the check-raise is all-in.
  const crTo = canStab && inp.heroMayCheckRaise !== false ? villainRaiseSizes(P, inp.effStack, [stab])[0] : 0;
  const canCR = crTo > stab;
  const nHC = canCR ? 3 : 2;
  const netCR = netPot(inp.rake, P + 2 * crTo);
  const heroCRFoldWin = P + stab - rakeOn(inp.rake, P + stab + crTo);
  const crFutScale = inp.effStack > crTo ? (P + 2 * crTo) / (P + 2 * stab) : 0;
  const heroCRCall = (i: number, j: number, futStab: Float64Array[] | null) =>
    eq[i][j] * netCR - crTo + (futStab ? futStab[i][j] * crFutScale : 0);
  const heroAfterStab = (i: number, j: number, hc: number[], vcr: number[], futStab: Float64Array[] | null) =>
    hc[1] * heroStabCall(i, j, futStab) +
    (canCR ? hc[2] * (vcr[0] * heroCRFoldWin + vcr[1] * heroCRCall(i, j, futStab)) : 0);
  const villAfterStab = (i: number, j: number, hc: number[], vcr: number[], futStab: Float64Array[] | null) =>
    hc[0] * villStabFoldWin +
    hc[1] * (netStab - 2 * stab - heroStabCall(i, j, futStab)) +
    (canCR ? hc[2] * (-vcr[0] * stab + vcr[1] * (netCR - 2 * crTo - heroCRCall(i, j, futStab))) : 0);

  // Terminal pots per bet size, precomputed: showdown at size s puts P + 2·b in the middle,
  // a fold leaves P + b. Hoisted out of the CFR loops — these are the innermost lines of the
  // whole solve, so a per-leaf function call costs whole seconds. Rake comes off the pot
  // collected, never off the chips invested (a loser pays no rake).
  const netAtBet = bets.map((b) => netPot(inp.rake, P + 2 * b));
  const foldWinBet = bets.map((b) => P - rakeOn(inp.rake, P + b));
  // ...and the raise branch: a showdown at raiseTo, or hero folding for just his bet.
  const netAtRaise = raiseTo.map((x) => netPot(inp.rake, P + 2 * x));
  const villRaiseFoldWin = bets.map((b, s) => P + b - rakeOn(inp.rake, P + b + raiseTo[s]));

  // `fut` = later-street value of the CALLED line per (size, hero combo, villain combo): added to hero's
  // called payoff and taken off villain's, so the game stays zero-sum.
  const cfrPass = (
    passIters: number,
    fut: Float64Array[][] | null,
    futStab: Float64Array[] | null,
    futRaise: Float64Array[][] | null,
  ) => {
    const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
    const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
    const regretV = canRaise.map((r) => Array.from({ length: nV }, () => new Array(r ? 3 : 2).fill(0)));
    const stratSumV = canRaise.map((r) => Array.from({ length: nV }, () => new Array(r ? 3 : 2).fill(0)));
    // hero facing villain's raise of size s: [fold, call]
    const regretH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));
    const stratSumH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));
    const regretVC = Array.from({ length: nV }, () => [0, 0]);
    const stratSumVC = Array.from({ length: nV }, () => [0, 0]);
    const regretHC = Array.from({ length: nH }, () => new Array(nHC).fill(0));
    const stratSumHC = Array.from({ length: nH }, () => new Array(nHC).fill(0));
    const regretVCR = Array.from({ length: nV }, () => [0, 0]);
    const stratSumVCR = Array.from({ length: nV }, () => [0, 0]);

    for (let t = 0; t < passIters; t++) {
      const hS = regretH.map(strat);
      const vS = locked ?? regretV.map((row) => row.map(strat));
      const hS2 = regretH2.map((rows) => rows.map(strat));
      const vcS = canStab ? regretVC.map(strat) : null;
      const hcS = canStab ? regretHC.map(strat) : null;
      const vcrS = regretVCR.map(strat);

      // the check line: villain checks back or stabs (solved even when locked — the lock pins
      // his answer to hero's BET), hero folds or calls the stab.
      if (vcS && hcS) {
        for (let i = 0; i < nH; i++) {
          let aCall = 0;
          let aRaise = 0;
          for (let j = 0; j < nV; j++) {
            if (!valid[i][j]) continue;
            const reach = V[j].w * vcS[j][1];
            if (reach === 0) continue;
            aCall += reach * heroStabCall(i, j, futStab);
            if (canCR) aRaise += reach * (vcrS[j][0] * heroCRFoldWin + vcrS[j][1] * heroCRCall(i, j, futStab));
          }
          const st = hcS[i];
          const node = st[1] * aCall + (canCR ? st[2] * aRaise : 0);
          const cf = H[i].w;
          regretHC[i][0] += cf * -node;
          regretHC[i][1] += cf * (aCall - node);
          if (canCR) regretHC[i][2] += cf * (aRaise - node);
          for (let a = 0; a < nHC; a++) stratSumHC[i][a] += cf * st[a];
        }
        if (canCR)
          for (let j = 0; j < nV; j++) {
            let vFold = 0;
            let vCall = 0;
            for (let i = 0; i < nH; i++) {
              if (!valid[i][j]) continue;
              const reach = H[i].w * hS[i][0] * hcS[i][2];
              if (reach === 0) continue;
              vFold -= reach * stab;
              vCall += reach * (netCR - 2 * crTo - heroCRCall(i, j, futStab));
            }
            const st = vcrS[j];
            const node = st[0] * vFold + st[1] * vCall;
            const cf = V[j].w;
            regretVCR[j][0] += cf * (vFold - node);
            regretVCR[j][1] += cf * (vCall - node);
            stratSumVCR[j][0] += cf * vcS[j][1] * st[0];
            stratSumVCR[j][1] += cf * vcS[j][1] * st[1];
          }
        for (let j = 0; j < nV; j++) {
          let vCheck = 0;
          let vBet = 0;
          for (let i = 0; i < nH; i++) {
            if (!valid[i][j]) continue;
            const reach = H[i].w * hS[i][0];
            if (reach === 0) continue;
            vCheck += reach * (netP - checkPair[i][j]);
            vBet += reach * villAfterStab(i, j, hcS[i], vcrS[j], futStab);
          }
          const st = vcS[j];
          const node = st[0] * vCheck + st[1] * vBet;
          const cf = V[j].w;
          regretVC[j][0] += cf * (vCheck - node);
          regretVC[j][1] += cf * (vBet - node);
          stratSumVC[j][0] += cf * st[0];
          stratSumVC[j][1] += cf * st[1];
        }
      }

      // hero's response to the raise: give up the bet, or call for a showdown at raiseTo.
      for (let s = 0; s < nSizes; s++) {
        if (!canRaise[s]) continue;
        const b = bets[s];
        const nx = netAtRaise[s];
        const x = raiseTo[s];
        for (let i = 0; i < nH; i++) {
          let aFold = 0;
          let aCall = 0;
          for (let j = 0; j < nV; j++) {
            if (!valid[i][j]) continue;
            const reach = V[j].w * vS[s][j][2];
            if (reach === 0) continue;
            aFold += reach * -b;
            aCall += reach * (eq[i][j] * nx - x + (futRaise ? futRaise[s][i][j] : 0));
          }
          const st = hS2[s][i];
          const node = st[0] * aFold + st[1] * aCall;
          const cf = H[i].w;
          regretH2[s][i][0] += cf * (aFold - node);
          regretH2[s][i][1] += cf * (aCall - node);
          stratSumH2[s][i][0] += cf * st[0];
          stratSumH2[s][i][1] += cf * st[1];
        }
      }

      // villain regret update — skipped when locked (his strategy is fixed to the read).
      if (!locked) for (let s = 0; s < nSizes; s++) {
        const b = bets[s];
        const nb = netAtBet[s];
        const nx = netAtRaise[s];
        const x = raiseTo[s];
        const vrf = villRaiseFoldWin[s];
        const raises = canRaise[s];
        const futS = fut ? fut[s] : null;
        for (let j = 0; j < nV; j++) {
          const vFold = 0;
          let vCall = 0;
          let vRaise = 0;
          for (let i = 0; i < nH; i++) {
            if (!valid[i][j]) continue;
            const reach = H[i].w * hS[i][1 + s];
            if (reach === 0) continue;
            vCall += reach * ((1 - eq[i][j]) * nb - b - (futS ? futS[i][j] : 0));
            if (raises) {
              const h2 = hS2[s][i];
              vRaise += reach * (h2[0] * vrf + h2[1] * ((1 - eq[i][j]) * nx - x - (futRaise ? futRaise[s][i][j] : 0)));
            }
          }
          const st = vS[s][j];
          const node = st[0] * vFold + st[1] * vCall + (raises ? st[2] * vRaise : 0);
          const cf = V[j].w;
          regretV[s][j][0] += cf * (vFold - node);
          regretV[s][j][1] += cf * (vCall - node);
          stratSumV[s][j][0] += cf * st[0];
          stratSumV[s][j][1] += cf * st[1];
          if (raises) {
            regretV[s][j][2] += cf * (vRaise - node);
            stratSumV[s][j][2] += cf * st[2];
          }
        }
      }

      for (let i = 0; i < nH; i++) {
        const av = new Array(nHeroActions).fill(0);
        let vCheck = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          vCheck += V[j].w * (vcS && hcS ? vcS[j][0] * checkPair[i][j] + vcS[j][1] * heroAfterStab(i, j, hcS[i], vcrS[j], futStab) : checkPair[i][j]);
        }
        av[0] = vCheck;
        for (let s = 0; s < nSizes; s++) {
          const b = bets[s];
          const nb = netAtBet[s];
          const fw = foldWinBet[s];
          const nx = netAtRaise[s];
          const x = raiseTo[s];
          const h2 = hS2[s][i];
          const raises = canRaise[s];
          const fi = fut ? fut[s][i] : null;
          let vBet = 0;
          for (let j = 0; j < nV; j++) {
            if (!valid[i][j]) continue;
            const vs = vS[s][j];
            const afterRaise = raises ? vs[2] * (h2[0] * -b + h2[1] * (eq[i][j] * nx - x + (futRaise ? futRaise[s][i][j] : 0))) : 0;
            vBet += V[j].w * (vs[0] * fw + vs[1] * (eq[i][j] * nb - b + (fi ? fi[j] : 0)) + afterRaise);
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
    return { stratSumH, stratSumV, stratSumH2, stratSumVC, stratSumHC, stratSumVCR };
  };

  // CALLED-LINE NESTING. A static called line ends the hand at the turn, so a bet earned one
  // street of value while a check (nested river) earned two — the solve checked the nuts and
  // under-barrelled. A first pass fixes who bets and who calls, the river is solved at the
  // called pot over THOSE ranges, and the final pass re-solves with that value priced in.
  // One round is not enough: the static first pass under-bluffs, so the nested villain folds
  // every river and air gets phantom future value. A second round re-nests over the corrected
  // ranges (measured on a static toy: nuts EV 252 → ~225, the exact two-street value).
  // The stab-called line gets the same treatment, so neither side's later streets are free.
  let fut: Float64Array[][] | null = null;
  let futStab: Float64Array[] | null = null;
  let futRaise: Float64Array[][] | null = null;
  const live = bets.map((_, s) => s).filter((s) => inp.effStack - bets[s] > 0);
  if (inp.nestRiverForCall !== false && (live.length || (canStab && inp.effStack > stab))) {
    const refs = live.length <= 2 ? live : [live[0], live[live.length - 1]];
    // Round 0 nests over the FULL ranges, like the check line: conditioning on a static first
    // pass handed air phantom value (that pass under-bluffs, so the nested villain over-folds).
    // Later rounds condition on the previous pass and DAMP ½ old + ½ new — undamped, the
    // future ↔ strategy map oscillates and the answer depended on the round count's parity.
    const rounds = inp.calledNestRounds ?? CALLED_NEST_ROUNDS;
    const all = (n: number) => new Array(n).fill(1);
    for (let round = 0; round < rounds; round++) {
      const pass = round === 0 ? null : cfrPass(Math.max(150, Math.round(iters / 4)), fut, futStab, futRaise);
      const heroStrat = pass ? pass.stratSumH.map(normalized) : null;
      if (live.length) {
        const solved = new Map<number, Float64Array[]>();
        for (const s of refs) {
          const villCall = locked
            ? V.map((_, j) => locked[s][j][1])
            : pass ? V.map((_, j) => normalized(pass.stratSumV[s][j])[1]) : all(nV);
          const heroBets = heroStrat ? heroStrat.map((r) => r[1 + s]) : all(nH);
          solved.set(s, nestedFutureAt(heroBets, villCall, P + 2 * bets[s], inp.effStack - bets[s]));
        }
        const next = bets.map(() => H.map(() => new Float64Array(nV)));
        interpolateFuture(next, solved, refs, live, bets);
        fut = fut ? dampFuture(fut, next) : next;
      }
      // The RAISE-called line too: left static, raising denied hero the next street for free and
      // villain raised ~30% to escape it. Solved once, last round, at one reference raise; the
      // other sizes scale its future by called pot (disclosed, like the interpolation above).
      const raiseLive = bets.map((_, s) => s).filter((s) => canRaise[s] && inp.effStack - raiseTo[s] > 0);
      if (raiseLive.length && round === rounds - 1) {
        const r = raiseLive[Math.floor(raiseLive.length / 2)];
        const heroCallsRaise = heroStrat && pass
          ? heroStrat.map((row, i) => row[1 + r] * normalized(pass.stratSumH2[r][i])[1])
          : all(nH);
        const villRaises = locked ? V.map((_, j) => locked[r][j][2] ?? 0) : pass ? V.map((_, j) => normalized(pass.stratSumV[r][j])[2] ?? 0) : all(nV);
        const ref = nestedFutureAt(heroCallsRaise, villRaises, P + 2 * raiseTo[r], inp.effStack - raiseTo[r]);
        const next = bets.map((_, s) =>
          raiseLive.includes(s) ? ref.map((row) => row.map((v) => (v * (P + 2 * raiseTo[s])) / (P + 2 * raiseTo[r]))) : H.map(() => new Float64Array(nV)),
        );
        futRaise = next;
      }
      // the stab-called future only moves the check line; solving it once, last, is enough
      if (canStab && inp.effStack > stab && round === rounds - 1) {
        const heroCalls = heroStrat && pass ? heroStrat.map((r, i) => r[0] * normalized(pass.stratSumHC[i])[1]) : all(nH);
        const villStabs = pass ? pass.stratSumVC.map((c) => normalized(c)[1]) : all(nV);
        futStab = nestedFutureAt(heroCalls, villStabs, P + 2 * stab, inp.effStack - stab);
      }
    }
  }
  const { stratSumH, stratSumV, stratSumH2, stratSumVC, stratSumHC, stratSumVCR } = cfrPass(iters, fut, futStab, futRaise);
  const vcFinal = stratSumVC.map(normalized);
  const hcFinal = stratSumHC.map(normalized);
  const vcrFinal = stratSumVCR.map(normalized);
  const checkValue = (i: number, j: number) =>
    canStab ? vcFinal[j][0] * checkPair[i][j] + vcFinal[j][1] * heroAfterStab(i, j, hcFinal[i], vcrFinal[j], futStab) : checkPair[i][j];

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
        const tot = c.reduce((a, v) => a + v, 0);
        return tot > 0 ? c.map((v) => v / tot) : c.map(() => 1 / c.length);
      }),
    );
  const h2Final = stratSumH2.map((rows) =>
    rows.map((c) => {
      const tot = c[0] + c[1];
      return tot > 0 ? [c[0] / tot, c[1] / tot] : [0.5, 0.5];
    }),
  );
  const heroActionEv: number[][] = [];
  for (let i = 0; i < nH; i++) {
    const av = new Array(nHeroActions).fill(0);
    const vw = vwSum[i];
    const inv = vw > 0 ? 1 / vw : 0;
    let ck = 0;
    for (let j = 0; j < nV; j++) if (valid[i][j]) ck += V[j].w * checkValue(i, j);
    av[0] = ck * inv;
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      const nb = netAtBet[s];
      const fw = foldWinBet[s];
      const nx = netAtRaise[s];
      const x = raiseTo[s];
      const h2 = h2Final[s][i];
      const raises = canRaise[s];
      const fi = fut ? fut[s][i] : null;
      let bt = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vFinal[s][j];
        const afterRaise = raises ? vs[2] * (h2[0] * -b + h2[1] * (eq[i][j] * nx - x + (futRaise ? futRaise[s][i][j] : 0))) : 0;
        bt += V[j].w * (vs[0] * fw + vs[1] * (eq[i][j] * nb - b + (fi ? fi[j] : 0)) + afterRaise);
      }
      av[1 + s] = bt * inv;
    }
    heroActionEv.push(av);
  }
  const freqOf = (a: number) =>
    vFinal.map((sr) => {
      let cw = 0;
      let cc = 0;
      for (let j = 0; j < nV; j++) {
        cw += V[j].w;
        cc += (sr[j][a] ?? 0) * V[j].w;
      }
      return cw > 0 ? cc / cw : 0;
    });
  const villainCallFreq = freqOf(1);
  const villainRaiseFreq = freqOf(2);
  const heroFoldToRaiseFreq = bets.map((_, s) => {
    if (!canRaise[s]) return 0;
    let acc = 0;
    let w = 0;
    for (let i = 0; i < nH; i++) {
      acc += H[i].w * h2Final[s][i][0];
      w += H[i].w;
    }
    return w > 0 ? acc / w : 0;
  });

  const pairEv = inp.wantPairEv
    ? H.map((_, i) => {
        const row = new Float64Array(nV);
        const hs = heroStrategy[i];
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          let v = hs[0].freq * checkValue(i, j);
          for (let s = 0; s < nSizes; s++) {
            const vs = vFinal[s][j];
            const h2 = h2Final[s][i];
            const fij = fut ? fut[s][i][j] : 0;
            const afterRaise = canRaise[s]
              ? vs[2] * (h2[0] * -bets[s] + h2[1] * (eq[i][j] * netAtRaise[s] - raiseTo[s] + (futRaise ? futRaise[s][i][j] : 0)))
              : 0;
            v += hs[1 + s].freq * (vs[0] * foldWinBet[s] + vs[1] * (eq[i][j] * netAtBet[s] - bets[s] + fij) + afterRaise);
          }
          row[j] = v;
        }
        return row;
      })
    : undefined;

  return {
    heroStrategy,
    actions,
    heroActionEv,
    villainCallFreq,
    villainRaiseFreq,
    villainContinueFreq: villainCallFreq.map((c, s) => c + villainRaiseFreq[s]),
    heroRaiseResponse: h2Final,
    heroFoldToRaiseFreq,
    pairEv,
    stabSize: stab,
    villainStabStrategy: canStab ? vcFinal : undefined,
    heroStabResponse: canStab ? hcFinal : undefined,
    villainStabFreq: canStab ? V.reduce((a, c, j) => a + c.w * vcFinal[j][1], 0) / (V.reduce((a, c) => a + c.w, 0) || 1) : 0,
    heroFoldToStabFreq: canStab ? H.reduce((a, c, i) => a + c.w * hcFinal[i][0], 0) / (H.reduce((a, c) => a + c.w, 0) || 1) : 0,
    checkRaiseTo: canCR ? crTo : 0,
    villainCheckRaiseResponse: canCR ? vcrFinal : undefined,
    heroCheckRaiseFreq: canCR ? H.reduce((a, c, i) => a + c.w * hcFinal[i][2], 0) / (H.reduce((a, c) => a + c.w, 0) || 1) : 0,
    villainFoldToCheckRaiseFreq: canCR ? V.reduce((a, c, j) => a + c.w * vcrFinal[j][0], 0) / (V.reduce((a, c) => a + c.w, 0) || 1) : 0,
  };
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
  raiseSizes: number[]; // hero's raise-TO totals in chips
  threeBetTo?: number[]; // villain's re-raise total per raise size
  iterations?: number;
  /** NODE LOCK: villain's ¾-pot-referenced fold-to-bet read pins his response to hero's
   *  raise (see vsBet.ts). Omit for the equilibrium baseline. */
  villainFoldToBet?: number;
  /** …superseded by a MEASURED fold-to-raise when the hero has one (see vsBet.ts). */
  villainFoldToRaise?: number;
  /** house rake in chips. Omit for rake-free EV. */
  rake?: Rake;
  /** Chips behind after hero calls. > 0 nests the next street on the CALLED line (a call is
   *  not the end of the hand: he can barrel, you can bet). 0 / omitted = static equity. */
  stackAfterCall?: number;
  /** Does hero act first on the next street (default true — out of position)? */
  heroActsFirst?: boolean;
}

// The CALLED line of a facing-a-bet node plays the next street: a nested hero-first (or, in
// position, villain-first with the roles swapped and the value negated) solve at the called
// pot over hero's CALLING range vs villain's betting range, minus the static equity baseline.
// Round 0 nests over hero's full range, then once more over the first pass's calls, damped
// ½/½ (the hero-first lines' rule). The raise lines borrow it scaled by pot (vsBet.ts).
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
  const base = {
    eq,
    valid,
    heroW: H.map((c) => c.w),
    villW: V.map((c) => c.w),
    potBeforeBet: inp.potBeforeBet,
    bet: inp.bet,
    raiseSizes: inp.raiseSizes,
    threeBetTo: inp.threeBetTo,
    iterations: inp.iterations,
    villainFoldToBet: inp.villainFoldToBet,
    villainFoldToRaise: inp.villainFoldToRaise,
    rake: inp.rake,
  };
  const behind = inp.stackAfterCall ?? 0;
  if (behind <= 0) return solveVsBetEquity(base);
  const pot = inp.potBeforeBet + 2 * inp.bet;
  const np = netPot(inp.rake, pot);
  const riverIters = 100;
  const futureFor = (callW: number[]): Float64Array[] => {
    const Hs = H.map((c, i) => ({ cards: c.cards, w: c.w * (callW[i] + REACH_FLOOR) }));
    if (inp.heroActsFirst !== false) {
      const n = nestedRiverPairEv(Hs, V, inp.board, pot, behind, VS_BET_NEXT_SIZES, riverIters, undefined, inp.rake, undefined, true);
      return n.map((row, i) => row.map((v, j) => (valid[i][j] && Number.isFinite(v) ? v - eq[i][j] * np : 0)));
    }
    const n = nestedRiverPairEv(V, Hs, inp.board, pot, behind, VS_BET_NEXT_SIZES, riverIters, undefined, inp.rake, undefined, true);
    return H.map((_, i) =>
      Float64Array.from(V, (_, j) => (valid[i][j] && Number.isFinite(n[j][i]) ? (1 - eq[i][j]) * np - n[j][i] : 0)),
    );
  };
  return solveVsBetWithFuture(base, behind, futureFor);
}

/** Base grid for the nested next street of a called line. */
export const VS_BET_NEXT_SIZES = [0.33, 0.5, 0.75, 1.0];

/** Round 0 over hero's full range, round 1 over the first pass's calls, damped ½/½. */
export function solveVsBetWithFuture(
  base: Parameters<typeof solveVsBetEquity>[0],
  behind: number,
  futureFor: (callW: number[]) => Float64Array[],
): VsBetResult {
  const f0 = futureFor(base.heroW.map(() => 1));
  const first = solveVsBetEquity({ ...base, callFuture: f0, stackAfterCall: behind, iterations: Math.max(300, Math.round((base.iterations ?? 1200) / 3)) });
  const f1 = futureFor(first.heroStrategy.map((s) => s.call));
  const callFuture = f0.map((row, i) => row.map((v, j) => 0.5 * (v + f1[i][j])));
  return solveVsBetEquity({ ...base, callFuture, stackAfterCall: behind });
}
