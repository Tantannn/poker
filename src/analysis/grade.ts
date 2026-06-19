// Grades a hero action against the heuristic strategy: EV loss, RNG match,
// and a verdict. Replaces the old chart-only feedback with solver-model output.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { evLoss as computeEvLoss, rngPrescription } from '../strategy/types';
import { matchActionId, primaryVillainIdx } from '../strategy';
import { describeTexture } from '../engine/board';
import { classifyHandClass } from '../strategy/handClass';
import { getProfile } from '../ai/profiles';
import type { ActionClass } from './feedback';
import type { MoveTier } from '../store/stats';
import { moveTier } from '../store/stats';

// The grade uses the same five GTOW-style tiers as the session scorecard.
export type Verdict = MoveTier;

const HEADLINE: Record<Verdict, (loss: number) => string> = {
  best: () => '✓ Best — top of the solver line',
  correct: (l) => `✓ Correct — sound line (−${l.toFixed(2)} bb vs best)`,
  inaccuracy: (l) => `≈ Inaccuracy (−${l.toFixed(2)} bb vs best)`,
  wrong: (l) => `✗ Wrong — your line is -EV (−${l.toFixed(2)} bb vs best)`,
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
  strategy: NodeStrategy;
  context?: FeedbackContext;
}

/** Build the rich gameplan context from the live state at the hero's decision. */
export function buildFeedbackContext(state: GameState, heroIdx: number): FeedbackContext {
  const bb = state.bigBlind;
  const la = legalActions(state);
  const pos = positionLabel(heroIdx, state.buttonIndex, state.players.length);
  const tex = describeTexture(state.board);
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
  const loss = computeEvLoss(strategy, chosen);
  const chosenEv = evOf(strategy, chosen);
  const prescribed = rngPrescription(strategy, roll);

  const verdict: Verdict = moveTier(loss, chosenEv);

  const headline = HEADLINE[verdict](loss);

  const bestLabel = labelFor(strategy, strategy.bestId);
  const chosenLabel = labelFor(strategy, chosen);
  const rngMatch = chosen === prescribed;

  let detail: string;
  if (verdict === 'best' || verdict === 'correct') {
    const lead = verdict === 'best' ? '' : `A fine alternative (−${loss.toFixed(2)} bb). `;
    detail = lead + (strategy.source === 'preflop-chart'
      ? `${strategy.rangeNote}: ${bestLabel} is the standard line.`
      : `Highest-EV action was ${bestLabel}.`);
  } else {
    detail = `Best was ${bestLabel} (${fmtEv(evOf(strategy, strategy.bestId))} bb) vs your ${chosenLabel} (${fmtEv(
      evOf(strategy, chosen),
    )} bb). ${strategy.note}`;
  }

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
