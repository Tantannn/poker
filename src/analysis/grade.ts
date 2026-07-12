// Grades a hero action against the heuristic strategy: EV loss, RNG match,
// and a verdict. Replaces the old chart-only feedback with solver-model output.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { evLoss as computeEvLoss, rngPrescription } from '../strategy/types';
import { matchActionId, primaryVillainIdx } from '../strategy';
import { describeTexture, boardWetness } from '../engine/board';
import { classifyHandClass } from '../strategy/handClass';
import { getProfile } from '../ai/profiles';
import type { ActionClass } from './feedback';
import type { MoveTier } from '../store/stats';
import { moveTier, TIER } from '../store/stats';

// The grade uses the same five GTOW-style tiers as the session scorecard.
export type Verdict = MoveTier;

const HEADLINE: Record<Verdict, (loss: number) => string> = {
  best: () => '✓ Best — top of the solver line',
  correct: (l) => `✓ Correct — sound line (−${l.toFixed(2)} bb vs best)`,
  inaccuracy: (l) => `≈ Inaccuracy (−${l.toFixed(2)} bb vs best)`,
  wrong: (l) => `✗ Wrong — a costly line (−${l.toFixed(2)} bb vs best)`,
  blunder: (l) => `✗✗ Blunder (−${l.toFixed(2)} bb vs best)`,
};

/** Decision-time context captured for the gameplan/feedback explainer. */
export interface FeedbackContext {
  street: string;
  facing: string; // e.g. "first to act", "facing a check", "facing a bet of 6 (3.0bb)"
  position: string;
  villainName: string;
  villainTag: string;
  boardLabel: string;
  /** dry / semi-wet / wet — the sizing-relevant type ('' preflop). */
  boardType: string;
  boardSentence: string;
  boardFavours: string;
  handLabel: string;
  handBlurb: string;
  handStrength: number;
  potBB: number;
  toCallBB: number;
}

export interface NodeFeedback {
  verdict: Verdict;
  chosen: ActionId;
  chosenLabel: string;
  best: ActionId;
  bestLabel: string;
  evLoss: number;
  chosenEv: number;
  roll: number;
  prescribed: ActionId;
  prescribedLabel: string;
  rngMatch: boolean;
  equity?: number;
  headline: string;
  detail: string;
  /** A punchy one-liner shown when a bet/raise was oversized vs the best line —
   *  names the value-own (equity-when-called drop) + the multiway caution. */
  coach?: string;
  strategy: NodeStrategy;
  context?: FeedbackContext;
}

const pctOf = (f: number) => `${Math.round(f * 100)}%`;
const isAggro = (id: ActionId) => id.startsWith('bet') || id.startsWith('raise') || id === 'allin';

/** GTO give-up guard: a CHECK/FOLD of a stone-cold air hand (strength 0) when the
 *  solver's best line is a bet is a "declining to bluff" — ~free at equilibrium, yet
 *  the turn model over-penalises it (a hero check is scored as an instant showdown,
 *  no river subgame). gradeNode uses this to clamp the penalty into the sound-line
 *  band. Scoped to postflop-model + true air so it never softens a real error (e.g.
 *  checking a made hand that should value-bet keeps its full penalty). */
export function isFreeGiveUp(
  strategy: NodeStrategy,
  chosen: ActionId,
  handStrength: number | null,
): boolean {
  if (strategy.source !== 'postflop-model') return false;
  if (chosen !== 'check' && chosen !== 'fold') return false;
  if (handStrength !== 0) return false;
  const bestOpt = strategy.options.find((o) => o.id === strategy.bestId);
  return !!bestOpt && isAggro(bestOpt.id);
}

/** Oversizing coach: fires only when hero bet/raised BIGGER than the best line
 *  and it cost EV. Surfaces the reason a big bet backfires — worse hands fold,
 *  so only stronger hands call and hero's equity-when-called drops (value-own) —
 *  plus a multiway caution. Returns undefined when it doesn't apply. */
// One-pair made-hand labels (not two-pair+/sets) — a medium tier that sizes
// small even on a wet board. Used to make the size lesson concrete.
const ONE_PAIR_LABEL = /(Top Pair|Middle Pair|Bottom Pair|Pocket Pair|Pair of)/;

