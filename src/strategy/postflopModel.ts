// Heuristic postflop "solver-model". For a node it estimates each action's EV
// (in bb) from equity-vs-range + a fold-equity model, then derives a mixed
// strategy. NOT a Nash solve — a fast, transparent approximation.

import type { Card } from '../engine/cards';
import { makeDeck, sameCard, makeRng } from '../engine/cards';
import type { WeightedRange, ComboWeight } from '../engine/range';
import { buildSampleTable, sampleCombo } from '../engine/range';
import { equityVsRange, equityVsField, countOuts, exactOutsEquity } from '../engine/equity';
import { evaluate7 } from '../engine/evaluator';
import { requiredEquityForBet } from '../engine/potOdds';
import { classifyFlop } from '../engine/board';
import type { ActionId, ActionOption, NodeStrategy } from './types';
import { mixFromEv } from './types';

// Four-way classification of an aggressive line by hero equity (+ draw), so the
// explanation distinguishes a real bluff from thin value / a semi-bluff.
type BetClass = 'value' | 'thin' | 'semibluff' | 'bluff';
function classifyBet(e: number, outs: number): BetClass {
  if (e >= 0.62) return 'value';
  if (e >= 0.5) return 'thin';
  if (e >= 0.3 || outs >= 4) return 'semibluff';
  return 'bluff';
}
// kind drives grid/bar color; we keep the existing 2-tone (value vs bluff).
const classKind = (c: BetClass): ActionOption['kind'] => (c === 'value' || c === 'thin' ? 'value' : 'bluff');

/** Hero is "flush-dominated": the board shows 3+ of a suit and hero holds NONE of
 *  it, so hero can't make that flush. Any opponent with a single card of the suit
 *  already beats (or chops over) hero's non-flush hand, and the range that calls a
 *  bet is flush-heavy — so stacking off is a trap the generic model under-rates.
 *  (At most one suit can hit 3+ on a ≤5-card board.) */
function flushDominated(hero: Card[], board: Card[]): boolean {
  const counts = [0, 0, 0, 0];
  for (const c of board) counts[c.suit]++;
  for (let s = 0; s < 4; s++) {
    if (counts[s] >= 3 && !hero.some((h) => h.suit === s)) return true;
  }
  return false;
}

/** GTO bluff frequency for a bet of `frac`×pot on the river, and value:bluff ratio.
 *  Memo: the bluff fraction equals the equity a caller needs at this size — same
 *  number, so `requiredEquityForBet` is the single source for both. */
function riverBalance(frac: number): string {
  const bluffFrac = requiredEquityForBet(frac);
  const ratio = (1 - bluffFrac) / Math.max(0.001, bluffFrac);
  return ` River balance: this size wants ~${Math.round(bluffFrac * 100)}% bluffs (≈ ${ratio.toFixed(1)} : 1 value-to-bluff).`;
}

// River call wording. The river is a pure pot-odds spot (no more cards, no
// implied odds) and a river BET is polarized — strong value + bluffs, little in
// between. A medium hand is therefore a BLUFF-CATCHER: it beats only his bluffs,
// never his value, and can't improve, so its equity ≈ how often he's bluffing.
function riverCallNote(isRiver: boolean, e: number, need: number): string {
  if (!isRiver) return '';
  if (e >= 0.7)
    return ` River read: your ~${Math.round(e * 100)}% beats enough of his value that this is a value call — raising mostly folds out the bluffs you beat, so calling captures them.`;
  return ` River = pure pot odds (no more cards, no implied odds), and a river bet is POLARIZED — strong value + bluffs, little between. This is a BLUFF-CATCH: you beat his bluffs, never his value, and can't improve, so your ~${Math.round(e * 100)}% is really "how often is he bluffing?". Call only if that clears the ${Math.round(need * 100)}% price AND he actually bluffs here — vs a player who never bluffs, fold.`;
}

