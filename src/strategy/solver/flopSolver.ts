// Range-vs-range FLOP solver (Tier-2, Stage 3). The flop has TWO chance layers — the
// turn card and the river card — so it is the heaviest street to solve. Same hero-first
// betting tree as the turn/river (check / bet-sizes → villain fold/call), but the two
// unknown streets are handled by NESTING the turn solver:
//
//   - CHECK line: a real TURN subgame per turn card (solveTurn as the leaf evaluator),
//     so a check realises its future betting value instead of being scored as give-up —
//     the same over-betting fix turnSolver applies for the river (nestRiverForCheck).
//   - BET-call line: static showdown using hero's equity over every turn+river runout,
//     enumerated exactly (mirrors turnSolver scoring its bet-call line by river-equity).
//
// TRACTABILITY (design doc §5, Stage 3). Enumerating a turn subgame for all ~45 turn
// cards — each of which itself enumerates ~44 rivers — is far too slow to run live. The
// turn cards are BUCKETED by strategic texture (which board card it pairs / brings a flush
// draw or completes one / rank tier / straight coordination — see textureBuckets) and one
// representative per bucket is solved, weighted by the
// bucket's size. The nested turn solves run with nestRiverForCheck:false (their own check
// is a static river showdown) so the recursion is two CFR layers deep, not three. This is
// a DISCLOSED abstraction, not a solver-exact flop solve — matching the app's teaching
// intent; the adapter surfaces it in the node note.

import { type Card, evaluate7 } from '@/engine/cards';


import { solveTurn, interpolateFuture, dampFuture, normalized, CALLED_NEST_ROUNDS, REACH_FLOOR, solveVsBetWithFuture, VS_BET_NEXT_SIZES } from './turnSolver';
import { solveVsBetEquity, type VsBetResult } from './vsBet';
import { textureBuckets } from './cardTexture';
import { villainRaiseSizes, STAB_FRAC, type Combo } from './riverSolver';
import { netPot, rakeOn, type Rake } from '@/engine/table';


export interface FlopInput {
  heroRange: Combo[];
  villainRange: Combo[];
  board: Card[]; // exactly 3 (flop)
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot
  iterations?: number;
  /** Nest a real turn subgame on the CHECK line instead of scoring a check as a static
   *  two-street showdown. Default true — this is what stops the solver over-betting. */
  nestTurnForCheck?: boolean;
  /** CFR iterations for each nested per-turn-bucket turn solve (default 260). */
  turnNestIterations?: number;
  /** Nest a turn subgame on the bet-CALLED line too (default true). Off = a static two-street
   *  showdown, which under-values betting the flop. */
  nestTurnForCall?: boolean;
  /** pass → nest rounds before the final pass (default CALLED_NEST_ROUNDS). */
  calledNestRounds?: number;
  /** May villain bet when hero checks the flop (default true)? See riverSolver STAB_FRAC. */
  villainMayStab?: boolean;
  /** May hero CHECK-RAISE villain's bet into his check (default true)? Rides into the nested
   *  subgames. Off = hero only folds or calls, so villain's stabs can never be punished. */
  heroMayCheckRaise?: boolean;
  /** house rake in chips; rides into the nested turn subgames too. Omit for rake-free EV. */
  rake?: Rake;
  /** May villain RAISE hero's bet (default true)? See riverSolver — off prices every bluff as
   *  risk-free. Rides into the nested turn subgames so both streets model the same tree. */
  villainMayRaise?: boolean;
}

