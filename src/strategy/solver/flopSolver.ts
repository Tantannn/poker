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

import type { Card } from '../../engine/cards';
import { evaluate7 } from '../../engine/evaluator';
import { solveTurn } from './turnSolver';
import { solveVsBetEquity, type VsBetResult } from './vsBet';
import { textureBuckets } from './cardTexture';
import { villainRaiseSizes, type Combo } from './riverSolver';
import { netPot, rakeOn, type Rake } from '../../engine/rake';

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

/** Per-hero-combo EV (chips) of CHECKING the flop, valued as a real turn subgame instead
 *  of a static two-street showdown. For each turn-texture bucket the check line is a
 *  hero-first turn node (hero checked → still OOP, acts first) between both full ranges —
 *  exactly solveTurn — so nesting it credits the check with the turn/river value the flat
 *  `equity × pot` payoff omits: barrelling good turns, giving up bad ones, semi-bluffing
 *  draws that improve. Independent of the flop CFR (a check faces no prior flop bet), so
 *  it is computed ONCE up front and fed in as the check payoff.
 *
 *  APPROXIMATIONS (v1): the turn subgame uses hero's FULL range (not just the flop-checking
 *  hands — slightly over-credits later bluffs, as in turnSolver) and only the bucket
 *  representatives are solved (texture abstraction). Both only nudge the check toward its
 *  true value — the direction that corrects the over-betting bias. */