function whyBet(
  c: BetClass,
  e: number,
  d: { fe: number; e2: number; contFrac?: number },
  outs: number,
  isAllIn: boolean,
  river: boolean,
  frac: number,
): string {
  const fe = `${Math.round(d.fe * 100)}%`;
  const eq = `${Math.round(e * 100)}%`;
  const e2 = `${Math.round(d.e2 * 100)}%`;
  const cont = d.contFrac != null ? `${Math.round(d.contFrac * 100)}%` : '';
  let base: string;
  switch (c) {
    case 'value':
      base = isAllIn
        ? `Value shove — but a jam folds out every worse hand and gets called almost only by what beats you${cont ? ` (~${cont} of his range continues, the strong part)` : ''}, so your equity WHEN CALLED drops to ~${e2}. Worth it only when committed (low SPR) or vs a station who won't fold — otherwise a sized value bet that keeps worse hands in prints more across streets.`
        : `Value bet: you're ahead (~${eq}). Bet to get WORSE hands to call and build the pot${cont ? ` — ~${cont} of his range continues at this size` : ''}. Size to the worst hand that still calls: too big and you fold out your customers and get called only by what beats you, too small and you leave value behind.`;
      break;
    case 'thin':
      base = `Thin value / merge: only a slight favourite (~${eq}). Bet to get called by worse — but size down, you're not strong enough to bloat the pot.`;
      break;
    case 'semibluff':
      base = `Semi-bluff: ~${eq} equity now${outs > 0 ? ` with ~${outs} outs` : ''}. Two ways to win — villain folds ~${fe}, and when called you still hit ~${e2} of the time. Keep barreling cards that complete your draw.`;
      break;
    default:
      base = `Pure bluff: ~${eq} equity — essentially drawing thin. Only profitable via fold equity (~${fe}); pick good blocker cards and a believable story, otherwise just give up.`;
  }
  return river ? base + riverBalance(frac) : base;
}

export interface PostflopInput {
  hero: Card[];
  board: Card[];
  oppRange: WeightedRange;
  /** ranges of EVERY live opponent (for multiway equity). Falls back to [oppRange]
   *  when omitted. >1 entry → hero must beat the whole field, so equity/EV drop. */
  oppRanges?: WeightedRange[];
  pot: number; // chips in middle before hero acts (incl. villain bet)
  toCall: number; // chips to call (0 if can check)
  heroCommitted: number; // chips hero already put this street
  currentBet: number; // highest committed this street
  minRaiseTo: number;
  maxRaiseTo: number; // all-in target
  canCheck: boolean;
  canRaise: boolean;
  bigBlind: number;
  iterations?: number;
  rangeNote?: string;
  heroCode?: string;
  /** hero's position vs the villain — affects equity realisation & fold equity. */
  position?: 'ip' | 'oop';
  /** effective stack BEHIND (chips still wagerable), in chips = min(hero, villain).
   *  Drives implied odds (draws win more on later streets) and the all-in risk
   *  premium (a deep shove risks far more than a shallow one). Falls back to the
   *  hero's remaining stack when omitted. */
  effStack?: number;
  /** precomputed hero equity (0..1). When provided, the model reuses it instead of
   *  running its OWN Monte-Carlo — so the solver panel and the HUD pot-odds panel
   *  read the identical number and can't contradict each other on a thin spot. */
  precomputedEquity?: number;
  /** board+action range conditioning. Used to discount implied odds by how often a
   *  draw that hits actually WINS vs the villain's *conditioned* betting range
   *  (clean outs), instead of crediting every raw out as a winner. */
  comboWeight?: ComboWeight;
}