export interface FlopResult {
  heroStrategy: { action: string; freq: number }[][];
  actions: string[];
  heroActionEv: number[][]; // per hero combo, per action (chips)
  villainCallFreq: number[];
  /** raise / continue (= call + raise) frequencies per bet size, and hero's [fold, call]
   *  response to the raise with its range average — the bet-fold decision. */
  villainRaiseFreq?: number[];
  villainContinueFreq?: number[];
  heroRaiseResponse?: number[][][];
  heroFoldToRaiseFreq?: number[];
  /** villain's bet-when-checked-to size, his [check, bet] and hero's [fold, call] per combo,
   *  and their range averages (see riverSolver STAB_FRAC). */
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

/** Hero equity (win + ½tie) vs one villain combo over BOTH remaining streets, enumerated
 *  over every unordered (turn, river) pair that doesn't collide with the flop or either
 *  hand. This is the payoff of the flop bet-call line (a static showdown at the flop pot),
 *  the same approximation turnSolver uses one street later — it ignores turn/river betting
 *  on the bet-call line but is exact on realised equity. */
function equityVsCombo(hero: [Card, Card], vill: [Card, Card], board3: Card[]): number {
  const used = new Set<number>([...board3, hero[0], hero[1], vill[0], vill[1]].map(id));
  const deck: Card[] = [];
  for (let rank = 2; rank <= 14; rank++)
    for (let suit = 0; suit < 4; suit++) if (!used.has(rank * 4 + suit)) deck.push({ rank, suit });
  let win = 0;
  let tie = 0;
  let n = 0;
  for (let t = 0; t < deck.length; t++) {
    for (let r = t + 1; r < deck.length; r++) {
      const h = evaluate7([hero[0], hero[1], ...board3, deck[t], deck[r]]).score;
      const v = evaluate7([vill[0], vill[1], ...board3, deck[t], deck[r]]).score;
      if (h > v) win++;
      else if (h === v) tie++;
      n++;
    }
  }
  return n > 0 ? (win + tie / 2) / n : 0.5;
}

/** Hero value per (hero, villain) matchup of a turn subgame at `pot` (static turn lines — the
 *  recursion bound), averaged over the turn-texture buckets neither hand blocks. */
function nestedTurnPairEv(
  H: Combo[],
  V: Combo[],
  board3: Card[],
  pot: number,
  effStack: number,
  betSizes: number[],
  turnIters: number,
  rake?: Rake,
  maxBuckets = Infinity,
  villainMayStab?: boolean,
  heroMayCheckRaise?: boolean,
): Float64Array[] {
  const nV = V.length;
  const acc = H.map(() => new Float64Array(nV));
  const cnt = H.map(() => new Float64Array(nV));
  const buckets = [...textureBuckets(board3)].sort((a, b) => b.weight - a.weight).slice(0, maxBuckets);
  for (const { card, weight } of buckets) {
    const tid = id(card);
    const blocks = (c: Combo) => id(c.cards[0]) === tid || id(c.cards[1]) === tid;
    const hMap = H.map((_, i) => i).filter((i) => !blocks(H[i]));
    const vMap = V.map((_, j) => j).filter((j) => !blocks(V[j]));
    if (!hMap.length || !vMap.length) continue;
    const res = solveTurn({
      heroRange: hMap.map((i) => H[i]),
      villainRange: vMap.map((j) => V[j]),
      board: [...board3, card],
      pot,
      effStack,
      betSizes,
      iterations: turnIters,
      nestRiverForCheck: false,
      nestRiverForCall: false,
      rake,
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

/** Cost bound on the flop's called-line nests — see turnSolver's FUTURE_NEST_BUCKETS. */
const FUTURE_TURN_BUCKETS = 8;

export function solveFlop(inp: FlopInput): FlopResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const P = inp.pot;
  const iters = inp.iterations ?? 700;
  const bets = inp.betSizes.map((f) => Math.min(inp.effStack, Math.round(f * P))).filter((b) => b > 0);
  const nSizes = bets.length;
  const nHeroActions = 1 + nSizes;
  const nH = H.length;
  const nV = V.length;

  // Equity matrix (hero i vs villain j over all turn+river runouts) + card-removal validity.
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

  const vwSum = H.map((_, i) => V.reduce((a, c, j) => a + (valid[i][j] ? c.w : 0), 0));
  const netP = netPot(inp.rake, P);
  const staticPair = (i: number, j: number) => eq[i][j] * netP;
  const turnIters = inp.turnNestIterations ?? 260;
  const nestedFutureAt = (hw: number[], vw: number[], pot: number, stack: number): Float64Array[] => {
    const Hs = H.map((c, i) => ({ cards: c.cards, w: c.w * (hw[i] + REACH_FLOOR) }));
    const Vs = V.map((c, j) => ({ cards: c.cards, w: c.w * (vw[j] + REACH_FLOOR) }));
    const nested = nestedTurnPairEv(Hs, Vs, inp.board, pot, stack, inp.betSizes, Math.max(80, Math.round(turnIters / 2)), inp.rake, FUTURE_TURN_BUCKETS, inp.villainMayStab, inp.heroMayCheckRaise);
    const np = netPot(inp.rake, pot);
    return nested.map((row, i) => row.map((v, j) => (valid[i][j] && Number.isFinite(v) ? v - eq[i][j] * np : 0)));
  };
  // CHECK-CHECK value per matchup: a turn subgame at pot P over the full ranges (a disclosed
  // approximation), else the static two-street showdown.
  const checkPair: Float64Array[] =
    inp.nestTurnForCheck !== false
      ? nestedTurnPairEv(H, V, inp.board, P, inp.effStack, inp.betSizes, turnIters, inp.rake, Infinity, inp.villainMayStab, inp.heroMayCheckRaise).map((row, i) =>
          row.map((v, j) => (Number.isFinite(v) ? v : staticPair(i, j))),
        )
      : H.map((_, i) => Float64Array.from(V, (_, j) => staticPair(i, j)));

  // VILLAIN STAB after hero checks the flop — see turnSolver.
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

  // VILLAIN MAY RAISE hero's bet (see riverSolver): one raise size, hero then folds his bet
  // or calls for a showdown at that total. Without it a flop bluff is priced risk-free.
  const mayRaise = inp.villainMayRaise !== false;
  const raiseTo = villainRaiseSizes(P, inp.effStack, bets);
  const canRaise = bets.map((b, s) => mayRaise && raiseTo[s] > b);

  // Terminal pots per bet size, precomputed: a showdown at size s holds P + 2·b, a fold
  // P + b. Hoisted out of the CFR loops — these are the innermost lines of the solve, so a
  // per-leaf call costs seconds. Rake comes off the pot collected, not the chips invested.
  const netAtBet = bets.map((b) => netPot(inp.rake, P + 2 * b));
  const foldWinBet = bets.map((b) => P - rakeOn(inp.rake, P + b));
  const netAtRaise = raiseTo.map((x: number) => netPot(inp.rake, P + 2 * x));
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
    const regretH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));
    const stratSumH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));
    const regretVC = Array.from({ length: nV }, () => [0, 0]);
    const stratSumVC = Array.from({ length: nV }, () => [0, 0]);
    const regretHC = Array.from({ length: nH }, () => new Array(nHC).fill(0));
    const stratSumHC = Array.from({ length: nH }, () => new Array(nHC).fill(0));
    const regretVCR = Array.from({ length: nV }, () => [0, 0]);
    const stratSumVCR = Array.from({ length: nV }, () => [0, 0]);

