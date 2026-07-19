// Plan-commit engine. Powers the drill where the hero commits a WHOLE-HAND line on
// the flop — size now, plus a conditional barrel policy for the turn and river — and
// is then graded street-by-street against the solver's best action on the actual
// runout. Teaches planning (which turns/rivers to keep firing) rather than reacting
// one node at a time. Pure, React-free helpers so they're unit-testable; the heavy
// solver orchestration lives in the component.

import type { Card } from '../engine/cards';
import { evaluate7 } from '../engine/evaluator';
import type { ActionId } from './types';

/** A committed line. `flop` is the concrete first action; `turn`/`river` are policies
 *  applied to whatever card comes; `vsRaise` is the response if villain raises. */
export type FlopAction = 'check' | 'bet33' | 'bet50' | 'bet75' | 'betpot';
export type BarrelPolicy = 'barrel' | 'selective' | 'giveup';

export interface Plan {
  flop: FlopAction;
  vsRaise: 'fold' | 'call' | 'jam';
  turn: BarrelPolicy;
  river: BarrelPolicy;
}

export const DEFAULT_PLAN: Plan = { flop: 'bet50', vsRaise: 'call', turn: 'selective', river: 'selective' };

/** The bet size a barrel uses on later streets (half-pot is the standard continuation). */
export const BARREL_ID: ActionId = 'bet50';

/** A "scare card" for the aggressor: it either completes a flush (a 3rd card of a suit
 *  already twice on board), pairs the board, or is an overcard to the previous top —
 *  the cards that shift range advantage and are the classic barrel triggers. */
export function isScareCard(newCard: Card, prevBoard: Card[]): boolean {
  const suitCount = prevBoard.filter((c) => c.suit === newCard.suit).length;
  if (suitCount >= 2) return true; // brings a 3-flush (or completes one)
  if (prevBoard.some((c) => c.rank === newCard.rank)) return true; // pairs the board
  const top = Math.max(...prevBoard.map((c) => c.rank));
  return newCard.rank > top; // an overcard
}

/** Did the new card improve hero's made-hand category vs the previous board? */
export function heroImproved(hero: Card[], prevBoard: Card[], newBoard: Card[]): boolean {
  return evaluate7([...hero, ...newBoard]).categoryRank > evaluate7([...hero, ...prevBoard]).categoryRank;
}

/** Resolve a barrel policy on a specific card into "do I bet?": barrel = always,
 *  giveup = never, selective = only on a scare card or when I improved. */
export function policyBets(policy: BarrelPolicy, ctx: { scare: boolean; improved: boolean }): boolean {
  if (policy === 'barrel') return true;
  if (policy === 'giveup') return false;
  return ctx.scare || ctx.improved;
}

/** The concrete ActionId a later-street policy resolves to for grading. */
export function policyActionId(policy: BarrelPolicy, ctx: { scare: boolean; improved: boolean }): ActionId {
  return policyBets(policy, ctx) ? BARREL_ID : 'check';
}

export const FLOP_LABEL: Record<FlopAction, string> = {
  check: 'Check',
  bet33: 'Bet ⅓ pot',
  bet50: 'Bet ½ pot',
  bet75: 'Bet ¾ pot',
  betpot: 'Bet pot',
};

export const POLICY_LABEL: Record<BarrelPolicy, string> = {
  barrel: 'Barrel every card',
  selective: 'Barrel only scare / improve cards',
  giveup: 'Check / give up',
};