export function buildSizingCoach(
  strategy: NodeStrategy,
  chosen: ActionId,
  loss: number,
  nOpp: number,
  handLabel?: string,
): string | undefined {
  if (loss <= 0.05 || !isAggro(chosen)) return undefined;
  const chosenOpt = strategy.options.find((o) => o.id === chosen);
  const bestOpt = strategy.options.find((o) => o.id === strategy.bestId);
  if (!chosenOpt || !bestOpt) return undefined;
  const chosenSize = chosenOpt.sizePct ?? 0;
  const bestSize = bestOpt.sizePct ?? 0; // check/call have none → treat as 0
  if (chosenSize <= bestSize) return undefined; // only coach OVER-sizing

  // Built as " • "-delimited segments: a lead line + bullet points (rendered as
  // a dot list in the Explain panel).
  const bullets: string[] = [];
  if (
    chosenOpt.calledEq != null &&
    bestOpt.calledEq != null &&
    chosenOpt.calledEq < bestOpt.calledEq - 0.005
  ) {
    bullets.push(
      `Worse hands fold to the bigger size, so only stronger hands call — your equity-when-called drops ${pctOf(bestOpt.calledEq)} → ${pctOf(chosenOpt.calledEq)}. You bet more into a range that beats you more.`,
    );
  } else {
    bullets.push(`A bigger bet folds out the worse hands you wanted to call and gets called mostly by what beats you.`);
  }
  bullets.push(`Size to the worst hand that still calls — oversizing folds out your customers.`);
  if (nOpp > 1) {
    bullets.push(
      `Multiway (${nOpp} opponents) — someone is likelier to actually have it: size down, or check with anything short of premium value.`,
    );
  }

  // The core lesson: SIZE comes from hand strength, not board wetness. A wet
  // board is a reason to BET (charge draws), never a reason to bet big — one
  // pair sizes small even when wet; big sizes are for the strong tier.
  const onePair = handLabel != null && ONE_PAIR_LABEL.test(handLabel) && !/Two Pair/.test(handLabel);
  bullets.push(
    onePair
      ? `Your size comes from HAND STRENGTH, not the board. ${handLabel} is one pair — a medium hand that sizes small (⅓–½ pot) even on a wet board. Big sizes (⅔–pot) are for two-pair+, sets and overpairs, where worse hands still call and you're ahead when called. A wet board means BET (charge draws), not bet big.`
      : `Your size comes from HAND STRENGTH, not the board. A wet board is a reason to bet (charge draws) — your hand decides how big. Big sizes are for the strong tier (two-pair+, sets, overpairs); one pair sizes small even when wet.`,
  );
  // The reusable mental tool.
  bullets.push(
    `The size-up test — before betting bigger, ask: would WORSE hands still call it? Yes → big is fine (value + protection). No → you only fold worse and get called by better, so size down.`,
  );

  const lead = `⚠ Too big — ${bestOpt.label} beat ${chosenOpt.label} by ${loss.toFixed(2)} bb.`;
  return [lead, ...bullets].join(' • ');
}

/** Build the rich gameplan context from the live state at the hero's decision. */
export function buildFeedbackContext(state: GameState, heroIdx: number): FeedbackContext {
  const bb = state.bigBlind;
  const la = legalActions(state);
  const pos = positionLabel(heroIdx, state.buttonIndex, state.players.length);
  const tex = describeTexture(state.board);
  const boardType =
    state.board.length < 3 ? '' : { dry: 'Dry', semi: 'Semi-wet', wet: 'Wet' }[boardWetness(state.board)];
  const hand = classifyHandClass(state.players[heroIdx].holeCards, state.board);

  const vIdx = primaryVillainIdx(state, heroIdx);
  const villain = vIdx >= 0 ? state.players[vIdx] : null;
  const villainName = villain ? villain.name : 'the field';
  const villainTag = villain && !villain.isHero ? getProfile(villain.profileId).tag : '';

  let facing: string;
  if (la.callAmount > 0) {
    facing = `facing a bet of ${la.callAmount} (${(la.callAmount / bb).toFixed(1)}bb)`;
  } else if (state.street === 'preflop') {
    facing = 'preflop, action on you';
  } else {
    const aggressedThisStreet = state.lastAggressor >= 0 && state.lastAggressor !== heroIdx;
    facing = aggressedThisStreet ? 'facing a check' : 'first to act';
  }

  return {
    street: state.street,
    facing,
    position: pos,
    villainName,
    villainTag,
    boardLabel: tex.label,
    boardType,
    boardSentence: tex.sentence,
    boardFavours: tex.favours,
    handLabel: hand.label,
    handBlurb: hand.blurb,
    handStrength: hand.strength,
    potBB: potTotal(state) / bb,
    toCallBB: la.callAmount / bb,
  };
}

export function idToClass(id: ActionId): ActionClass {
  if (id === 'fold') return 'fold';
  if (id === 'check') return 'check';
  if (id === 'call') return 'call';
  return 'raise';
}

