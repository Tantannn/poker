// Range-vs-range MULTIWAY solver (Tier-2, Stage 4). Full multiway CFR (every player
// optimising at once) is intractable; this approximates a 3-to-5-handed pot by solving hero +
// ONE villain with CFR while the REST OF THE FIELD (1–3 players) follows a FIXED policy —
// they are not strategic agents, so they have no regrets, but they still contest the pot and
// the showdown. The field is a list, so the same solve covers 3-way through 5-way: each extra
// player is one more independent caller to get through, which is exactly why bluffs die
// multiway and thin value bets get worse.
//
// FIXED THIRD-PLAYER POLICY: the third player defends by MDF-by-strength — facing a bet of
// size f it continues with the top 1/(1+f) of its range by made-hand strength (mdf()), and
// checks its whole range to a checked pot. Bigger bets fold out more of the field, exactly
// as a disciplined-but-non-adapting caller would. (When a villain read is available the
// caller could be widened/tightened; v1 stays parameter-free MDF.)
//
// KEY TRACTABILITY TRICK. Hero scoops a contested pot iff he beats EVERY caller. "Beats the
// villain" is a per-(hero,villain) fact the CFR already tracks; "beats the third player"
// marginalises over the third's range+policy into a per-hero scalar (its win-rate vs the
// third's calling range). Treating the two as independent (they are, up to card removal)
// lets the third player collapse into precomputed scalars — so the solve stays O(hero ×
// villain) per iteration plus an O((hero+villain) × third) one-off precompute, NOT
// O(hero × villain × third). The independence is the one modelling approximation; on the
// river (fixed board) it is exact except for third-vs-villain card removal.

import type { Card } from '../../engine/cards';
import { evaluate7 } from '../../engine/evaluator';
import { mdf } from '../../engine/potOdds';
import { lockedContinueBySize, type Combo, type RiverResult } from './riverSolver';
import { netPot, type Rake } from '../../engine/rake';
import { textureBuckets } from './cardTexture';