function checkLineTurnEv(
  H: Combo[],
  V: Combo[],
  board3: Card[],
  P: number,
  effStack: number,
  betSizes: number[],
  turnIters: number,
  rake?: Rake,
): number[] {
  const nH = H.length;
  const acc = new Array(nH).fill(0);
  const cnt = new Array(nH).fill(0);
  for (const { card, weight } of textureBuckets(board3)) {
    const tid = id(card);
    // combos that don't use the turn card, with a back-map to the original hero index.
    const Hr: Combo[] = [];
    const hMap: number[] = [];
    for (let i = 0; i < nH; i++) {
      if (id(H[i].cards[0]) === tid || id(H[i].cards[1]) === tid) continue;
      Hr.push(H[i]);
      hMap.push(i);
    }
    const Vr = V.filter((c) => id(c.cards[0]) !== tid && id(c.cards[1]) !== tid);
    if (!Hr.length || !Vr.length) continue;
    const res = solveTurn({
      heroRange: Hr,
      villainRange: Vr,
      board: [...board3, card],
      pot: P,
      effStack,
      betSizes,
      iterations: turnIters,
      nestRiverForCheck: false, // bound recursion to two CFR layers; turn check = static river showdown
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

  // Per-combo valid villain weight + the static two-street showdown check value (the
  // fallback). The flop CFR scores actions as villain-weight SUMS, so the check payoff is
  // rescaled by vwSum[i]; the reported per-combo EV wants the AVERAGE (checkAvg[i]).
  const vwSum = new Array(nH).fill(0);
  const checkStatic = new Array(nH).fill(0);
  for (let i = 0; i < nH; i++) {
    let w = 0;
    let sd = 0;
    for (let j = 0; j < nV; j++) {
      if (!valid[i][j]) continue;
      w += V[j].w;
      sd += V[j].w * (eq[i][j] * netPot(inp.rake, P)); // heroSD(eq, 0) = eq × pot after rake
    }
    vwSum[i] = w;
    checkStatic[i] = w > 0 ? sd / w : 0;
  }
  // Deeper model: value a CHECK as a real turn subgame (checkLineTurnEv), not a static
  // two-street showdown. Falls back to the static value per combo when disabled or when a
  // runout yields none (NaN). This is what stops the solver over-betting the flop.
  const checkAvg = new Array(nH);
  const nested =
    inp.nestTurnForCheck !== false
      ? checkLineTurnEv(H, V, inp.board, P, inp.effStack, inp.betSizes, inp.turnNestIterations ?? 260, inp.rake)
      : null;
  for (let i = 0; i < nH; i++) {
    const v = nested ? nested[i] : NaN;
    checkAvg[i] = Number.isFinite(v) ? v : checkStatic[i];
  }

  // VILLAIN MAY RAISE hero's bet (see riverSolver): one raise size, hero then folds his bet
  // or calls for a showdown at that total. Without it a flop bluff is priced risk-free.
  const mayRaise = inp.villainMayRaise !== false;
  const raiseTo = villainRaiseSizes(P, inp.effStack, bets);
  const canRaise = bets.map((b, s) => mayRaise && raiseTo[s] > b);

  const regretH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const stratSumH = Array.from({ length: nH }, () => new Array(nHeroActions).fill(0));
  const regretV = canRaise.map((r) => Array.from({ length: nV }, () => new Array(r ? 3 : 2).fill(0)));
  const stratSumV = canRaise.map((r) => Array.from({ length: nV }, () => new Array(r ? 3 : 2).fill(0)));
  const regretH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));
  const stratSumH2 = bets.map(() => Array.from({ length: nH }, () => [0, 0]));

  // hero showdown EV given equity e and both invested inv (uses the flop pot P). The
  // bet-call line is scored as a static showdown at the flop pot — turn/river betting on
  // that line is not modelled (same simplification turnSolver makes one street later).
  // Terminal pots per bet size, precomputed: a showdown at size s holds P + 2·b, a fold
  // P + b. Hoisted out of the CFR loops — these are the innermost lines of the solve, so a
  // per-leaf call costs seconds. Rake comes off the pot collected, not the chips invested.
  const netAtBet = bets.map((b) => netPot(inp.rake, P + 2 * b));
  const foldWinBet = bets.map((b) => P - rakeOn(inp.rake, P + b));
  const netAtRaise = raiseTo.map((x: number) => netPot(inp.rake, P + 2 * x));
  const villRaiseFoldWin = bets.map((b, s) => P + b - rakeOn(inp.rake, P + b + raiseTo[s]));

  for (let t = 0; t < iters; t++) {
    const hS = regretH.map(strat);
    const vS = regretV.map((row) => row.map(strat));
    const hS2 = regretH2.map((rows) => rows.map(strat));

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
          aCall += reach * (eq[i][j] * nx - x);
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
      for (let j = 0; j < nV; j++) {
        const vFold = 0;
        let vCall = 0;
        let vRaise = 0;
        for (let i = 0; i < nH; i++) {
          if (!valid[i][j]) continue;
          const reach = H[i].w * hS[i][1 + s];
          if (reach === 0) continue;
          vCall += reach * ((1 - eq[i][j]) * nb - b);
          if (raises) {
            const h2 = hS2[s][i];
            vRaise += reach * (h2[0] * vrf + h2[1] * ((1 - eq[i][j]) * nx - x));
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
      av[0] = checkAvg[i] * vwSum[i]; // check payoff on the villain-weight SUM scale the bets use
      for (let s = 0; s < nSizes; s++) {
        const b = bets[s];
        const nb = netAtBet[s];
        const fw = foldWinBet[s];
        const nx = netAtRaise[s];
        const x = raiseTo[s];
        const h2 = hS2[s][i];
        const raises = canRaise[s];
        let vBet = 0;
        for (let j = 0; j < nV; j++) {
          if (!valid[i][j]) continue;
          const vs = vS[s][j];
          const afterRaise = raises ? vs[2] * (h2[0] * -b + h2[1] * (eq[i][j] * nx - x)) : 0;
          vBet += V[j].w * (vs[0] * fw + vs[1] * (eq[i][j] * nb - b) + afterRaise);
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
    av[0] = checkAvg[i]; // reported check EV = the turn-subgame value (average chips)
    for (let s = 0; s < nSizes; s++) {
      const b = bets[s];
      const nb = netAtBet[s];
      const fw = foldWinBet[s];
      const nx = netAtRaise[s];
      const x = raiseTo[s];
      const h2 = h2Final[s][i];
      const raises = canRaise[s];
      let bt = 0;
      for (let j = 0; j < nV; j++) {
        if (!valid[i][j]) continue;
        const vs = vFinal[s][j];
        const afterRaise = raises ? vs[2] * (h2[0] * -b + h2[1] * (eq[i][j] * nx - x)) : 0;
        bt += V[j].w * (vs[0] * fw + vs[1] * (eq[i][j] * nb - b) + afterRaise);
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
  /** house rake in chips. Omit for rake-free EV. */
  rake?: Rake;
}

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
  return solveVsBetEquity({
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
    rake: inp.rake,
  });
}
