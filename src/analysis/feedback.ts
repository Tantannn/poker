// Post-decision feedback: compares the hero's action against a simple,
// transparent baseline (preflop charts + equity-vs-pot-odds postflop).
// Not a true solver, but a consistent yardstick to surface leaks.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import { equityVsRange, equityVsField } from '../engine/equity';
import { potOdds } from '../engine/potOdds';
import { countOuts, ruleOf2and4 } from '../engine/equity';
import { handCode, preflopStrength, RFI_RANGES, THREEBET_RANGE } from '../ai/preflop';
import { buildVillainRange } from '../strategy';

export type ActionClass = 'fold' | 'check' | 'call' | 'raise';
export type Verdict = 'correct' | 'ok' | 'mistake';

export interface Recommendation {
  action: ActionClass;
  reason: string;
}

export interface DecisionFeedback {
  verdict: Verdict;
  heroAction: ActionClass;
  recommended: ActionClass;
  headline: string;
  detail: string;
  equity?: number;
  requiredEquity?: number;
  outs?: number;
}

function classify(a: Action, callAmount: number): ActionClass {
  if (a.type === 'fold') return 'fold';
  if (a.type === 'bet' || a.type === 'raise') return 'raise';
  if (a.type === 'call') return callAmount > 0 ? 'call' : 'check';
  return 'check';
}

export function recommend(state: GameState): Recommendation & {
  equity?: number;
  requiredEquity?: number;
  outs?: number;
} {
  const i = state.toAct;
  const p = state.players[i];
  const la = legalActions(state);
  const pos = positionLabel(i, state.buttonIndex, state.players.length);
  const pot = potTotal(state);

  if (state.street === 'preflop') {
    const code = handCode(p.holeCards);
    const strength = preflopStrength(code);
    const facingRaise = state.currentBet > state.bigBlind;
    const inRFI = RFI_RANGES[pos]?.has(code) ?? false;

    if (!facingRaise) {
      if (la.callAmount === 0) {
        // BB option / limped pot
        if (strength > 0.8) return { action: 'raise', reason: `${code} is a premium — raise for value.` };
        return { action: 'check', reason: `Take the free flop with ${code}; no need to bloat the pot.` };
      }
      if (inRFI) return { action: 'raise', reason: `${code} is in the ${pos} opening range — raise first in.` };
      return { action: 'fold', reason: `${code} is outside a solid ${pos} opening range — fold.` };
    }

    // facing a raise
    if (THREEBET_RANGE.has(code) || strength > 0.86)
      return { action: 'raise', reason: `${code} is strong enough to 3-bet for value.` };
    const odds = potOdds(pot, la.callAmount);
    if (strength > 0.62 && odds.requiredEquity < 0.35)
      return { action: 'call', reason: `${code} plays well enough to call and see a flop in position.` };
    return { action: 'fold', reason: `${code} is too weak to continue versus a raise — fold.` };
  }

  // postflop — equity vs the opponent's actual range (not random cards), so this
  // advice lines up with the HUD, solver and bots.
  const { range, comboWeight } = buildVillainRange(state, p.id);
  const opps = liveOpp(state, p.id);
  const eq =
    opps > 1
      ? equityVsField(p.holeCards, state.board, Array.from({ length: opps }, () => range), 2000, Math.random, comboWeight).equity
      : equityVsRange(p.holeCards, state.board, range, 2000, Math.random, comboWeight).equity;
  const outsInfo = countOuts(p.holeCards, state.board);

  if (la.callAmount > 0) {
    const odds = potOdds(pot, la.callAmount);
    if (eq > 0.62 && la.canRaise)
      return {
        action: 'raise',
        reason: `Your ~${pct(eq)} equity is ahead — raise for value/protection.`,
        equity: eq,
        requiredEquity: odds.requiredEquity,
        outs: outsInfo.outs,
      };
    if (eq >= odds.requiredEquity)
      return {
        action: 'call',
        reason: `~${pct(eq)} equity beats the ${pct(odds.requiredEquity)} you need — call is +EV.`,
        equity: eq,
        requiredEquity: odds.requiredEquity,
        outs: outsInfo.outs,
      };
    return {
      action: 'fold',
      reason: `~${pct(eq)} equity is below the ${pct(odds.requiredEquity)} the pot odds require — fold.`,
      equity: eq,
      requiredEquity: odds.requiredEquity,
      outs: outsInfo.outs,
    };
  }

  // can check or bet
  if (eq > 0.6)
    return {
      action: 'raise',
      reason: `~${pct(eq)} equity — bet for value while you're ahead.`,
      equity: eq,
      outs: outsInfo.outs,
    };
  if (outsInfo.outs >= 8)
    return {
      action: 'raise',
      reason: `Strong draw (${outsInfo.outs} outs, ~${ruleOf2and4(
        outsInfo.outs,
        state.street === 'flop' ? 2 : 1,
      )}%) — semi-bluffing has merit.`,
      equity: eq,
      outs: outsInfo.outs,
    };
  return {
    action: 'check',
    reason: `~${pct(eq)} equity — check and control the pot.`,
    equity: eq,
    outs: outsInfo.outs,
  };
}

export function gradeHeroDecision(stateBefore: GameState, heroAction: Action): DecisionFeedback {
  const la = legalActions(stateBefore);
  const heroClass = classify(heroAction, la.callAmount);
  const rec = recommend(stateBefore);
  const recClass = rec.action;

  let verdict: Verdict;
  if (heroClass === recClass) verdict = 'correct';
  else if (
    (recClass === 'raise' && heroClass === 'call') ||
    (recClass === 'call' && heroClass === 'raise') ||
    (recClass === 'check' && heroClass === 'raise') ||
    (recClass === 'raise' && heroClass === 'check')
  )
    verdict = 'ok';
  else verdict = 'mistake';

  const headlineMap: Record<Verdict, string> = {
    correct: '✓ Matches the baseline',
    ok: '≈ Reasonable, not ideal',
    mistake: '✗ Likely a leak',
  };

  return {
    verdict,
    heroAction: heroClass,
    recommended: recClass,
    headline: headlineMap[verdict],
    detail: rec.reason,
    equity: rec.equity,
    requiredEquity: rec.requiredEquity,
    outs: rec.outs,
  };
}

function liveOpp(state: GameState, selfId: number): number {
  return state.players.filter((q) => !q.folded && q.id !== selfId).length;
}

function pct(x: number): string {
  return Math.round(x * 100) + '%';
}