export interface Multiway3Input {
  heroRange: Combo[];
  villainRange: Combo[]; // the SOLVED opponent
  /** the FIXED-policy opponents, one range each: 1 entry = 3-way, 2 = 4-way, 3 = 5-way */
  fieldRanges: Combo[][];
  board: Card[]; // exactly 5 (river)
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot
  iterations?: number;
  /** READS ON THE FIXED PLAYERS, 0..1, parallel to `fieldRanges` (undefined = no read) —
   *  how often that opponent folds facing a ¾-pot bet. When set, his MDF-by-strength policy
   *  is re-anchored to it (an over-folder defends narrower, a station wider), scaled across
   *  sizes by pot odds — the same ¾-pot-referenced curve the HU node lock uses
   *  (lockedContinueBySize). Omit for the parameter-free MDF default. Only FIXED players'
   *  reads land here; the SOLVED villain carries reads via the per-hand fallback in index.ts. */
  fieldFoldToBet?: (number | undefined)[];
  /** house rake in chips; rides into the nested river subgames too. Omit for rake-free EV. */
  rake?: Rake;
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

/** Per-size call probability for each third-player combo under the MDF-by-strength policy:
 *  facing bet `bets[s]` into `pot`, the top mdf(pot,bet) share of the third's range by
 *  `strength` continues (fractional at the boundary combo), the rest folds. On the river
 *  strength = made-hand score; on the turn it is equity vs the bettor's range (a draw with
 *  the odds continues), so the ranking metric is passed in rather than evaluated here. */
function mdfCallProbs(
  strength: number[],
  weights: number[],
  bets: number[],
  pot: number,
  contBySize?: number[],
): Float64Array[] {
  const order = strength.map((_, i) => i).sort((a, b) => strength[b] - strength[a]); // strongest first
  const totalW = weights.reduce((s, w) => s + w, 0);
  return bets.map((b, s) => {
    const cp = new Float64Array(strength.length);
    // Read-anchored continue share when supplied (a fold-to-bet lock), else parameter-free MDF.
    let target = (contBySize ? contBySize[s] : mdf(pot, b)) * totalW;
    for (const idx of order) {
      if (target <= 0) break;
      const w = weights[idx];
      const take = Math.min(w, target);
      cp[idx] = w > 0 ? take / w : 0;
      target -= take;
    }
    return cp;
  });
}

/** One enumerated caller-set from the fixed field: the chance exactly those players call,
 *  the player's win-rate against all of them (a PRODUCT — the independence approximation),
 *  and how many bets they put in (which sets the pot the winner collects). */
interface FieldOutcome {
  prob: number;
  win: number;
  callers: number;
}

/** Collapse N independent fixed players into the caller sets, per size and player combo.
 *  Zero-probability branches are pruned, so one fixed player yields exactly the {folds,
 *  calls} pair the 3-way solver used before and N players yield at most 2^N. */
function fieldOutcomes(aggs: ThirdAgg[], nSizes: number, nP: number): FieldOutcome[][][] {
  return Array.from({ length: nSizes }, (_, s) =>
    Array.from({ length: nP }, (_, p) => {
      let out: FieldOutcome[] = [{ prob: 1, win: 1, callers: 0 }];
      for (const a of aggs) {
        const pc = a.pTcall[s][p];
        const wc = a.wVsT[s][p];
        const next: FieldOutcome[] = [];
        for (const o of out) {
          if (pc < 1) next.push({ prob: o.prob * (1 - pc), win: o.win, callers: o.callers });
          if (pc > 0) next.push({ prob: o.prob * pc, win: o.win * wc, callers: o.callers + 1 });
        }
        out = next;
      }
      return out;
    }),
  );
}

/** Hero's net chips betting `b` as the lone aggressor, summed over the field's caller sets.
 *  `vs0`/`vs1` are the solved villain's fold/call probabilities and `hv` hero's win-rate vs
 *  that villain combo. Hero scoops only by beating EVERY caller, so each extra caller both
 *  raises the pot and multiplies another win-rate in. */
function betEvVsField(
  field: FieldOutcome[],
  hv: number,
  vs0: number,
  vs1: number,
  b: number,
  netByBets: number[],
): number {
  let acc = 0;
  for (const o of field) {
    // netByBets[m] = what the winner collects from a pot of P + m·b. With no rake it is
    // exactly P + m·b, so this reduces to the raw arithmetic.
    const villainOut = o.callers === 0 ? netByBets[1] - b : o.win * netByBets[o.callers + 1] - b;
    const villainIn = hv * o.win * netByBets[o.callers + 2] - b;
    acc += o.prob * (vs0 * villainOut + vs1 * villainIn);
  }
  return acc;
}

/** The solved villain's net chips CALLING a bet of `b`: hero and villain are both in, so
 *  every caller set adds two bets plus the field's. `vv` = villain's win-rate vs hero. */
function callEvVsField(field: FieldOutcome[], vv: number, b: number, netByBets: number[]): number {
  let acc = 0;
  for (const o of field) acc += o.prob * (vv * o.win * netByBets[o.callers + 2] - b);
  return acc;
}

/** Winner's collect from a pot of P + m·b, for m = 0..maxBets. Precomputed per bet size so
 *  the CFR's innermost lines index a number instead of calling into the rake model. */
function netPotByBets(P: number, b: number, maxBets: number, rake?: Rake): number[] {
  return Array.from({ length: maxBets + 1 }, (_, m) => netPot(rake, P + m * b));
}

interface ThirdAgg {
  pTcall: Float64Array[]; // [size][playerCombo] prob the third player calls
  wVsT: Float64Array[]; // [size][playerCombo] player win-rate vs the third's CALLERS (0.5 if none)
  wVsTfull: Float64Array; // [playerCombo] player win-rate vs the FULL third range (checked pot)
}

/** Collapse the fixed third player into per-player-combo scalars: how often it calls each
 *  size, and the player's win-rate vs its calling range (and vs its full range for a check).
 *  `win(p,m)` = player p's showdown result vs third m in [0,1] (1 win / .5 tie / 0 lose, or
 *  an equity for a street with cards to come). */
function buildThirdAgg(
  players: Combo[],
  third: Combo[],
  callProb: Float64Array[],
  win: (p: number, m: number) => number,
  nSizes: number,
): ThirdAgg {
  const nP = players.length;
  const nT = third.length;
  const pTcall = Array.from({ length: nSizes }, () => new Float64Array(nP));
  const wVsT = Array.from({ length: nSizes }, () => new Float64Array(nP));
  const wVsTfull = new Float64Array(nP);
  for (let p = 0; p < nP; p++) {
    const wpm = new Float64Array(nT); // cache win(p,m)
    for (let m = 0; m < nT; m++) wpm[m] = win(p, m);
    let fullNum = 0;
    let fullDen = 0;
    for (let s = 0; s < nSizes; s++) {
      let callW = 0;
      let callNum = 0;
      let tot = 0;
      for (let m = 0; m < nT; m++) {
        if (conflict(players[p], third[m])) continue;
        const w = third[m].w;
        tot += w;
        const cp = callProb[s][m];
        callW += w * cp;
        callNum += w * cp * wpm[m];
      }
      pTcall[s][p] = tot > 0 ? callW / tot : 0;
      wVsT[s][p] = callW > 0 ? callNum / callW : 0.5;
    }
    for (let m = 0; m < nT; m++) {
      if (conflict(players[p], third[m])) continue;
      const w = third[m].w;
      fullDen += w;
      fullNum += w * wpm[m];
    }
    wVsTfull[p] = fullDen > 0 ? fullNum / fullDen : 0.5;
  }
  return { pTcall, wVsT, wVsTfull };
}

/** The shared multiway CFR, used by every street. Hero picks check / bet-size, the SOLVED
 *  villain answers fold / call, and the fixed field is already collapsed into `aggs`
 *  (buildThirdAgg). Street-agnostic by construction: `hvWin` is an exact showdown win-rate
 *  on the river and hero's EQUITY over the remaining runouts on the turn/flop — the betting
 *  math is identical either way. `checkEv` optionally values the check line as a real nested
 *  subgame instead of a static checkdown (non-finite entries fall back to static). */
function multiwayCfr(p: {
  H: Combo[];
  V: Combo[];
  nField: number;
  pot: number;
  bets: number[]; // chips, already capped at the effective stack
  iterations: number;
  valid: Uint8Array[];
  hvWin: Float64Array[];
  aggsH: ThirdAgg[];
  aggsV: ThirdAgg[];
  rake?: Rake;
  checkEv?: number[];
  /** Extra chips hero earns on a CALLED bet, per hero combo and size — the later-street
   *  betting value a static showdown payoff omits. Only the flop supplies it; see
   *  `calledLineFutureValue` for why leaving it at zero biases the solve against betting. */
  calledBonus?: number[][];
}): RiverResult {
  const { H, V, bets, valid, hvWin, aggsH, aggsV } = p;
  const P = p.pot;
  const iters = p.iterations;
  const nSizes = bets.length;
  const nHeroActions = 1 + nSizes;
  const nH = H.length;
  const nV = V.length;
  const netP = netPot(p.rake, P); // checked-down pot after rake
  const netBySize = bets.map((b) => netPotByBets(P, b, p.nField + 2, p.rake));
  const fieldH = fieldOutcomes(aggsH, nSizes, nH);
  const fieldV = fieldOutcomes(aggsV, nSizes, nV);
  // Checked pot: hero must beat the whole field, so the scoop chance is the product over
  // every fixed player's FULL range (nobody folded — there was no bet to fold to).
  const fullWinH = H.map((_, i) => aggsH.reduce((acc, a) => acc * a.wVsTfull[i], 1));

  // Per-combo check EV (chips) + the villain weight it averages over. The CFR scores actions
  // as villain-weight SUMS, so the per-combo average is rescaled by vwSum in the loop.
  const vwSum = new Array(nH).fill(0);
  const checkAvg = new Array(nH).fill(0);
  for (let i = 0; i < nH; i++) {
    let w = 0;
    let sd = 0;
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      w += V[j].w;
      sd += V[j].w * netP * hvWin[i][j] * fullWinH[i];
    }
    vwSum[i] = w;
    const nested = p.checkEv?.[i];
    checkAvg[i] = nested != null && Number.isFinite(nested) ? nested : w > 0 ? sd / w : 0;
  }

  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const regretV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));
  const stratSumV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(strat);
    const vS = regretV.map((row) => row.map(strat));

    // villain regret (faces each bet size). Villain wins iff it beats hero AND the field.
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      for (let j = 0; j < nV; j++) {
        const fv = fieldV[s][j];
        let vCall = 0;
        for (let i = 0; i < nH; i++) {
          if (!valid[i][j]) continue;
          const reach = H[i].w * hS[i][1 + s];
          if (reach === 0) continue;
          const vv = 1 - hvWin[i][j]; // villain win-rate vs hero (ties → .5)
          vCall += reach * callEvVsField(fv, vv, b, netBySize[s]);
        }
        const st = vS[s][j];
        const node = st[1] * vCall; // fold = 0
        const cf = V[j].w;
        regretV[s][j][0] += cf * (0 - node);
        regretV[s][j][1] += cf * (vCall - node);
        stratSumV[s][j][0] += cf * st[0];
        stratSumV[s][j][1] += cf * st[1];
      }
    }

    // hero regret.
    for (let i = 0; i < nH; i++) {
      const av = new Array(nHeroActions).fill(0);
      av[0] = checkAvg[i] * vwSum[i];
      for (let s = 0; s < nSizes; s++) {
        const b = bets[s];
        const fh = fieldH[s][i];
        const bonus = p.calledBonus?.[i][s] ?? 0;
        let vBet = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const vs = vS[s][j];
          vBet += V[j].w * (betEvVsField(fh, hvWin[i][j], vs[0], vs[1], b, netBySize[s]) + vs[1] * bonus);
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
    const inv = vwSum[i] > 0 ? 1 / vwSum[i] : 0;
    av[0] = checkAvg[i];
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      const fh = fieldH[s][i];
      const bonus = p.calledBonus?.[i][s] ?? 0;
      let vBet = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vFinal[s][j];
        vBet += V[j].w * (betEvVsField(fh, hvWin[i][j], vs[0], vs[1], b, netBySize[s]) + vs[1] * bonus);
      }
      av[1 + s] = vBet * inv;
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

  const actionEv: Record<string, number> = {};
  let hw = 0;
  for (let i = 0; i < nH; i++) hw += H[i].w;
  for (let a = 0; a < nHeroActions; a++) {
    let ev = 0;
    for (let i = 0; i < nH; i++) ev += H[i].w * heroActionEv[i][a];
    actionEv[actions[a]] = hw > 0 ? ev / hw : 0;
  }

  return { heroStrategy, actions, actionEv, heroActionEv, villainCallFreq };
}

