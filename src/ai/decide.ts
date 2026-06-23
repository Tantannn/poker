// AI decision function. Reads a profile's parameters + the live game state and
// returns a legal Action. Heuristic, not a solver — but architecturally the
// single seam where smarter engines can be swapped in.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import { makeRng } from '../engine/cards';
import type { Card } from '../engine/cards';
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
  const sizeTo = (
    fractionOfPot: number,
    isBet: boolean,
    opts: { shove?: boolean; willCommit?: boolean } = {},
  ): Action => {
    const shove = opts.shove ?? false;
    // willCommit = "this hand is worth playing for stacks". Only then does a
    // committing sized bet get upgraded to a clean all-in; a marginal hand sizes
    // down instead, so the bot never punts its whole (possibly 800bb) stack on
    // one street with a hand not strong enough to stack off.
    const willCommit = opts.willCommit ?? false;
    const base = isBet ? p.committed : state.currentBet;
    let target = Math.round(base + fractionOfPot * (pot + (isBet ? 0 : la.callAmount)));
    target = Math.max(target, la.minRaiseTo);

    // Commitment guard. By the turn/river the pot is large, so a "normal"
    // pot-fraction is already most of the remaining stack — the spot is committing.
    if (!shove) {
      const added = target - p.committed; // chips this action puts in
      const behindAfter = p.stack - added; // stack left behind after it
      const potRef = pot + (isBet ? 0 : la.callAmount);
      const potAfter = potRef + added;
      const crumbs = behindAfter <= state.bigBlind * 8; // unplayable nub left
      const committing = crumbs || (potAfter > 0 && behindAfter / potAfter < 0.4);
      if (committing) {
        if (willCommit || crumbs) {
          // Strong enough to play for stacks (or only a <8bb nub would remain) →
          // jam clean instead of an awkward 91%-of-stack fraction.
          target = la.maxRaiseTo;
        } else {
          // MARGINAL hand at low SPR: real players don't risk their whole stack on
          // one street with a hand not worth stacking off. Size DOWN to the biggest
          // bet that still leaves ~half-pot behind — keep pot control and a fold
          // option later rather than committing the stack now.
          const maxAdd = Math.max(0, p.stack - Math.round(0.5 * potRef));
          target = Math.max(la.minRaiseTo, Math.min(target, p.committed + maxAdd));
        }
      } else {
        // deep-stack guard: never let one action silently balloon past ~60% of a
        // deep stack on a surprise re-raise war.
        const softCap = p.committed + Math.round(p.stack * 0.6);
        if (target > softCap) target = Math.max(softCap, la.minRaiseTo);
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
  const { range: villainRange, comboWeight } = buildVillainRange(state, i);
  const eqRes =
    liveOpponents > 1
      ? equityVsField(
          p.holeCards,
          state.board,
          Array.from({ length: liveOpponents }, () => villainRange),
          diff.iters,
          r,
          comboWeight,
        )
      : equityVsRange(p.holeCards, state.board, villainRange, diff.iters, r, comboWeight);
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

  // Board-texture sizing (realism): bet small on dry/static boards, big on
  // wet/draw-heavy ones, instead of one fixed fraction regardless of board.
  // `textureMult` scales the role fraction (value / c-bet / bluff), so intent is
  // preserved — a value bet is still a value bet, just sized to the texture.
  const textureMult = boardSizeMult(state.board);
  const tFrac = (base: number): number => jitter(base * textureMult);

  if (la.callAmount > 0) {
    // facing a bet
    const odds = potOdds(pot, la.callAmount);
    const margin = equity - odds.requiredEquity;
    // a shove or a near-pot+ overbet — villains demand a real edge to stack off
    const bigBet = la.isAllInCall || la.callAmount > pot * 0.9;

    // value raise with strong hands — but sometimes just flat to trap (slowplay)
    if (equity > 0.72 && la.canRaise && r() < profile.aggression * 0.7 * mood) {
      if (equity > 0.85 && r() < 0.25) return { type: 'call' }; // trap the monster
      // only stack off with a genuinely strong hand (sets/strong two pair+)
      return sizeTo(tFrac(0.7), false, { willCommit: equity > 0.8 });
    }
    // semi-bluff raise with aggression (not into a jam we can't profitably inflate)
    if (!bigBet && margin > 0 && equity < 0.55 && la.canRaise && r() < profile.bluffFreq * 0.5 * mood * bluffTilt) {
      // commit only on a strong draw (decent equity when called); weak draws size down
      return sizeTo(tFrac(0.8), false, { willCommit: equity > 0.5 });
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
  // value bet — only the strong end (overpair+/top-pair-strong-kicker and up) is
  // willing to get stacks in; thin value sizes down instead of punting.
  if (equity > 0.62 && r() < (0.6 + profile.aggression * 0.35) * mood * valueTilt) {
    return sizeTo(tFrac(equity > 0.8 ? 0.75 : 0.55), true, { willCommit: equity > 0.78 });
  }
  // c-bet as the aggressor on many boards
  if (wasAggressor && r() < profile.cbetFreq * mood * bluffTilt && state.street === 'flop') {
    return sizeTo(tFrac(0.5), true, { willCommit: equity > 0.78 });
  }
  // pure bluff
  if (equity < 0.4 && r() < profile.bluffFreq * 0.5 * mood * bluffTilt) {
    return sizeTo(tFrac(0.6), true);
  }
  return { type: 'check' };
}

/** Bet-size multiplier from board wetness over the FULL board (so turn/river
 *  flush/straight completers count, not just the flop). Dry/static boards bet
 *  small (range bets); wet/draw-heavy boards bet big to charge the draws. Returns
 *  a multiplier applied to the role fraction (≈0.66 dry … 1.3 very wet). */
function boardSizeMult(board: Card[]): number {
  if (board.length < 3) return 1;
  const suitCounts = new Map<number, number>();
  for (const c of board) suitCounts.set(c.suit, (suitCounts.get(c.suit) ?? 0) + 1);
  const maxSuit = Math.max(...suitCounts.values());
  const ranks = [...new Set(board.map((c) => c.rank))].sort((a, b) => a - b);
  let straighty = false;
  for (let i = 0; i + 1 < ranks.length; i++) if (ranks[i + 1] - ranks[i] <= 2) straighty = true;
  const span = ranks[ranks.length - 1] - ranks[0];
  let wet = 0;
  if (maxSuit >= 3) wet += 2; // flush out there
  else if (maxSuit === 2) wet += 1; // flush draw live
  if (straighty || span <= 4) wet += 1; // connected / straight-draw heavy
  return wet >= 3 ? 1.3 : wet === 2 ? 1.15 : wet === 1 ? 1.0 : 0.66;
}