interface Candidate {
  id: ActionId;
  label: string;
  ev: number; // bb
  amount?: number;
  sizePct?: number;
  kind: ActionOption['kind'];
  why?: string;
  math?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

export function solvePostflop(inp: PostflopInput): NodeStrategy {
  const ranges = inp.oppRanges && inp.oppRanges.length ? inp.oppRanges : [inp.oppRange];
  const nOpp = ranges.length;
  const iters = inp.iterations ?? 1200;
  // multiway: hero must beat the whole field, so equity is lower than heads-up.
  // Reuse the caller's equity when supplied (shared with the HUD); otherwise run
  // our own Monte-Carlo (drills call this directly without a precomputed number).
  const e =
    inp.precomputedEquity ??
    (nOpp > 1
      ? equityVsField(inp.hero, inp.board, ranges, iters).equity
      : equityVsRange(inp.hero, inp.board, inp.oppRange, iters).equity);
  // Heads-up equity vs the villain's range — the number that matters WHEN HERO BETS.
  // A value bet only has to beat the ONE opponent who calls, not the whole field, so
  // equity-when-called is based on this, NOT the multiway field equity `e` (which is
  // correctly lower because a checked-down showdown must beat everyone). Conflating
  // the two made overpairs look like check-only semibluffs and graded a bet a blunder.
  const eHU = nOpp > 1 ? equityVsRange(inp.hero, inp.board, inp.oppRange, iters).equity : e;
  const P = inp.pot;
  const C = inp.toCall;
  const bb = inp.bigBlind;

  // outs for semi-bluff vs pure-bluff labelling (meaningful flop/turn only)
  const outs = inp.board.length >= 3 && inp.board.length < 5 ? countOuts(inp.hero, inp.board).outs : 0;
  const isRiver = inp.board.length === 5;

  const tex = inp.board.length >= 3 ? classifyFlop(inp.board) : null;
  const wetness =
    tex == null
      ? 0
      : (tex.connected ? 0.06 : 0) + (tex.suitPattern !== 'rainbow' ? 0.05 : 0) + (tex.paired ? -0.03 : 0);

  // hero can't make the board flush and holds none of it → dominated (see helper).
  // Drives the fold-equity collapse + equity-when-called penalty in computeAggro.
  const flushDom = inp.board.length >= 3 && flushDominated(inp.hero, inp.board);

  // position: in position you act last, so you realise more of your equity
  // (free cards, pot control) and your bets carry a touch more fold equity;
  // out of position the opposite. 1.0 = neutral when position is unknown.
  const oop = inp.position === 'oop';
  const ip = inp.position === 'ip';
  const realize = ip ? 1.06 : oop ? 0.9 : 1.0;
  const feMult = ip ? 1.1 : oop ? 0.9 : 1.0;
  const eReal = Math.min(1, e * realize);

  // ---- depth: effective stack behind + SPR ----
  // The thing the pure pot-odds EV ignores. effStack = chips still wagerable
  // (min of hero vs villain). SPR drives implied odds for draws and the all-in
  // risk premium below — so the SAME spot plays differently 100bb vs 800bb deep.
  const effStack = inp.effStack ?? Math.max(0, inp.maxRaiseTo - inp.heroCommitted);
  const cardsToCome = inp.board.length === 3 ? 2 : inp.board.length === 4 ? 1 : 0;
  const spr = P > 0 ? effStack / P : 0;
  // Implied odds for a CALL with a draw: when it completes on a later street hero
  // wins EXTRA chips beyond today's pot — future bets villain pays off. That money
  // is bounded by the stack behind, so deeper stacks = bigger implied odds. Only
  // credited for real draws (>=4 outs) not already ahead, on flop/turn (the river
  // has no "later street", so depth correctly adds nothing there).
  let implied = 0;
  let cleanFrac = 1; // share of outs that, when they hit, actually WIN vs his range
  if (cardsToCome > 0 && C > 0 && outs >= 4 && e < 0.55) {
    const pHit = Math.min(0.9, exactOutsEquity(outs, cardsToCome) / 100);
    const behind = Math.max(0, effStack - C); // wagerable after the call
    const futureBet = Math.min(behind, 0.6 * (P + C)); // ~⅔-pot payoff, capped by stack
    // CLEAN OUTS: not every out is a winner. On a wet board a draw to two pair can
    // hit and still lose to a flush / better two pair, and a "scary" card may stop
    // villain paying. Scale implied odds by how often hitting actually wins vs his
    // (conditioned) range — so optimistic draw-calls get pulled back toward fold.
    cleanFrac = winIfHit(inp.hero, inp.board, inp.oppRange, inp.comboWeight);
    implied = pHit * futureBet * realize * cleanFrac;
  }

  const cands: Candidate[] = [];

  // passive line
  if (inp.canCheck) {
    cands.push({
      id: 'check',
      label: 'Check',
      ev: (eReal * P) / bb,
      kind: 'passive',
      why: `Realize your ~${pct(e)} equity in a ${P}-chip pot without risking more${
        inp.position ? ` (${ip ? 'in position you realise it well — you can check back and take a free card' : 'out of position you realise less — villain can barrel you off it'})` : ''
      }. Best when you're not ahead enough to bet for value or to profitably pressure.`,
      math: `EV = equity × pot${inp.position ? ` × realise(${realize})` : ''} = ${pct1(eReal)} × ${P} = ${(eReal * P).toFixed(1)} chips ≈ ${((eReal * P) / bb).toFixed(2)} bb`,
    });
  }
  if (C > 0) {
    const need = C / (P + C);
    cands.push({
      id: 'fold',
      label: 'Fold',
      ev: 0,
      kind: 'fold',
      why: `You need ${pct(need)} equity to call but only have ~${pct(e)}. Folding forfeits the pot but loses the least.`,
      math: `Pot odds: need = call ÷ (pot + call) = ${C} ÷ ${P + C} = ${pct(need)}; you have ~${pct(e)}.\nEV(fold) = 0 bb (you put in nothing more).`,
    });
    cands.push({
      id: 'call',
      label: `Call ${C}`,
      ev: (eReal * (P + C) - C + implied) / bb,
      kind: 'passive',
      why: `Pot odds require ${pct(need)}; you have ~${pct(e)}, so calling is ${eReal >= need || implied > 0 ? 'profitable' : 'marginal/-EV'}.${
        oop ? ' Out of position you realise less of that equity, so call tighter.' : ip ? ' In position you realise it well.' : ''
      }${implied > 0 ? ` Implied odds add ~${(implied / bb).toFixed(1)}bb: ${effStack} behind (SPR ${spr.toFixed(1)}) pays you off when the draw lands — but only ~${Math.round(cleanFrac * 100)}% of your outs actually win vs his range here, so the draw is discounted (clean outs, not raw outs).` : ''}${riverCallNote(isRiver, e, need)}`,
      math: `Pot odds: need = call ÷ (pot + call) = ${C} ÷ ${P + C} = ${pct(need)} (you have ~${pct(e)}).\nEV = equity × (pot + call) − call${implied > 0 ? ' + implied' : ''} = ${pct1(eReal)} × ${P + C} − ${C}${implied > 0 ? ` + ${implied.toFixed(1)} (implied odds, after a ${Math.round(cleanFrac * 100)}% clean-out discount)` : ''} = ${(eReal * (P + C) - C + implied).toFixed(1)} chips ≈ ${((eReal * (P + C) - C + implied) / bb).toFixed(2)} bb`,
    });
  }

  // aggressive lines
  const potForSize = P + C; // pot if hero just calls
  const addBet = (id: ActionId, frac: number, label: string) => {
    if (!inp.canRaise) return;
    let target: number;
    if (C === 0) target = Math.round(inp.heroCommitted + frac * P);
    else target = Math.round(inp.currentBet + frac * potForSize);
    target = Math.max(target, inp.minRaiseTo);
    target = Math.min(target, inp.maxRaiseTo);
    if (target >= inp.maxRaiseTo) return; // becomes all-in; handled separately
    const d = computeAggro(eHU, P, C, target, inp.currentBet, inp.heroCommitted, wetness, false, realize, feMult, nOpp, effStack, cardsToCome, e, flushDom);
    const cls = classifyBet(eHU, outs);
    const sv = d.streetValue > 0.05;
    cands.push({
      id,
      label,
      ev: d.ev / bb,
      amount: target,
      sizePct: Math.round((100 * (target - inp.currentBet)) / Math.max(1, potForSize)),
      kind: classKind(cls),
      why: whyBet(cls, eHU, d, outs, false, isRiver, frac),
      math: `EV = fold% × pot + called% × (eq-when-called × final pot − you invest)${sv ? ' + multi-street value' : ''}\n   = ${pct1(d.fe)} × ${P} + ${pct1(1 - d.fe)} × (${pct1(d.e2)} × ${d.calledPot} − ${d.A})${sv ? ` + ${d.streetValue.toFixed(1)}` : ''}\n   = ${d.ev.toFixed(1)} chips ≈ ${(d.ev / bb).toFixed(2)} bb${sv ? `\n   (~${Math.round(d.contFrac * 100)}% of his range calls this size; the rest folds — a smaller bet keeps more worse hands in to pay later streets)` : ''}`,
    });
  };

  addBet('bet33', 0.33, C === 0 ? 'Bet 33%' : 'Raise 33%');
  addBet('bet75', 0.75, C === 0 ? 'Bet 75%' : 'Raise 75%');
  addBet('betpot', 1.0, C === 0 ? 'Bet pot' : 'Raise pot');

  if (inp.canRaise && inp.maxRaiseTo > inp.currentBet) {
    const d = computeAggro(eHU, P, C, inp.maxRaiseTo, inp.currentBet, inp.heroCommitted, wetness, true, realize, feMult, nOpp, effStack, cardsToCome, e, flushDom);
    const cls = classifyBet(eHU, outs);
    const allinFrac = (inp.maxRaiseTo - inp.currentBet) / Math.max(1, potForSize);
    // shoving your whole stack is high-variance and hard to recover from IRL, so
    // apply a risk premium — all-in only "wins" when it's clearly best. SCALES
    // WITH SPR: a sub-1-SPR jam is standard and barely a gamble, while a deep
    // (high-SPR) shove risks a huge earned stack on one runout, so demand a far
    // clearer edge before all-in becomes the top line.
    const RISK = Math.max(0.1, Math.min(2.0, 0.3 + 0.25 * spr));
    const rawEv = d.ev / bb;
    const adjEv = rawEv - RISK;
    cands.push({
      id: 'allin',
      label: 'All-in',
      ev: adjEv,
      amount: inp.maxRaiseTo,
      sizePct: Math.round((100 * (inp.maxRaiseTo - inp.currentBet)) / Math.max(1, potForSize)),
      kind: classKind(cls),
      why:
        whyBet(cls, eHU, d, outs, true, isRiver, allinFrac) +
        ` Note: a ${RISK.toFixed(1)}bb risk premium is applied (scaled to SPR ${spr.toFixed(1)} — deeper stacks risk more, so the premium is bigger) — shoving your whole stack is high-variance and hard to recover from, so prefer a sized bet unless all-in is clearly best.`,
      math: `EV = ${pct1(d.fe)} × ${P} + ${pct1(1 - d.fe)} × (${pct1(d.e2)} × ${d.calledPot} − ${d.A}) = ${rawEv.toFixed(2)} bb\n   only ~${Math.round(d.contFrac * 100)}% of his range calls a shove (the strong part), so eq-when-called is just ${pct1(d.e2)}; and a jam forgoes all later-street value.\n   − ${RISK.toFixed(1)} bb risk premium (SPR ${spr.toFixed(1)}) → ${adjEv.toFixed(2)} bb`,
    });
  }

  // ---- mix ----
  const evs = cands.map((c) => ({ id: c.id, ev: c.ev }));
  // temperature 0.3 (was 0.5): sharper mix — the top-EV line keeps most of the
  // frequency and dominated lines fade faster, closer to "play the best line".
  const mix = mixFromEv(evs, 0.3, 1.4);
  const bestEv = Math.max(...cands.map((c) => c.ev));
  // Only zero out fold when some line CLEARLY beats folding (> 0.1bb). A razor-thin
  // +EV — a spot sitting right on the pot-odds line — stays a CALL/FOLD *mix* rather
  // than snapping to 100%, so a break-even hand reads as "mostly call, sometimes
  // fold" instead of flip-flopping between 100% fold and 100% call on tiny noise.
  if (bestEv > 0.1) mix.set('fold', 0);
  // renormalise
  let sum = 0;
  mix.forEach((v) => (sum += v));
  if (sum > 0) mix.forEach((v, k) => mix.set(k, v / sum));

  const options: ActionOption[] = cands
    .map((c) => ({
      id: c.id,
      label: c.label,
      freq: mix.get(c.id) ?? 0,
      ev: round2(c.ev),
      amount: c.amount,
      sizePct: c.sizePct,
      kind: c.kind,
      why: c.why,
      math: c.math,
    }))
    .sort((a, b) => b.freq - a.freq || b.ev - a.ev);

  const best = options.reduce((a, b) => (b.ev > a.ev ? b : a), options[0]);

  return {
    options,
    bestEv: round2(bestEv),
    bestId: best.id,
    source: 'postflop-model',
    note: `Equity ${(e * 100).toFixed(1)}% ${nOpp > 1 ? `vs the ${nOpp}-way field (you must beat all)` : 'vs villain range'}.${inp.effStack != null ? ` Effective stack ${effStack} (SPR ${spr.toFixed(1)}) — depth-aware: draws get implied odds, deep shoves a bigger risk premium.` : ''} Bet EVs use a minimum-defence model (bigger size → tighter, stronger calling range → lower equity-when-called) plus a multi-street value term, so over-bets/jams aren't over-credited.${nOpp > 1 && !isRiver ? ` Equity-when-called is measured HEADS-UP vs the calling range (${(eHU * 100).toFixed(1)}%) — a bet only has to beat the one caller, not the whole ${nOpp}-way field — which is why a strong made hand bets even when its field equity is modest.` : ''}${isRiver ? ` On the river (no later street) bets are scored by the thin-value rule on the SAME field equity as the check — a bet gains only when MORE worse hands call than better — so a marginal made hand checks instead of taking a free heads-up upgrade.` : ''} Still a heuristic, not a Nash solve.`,
    equity: e,
    rangeNote: inp.rangeNote,
    heroCode: inp.heroCode,
    villainRange: inp.oppRange,
  };
}

interface AggroDetail {
  ev: number;
  fe: number;
  e2: number;
  calledPot: number;
  A: number;
  /** extra EV from getting to value bet a later street (0 for all-in / river). */
  streetValue: number;
  /** share of villain's range that continues at this size (minimum-defence). */
  contFrac: number;
}

function computeAggro(
  e: number,
  P: number,
  C: number,
  target: number,
  currentBet: number,
  heroCommitted: number,
  wetness: number,
  isAllIn: boolean,
  realize = 1.0,
  feMult = 1.0,
  oppCount = 1,
  effStack = 0,
  cardsToCome = 0,
  eField = e,
  flushDom = false,
): AggroDetail {
  const R = target - currentBet; // pressure on top of a call
  const A = target - heroCommitted; // total hero invests now
  const s = R / Math.max(1, P + C); // raise size relative to the pot

  // ---- RIVER: thin-value model (no more cards to come) ----
  // Minimum-defence (below) answers "does villain fold enough vs a BLUFF?" — the
  // wrong question for a made-hand VALUE bet on the river. On the river worse hands
  // FOLD to a bet and better hands CALL, so a bet profits ONLY when more worse
  // hands call than better do — the textbook thin-value rule:
  //     EV(bet) − EV(check) = bet × (worse-that-call − better-that-call).
  // Baseline is the MULTIWAY FIELD equity `eField` — the SAME number the CHECK uses
  // — so a bet can't escape the field penalty by pretending it's heads-up. eHU is
  // deliberately NOT used here: with no later street, isolating one caller earns
  // nothing; you just show down for whatever the pot already is. There is also NO
  // fe×pot term — hero already wins vs the folders at showdown, so crediting their
  // folds again would double-count (the bug that made marginal made hands over-bet).
  // This applies to an ALL-IN too: a river shove can't fold out a made hand for
  // value, so the old fold-equity path (gated `!isAllIn`) credited ~40% phantom
  // folds and made hero jam no-flush hands into a flush board (a made flush never
  // folds). Score the river shove with the same thin-value model; the all-in risk
  // premium is still layered on afterward in solvePostflop.
  if (cardsToCome === 0) {
    const base = Math.min(1, eField * realize); // showdown EV baseline, == the check
    const worse = base; // hands hero beats vs the field
    const better = 1 - base; // hands that beat hero
    // cry-call rate: share of WORSE hands that still call, shrinking with size — a
    // small bet buys a few crying calls, a pot bet buys almost none.
    const cryCall = Math.max(0.05, Math.min(0.55, 0.55 - 0.45 * s));
    const Cw = worse * cryCall; // worse hands that call (hero wins R off each)
    const Cb = better; // better hands ~always call a bet (hero loses A to each)
    const cont = Cw + Cb;
    const e2r = cont > 0 ? Cw / cont : 0; // hero equity GIVEN called
    const fer = Math.max(0.02, 1 - cont); // share that folds (worse, didn't cry-call)
    const evr = base * P + R * Cw - A * Cb; // showdown + thin-value increment
    return { ev: evr, fe: fer, e2: e2r, calledPot: P + A + R, A, streetValue: 0, contFrac: cont };
  }

  // Fold equity rises with size but SATURATES fast and never folds everything.
  // A pot-sized bet already buys most of the folds; over-betting/shoving buys
  // almost none more — so a 10x-pot shove is not "free money". Position nudges
  // it (in position bets earn a touch more folds); wet boards lower it (villain
  // has draws that keep calling).
  let fe = (0.1 + 0.3 * Math.min(s, 1.2) - wetness) * feMult;
  fe = Math.max(0.04, Math.min(0.6, fe));
  // MULTIWAY: EVERY opponent has to fold for the bet to take it down. Treating
  // their folds as roughly independent, the chance they ALL fold is fe^oppCount —
  // so fold equity collapses fast as the field grows.
  if (oppCount > 1) fe = Math.max(0.02, Math.pow(fe, oppCount));
  // FLUSH DOMINATION: 3+ of a suit on the board and hero holds none of it. A made
  // flush never folds and the live flush draws keep calling, so betting almost
  // never takes it down — collapse fold equity to a sliver.
  if (flushDom) fe = Math.min(fe, 0.08);

  // EQUITY WHEN CALLED — derived from minimum-defence frequency. Against a bet of
  // `s` pots a defending villain continues with ~his strongest 1/(1+s) of range,
  // so the BIGGER the bet the TIGHTER and STRONGER the range that calls, and
  // hero's realised equity when called collapses toward (then past) a coin flip.
  // This is the term that makes over-bets and shoves -EV with a one-pair value
  // hand: you fold out everything you beat and get called only by what beats you.
  // Convex and UNCAPPED in size, so a 5–10x shove is punished far harder than a
  // ¾-pot bet — unlike a fixed penalty, which let the jam keep winning.
  const contFrac = 1 / (1 + Math.max(0, s));
  const rangeLift = 0.32 * (1 - contFrac); // strength gain of the continuing range
  // a shove reads scarier than the same chips as a bet, so the stack-off range is
  // a touch tighter — but only meaningfully once the shove is large vs the pot.
  // A sub-pot all-in (low SPR) is just a normal-sized bet and shouldn't be taxed
  // like a 10x overbet, so scale the tax with size.
  const allinTax = isAllIn ? 0.06 * Math.min(1, s) : 0;
  const multiTax = 0.04 * (oppCount - 1); // each extra caller tightens it further
  // when flush-dominated, the hands that CALL a bet are overwhelmingly the flushes
  // that crush hero — generic rangeLift (≤0.32) is far too small, so add a heavy
  // tax to push equity-when-called toward ~0. This is what stops the model from
  // jamming a no-flush hand into a flush board.
  const flushTax = flushDom ? 0.25 : 0;
  const e2 = Math.max(0, Math.min(1, e * realize) - rangeLift - allinTax - multiTax - flushTax);

  const calledPot = P + A + R;
  let ev = fe * P + (1 - fe) * (e2 * calledPot - A);

  // MULTI-STREET VALUE — the thing a single-street EV misses, and the reason a
  // sized value bet beats a jam on a dry board even though the immediate pot is
  // smaller. A value hand that bets a NON-all-in amount on the flop/turn keeps
  // worse hands in AND gets to bet again on a later street. That future value is
  // largest when MORE worse hands continue (i.e. for SMALLER bets — high contFrac)
  // and is FORGONE entirely by shoving (no next street). Bounded by the stack
  // behind, and faded on wet boards where you'd rather charge/fold draws now.
  let streetValue = 0;
  if (!isAllIn && cardsToCome > 0 && e > 0.55 && !flushDom) {
    const behind = Math.max(0, effStack - A); // wagerable on later streets
    const futureExtract = Math.min(behind, 0.5 * calledPot); // ~½-pot next street
    const edge = Math.max(0, Math.min(1, (e2 - 0.5) * 2)); // how far ahead of callers
    const dryness = Math.max(0, 1 - 3 * wetness); // dry boards keep worse hands around
    streetValue = (1 - fe) * contFrac * edge * futureExtract * 0.5 * dryness;
    ev += streetValue;
  }

  return { ev, fe, e2, calledPot, A, streetValue, contFrac };
}

/**
 * Probability hero WINS at showdown GIVEN the draw completes, vs the (conditioned)
 * villain range — the "clean outs" factor. On a wet board a draw can hit and still
 * lose (flush over your two pair, a higher two pair, a counterfeiting river), so
 * implied odds must be scaled by this rather than crediting every raw out.
 *
 * Seeded deterministically from hero+board so the discount (and the EV / HUD
 * verdict that read it) stay stable across re-renders of the same node.
 */
function winIfHit(hero: Card[], board: Card[], oppRange: WeightedRange, comboWeight?: ComboWeight, iters = 300): number {
  if (board.length >= 5) return 1;
  const outs = countOuts(hero, board).cards;
  if (!outs.length) return 1;
  const dead = [...hero, ...board];
  const table = buildSampleTable(oppRange, dead, comboWeight);
  if (table.total <= 0) return 1;
  let seed = 0x1a2b3c >>> 0;
  for (const c of dead) seed = (seed ^ Math.imul(c.rank * 4 + c.suit + 1, 0x9e3779b1)) >>> 0;
  const rng = makeRng(seed >>> 0 || 1);
  let wins = 0;
  let n = 0;
  for (let i = 0; i < iters; i++) {
    const out = outs[Math.floor(rng() * outs.length)]; // condition on a hit
    const opp = sampleCombo(table, rng);
    if (!opp) continue;
    if (sameCard(opp[0], out) || sameCard(opp[1], out)) continue; // villain holds the out
    const b2 = [...board, out];
    const used = [...hero, ...b2, opp[0], opp[1]];
    const deck = makeDeck().filter((d) => !used.some((u) => sameCard(u, d)));
    const need = 5 - b2.length;
    const fb = b2.slice();
    let top = deck.length;
    for (let k = 0; k < need; k++) {
      const j = Math.floor(rng() * top);
      fb.push(deck[j]);
      deck[j] = deck[top - 1];
      top--;
    }
    const hs = evaluate7([...hero, ...fb]).score;
    const os = evaluate7([opp[0], opp[1], ...fb]).score;
    n++;
    if (hs > os) wins += 1;
    else if (hs === os) wins += 0.5;
  }
  return n > 0 ? wins / n : 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
