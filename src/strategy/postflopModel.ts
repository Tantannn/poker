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
function classifyBet(e: number, outs: number, hasMade: boolean): BetClass {
  // value / thin value require an actual MADE hand (pair or better). A big draw can
  // sit at >60% equity vs a wide range, but it's a SEMI-BLUFF, not a value bet — so
  // it must NOT borrow the made-hand "you're ahead, get worse hands to call" story
  // (worse hands FOLD to the bet; the draw wins by folds + improving, not by calls).
  if (hasMade && e >= 0.62) return 'value';
  if (hasMade && e >= 0.5) return 'thin';
  if (e >= 0.3 || outs >= 4) return 'semibluff';
  return 'bluff';
}
// kind drives grid/bar color; we keep the existing 2-tone (value vs bluff).
const classKind = (c: BetClass): ActionOption['kind'] => (c === 'value' || c === 'thin' ? 'value' : 'bluff');

/** Flush-domination LEVEL: the count (0, 3, 4 or 5) of a single suit on the board
 *  that hero holds NONE of. It matters how many, because the threat is very
 *  different by count:
 *   • 4–5 on board: ANY opponent with a single card of the suit already HAS a made
 *     flush hero can't beat — the calling/raising range is a wall of flushes, so a
 *     no-flush bet almost never wins (a trap the generic model under-rates).
 *   • exactly 3 (a monotone / 3-flush flop): a MADE flush needs BOTH of villain's
 *     hole cards to be that suit — rare. Most in-suit hands are single-suit DRAWS
 *     that hero's made hand still beats, so betting to charge/deny them is fine;
 *     only a mild discount is warranted, not the 4-flush collapse.
 *  (At most one suit can reach 3+ on a ≤5-card board.) 0 = not flush-dominated. */