/** Bet sizes in chips for a multiway node, capped at the effective stack. */
function betChips(inp: { betSizes: number[]; effStack: number; pot: number }): number[] {
  return inp.betSizes.map((f) => Math.min(inp.effStack, Math.round(f * inp.pot))).filter((b) => b > 0);
}

export function solveRiver3way(inp: Multiway3Input): RiverResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const F = inp.fieldRanges;
  const P = inp.pot;
  const bets = betChips(inp);
  const nSizes = bets.length;
  const nH = H.length;
  const nV = V.length;

  const heroScore = H.map((c) => evaluate7([...c.cards, ...inp.board]).score);
  const villScore = V.map((c) => evaluate7([...c.cards, ...inp.board]).score);
  const fieldScore = F.map((T) => T.map((c) => evaluate7([...c.cards, ...inp.board]).score));
  const wr = (a: number, b: number) => (a > b ? 1 : a === b ? 0.5 : 0); // win / tie(.5) / lose(0)

  // hero-vs-villain validity + hero win-rate (0 / .5 / 1).
  const valid: Uint8Array[] = [];
  const hvWin: Float64Array[] = [];
  for (let i = 0; i < nH; i++) {
    const vr = new Uint8Array(nV);
    const hw = new Float64Array(nV);
    for (let j = 0; j < nV; j++) {
      vr[j] = conflict(H[i], V[j]) ? 0 : 1;
      hw[j] = wr(heroScore[i], villScore[j]);
    }
    valid.push(vr);
    hvWin.push(hw);
  }

  const aggsH: ThirdAgg[] = [];
  const aggsV: ThirdAgg[] = [];
  F.forEach((T, f) => {
    const read = inp.fieldFoldToBet?.[f];
    const cont = read != null ? lockedContinueBySize(read, bets.map((b) => b / P)) : undefined;
    const callProb = mdfCallProbs(fieldScore[f], T.map((c) => c.w), bets, P, cont);
    aggsH.push(buildThirdAgg(H, T, callProb, (i, m) => wr(heroScore[i], fieldScore[f][m]), nSizes));
    aggsV.push(buildThirdAgg(V, T, callProb, (j, m) => wr(villScore[j], fieldScore[f][m]), nSizes));
  });

  return multiwayCfr({
    H,
    V,
    nField: F.length,
    pot: P,
    bets,
    iterations: inp.iterations ?? 1200,
    valid,
    hvWin,
    aggsH,
    aggsV,
    rake: inp.rake,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3-WAY TURN — one chance layer (the river). Showdowns become equities enumerated
// over every river runout (as turnSolver does HU), and the "scoop needs to beat
// everyone" logic uses the PRODUCT of the marginal equities (independence approx,
// the same simplification the river solver's card-removal decoupling makes). The
// CHECK line nests a real 3-way river subgame per river-texture bucket — a check is
// worth its river play, not scored as give-up (the fix the HU turn solver needed).
// ─────────────────────────────────────────────────────────────────────────────

export interface Turn3Input extends Omit<Multiway3Input, 'board'> {
  board: Card[]; // exactly 4 (turn)
  riverNestIterations?: number;
  /** Nest a real 3-way river subgame on the CHECK line (default true). False scores a check
   *  as a static multiway checkdown — the escape hatch the FLOP solver uses to bound
   *  recursion to two CFR layers, exactly as the heads-up flop solver does. */
  nestRiverForCheck?: boolean;
}

/** Hero equity (win + ½tie) vs one opponent over every legal river, given a 4-card board. */
function eqOverRiver(a: [Card, Card], b: [Card, Card], board4: Card[]): number {
  const used = new Set<number>([...board4, a[0], a[1], b[0], b[1]].map(id));
  let win = 0;
  let tie = 0;
  let n = 0;
  for (let rank = 2; rank <= 14; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      const rid = rank * 4 + suit;
      if (used.has(rid)) continue;
      const river = { rank, suit };
      const ha = evaluate7([a[0], a[1], ...board4, river]).score;
      const hb = evaluate7([b[0], b[1], ...board4, river]).score;
      if (ha > hb) win++;
      else if (ha === hb) tie++;
      n++;
    }
  }
  return n > 0 ? (win + tie / 2) / n : 0.5;
}

/** Per-hero-combo EV (chips) of CHECKING the turn 3-way, valued as a real 3-way river
 *  subgame per river-texture bucket (solveRiver3way as the leaf) rather than a static
 *  checkdown — so the check keeps its river potential instead of being scored as give-up. */
function checkLineRiver3wayEv(
  H: Combo[],
  V: Combo[],
  F: Combo[][],
  board4: Card[],
  P: number,
  effStack: number,
  betSizes: number[],
  riverIters: number,
  fieldFoldToBet?: (number | undefined)[],
  rake?: Rake,
): number[] {
  const nH = H.length;
  const acc = new Array(nH).fill(0);
  const cnt = new Array(nH).fill(0);
  for (const { card, weight } of textureBuckets(board4)) {
    const rid = id(card);
    const Hr: Combo[] = [];
    const hMap: number[] = [];
    for (let i = 0; i < nH; i++) {
      if (id(H[i].cards[0]) === rid || id(H[i].cards[1]) === rid) continue;
      Hr.push(H[i]);
      hMap.push(i);
    }
    const Vr = V.filter((c) => id(c.cards[0]) !== rid && id(c.cards[1]) !== rid);
    const Fr = F.map((T) => {
      const kept = T.filter((c) => id(c.cards[0]) !== rid && id(c.cards[1]) !== rid);
      return kept.length ? kept : Vr; // a field range emptied by the river card falls back
    });
    if (!Hr.length || !Vr.length) continue;
    const res = solveRiver3way({
      heroRange: Hr,
      villainRange: Vr,
      fieldRanges: Fr,
      board: [...board4, card],
      pot: P,
      effStack,
      betSizes,
      iterations: riverIters,
      fieldFoldToBet,
      rake,
    });
    for (let k = 0; k < Hr.length; k++) {
      const s = res.heroStrategy[k];
      const evs = res.heroActionEv[k];
      let node = 0;
      for (let a = 0; a < s.length; a++) node += s[a].freq * evs[a];
      acc[hMap[k]] += weight * node;
      cnt[hMap[k]] += weight;
    }
  }
  return acc.map((v, i) => (cnt[i] > 0 ? v / cnt[i] : NaN));
}

export function solveTurn3way(inp: Turn3Input): RiverResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const F = inp.fieldRanges;
  const P = inp.pot;
  const iters = inp.iterations ?? 1000;
  const bets = betChips(inp);
  const nSizes = bets.length;
  const nH = H.length;
  const nV = V.length;

  // Equity matrices over river runouts. eqHV = hero vs villain, eqHF/eqVF = hero/villain vs
  // each fixed player. Validity (card removal) tracked for the solved HV pairs.
  const valid: Uint8Array[] = [];
  const eqHV: Float64Array[] = [];
  const eqHF: Float64Array[][] = F.map(() => []);
  for (let i = 0; i < nH; i++) {
    const vr = new Uint8Array(nV);
    const hv = new Float64Array(nV);
    for (let j = 0; j < nV; j++) {
      if (conflict(H[i], V[j])) {
        vr[j] = 0;
        continue;
      }
      vr[j] = 1;
      hv[j] = eqOverRiver(H[i].cards, V[j].cards, inp.board);
    }
    F.forEach((T, f) => {
      const ht = new Float64Array(T.length);
      for (let m = 0; m < T.length; m++) {
        ht[m] = conflict(H[i], T[m]) ? 0.5 : eqOverRiver(H[i].cards, T[m].cards, inp.board);
      }
      eqHF[f].push(ht);
    });
    valid.push(vr);
    eqHV.push(hv);
  }
  const eqVF: Float64Array[][] = F.map((T) =>
    V.map((v) => {
      const vt = new Float64Array(T.length);
      for (let m = 0; m < T.length; m++) {
        vt[m] = conflict(v, T[m]) ? 0.5 : eqOverRiver(v.cards, T[m].cards, inp.board);
      }
      return vt;
    }),
  );

  // Each fixed player's policy ranks by EQUITY vs hero's range (a draw with the price
  // continues), not raw made strength — computed from eqHF (his equity = 1 − hero's).
  const hwTotal = H.reduce((s, c) => s + c.w, 0) || 1;
  const aggsH: ThirdAgg[] = [];
  const aggsV: ThirdAgg[] = [];
  F.forEach((T, f) => {
    const strength = T.map((_, m) => {
      let acc = 0;
      for (let i = 0; i < nH; i++) acc += H[i].w * (1 - eqHF[f][i][m]);
      return acc / hwTotal;
    });
    const read = inp.fieldFoldToBet?.[f];
    const cont = read != null ? lockedContinueBySize(read, bets.map((b) => b / P)) : undefined;
    const callProb = mdfCallProbs(strength, T.map((c) => c.w), bets, P, cont);
    aggsH.push(buildThirdAgg(H, T, callProb, (i, m) => eqHF[f][i][m], nSizes));
    aggsV.push(buildThirdAgg(V, T, callProb, (j, m) => eqVF[f][j][m], nSizes));
  });
  const nested =
    inp.nestRiverForCheck === false
      ? undefined
      : checkLineRiver3wayEv(H, V, F, inp.board, P, inp.effStack, inp.betSizes, inp.riverNestIterations ?? 120, inp.fieldFoldToBet, inp.rake);

  return multiwayCfr({
    H,
    V,
    nField: F.length,
    pot: P,
    bets,
    iterations: iters,
    valid,
    hvWin: eqHV,
    aggsH,
    aggsV,
    rake: inp.rake,
    checkEv: nested,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTIWAY FLOP — the modal live pot (a limped or single-raised family pot) and the street
// where multiway EV diverges most from heads-up: hero has to get through 2–4 independent
// callers with two cards to come, so bluffs almost never work and a bare made hand is
// value-betting into a field that can only continue with better. Same tree and the same
// shared CFR as the other streets; only the payoff source changes.
//
// TWO DISCLOSED ABSTRACTIONS, both narrower than they sound:
//  · showdown equity comes from NESTED TEXTURE BUCKETS (a turn representative per bucket ×
//    a river representative per bucket, weighted) rather than all C(45,2)=990 runouts. The
//    coarse-grained runouts it merges are ones that play alike (cardTexture.ts), and this is
//    the only affordable way to get two chance layers into a live solve.
//  · the CHECK line nests a real multiway TURN subgame per turn bucket, but that subgame does
//    NOT nest its own river subgame (`nestRiverForCheck: false`) — recursion is bounded at two
//    CFR layers, exactly as the heads-up flop solver bounds it.
// ─────────────────────────────────────────────────────────────────────────────

/** Turn-texture buckets solved per nesting sweep. The flop runs several sweeps (the check line
 *  plus the called line at two reference sizes), so this constant is the app's single biggest
 *  cost knob — each unit is one more nested multiway turn solve per sweep. */
const NEST_BUCKETS = 10;

export interface Flop3Input extends Omit<Multiway3Input, 'board'> {
  board: Card[]; // exactly 3 (flop)
  /** CFR iterations for each nested per-turn-bucket subgame (default 150). */
  turnNestIterations?: number;
  /** Nest a real multiway turn subgame on the CHECK line (default true). False = static
   *  two-street checkdown, which under-credits checking and so over-bets: an A/B escape
   *  hatch and a way to keep unit tests cheap, not a mode to ship. */
  nestTurnForCheck?: boolean;
}

const usesCard = (c: Card, a: [Card, Card], b: [Card, Card]) =>
  id(c) === id(a[0]) || id(c) === id(a[1]) || id(c) === id(b[0]) || id(c) === id(b[1]);

/** Hero equity (win + ½tie) vs one opponent over both remaining streets, on nested texture
 *  buckets: each turn representative is weighted by its bucket size, and within it each river
 *  representative likewise. Weights renormalise over whatever survives card removal, so a
 *  bucket whose representative collides with either hand drops out rather than skewing. */
function eqOverTwoStreets(a: [Card, Card], b: [Card, Card], board3: Card[]): number {
  let num = 0;
  let den = 0;
  for (const { card: turn, weight: wT } of textureBuckets(board3)) {
    if (usesCard(turn, a, b)) continue;
    const board4 = [...board3, turn];
    for (const { card: river, weight: wR } of textureBuckets(board4)) {
      if (usesCard(river, a, b)) continue;
      const w = wT * wR;
      const ha = evaluate7([a[0], a[1], ...board4, river]).score;
      const hb = evaluate7([b[0], b[1], ...board4, river]).score;
      num += w * (ha > hb ? 1 : ha === hb ? 0.5 : 0);
      den += w;
    }
  }
  return den > 0 ? num / den : 0.5;
}

/** Per-hero-combo EV (chips) of CHECKING the flop multiway, valued as a real multiway turn
 *  subgame per turn-texture bucket instead of a static two-street checkdown — the same fix
 *  the heads-up flop solver needed, and the reason this solver doesn't over-bet. */
function checkLineTurn3wayEv(
  H: Combo[],
  V: Combo[],
  F: Combo[][],
  board3: Card[],
  P: number,
  effStack: number,
  betSizes: number[],
  turnIters: number,
  fieldFoldToBet?: (number | undefined)[],
  rake?: Rake,
  maxBuckets = NEST_BUCKETS,
): number[] {
  const nH = H.length;
  const acc = new Array(nH).fill(0);
  const cnt = new Array(nH).fill(0);
  // Heaviest loop in the app: one nested turn solve per bucket. Keep the biggest buckets —
  // the tail ones are single-card textures whose weight barely moves the average, and the
  // weighted mean renormalises over whatever is solved.
  const buckets = [...textureBuckets(board3)].sort((a, b) => b.weight - a.weight).slice(0, maxBuckets);
  for (const { card, weight } of buckets) {
    const tid = id(card);
    const Hr: Combo[] = [];
    const hMap: number[] = [];
    for (let i = 0; i < nH; i++) {
      if (id(H[i].cards[0]) === tid || id(H[i].cards[1]) === tid) continue;
      Hr.push(H[i]);
      hMap.push(i);
    }
    const Vr = V.filter((c) => id(c.cards[0]) !== tid && id(c.cards[1]) !== tid);
    const Fr = F.map((T) => {
      const kept = T.filter((c) => id(c.cards[0]) !== tid && id(c.cards[1]) !== tid);
      return kept.length ? kept : Vr; // a field range emptied by the turn card falls back
    });
    if (!Hr.length || !Vr.length) continue;
    const res = solveTurn3way({
      heroRange: Hr,
      villainRange: Vr,
      fieldRanges: Fr,
      board: [...board3, card],
      pot: P,
      effStack,
      betSizes,
      iterations: turnIters,
      nestRiverForCheck: false, // bound recursion to two CFR layers
      fieldFoldToBet,
      rake,
    });
    for (let k = 0; k < Hr.length; k++) {
      const s = res.heroStrategy[k];
      const evs = res.heroActionEv[k];
      let node = 0;
      for (let a = 0; a < s.length; a++) node += s[a].freq * evs[a];
      acc[hMap[k]] += weight * node;
      cnt[hMap[k]] += weight;
    }
  }
  return acc.map((v, i) => (cnt[i] > 0 ? v / cnt[i] : NaN));
}

export function solveFlop3way(inp: Flop3Input): RiverResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const F = inp.fieldRanges;
  const P = inp.pot;
  const bets = betChips(inp);
  const nSizes = bets.length;
  const nH = H.length;
  const nV = V.length;

  const valid: Uint8Array[] = [];
  const eqHV: Float64Array[] = [];
  const eqHF: Float64Array[][] = F.map(() => []);
  for (let i = 0; i < nH; i++) {
    const vr = new Uint8Array(nV);
    const hv = new Float64Array(nV);
    for (let j = 0; j < nV; j++) {
      if (conflict(H[i], V[j])) {
        vr[j] = 0;
        continue;
      }
      vr[j] = 1;
      hv[j] = eqOverTwoStreets(H[i].cards, V[j].cards, inp.board);
    }
    F.forEach((T, f) => {
      const ht = new Float64Array(T.length);
      for (let m = 0; m < T.length; m++) {
        ht[m] = conflict(H[i], T[m]) ? 0.5 : eqOverTwoStreets(H[i].cards, T[m].cards, inp.board);
      }
      eqHF[f].push(ht);
    });
    valid.push(vr);
    eqHV.push(hv);
  }
  const eqVF: Float64Array[][] = F.map((T) =>
    V.map((v) => {
      const vt = new Float64Array(T.length);
      for (let m = 0; m < T.length; m++) {
        vt[m] = conflict(v, T[m]) ? 0.5 : eqOverTwoStreets(v.cards, T[m].cards, inp.board);
      }
      return vt;
    }),
  );

  // Each fixed player continues by EQUITY vs hero's range, not made strength: on the flop a
  // draw is the most common legitimate continue, and ranking by current pair strength would
  // fold the field's draws and hand hero free equity.
  const hwTotal = H.reduce((s, c) => s + c.w, 0) || 1;
  const aggsH: ThirdAgg[] = [];
  const aggsV: ThirdAgg[] = [];
  F.forEach((T, f) => {
    const strength = T.map((_, m) => {
      let acc = 0;
      for (let i = 0; i < nH; i++) acc += H[i].w * (1 - eqHF[f][i][m]);
      return acc / hwTotal;
    });
    const read = inp.fieldFoldToBet?.[f];
    const cont = read != null ? lockedContinueBySize(read, bets.map((b) => b / P)) : undefined;
    const callProb = mdfCallProbs(strength, T.map((c) => c.w), bets, P, cont);
    aggsH.push(buildThirdAgg(H, T, callProb, (i, m) => eqHF[f][i][m], nSizes));
    aggsV.push(buildThirdAgg(V, T, callProb, (j, m) => eqVF[f][j][m], nSizes));
  });

  const nested =
    inp.nestTurnForCheck === false
      ? undefined
      : checkLineTurn3wayEv(H, V, F, inp.board, P, inp.effStack, inp.betSizes, inp.turnNestIterations ?? 150, inp.fieldFoldToBet, inp.rake);

  return multiwayCfr({
    H,
    V,
    nField: F.length,
    pot: P,
    bets,
    iterations: inp.iterations ?? 700,
    valid,
    hvWin: eqHV,
    aggsH,
    aggsV,
    rake: inp.rake,
    checkEv: nested,
    calledBonus: nested
      ? calledLineFutureValue(
          H,
          V,
          F,
          inp.board,
          staticCheckdown(H, V, valid, eqHV, aggsH, P, inp.rake),
          aggsH,
          P,
          bets,
          inp.effStack,
          inp.betSizes,
          Math.max(40, Math.round((inp.turnNestIterations ?? 150) * 0.6)), // cheaper: 4 sweeps, one per size
          inp.fieldFoldToBet,
          inp.rake,
        )
      : undefined,
  });
}

/** The flop's asymmetry fix, and the reason this solver can be trusted multiway.
 *
 *  A CHECK is valued as a nested turn subgame; a bet that gets CALLED is valued as a static
 *  two-street showdown with no further betting (the cost bound the heads-up flop solver takes
 *  as well). Heads-up that gap hides behind fold equity. Multiway fold equity collapses and
 *  the gap takes over — and it WIDENS with every extra player, because the check line keeps
 *  the whole field in for its nested street while the bet line folds part of the field out and
 *  gets nothing later. Uncorrected, the solve checks a set on a wet 5-way flop, which is the
 *  single worst piece of advice it could give a live player.
 *
 *  So the bet line is raised to the same fidelity instead of being patched: for each size,
 *  the called line is valued as a real nested turn subgame at the called pot (P + callers·b)
 *  with the stacks that are actually left, and the static baseline at that same pot is
 *  subtracted — leaving exactly the later-street value the static payoff omits. Both lines now
 *  carry one nested street, so the comparison no longer depends on which branch got nested.
 *
 *  Two disclosed approximations remain: the callers count is a range average (one nested solve
 *  per size, not per hero combo), and the nested field uses full ranges rather than the calling
 *  subsets — the latter understates the field's strength on that line, which is conservative
 *  for betting.
 *
 *  The correction is then DISCOUNTED per combo by how often that hand actually wins the pot it
 *  is building (its scoop share). Without it the nested subgame — which values hero's whole
 *  range, including the value hands — hands pure air the barrel equity of a range it isn't in,
 *  and the solve starts stabbing multiway flops with king-high. Later-street value is only
 *  collectable by hands that get to collect: a set keeps most of it, a draw about half, air
 *  almost none. */
function calledLineFutureValue(
  H: Combo[],
  V: Combo[],
  F: Combo[][],
  board3: Card[],
  staticCheck: number[],
  aggsH: ThirdAgg[],
  P: number,
  bets: number[],
  effStack: number,
  betSizes: number[],
  turnIters: number,
  fieldFoldToBet?: (number | undefined)[],
  rake?: Rake,
): number[][] {
  const netP = netPot(rake, P) || 1;
  const hw = H.reduce((s, c) => s + c.w, 0) || 1;
  const bonus = H.map(() => new Array(bets.length).fill(0));
  // callers on the called line = villain + the field's expected callers at that size, averaged
  // over hero's range (one nested solve per size, never per combo — far too many solves).
  const potCalled = bets.map(
    (b, s) => P + (2 + aggsH.reduce((acc, a) => acc + H.reduce((t, c, i) => t + c.w * a.pTcall[s][i], 0) / hw, 0)) * b,
  );
  // Sweeps are the cost, so only the extreme sizes are solved and the interior sizes are
  // INTERPOLATED between them by called pot. Interpolation between two measured points, not
  // extrapolation from one — the smallest and largest bet bracket every other size.
  const refs = bets.length <= 2 ? bets.map((_, s) => s) : [0, bets.length - 1];
  const solved = new Map<number, number[]>();
  for (const s of refs) {
    const behind = Math.max(0, effStack - bets[s]);
    if (behind <= 0) continue; // a shove has no later street to play
    solved.set(
      s,
      checkLineTurn3wayEv(H, V, F, board3, potCalled[s], behind, betSizes, turnIters, fieldFoldToBet, rake),
    );
  }
  if (solved.size === 0) return bonus;
  const lo = refs[0];
  const hi = refs[refs.length - 1];
  const future = (i: number, s: number): number => {
    const at = (k: number) => {
      const n = solved.get(k)?.[i];
      if (n == null || !Number.isFinite(n)) return 0;
      return Math.max(0, n - staticCheck[i] * (netPot(rake, potCalled[k]) / netP));
    };
    if (s === lo || !solved.has(hi) || lo === hi) return at(lo);
    if (s === hi) return at(hi);
    const span = potCalled[hi] - potCalled[lo];
    const t = span > 0 ? (potCalled[s] - potCalled[lo]) / span : 0;
    return at(lo) + t * (at(hi) - at(lo));
  };
  for (let i = 0; i < H.length; i++) {
    const scoopShare = Math.min(1, Math.max(0, staticCheck[i] / netP));
    bets.forEach((b, s) => {
      if (effStack - b <= 0) return;
      bonus[i][s] = future(i, s) * scoopShare;
    });
  }
  return bonus;
}

/** Static multiway checkdown per hero combo (chips): hero's equity vs the solved villain times
 *  the chance he also beats every fixed player's full range, on the netted pot. */
function staticCheckdown(
  H: Combo[],
  V: Combo[],
  valid: Uint8Array[],
  eqHV: Float64Array[],
  aggsH: ThirdAgg[],
  P: number,
  rake?: Rake,
): number[] {
  const netP = netPot(rake, P);
  const fullWinH = H.map((_, i) => aggsH.reduce((acc, a) => acc * a.wVsTfull[i], 1));
  return H.map((_, i) => {
    let w = 0;
    let sd = 0;
    for (let j = 0; j < V.length; j++) {
      if (!valid[i][j]) continue;
      w += V[j].w;
      sd += V[j].w * netP * eqHV[i][j] * fullWinH[i];
    }
    return w > 0 ? sd / w : 0;
  });
}

