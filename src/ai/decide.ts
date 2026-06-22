// AI decision function. Reads a profile's parameters + the live game state and
// returns a legal Action. Heuristic, not a solver — but architecturally the
// single seam where smarter engines can be swapped in.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import { makeRng } from '../engine/cards';
import { equityVsRange, equityVsField } from '../engine/equity';
import { buildVillainRange } from '../strategy';
import { potOdds } from '../engine/potOdds';
import { handCode, preflopStrength, RFI_RANGES, THREEBET_RANGE } from './preflop';
import { getProfile } from './profiles';
import { rfiOpenFreq, limpedRaiseFreq, valueThreeBetFreq } from './blueprint';
import { DIFFICULTIES, type DifficultyParams, type HeroReads } from './difficulty';

export interface DecideOpts {
  diff?: DifficultyParams;
  reads?: HeroReads;
}

export function decideAction(state: GameState, opts?: DecideOpts): Action {
  const i = state.toAct;
  const p = state.players[i];
  const la = legalActions(state);
  const profile = getProfile(p.profileId);
  const pos = positionLabel(i, state.buttonIndex, state.players.length);
  const pot = potTotal(state);
  // Deterministic per-decision RNG. Seeded from the hand's seed + how many
  // actions have happened this hand + the acting seat, so replaying the SAME
  // hand (same hero line) reproduces the bots' EXACT decisions instead of
  // rolling fresh each time. All bot randomness — option mix AND the Monte-Carlo
  // equity sims below — draws from this one stream so the whole decision is
  // reproducible. Falls back gracefully (seed 0) for pre-seed saved games.
  const actionsThisHand = state.log.reduce((n, l) => n + (l.handNumber === state.handNumber ? 1 : 0), 0);
  const decisionSeed =
    (((state.seed ?? 0) >>> 0) ^ Math.imul(actionsThisHand + 1, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
  const r = makeRng(decisionSeed);
  const diff = opts?.diff ?? DIFFICULTIES.normal;
  const reads = opts?.reads;

  const liveOpponents = state.players.filter((q) => !q.folded && q.id !== p.id).length;

  // per-decision human "mood": a small streaky tilt so a bot isn't a fixed robot.
  const mood = 0.85 + r() * 0.3; // ~0.85..1.15
  // slightly randomized bet sizing so bots don't always fire identical fractions.
  const jitter = (frac: number): number => Math.max(0.2, frac * (0.9 + r() * 0.2));

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

  // ---- difficulty: weaker bots make mistakes ----
  // With probability mistakeRate, abandon the correct line and play "fishy":
  // call too much, spaz-raise, or stab randomly — exactly how a beginner leaks.
  if (diff.mistakeRate > 0 && r() < diff.mistakeRate) {
    if (la.callAmount > 0) {
      if (la.canRaise && r() < 0.12) return sizeTo(jitter(0.6), false); // random spaz raise
      return { type: 'call' }; // station call — pays off too much
    }
    if (la.canCheck && r() < 0.55) return { type: 'check' };
    if (la.canRaise) return sizeTo(jitter(0.5), true); // random stab
    return { type: 'check' };
  }

  // =================== PREFLOP ===================
  if (state.street === 'preflop') {
    const code = handCode(p.holeCards);
    const strength = preflopStrength(code);
    const facingRaise = state.currentBet > state.bigBlind;
    const inRFI = RFI_RANGES[pos]?.has(code) ?? false;

    if (!facingRaise) {
      // open opportunity (or BB option / limped pot)
      if (la.callAmount === 0) {
        // BB with the option, or limped to us — mostly check, raise by blueprint
        // frequency (strength + aggression), so it's mixed rather than a hard cut.
        if (r() < limpedRaiseFreq(code, profile.aggression)) return sizeTo(strength > 0.78 ? 1.0 : 0.9, true);
        return { type: 'check' };
      }
      // it's folded to us (or limps in front) — RFI by blueprint open frequency:
      // strong hands open ~always, borderline hands mix, a thin off-chart band steals.
      if (r() < rfiOpenFreq(inRFI, code, profile.openLooseness)) return sizeTo(1.1, false); // ~2.2-2.5bb
      return { type: 'fold' };
    }

    // facing a raise: 3-bet / call / fold. Value 3-bets fire by blueprint
    // frequency — premiums near always, borderline value hands mixed.
    const threeBetWorthy = THREEBET_RANGE.has(code) || strength > 0.85;
    if (threeBetWorthy && la.canRaise && r() < valueThreeBetFreq(code, profile.threeBetFreq)) {
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
  // Hand-read: estimate equity against the opponent's *actual* range (built from
  // their position + preflop action), not vs random cards. This is the core
  // smartness upgrade — bots now fold weak hands to strong ranges and value-bet
  // correctly, instead of treating every opponent as a random hand.
  const { range: villainRange } = buildVillainRange(state, i);
  const eqRes =
    liveOpponents > 1
      ? equityVsField(
          p.holeCards,
          state.board,
          Array.from({ length: liveOpponents }, () => villainRange),
          diff.iters,
          r,
        )
      : equityVsRange(p.holeCards, state.board, villainRange, diff.iters, r);
  // difficulty: weaker bots misread their equity (noise); strong bots read true.
  let equity = eqRes.equity;
  if (diff.equityNoise > 0) {
    equity = Math.max(0, Math.min(1, equity + (r() * 2 - 1) * diff.equityNoise));
  }

  // ---- adaptation: hard/extreme bots exploit the hero's leaks ----
  // Read the running tally of how the hero plays and tilt bluff/value/call
  // tendencies to attack it. Needs a small sample before it kicks in.
  let bluffTilt = 1;
  let valueTilt = 1;
  let callWiden = 0;
  if (reads && diff.adapt > 0 && reads.decisions >= 12) {
    const f2b = reads.foldToBet / Math.max(1, reads.betsFaced);
    const aggF = reads.aggrActions / Math.max(1, reads.passiveActions);
    if (f2b > 0.55) bluffTilt += diff.adapt * 0.9; // hero over-folds → bluff more
    if (f2b < 0.35) {
      bluffTilt -= diff.adapt * 0.6; // hero is a station → bluff less,
      valueTilt += diff.adapt * 0.5; // value bet more
    }
    if (aggF > 1.6) callWiden += diff.adapt * 0.07; // hero over-aggressive → call lighter
  }

  if (la.callAmount > 0) {
    // facing a bet
    const odds = potOdds(pot, la.callAmount);
    const margin = equity - odds.requiredEquity;
    // a shove or a near-pot+ overbet — villains demand a real edge to stack off
    const bigBet = la.isAllInCall || la.callAmount > pot * 0.9;

    // value raise with strong hands — but sometimes just flat to trap (slowplay)
    if (equity > 0.72 && la.canRaise && r() < profile.aggression * 0.7 * mood) {
      if (equity > 0.85 && r() < 0.25) return { type: 'call' }; // trap the monster
      return sizeTo(jitter(0.7), false);
    }
    // semi-bluff raise with aggression (not into a jam we can't profitably inflate)
    if (!bigBet && margin > 0 && equity < 0.55 && la.canRaise && r() < profile.bluffFreq * 0.5 * mood * bluffTilt) {
      return sizeTo(jitter(0.8), false);
    }
    // vs a shove / overbet: only continue with a clear edge. Marginal made hands
    // and draws fold — so a hero who jams has fold equity and isn't auto-called.
    if (bigBet) {
      const need = la.isAllInCall ? 0.05 : 0.02;
      if (margin > need - callWiden) return { type: 'call' };
      if (profile.callStation > 0.75 && margin > -0.04 && r() < profile.callStation - 0.5) return { type: 'call' };
      return { type: 'fold' };
    }
    // Soft call/fold boundary: instead of a hard cutoff at break-even, call with
    // a probability that rises smoothly through the break-even line. `temp` sets
    // how fuzzy the zone is — wide for weak/human bots, near-sharp for extreme.
    // This removes the robotic "flips at exactly X%" tell.
    const callProb = 1 / (1 + Math.exp(-(margin + callWiden + 0.02) / diff.temp));
    if (r() < callProb) return { type: 'call' };
    // calling stations call light even below the line
    if (r() < profile.callStation * 0.5 && odds.requiredEquity < 0.4) return { type: 'call' };
    return { type: 'fold' };
  }

  // can check or bet
  const wasAggressor = state.lastAggressor === i || state.lastAggressor === -1;
  const canSlowplay = state.street === 'flop' || state.street === 'turn';
  // trap: occasionally check a monster to induce bluffs / keep their range in
  if (equity > 0.85 && canSlowplay && r() < 0.3) {
    return { type: 'check' };
  }
  // value bet
  if (equity > 0.62 && r() < (0.6 + profile.aggression * 0.35) * mood * valueTilt) {
    return sizeTo(jitter(equity > 0.8 ? 0.75 : 0.55), true);
  }
  // c-bet as the aggressor on many boards
  if (wasAggressor && r() < profile.cbetFreq * mood * bluffTilt && state.street === 'flop') {
    return sizeTo(jitter(0.5), true);
  }
  // pure bluff
  if (equity < 0.4 && r() < profile.bluffFreq * 0.5 * mood * bluffTilt) {
    return sizeTo(jitter(0.6), true);
  }
  return { type: 'check' };
}