function labelFor(strategy: NodeStrategy, id: ActionId): string {
  return strategy.options.find((o) => o.id === id)?.label ?? id;
}

export function gradeNode(
  strategy: NodeStrategy,
  action: Action,
  callAmount: number,
  roll: number,
  ctx?: { state: GameState; heroIdx: number },
): NodeFeedback {
  const chosen = matchActionId(strategy, action, callAmount);
  let loss = computeEvLoss(strategy, chosen);
  const chosenEv = evOf(strategy, chosen);
  const prescribed = rngPrescription(strategy, roll);

  // Hand class (air / draw / made) at this node — reused for the give-up guard
  // below and the sizing coach further down.
  const hand = ctx ? classifyHandClass(ctx.state.players[ctx.heroIdx].holeCards, ctx.state.board) : null;

  // GTO give-up guard (see isFreeGiveUp): the turn model over-penalises declining to
  // bluff stone-cold air, because it scores a hero check as an instant showdown. When
  // it applies, clamp the penalty into the "sound line" band — live AND in the
  // scorecard, which re-derives the tier from this same evLoss.
  const softenedGiveUp = isFreeGiveUp(strategy, chosen, hand?.strength ?? null) && loss > TIER.correct;
  if (softenedGiveUp) loss = TIER.correct;

  let verdict: Verdict = moveTier(loss, chosenEv);
  // Preflop CHART EVs are relative estimates, NOT solved — so a tiny EV gap can hide
  // a real leak. Grade chart deviations by FREQUENCY instead: taking an action the
  // chart almost never plays (e.g. folding AJo when it's a pure ~100% call) is at
  // least an inaccuracy, never "✓ Correct — sound line". Legit MIXED spots are spared
  // (folding a 40%-fold hand stays fine) because the chosen action still has weight.
  if (strategy.source === 'preflop-chart' && chosen !== strategy.bestId) {
    const chosenFreq = strategy.options.find((o) => o.id === chosen)?.freq ?? 0;
    const bestFreq = strategy.options.find((o) => o.id === strategy.bestId)?.freq ?? 0;
    if (chosenFreq < 0.15 && bestFreq >= 0.6 && (verdict === 'best' || verdict === 'correct')) {
      verdict = 'inaccuracy';
    }
  }

  const headline = HEADLINE[verdict](loss);

  const bestLabel = labelFor(strategy, strategy.bestId);
  const chosenLabel = labelFor(strategy, chosen);
  const rngMatch = chosen === prescribed;

  let detail: string;
  if (softenedGiveUp) {
    detail = `Giving up is fine — you're never forced to bluff. The model rates ${bestLabel} higher mainly because it scores a check as an instant turn showdown (no river), which understates a give-up. Checking air is a sound, low-cost line.`;
  } else if (verdict === 'best' || verdict === 'correct') {
    const lead = verdict === 'best' ? '' : `A fine alternative (−${loss.toFixed(2)} bb). `;
    detail = lead + (strategy.source === 'preflop-chart'
      ? `${strategy.rangeNote}: ${bestLabel} is the standard line.`
      : `Highest-EV action was ${bestLabel}.`);
  } else {
    const head = `Best was ${bestLabel} (${fmtEv(evOf(strategy, strategy.bestId))} bb) vs your ${chosenLabel} (${fmtEv(
      evOf(strategy, chosen),
    )} bb).`;
    // Postflop carries a bulleted `notes` list (rendered in the Explain panel),
    // so don't also glue the paragraph here — it used to show up twice. Preflop
    // has no bullets, so keep the one-line note inline.
    detail = strategy.notes?.length ? head : `${head} ${strategy.note}`;
  }

  const nOpp = ctx
    ? ctx.state.players.filter((p, i) => i !== ctx.heroIdx && !p.folded).length
    : 1;
  const handLabel = hand?.label;

  return {
    verdict,
    chosen,
    chosenLabel,
    best: strategy.bestId,
    bestLabel,
    evLoss: loss,
    chosenEv,
    roll,
    prescribed,
    prescribedLabel: labelFor(strategy, prescribed),
    rngMatch,
    equity: strategy.equity,
    headline,
    detail,
    coach: buildSizingCoach(strategy, chosen, loss, nOpp, handLabel),
    strategy,
    context: ctx ? buildFeedbackContext(ctx.state, ctx.heroIdx) : undefined,
  };
}

function evOf(strategy: NodeStrategy, id: ActionId): number {
  return strategy.options.find((o) => o.id === id)?.ev ?? 0;
}
function fmtEv(x: number): string {
  return (x >= 0 ? '+' : '') + x.toFixed(2);
}
