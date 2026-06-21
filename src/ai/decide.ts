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

  // helper to make a raise/bet to a pot fraction, clamped to legal bounds.
  // `shove` opts out of the commitment guard for deliberate all-ins.
  const sizeTo = (fractionOfPot: number, isBet: boolean, shove = false): Action => {
    const base = isBet ? p.committed : state.currentBet;
    let target = Math.round(base + fractionOfPot * (pot + (isBet ? 0 : la.callAmount)));
    target = Math.max(target, la.minRaiseTo);

    // Commitment guard: a normal bet/raise must never silently balloon into an
    // all-in just because the pot-fraction math (or a re-raise war) crossed the
    // stack. Cap a single action at ~60% of the remaining stack. Pots still grow
    // street by street — but the human isn't surprise-jammed on a deep stack.
    if (!shove) {
      const softCap = p.committed + Math.round(p.stack * 0.6);
      if (target > softCap) {
        // if the cap would leave only crumbs behind, jam cleanly instead of
        // leaving an unplayable sub-8bb stack; otherwise pull back to the cap.
        const leftover = la.maxRaiseTo - softCap;
        target = leftover <= state.bigBlind * 8 ? la.maxRaiseTo : Math.max(softCap, la.minRaiseTo);
      }
    }

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
    let callThreshold = 0.58 - profile.callRaiseLooseness * 0.18;

    // Facing a shove or a big overbet preflop, villains tighten HARD — nobody
    // stacks off 100bb light. The bigger the price, the closer to a premium-only
    // calling range. This is what gives a hero's all-in real fold equity instead
    // of always getting snapped off by a better hand.
    const callBB = la.callAmount / state.bigBlind;
    const bigShove = la.isAllInCall || callBB >= 12;
    if (bigShove) {
      const pressure = Math.min(1, callBB / 50); // ~50bb+ to call ⇒ max tightness
      // up to ~0.82 ≈ {66+, AK} — folds the rest of the deck to the jam
      callThreshold = Math.max(callThreshold, 0.62 + pressure * 0.2);
    }

    // good-price call only applies to normal-sized raises, never a jam
    const priceOk = !bigShove && odds.requiredEquity < strength * 0.6 + 0.1;
    if (strength > callThreshold || priceOk) {
      if (la.callAmount > 0) return { type: 'call' };
      return { type: 'check' };
    }
    // calling stations peel light vs normal raises, but even they fold to a jam
    if (!bigShove && profile.callStation > 0.7 && r() < profile.callStation - 0.4) return { type: 'call' };
    return { type: 'fold' };
  }

  // =================== POSTFLOP ===================
  const { equity } = monteCarloEquity(p.holeCards, state.board, liveOpponents, BOT_EQUITY_ITERS);

  if (la.callAmount > 0) {
    // facing a bet
    const odds = potOdds(pot, la.callAmount);
    const margin = equity - odds.requiredEquity;
    // a shove or a near-pot+ overbet — villains demand a real edge to stack off
    const bigBet = la.isAllInCall || la.callAmount > pot * 0.9;

    // value raise with strong hands
    if (equity > 0.72 && la.canRaise && r() < profile.aggression * 0.7) {
      return sizeTo(0.7, false);
    }
    // semi-bluff raise with aggression (not into a jam we can't profitably inflate)
    if (!bigBet && margin > 0 && equity < 0.55 && la.canRaise && r() < profile.bluffFreq * 0.5) {
      return sizeTo(0.8, false);
    }
    // vs a shove / overbet: only continue with a clear edge. Marginal made hands
    // and draws fold — so a hero who jams has fold equity and isn't auto-called.
    if (bigBet) {
      const need = la.isAllInCall ? 0.05 : 0.02;
      if (margin > need) return { type: 'call' };
      if (profile.callStation > 0.75 && margin > -0.04 && r() < profile.callStation - 0.5) return { type: 'call' };
      return { type: 'fold' };
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