    // hero showdown EV given equity e and both invested inv (uses the flop pot P). The
    // bet-call line is scored as a static showdown at the flop pot — turn/river betting on
    // that line is not modelled (same simplification turnSolver makes one street later).

    for (let t = 0; t < passIters; t++) {
      const hS = regretH.map(strat);
      const vS = regretV.map((row) => row.map(strat));
      const hS2 = regretH2.map((rows) => rows.map(strat));
      const vcS = canStab ? regretVC.map(strat) : null;
      const hcS = canStab ? regretHC.map(strat) : null;
      const vcrS = regretVCR.map(strat);
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

      for (let s = 0; s < nSizes; s++) {
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

  // CALLED-LINE NESTING — see turnSolver's (full-range round 0, then conditioned + damped
  // rounds). Both flop lines nest one turn layer with static turn lines inside — the cost bound.
  let fut: Float64Array[][] | null = null;
  let futStab: Float64Array[] | null = null;
  let futRaise: Float64Array[][] | null = null;
  const live = bets.map((_, s) => s).filter((s) => inp.effStack - bets[s] > 0);
  if (inp.nestTurnForCall !== false && (live.length || (canStab && inp.effStack > stab))) {
    const refs = live.length <= 2 ? live : [live[0], live[live.length - 1]];
    const rounds = inp.calledNestRounds ?? CALLED_NEST_ROUNDS;
    const all = (n: number) => new Array(n).fill(1);
    for (let round = 0; round < rounds; round++) {
      const pass = round === 0 ? null : cfrPass(Math.max(150, Math.round(iters / 4)), fut, futStab, futRaise);
      const heroStrat = pass ? pass.stratSumH.map(normalized) : null;
      if (live.length) {
        const solved = new Map<number, Float64Array[]>();
        for (const s of refs) {
          const villCall = pass ? V.map((_, j) => normalized(pass.stratSumV[s][j])[1]) : all(nV);
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
        const villRaises = pass ? V.map((_, j) => normalized(pass.stratSumV[r][j])[2] ?? 0) : all(nV);
        const ref = nestedFutureAt(heroCallsRaise, villRaises, P + 2 * raiseTo[r], inp.effStack - raiseTo[r]);
        const next = bets.map((_, s) =>
          raiseLive.includes(s) ? ref.map((row) => row.map((v) => (v * (P + 2 * raiseTo[s])) / (P + 2 * raiseTo[r]))) : H.map(() => new Float64Array(nV)),
        );
        futRaise = next;
      }
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
  const vFinal = stratSumV.map((sr) =>
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

  return {
    heroStrategy,
    actions,
    heroActionEv,
    villainCallFreq,
    villainRaiseFreq,
    villainContinueFreq: villainCallFreq.map((c, s) => c + villainRaiseFreq[s]),
    heroRaiseResponse: h2Final,
    heroFoldToRaiseFreq,
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
// FACING A BET on the flop — hero fold / call / raise vs villain's bet. Same tree as the
// river/turn vs-bet, but the equity terminals enumerate BOTH remaining streets
// (equityVsCombo above), so a call/raise is scored on realised two-street equity. Ignores
// turn/river betting on the call line (a static two-street showdown, the same simplification
// solveFlop makes on its bet-call line). Generic CFR in vsBet.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface FlopVsBetInput {
  heroRange: Combo[];
  villainRange: Combo[]; // villain's BETTING range (already conditioned)
  board: Card[]; // exactly 3 (flop)
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

// The CALLED line of a facing-a-bet node plays the turn: a nested hero-first (or, in
// position, villain-first with the roles swapped and the value negated) solve at the called
// pot over hero's CALLING range vs villain's betting range, minus the static equity baseline.
// Round 0 nests over hero's full range, then once more over the first pass's calls, damped
// ½/½ (the hero-first lines' rule). The raise lines borrow it scaled by pot (vsBet.ts).
export function solveFlopVsBet(inp: FlopVsBetInput): VsBetResult {
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
  const turnIters = 110;
  const futureFor = (callW: number[]): Float64Array[] => {
    const Hs = H.map((c, i) => ({ cards: c.cards, w: c.w * (callW[i] + REACH_FLOOR) }));
    if (inp.heroActsFirst !== false) {
      const n = nestedTurnPairEv(Hs, V, inp.board, pot, behind, VS_BET_NEXT_SIZES, turnIters, inp.rake, FUTURE_TURN_BUCKETS);
      return n.map((row, i) => row.map((v, j) => (valid[i][j] && Number.isFinite(v) ? v - eq[i][j] * np : 0)));
    }
    const n = nestedTurnPairEv(V, Hs, inp.board, pot, behind, VS_BET_NEXT_SIZES, turnIters, inp.rake, FUTURE_TURN_BUCKETS);
    return H.map((_, i) =>
      Float64Array.from(V, (_, j) => (valid[i][j] && Number.isFinite(n[j][i]) ? (1 - eq[i][j]) * np - n[j][i] : 0)),
    );
  };
  return solveVsBetWithFuture(base, behind, futureFor);
}
