// Range-vs-range 3-WAY solver (Tier-2, Stage 4). Full multiway CFR (every player
// optimising at once) is intractable; this approximates a 3-handed pot by solving hero +
// ONE villain with CFR while a THIRD player follows a FIXED policy — it is not a strategic
// agent, so it has no regrets, but it still contests the pot and the showdown.
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
import { textureBuckets } from './cardTexture';

export interface Multiway3Input {
  heroRange: Combo[];
  villainRange: Combo[]; // the SOLVED opponent
  thirdRange: Combo[]; // the FIXED-policy opponent
  board: Card[]; // exactly 5 (river)
  pot: number;
  effStack: number;
  betSizes: number[]; // fractions of pot
  iterations?: number;
  /** READ ON THE FIXED THIRD PLAYER, 0..1 — how often the second (non-solved) opponent
   *  folds facing a ¾-pot bet. When set, his MDF-by-strength policy is re-anchored to it
   *  (an over-folder defends narrower, a station wider), scaled across sizes by pot odds —
   *  the same ¾-pot-referenced curve the HU node lock uses (lockedContinueBySize). Omit
   *  for the parameter-free MDF default. Only the fixed player's read lands here; the
   *  SOLVED villain carries reads via the per-hand fallback in index.ts. */
  thirdFoldToBet?: number;
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

export function solveRiver3way(inp: Multiway3Input): RiverResult {
  const H = inp.heroRange;
  const V = inp.villainRange;
  const T = inp.thirdRange;
  const P = inp.pot;
  const iters = inp.iterations ?? 1200;
  const bets = inp.betSizes.map((f) => Math.min(inp.effStack, Math.round(f * P))).filter((b) => b > 0);
  const nSizes = bets.length;
  const nHeroActions = 1 + nSizes;
  const nH = H.length;
  const nV = V.length;

  const heroScore = H.map((c) => evaluate7([...c.cards, ...inp.board]).score);
  const villScore = V.map((c) => evaluate7([...c.cards, ...inp.board]).score);
  const thirdScore = T.map((c) => evaluate7([...c.cards, ...inp.board]).score);
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

  const thirdCont =
    inp.thirdFoldToBet != null ? lockedContinueBySize(inp.thirdFoldToBet, bets.map((b) => b / P)) : undefined;
  const callProb = mdfCallProbs(thirdScore, T.map((c) => c.w), bets, P, thirdCont);
  const aggH = buildThirdAgg(H, T, callProb, (i, m) => wr(heroScore[i], thirdScore[m]), nSizes);
  const aggV = buildThirdAgg(V, T, callProb, (j, m) => wr(villScore[j], thirdScore[m]), nSizes);

  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const regretV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));
  const stratSumV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));

  // hero net (chips) betting b, decomposed by whether the villain (v) and the fixed third
  // player (t) call. Hero scoops iff he beats every caller; a single beat-me caller costs
  // hero his bet b. hv = hero win-rate vs this villain combo; wht = hero win-rate vs the
  // third's calling range; ptc = third's call probability.
  const heroBet = (hv: number, vs0: number, vs1: number, ptc: number, wht: number, b: number) => {
    const tFold = vs0 * P + vs1 * (hv * (P + 2 * b) - b); // third folds → uncontested or 2-way vs villain
    const tCall =
      vs0 * (wht * (P + 2 * b) - b) + // only third called → 2-way vs third
      vs1 * (hv * wht * (P + 3 * b) - b); // both called → 3-way, scoop needs both
    return (1 - ptc) * tFold + ptc * tCall;
  };

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(strat);
    const vS = regretV.map((row) => row.map(strat));

    // villain regret (faces each bet size). Villain wins iff it beats hero AND the field.
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      for (let j = 0; j < nV; j++) {
        const ptc = aggV.pTcall[s][j];
        const wvt = aggV.wVsT[s][j];
        let vCall = 0;
        for (let i = 0; i < nH; i++) {
          if (!valid[i][j]) continue;
          const reach = H[i].w * hS[i][1 + s];
          if (reach === 0) continue;
          const vv = 1 - hvWin[i][j]; // villain win-rate vs hero (ties → .5)
          const twoWay = vv * (P + 2 * b) - b;
          const threeWay = vv * wvt * (P + 3 * b) - b;
          vCall += reach * ((1 - ptc) * twoWay + ptc * threeWay);
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
      let vCheck = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        vCheck += V[j].w * P * hvWin[i][j] * aggH.wVsTfull[i]; // checked 3-way pot: win P iff scoop
      }
      av[0] = vCheck;
      for (let s = 0; s < nSizes; s++) {
        const b = bets[s];
        const ptc = aggH.pTcall[s][i];
        const wht = aggH.wVsT[s][i];
        let vBet = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const vs = vS[s][j];
          vBet += V[j].w * heroBet(hvWin[i][j], vs[0], vs[1], ptc, wht, b);
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
    let vCheck = 0;
    for (let j = 0; j < nV; j++) if (valid[i][j]) vCheck += V[j].w * P * hvWin[i][j] * aggH.wVsTfull[i];
    av[0] = vCheck * inv;
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      const ptc = aggH.pTcall[s][i];
      const wht = aggH.wVsT[s][i];
      let vBet = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vFinal[s][j];
        vBet += V[j].w * heroBet(hvWin[i][j], vs[0], vs[1], ptc, wht, b);
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
  T: Combo[],
  board4: Card[],
  P: number,
  effStack: number,
  betSizes: number[],
  riverIters: number,
  thirdFoldToBet?: number,
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
    const Tr = T.filter((c) => id(c.cards[0]) !== rid && id(c.cards[1]) !== rid);
    if (!Hr.length || !Vr.length) continue;
    const res = solveRiver3way({
      heroRange: Hr,
      villainRange: Vr,
      thirdRange: Tr.length ? Tr : Vr,
      board: [...board4, card],
      pot: P,
      effStack,
      betSizes,
      iterations: riverIters,
      thirdFoldToBet,
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
  const T = inp.thirdRange;
  const P = inp.pot;
  const iters = inp.iterations ?? 1000;
  const bets = inp.betSizes.map((f) => Math.min(inp.effStack, Math.round(f * P))).filter((b) => b > 0);
  const nSizes = bets.length;
  const nHeroActions = 1 + nSizes;
  const nH = H.length;
  const nV = V.length;
  const nT = T.length;

  // Equity matrices over river runouts. eqHV = hero vs villain, eqHT = hero vs third,
  // eqVT = villain vs third. Validity (card removal) tracked for the solved HV pairs.
  const valid: Uint8Array[] = [];
  const eqHV: Float64Array[] = [];
  const eqHT: Float64Array[] = [];
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
    const ht = new Float64Array(nT);
    for (let m = 0; m < nT; m++) ht[m] = conflict(H[i], T[m]) ? 0.5 : eqOverRiver(H[i].cards, T[m].cards, inp.board);
    valid.push(vr);
    eqHV.push(hv);
    eqHT.push(ht);
  }
  const eqVT: Float64Array[] = [];
  for (let j = 0; j < nV; j++) {
    const vt = new Float64Array(nT);
    for (let m = 0; m < nT; m++) vt[m] = conflict(V[j], T[m]) ? 0.5 : eqOverRiver(V[j].cards, T[m].cards, inp.board);
    eqVT.push(vt);
  }

  // Third player's fixed policy ranks by EQUITY vs hero's range (a draw with the price
  // continues), not raw made strength — computed from eqHT (third's equity = 1 − hero's).
  const hwTotal = H.reduce((s, c) => s + c.w, 0) || 1;
  const strengthT = T.map((_, m) => {
    let acc = 0;
    for (let i = 0; i < nH; i++) acc += H[i].w * (1 - eqHT[i][m]);
    return acc / hwTotal;
  });
  const thirdCont =
    inp.thirdFoldToBet != null ? lockedContinueBySize(inp.thirdFoldToBet, bets.map((b) => b / P)) : undefined;
  const callProb = mdfCallProbs(strengthT, T.map((c) => c.w), bets, P, thirdCont);
  const aggH = buildThirdAgg(H, T, callProb, (i, m) => eqHT[i][m], nSizes);
  const aggV = buildThirdAgg(V, T, callProb, (j, m) => eqVT[j][m], nSizes);

  const vwSum = new Array(nH).fill(0);
  const checkStatic = new Array(nH).fill(0);
  for (let i = 0; i < nH; i++) {
    let w = 0;
    let sd = 0;
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      w += V[j].w;
      sd += V[j].w * eqHV[i][j] * aggH.wVsTfull[i] * P; // static 3-way checkdown = P × P(scoop)
    }
    vwSum[i] = w;
    checkStatic[i] = w > 0 ? sd / w : 0;
  }
  const nested = checkLineRiver3wayEv(H, V, T, inp.board, P, inp.effStack, inp.betSizes, inp.riverNestIterations ?? 120, inp.thirdFoldToBet);
  const checkAvg = new Array(nH);
  for (let i = 0; i < nH; i++) {
    const v = nested[i];
    checkAvg[i] = Number.isFinite(v) ? v : checkStatic[i];
  }

  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const regretV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));
  const stratSumV = Array.from({ length: nSizes }, () => Array.from({ length: nV }, () => [0, 0]));

  const heroBet = (hv: number, vs0: number, vs1: number, ptc: number, wht: number, b: number) => {
    const tFold = vs0 * P + vs1 * (hv * (P + 2 * b) - b);
    const tCall = vs0 * (wht * (P + 2 * b) - b) + vs1 * (hv * wht * (P + 3 * b) - b);
    return (1 - ptc) * tFold + ptc * tCall;
  };

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(strat);
    const vS = regretV.map((row) => row.map(strat));

    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      for (let j = 0; j < nV; j++) {
        const ptc = aggV.pTcall[s][j];
        const wvt = aggV.wVsT[s][j];
        let vCall = 0;
        for (let i = 0; i < nH; i++) {
          if (!valid[i][j]) continue;
          const reach = H[i].w * hS[i][1 + s];
          if (reach === 0) continue;
          const vv = 1 - eqHV[i][j];
          const twoWay = vv * (P + 2 * b) - b;
          const threeWay = vv * wvt * (P + 3 * b) - b;
          vCall += reach * ((1 - ptc) * twoWay + ptc * threeWay);
        }
        const st = vS[s][j];
        const node = st[1] * vCall;
        const cf = V[j].w;
        regretV[s][j][0] += cf * (0 - node);
        regretV[s][j][1] += cf * (vCall - node);
        stratSumV[s][j][0] += cf * st[0];
        stratSumV[s][j][1] += cf * st[1];
      }
    }

    for (let i = 0; i < nH; i++) {
      const av = new Array(nHeroActions).fill(0);
      av[0] = checkAvg[i] * vwSum[i]; // put the per-combo average on the villain-weight SUM scale
      for (let s = 0; s < nSizes; s++) {
        const b = bets[s];
        const ptc = aggH.pTcall[s][i];
        const wht = aggH.wVsT[s][i];
        let vBet = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const vs = vS[s][j];
          vBet += V[j].w * heroBet(eqHV[i][j], vs[0], vs[1], ptc, wht, b);
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
      const ptc = aggH.pTcall[s][i];
      const wht = aggH.wVsT[s][i];
      let vBet = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vFinal[s][j];
        vBet += V[j].w * heroBet(eqHV[i][j], vs[0], vs[1], ptc, wht, b);
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