function flushDomLevel(hero: Card[], board: Card[]): number {
  const counts = [0, 0, 0, 0];
  for (const c of board) counts[c.suit]++;
  let level = 0;
  for (let s = 0; s < 4; s++) {
    if (counts[s] >= 3 && !hero.some((h) => h.suit === s)) level = Math.max(level, counts[s]);
  }
  return level;
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
  // does hero hold a MADE hand (pair or better)? gates value-vs-semibluff labelling
  // so a high-equity DRAW is called a semi-bluff, not a value bet.
  const hasMade = inp.board.length >= 3 && evaluate7([...inp.hero, ...inp.board]).categoryRank >= 1;

  const tex = inp.board.length >= 3 ? classifyFlop(inp.board) : null;
  const wetness =
    tex == null
      ? 0
      : (tex.connected ? 0.06 : 0) + (tex.suitPattern !== 'rainbow' ? 0.05 : 0) + (tex.paired ? -0.03 : 0);

  // hero can't make the board flush and holds none of it → flush-dominated (see
  // helper). The LEVEL (3 vs 4+) scales the fold-equity/equity-when-called penalty
  // in computeAggro; `flushDom` (level ≥ 3) drives the qualitative "no redraw" read.
  const flushLevel = inp.board.length >= 3 ? flushDomLevel(inp.hero, inp.board) : 0;
  const flushDom = flushLevel >= 3;

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
    const posClause = inp.position
      ? ` (${ip ? 'in position you realise it well — you can check back and take a free card' : 'out of position you realise less — villain can barrel you off it'})`
      : '';
    const checkBase = `Realize your ~${pct(e)} equity in a ${P}-chip pot without risking more${posClause}.`;
    // Reason to check depends on WHY betting is worse — a strong made hand can be
    // best-checked on a dangerous board, which is NOT the same as "no edge".
    const checkWhy =
      flushDom && e >= 0.5
        ? `${checkBase} You're AHEAD now — but the board is flush-heavy and you hold NONE of that suit, so you have no redraw. Betting folds out the hands you beat and gets called or raised by the made flushes & flush draws that crush or outdraw you. Check to pot-control, keep his bluffs in, and don't bloat a pot you can't safely build with a no-flush hand.`
        : e >= 0.6
          ? `${checkBase} You're ahead, but betting here mostly folds out the worse hands you beat and bloats the pot against the part of his range that continues. Checking captures more by keeping his weaker hands and bluffs in while you control the pot.`
          : `${checkBase} Best when you're not ahead enough to bet for value or to profitably pressure.`;
    cands.push({
      id: 'check',
      label: 'Check',
      ev: (eReal * P) / bb,
      kind: 'passive',
      why: checkWhy,
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
    const d = computeAggro(eHU, P, C, target, inp.currentBet, inp.heroCommitted, wetness, false, realize, feMult, nOpp, effStack, cardsToCome, e, flushLevel);
    const cls = classifyBet(eHU, outs, hasMade);
    const sv = d.streetValue > 0.05;
    cands.push({
      id,
      label,
      ev: d.ev / bb,
      amount: target,
      sizePct: Math.round((100 * (target - inp.currentBet)) / Math.max(1, potForSize)),
      kind: classKind(cls),
      why: whyBet(cls, eHU, d, outs, false, isRiver, frac),
      math: `EV = ${d.evLabel}${sv ? ' + multi-street value' : ''}\n   = ${d.evExpr}${sv ? ` + ${d.streetValue.toFixed(1)}` : ''}\n   = ${d.ev.toFixed(1)} chips ≈ ${(d.ev / bb).toFixed(2)} bb${sv ? `\n   (~${Math.round(d.contFrac * 100)}% of his range calls this size; the rest folds — a smaller bet keeps more worse hands in to pay later streets)` : d.isThinValue ? `\n   (river: worse hands call and pay the bet, better hands call and beat you — betting profits only when more worse call than better)` : ''}`,
    });
  };

  addBet('bet33', 0.33, C === 0 ? 'Bet 33%' : 'Raise 33%');
  addBet('bet75', 0.75, C === 0 ? 'Bet 75%' : 'Raise 75%');
  addBet('betpot', 1.0, C === 0 ? 'Bet pot' : 'Raise pot');

  if (inp.canRaise && inp.maxRaiseTo > inp.currentBet) {
    const d = computeAggro(eHU, P, C, inp.maxRaiseTo, inp.currentBet, inp.heroCommitted, wetness, true, realize, feMult, nOpp, effStack, cardsToCome, e, flushLevel);
    const cls = classifyBet(eHU, outs, hasMade);
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
      math: `EV = ${d.evExpr} = ${d.ev.toFixed(1)} chips ≈ ${rawEv.toFixed(2)} bb\n   ${
        d.isThinValue
          ? `river shove: worse hands FOLD and better hands CALL, so a jam prints only when more worse hands call than better — it can't fold out a made hand for value.`
          : `only ~${Math.round(d.contFrac * 100)}% of his range calls a shove (the strong part), so eq-when-called is just ${pct1(d.e2)}; and a jam forgoes all later-street value.`
      }\n   − ${RISK.toFixed(1)} bb risk premium (SPR ${spr.toFixed(1)}) → ${adjEv.toFixed(2)} bb`,
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
    note: `You win about ${Math.round(e * 100)}% of the time if the hand just gets checked down${nOpp > 1 ? `, because in a ${nOpp}-way pot you have to beat everyone at once` : ''}.${nOpp > 1 && !isRiver ? ` The key idea: betting chases the weak hands out. With fewer players left in, your hand wins more often — so a bet can be worth more than checking, even when your hand doesn't look strong yet. A small bet is cheap and stops opponents from getting a free card.` : ''}${isRiver ? ` It's the river, so no more cards are coming. Betting only helps if more worse hands call than better ones — so a so-so hand is better off just checking.` : ''}${inp.effStack != null ? (spr < 1 ? ` Not much money is left behind, so the hand plays out fast.` : ` There's a lot of money left behind, so a draw that hits can win a big pot — and going all-in risks a lot.`) : ''} Bigger bets only get called by stronger hands, so betting huge or shoving usually isn't rewarded here. This is a quick estimate to guide you, not a perfect solver.`,
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
  /** the EV formula for THIS branch — symbolic form + the numbers plugged in — so the
   *  displayed math matches what was actually computed. The flop/turn branch and the
   *  river thin-value branch use different formulas; each supplies its own here rather
   *  than letting solvePostflop print one hardcoded template that only fits the former. */
  evLabel: string;
  evExpr: string;
  /** river thin-value branch (no more cards): worse hands fold, better hands call — a
   *  different EV structure and a different all-in story than a flop/turn shove. */
  isThinValue: boolean;
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
  flushLevel = 0, // 0 = not flush-dominated; 3 = monotone/3-flush (mild); 4+ = made-flush wall
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
    // river math is a thin-value increment, NOT the generic fold-equity template —
    // print the formula that was actually evaluated so the panel can't contradict it.
    const evLabel = `showdown share × pot + bet × (worse hands that call) − you invest × (better hands that call)`;
    const evExpr = `${pct1(base)} × ${P} + ${R} × ${pct1(Cw)} − ${A} × ${pct1(Cb)}`;
    return { ev: evr, fe: fer, e2: e2r, calledPot: P + A + R, A, streetValue: 0, contFrac: cont, evLabel, evExpr, isThinValue: true };
  }

  // ---- CONTINUE vs FOLD frequency: ONE model, shared by the EV pot-split, the
  // equity-when-called (e2) below, AND the displayed math ----
  // Minimum-defence: against a bet of `s` pots a villain continues with ~his
  // strongest 1/(1+s) of range. This single number is the source of truth for "how
  // often is hero called", so the EV split and the range strength can no longer
  // disagree. (The OLD code split the pot on a SEPARATE saturating fold-equity term
  // while deriving e2 from contFrac — for a shove that printed "76% called" in the EV
  // yet "4% continues" in the note: the same event with two numbers, which let the
  // jam bank a huge called-pot it almost never actually reaches.)
  let contFrac = 1 / (1 + Math.max(0, s));
  // FLUSH DOMINATION, graded by level. Hero holds none of the board suit: on a 4+
  // flush board villain's one-card flushes never fold → he continues almost always;
  // on a 3-flush/monotone board a made flush needs both his cards suited (rare) and
  // the rest are draws, so only a mild FLOOR on how often he continues.
  if (flushLevel >= 4) contFrac = Math.max(contFrac, 0.92);
  else if (flushLevel === 3) contFrac = Math.max(contFrac, 0.72);
  // MULTIWAY: the bet only wins UNCONTESTED if EVERY opponent folds, so someone
  // continuing is likelier as the field grows — P(≥1 continues) = 1 − (1−contFrac)^n.
  if (oppCount > 1) contFrac = 1 - Math.pow(1 - contFrac, oppCount);
  // POSITION & TEXTURE nudge — small and ADDITIVE, so it can't swing a shove's
  // call-rate (a multiplicative factor near contFrac≈1 would). In position hero's
  // bets fold a hair more out (lower contFrac), out of position a hair fewer; a wet
  // board keeps more draws in (higher contFrac).
  contFrac = Math.max(0.02, Math.min(0.98, contFrac + (1 - feMult) * 0.15 + wetness));
  const fe = 1 - contFrac; // fold frequency == fold equity — the ONE number, used & shown

  // EQUITY WHEN CALLED — built on the SAME contFrac. Against a bigger bet the
  // continuing range is TIGHTER and STRONGER (1/(1+s) shrinks), so hero's realised
  // equity when called collapses toward (then past) a coin flip. This is what makes
  // over-bets and shoves -EV with a one-pair value hand: you fold out everything you
  // beat and get called only by what beats you. Convex and UNCAPPED in size, so a
  // 5–10x shove is punished far harder than a ¾-pot bet.
  const rangeLift = 0.32 * (1 - contFrac); // strength gain of the continuing range
  // a shove reads scarier than the same chips as a bet, so the stack-off range is
  // a touch tighter — but only meaningfully once the shove is large vs the pot.
  // A sub-pot all-in (low SPR) is just a normal-sized bet and shouldn't be taxed
  // like a 10x overbet, so scale the tax with size.
  const allinTax = isAllIn ? 0.06 * Math.min(1, s) : 0;
  const multiTax = 0.04 * (oppCount - 1); // each extra caller tightens it further
  // when flush-dominated, the hands that CALL a bet skew to the suit. On a 4+ flush
  // board those are made flushes that crush hero — generic rangeLift (≤0.32) is far
  // too small, so a heavy tax pushes equity-when-called toward ~0 (this is what stops
  // the model jamming a no-flush hand into a made-flush board). On a 3-flush board the
  // callers are mostly DRAWS hero still beats, so only a small tax.
  const flushTax = flushLevel >= 4 ? 0.25 : flushLevel === 3 ? 0.08 : 0;
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
  if (!isAllIn && cardsToCome > 0 && e > 0.55 && flushLevel < 4) {
    const behind = Math.max(0, effStack - A); // wagerable on later streets
    const futureExtract = Math.min(behind, 0.5 * calledPot); // ~½-pot next street
    const edge = Math.max(0, Math.min(1, (e2 - 0.5) * 2)); // how far ahead of callers
    const dryness = Math.max(0, 1 - 3 * wetness); // dry boards keep worse hands around
    // contFrac === (1 − fe) now, so this is the single "worse hands that continue and
    // pay a later street" factor (the old code multiplied both and double-counted it).
    streetValue = contFrac * edge * futureExtract * 0.5 * dryness;
    ev += streetValue;
  }

  const evLabel = `fold% × pot + called% × (eq-when-called × final pot − you invest)`;
  const evExpr = `${pct1(fe)} × ${P} + ${pct1(1 - fe)} × (${pct1(e2)} × ${calledPot} − ${A})`;
  return { ev, fe, e2, calledPot, A, streetValue, contFrac, evLabel, evExpr, isThinValue: false };
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
