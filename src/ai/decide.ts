// AI decision function. Reads a profile's parameters + the live game state and
// returns a legal Action. Heuristic, not a solver — but architecturally the
// single seam where smarter engines can be swapped in.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import { monteCarloEquity } from '../engine/equity';
import { potOdds } from '../engine/potOdds';
import { handCode, preflopStrength, RFI_RANGES, THREEBET_RANGE } from './preflop';
import { getProfile } from './profiles';

const BOT_EQUITY_ITERS = 400;

export function decideAction(state: GameState): Action {
  const i = state.toAct;
  const p = state.players[i];
  const la = legalActions(state);
  const profile = getProfile(p.profileId);
  const pos = positionLabel(i, state.buttonIndex, state.players.length);
  const pot = potTotal(state);
  const r = Math.random;

  const liveOpponents = state.players.filter((q) => !q.folded && q.id !== p.id).length;

  // helper to make a raise/bet to a pot fraction, clamped to legal bounds
  const sizeTo = (fractionOfPot: number, isBet: boolean): Action => {
    const base = isBet ? p.committed : state.currentBet;
    let target = Math.round(base + fractionOfPot * (pot + (isBet ? 0 : la.callAmount)));
    target = Math.max(target, la.minRaiseTo);
    target = Math.min(target, la.maxRaiseTo);
    return { type: isBet ? 'bet' : 'raise', amount: target };
  };

  // =================== PREFLOP ===================
  if (state.street === 'preflop') {
    const code = handCode(p.holeCards);
    const strength = preflopStrength(code);
    const facingRaise = state.currentBet > state.bigBlind;
    const inRFI = RFI_RANGES[pos]?.has(code) ?? false;

    if (!facingRaise) {
      // open opportunity (or BB option / limped pot)
      if (la.callAmount === 0) {
        // BB with the option, or limped to us — mostly check, raise strong
        if (strength > 0.78 && r() < 0.6 + profile.aggression * 0.3) return sizeTo(1.0, true);
        if (strength > 0.6 && r() < profile.aggression * 0.4) return sizeTo(0.9, true);
        return { type: 'check' };
      }
      // it's folded to us (or limps in front) — RFI decision
      const wantOpen =
        (inRFI && r() < 0.85 + profile.openLooseness * 0.1) ||
        (!inRFI && strength > 0.62 - profile.openLooseness * 0.18 && r() < profile.openLooseness * 0.5);
      if (wantOpen) return sizeTo(1.1, false); // ~2.2-2.5bb raise
      return { type: 'fold' };
    }

    // facing a raise: 3-bet / call / fold
    const threeBetWorthy = THREEBET_RANGE.has(code) || strength > 0.85;
    if (threeBetWorthy && la.canRaise && r() < profile.threeBetFreq) {
      return sizeTo(1.0, false);
    }
    // occasional bluff 3-bet for aggressive types
    if (la.canRaise && strength < 0.5 && r() < profile.bluffFreq * 0.25) {
      return sizeTo(1.0, false);
    }
    const odds = potOdds(pot, la.callAmount);
    const callThreshold = 0.58 - profile.callRaiseLooseness * 0.18;
    if (strength > callThreshold || odds.requiredEquity < strength * 0.6 + 0.1) {
      if (la.callAmount > 0) return { type: 'call' };
      return { type: 'check' };
    }
    if (profile.callStation > 0.7 && r() < profile.callStation - 0.4) return { type: 'call' };
    return { type: 'fold' };
  }

  // =================== POSTFLOP ===================
  const { equity } = monteCarloEquity(p.holeCards, state.board, liveOpponents, BOT_EQUITY_ITERS);

  if (la.callAmount > 0) {
    // facing a bet
    const odds = potOdds(pot, la.callAmount);
    const margin = equity - odds.requiredEquity;

    // value raise with strong hands
    if (equity > 0.72 && la.canRaise && r() < profile.aggression * 0.7) {
      return sizeTo(0.7, false);
    }
    // semi-bluff raise with aggression
    if (margin > 0 && equity < 0.55 && la.canRaise && r() < profile.bluffFreq * 0.5) {
      return sizeTo(0.8, false);
    }
    if (margin > -0.03) return { type: 'call' };
    // calling stations call light
    if (r() < profile.callStation * 0.5 && odds.requiredEquity < 0.4) return { type: 'call' };
    return { type: 'fold' };
  }

  // can check or bet
  const wasAggressor = state.lastAggressor === i || state.lastAggressor === -1;
  // value bet
  if (equity > 0.62 && r() < 0.6 + profile.aggression * 0.35) {
    return sizeTo(equity > 0.8 ? 0.75 : 0.55, true);
  }
  // c-bet as the aggressor on many boards
  if (wasAggressor && r() < profile.cbetFreq && state.street === 'flop') {
    return sizeTo(0.5, true);
  }
  // pure bluff
  if (equity < 0.4 && r() < profile.bluffFreq * 0.5) {
    return sizeTo(0.6, true);
  }
  return { type: 'check' };
}
