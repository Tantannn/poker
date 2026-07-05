// AI decision function. Reads a profile's parameters + the live game state and
// returns a legal Action. Heuristic, not a solver — but architecturally the
// single seam where smarter engines can be swapped in.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import { makeRng } from '../engine/cards';
import type { Card } from '../engine/cards';
import { equityVsRange, equityVsField, countOuts } from '../engine/equity';
import { boardWetScore } from '../engine/board';
import { buildVillainRange } from '../strategy';
import { potOdds } from '../engine/potOdds';
import { handCode, preflopStrength, RFI_RANGES, THREEBET_RANGE, BLUFF_THREEBET_RANGE } from './preflop';
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
  // Tilt (persisted on the Player, set by the engine after big losses) warps the
  // profile: more bluffs, more aggression, worse calls — visible in behavior, not
  // labels, so the hero has to SPOT the steaming player and attack. Extreme bots
  // stay disciplined (part of what "extreme" means).
  const baseProfile = getProfile(p.profileId);
  const tiltAmt = opts?.diff?.id === 'extreme' ? 0 : (p.tilt ?? 0);
  const profile =
    tiltAmt > 0.05
      ? {
          ...baseProfile,
          bluffFreq: Math.min(1, baseProfile.bluffFreq * (1 + tiltAmt * 0.9)),
          aggression: Math.min(1, baseProfile.aggression + tiltAmt * 0.25),
          callStation: Math.min(1, baseProfile.callStation + tiltAmt * 0.3),
          cbetFreq: Math.min(1, baseProfile.cbetFreq + tiltAmt * 0.15),
        }
      : baseProfile;
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
  // easy = raw beginner: doesn't play a real strategy at all. Limps everything
  // preflop, only raises when its cards look good, calls too much, and fires the
  // occasional random bluff. Handled by its own path below, not the skill knobs.
  const isNoob = diff.id === 'easy';

  const liveOpponents = state.players.filter((q) => !q.folded && q.id !== p.id).length;
  // effective stack (bb): the shorter of hero vs the deepest live opponent — drives
  // short-stack push/fold preflop and implied-odds depth postflop.
  const effStackBB =
    Math.min(
      p.stack + p.committed,
      Math.max(0, ...state.players.filter((q) => !q.folded && q.id !== p.id).map((q) => q.stack + q.committed)),
    ) / state.bigBlind;

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
  if (!isNoob && diff.mistakeRate > 0 && r() < diff.mistakeRate) {
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

    // ---- easy = raw beginner preflop ----
    // A real fish limps in with everything, raises only when the cards "look
    // good" (a premium), and every so often spazzes a random bluff-raise. It
    // never open-raises a normal hand and hates folding, so it just calls.
    if (isNoob) {
      const goodHand = strength > 0.8; // ~TT+/AK/AQs — "ooh, good cards, raise!"
      const bluffRaise = r() < 0.08; // rare spaz raise with air
      if (!facingRaise) {
        if (la.callAmount === 0) {
          // BB option / limped pot — raise the premiums (or a random bluff), else free flop
          if ((goodHand || bluffRaise) && la.canRaise) return sizeTo(0.9, true);
          return { type: 'check' };
        }
        // folded / limped to us — the fish LIMPS instead of opening for a raise
        if ((goodHand || bluffRaise) && la.canRaise) return sizeTo(1.1, false);
        return { type: 'call' };
      }
      // facing a raise: raise the nuts, occasional bluff-raise, dump only the true
      // trash, otherwise call it off (station — calls way too much preflop)
      if ((goodHand || bluffRaise) && la.canRaise) return sizeTo(1.0, false);
      if (strength < 0.3 && r() < 0.5) return { type: 'fold' };
      return la.callAmount > 0 ? { type: 'call' } : { type: 'check' };
    }

    const inRFI = RFI_RANGES[pos]?.has(code) ?? false;

    // ---- short stack: push/fold (≤15bb) ----
    // Too shallow to play postflop or realise implied odds. Open-jam or 3-bet-jam a
    // range and fold the rest; the shorter we are, the wider we jam. Speculative
    // suited connectors lose value here, pairs & big cards gain.
    if (effStackBB <= 15) {
      const shortness = Math.max(0, Math.min(1, (15 - effStackBB) / 12));
      const pushFloor = (facingRaise ? 0.8 : 0.66) - shortness * 0.14;
      if (strength >= pushFloor && la.canRaise) return { type: 'raise', amount: la.maxRaiseTo };
      if (la.callAmount === 0) return { type: 'check' }; // free flop in the BB / limped pot
      if (la.isAllInCall && strength >= pushFloor) return { type: 'call' }; // priced into an all-in call
      return { type: 'fold' }; // no flat / set-mine when short
    }

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

    // facing a raise: (re)raise / call / fold. Detect the raise level so a re-raise
    // facing a 3-bet is treated as a 4-bet — far tighter than a 3-bet vs an open.
    const facing4betPlus = preflopRaiseCount(state) >= 2; // open + 3-bet already in
    const value4bet = code === 'AA' || code === 'KK' || code === 'AKs' || code === 'AKo';
    // Value 3-bet floor: chart premiums + TT+ (strength > 0.90 ⇒ 99 out, TT in) —
    // 3-betting 77/88/99 vs an open is a leak. Vs a 3-bet, only KK+/AK get it in;
    // JJ/QQ/AQ flat or fold rather than spew a 4-bet.
    const threeBetWorthy = facing4betPlus ? value4bet : THREEBET_RANGE.has(code) || strength > 0.9;
    if (threeBetWorthy && la.canRaise && r() < valueThreeBetFreq(code, profile.threeBetFreq)) {
      return sizeTo(1.0, false);
    }
    // bluff 3-bet only the blocker family (suited wheel aces + suited Broadway
    // gappers) — they block AA/AK and keep backup equity, unlike random offsuit
    // air. Never a light 4-bet spaz vs a 3-bet.
    if (
      !facing4betPlus &&
      !threeBetWorthy &&
      BLUFF_THREEBET_RANGE.has(code) &&
      la.canRaise &&
      r() < profile.bluffFreq * 0.5
    ) {
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

  // ---- easy = raw beginner postflop ----
  // Bets/raises when the hand "looks good", fires a random bluff now and then,
  // and otherwise just calls — a classic calling station that hates folding.
  // Uses its noisy equity read above, so it misreads and pays off too much.
  if (isNoob) {
    const bluff = r() < 0.18; // random stab / spaz raise
    // SIZING TELL: a fish sizes its bet by how good its hand looks — big bet =
    // big hand, small stab = weak/probe. Readable, exploitable, and exactly what
    // low-stakes players do. Bluffs go small (scared money), monsters go big.
    const tellSize = 0.3 + equity * 0.7; // ~⅓ pot weak … ~pot-size monster
    const stabSize = 0.3; // timid small stab with air
    if (la.callAmount > 0) {
      // facing a bet
      if (equity > 0.62 && la.canRaise) return sizeTo(jitter(tellSize), false, { willCommit: equity > 0.8 });
      if (bluff && liveOpponents === 1 && la.canRaise) return sizeTo(jitter(stabSize + 0.2), false); // spaz raise heads-up
      if (equity < 0.18 && r() < 0.5) return { type: 'fold' }; // folds pure air — only sometimes
      return { type: 'call' }; // otherwise pays it off (station)
    }
    // checked to us / leading
    if (equity > 0.6) return sizeTo(jitter(tellSize), true, { willCommit: equity > 0.78 }); // value bet, sized to strength
    if (bluff) return sizeTo(jitter(stabSize), true); // timid small stab at the pot
    return { type: 'check' };
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

  // Position & equity realisation: in position you realise ~106% of raw equity,
  // out of position ~90% (the rule the solver and Reference teach). Marginal calls,
  // thin value and bluffs key off REALISED equity; absolute monsters stay on raw.
  // Bluffs only fire heads-up (bluffing a field is -EV) and lean on blockers.
  const inPosition = inPositionPostflop(state, i);
  const realize = inPosition ? 1.06 : 0.9;
  const eqR = Math.min(1, equity * realize);
  const heads = liveOpponents === 1;
  const blockerMult = bluffBlockerMult(p.holeCards, state.board);
  const cardsToCome = state.street === 'flop' || state.street === 'turn';
  const maxOppStack = Math.max(0, ...state.players.filter((q) => !q.folded && q.id !== p.id).map((q) => q.stack));
  const behindBB = Math.min(p.stack, maxOppStack) / state.bigBlind;
  const potBB = pot / state.bigBlind;

  if (la.callAmount > 0) {
    // facing a bet
    const odds = potOdds(pot, la.callAmount);
    // a shove or a near-pot+ overbet — villains demand a real edge to stack off
    const bigBet = la.isAllInCall || la.callAmount > pot * 0.9;
    // implied-odds credit: a genuine draw (≥8 outs) with stacks behind may call a
    // touch below raw pot odds — it gets paid off when it completes. Only while more
    // cards are coming, and never vs a shove (no implied chips left to win).
    const outs = cardsToCome ? countOuts(p.holeCards, state.board).outs : 0;
    // reverse implied odds: a non-nut draw gets paid less and pays off more when it
    // loses, so it earns little/no implied credit even with the same out count.
    const impliedCredit =
      outs >= 8 && !bigBet
        ? Math.min(0.12, (behindBB / Math.max(1, potBB)) * 0.05) * drawNutMult(p.holeCards, state.board)
        : 0;
    // decide on REALISED equity (+ implied odds) vs the price, not raw equity
    const margin = eqR - odds.requiredEquity + impliedCredit;

    // value raise with strong hands — but sometimes just flat to trap (slowplay)
    if (equity > 0.72 && la.canRaise && r() < profile.aggression * 0.7 * mood) {
      if (equity > 0.85 && r() < 0.25) return { type: 'call' }; // trap the monster
      // only stack off with a genuinely strong hand (sets/strong two pair+)
      return sizeTo(tFrac(0.7), false, { willCommit: equity > 0.8 });
    }
    // semi-bluff raise (heads-up only; not into a jam we can't profitably inflate)
    if (
      heads &&
      !bigBet &&
      margin > 0 &&
      equity < 0.55 &&
      la.canRaise &&
      r() < profile.bluffFreq * 0.5 * mood * bluffTilt * blockerMult
    ) {
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
  // willing to get stacks in; thin value sizes down instead of punting. Thin value
  // keys off realised equity, so OOP bets a touch less thin than IP.
  if (eqR > 0.62 && r() < (0.6 + profile.aggression * 0.35) * mood * valueTilt) {
    return sizeTo(tFrac(equity > 0.8 ? 0.75 : 0.55), true, { willCommit: equity > 0.78 });
  }
  // continuation / barrel as the aggressor (heads-up). Flop c-bet wide; turn & river
  // barrel less often, and only with some equity or fold equity — a bricked bluff
  // gives up instead of auto-firing every street.
  if (wasAggressor && heads) {
    const streetMult = state.street === 'flop' ? 1 : state.street === 'turn' ? 0.55 : 0.4;
    const canBarrel = state.street === 'flop' || eqR > 0.32;
    if (canBarrel && r() < profile.cbetFreq * streetMult * mood * bluffTilt * blockerMult) {
      return sizeTo(tFrac(0.5), true, { willCommit: equity > 0.78 });
    }
  }
  // pure bluff (heads-up only — bluffing into a field is -EV)
  if (heads && equity < 0.4 && r() < profile.bluffFreq * 0.5 * mood * bluffTilt * blockerMult) {
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
  const wet = boardWetScore(board); // shared with the drill explanations
  return wet >= 3 ? 1.3 : wet === 2 ? 1.15 : wet === 1 ? 1.0 : 0.66;
}

/** True if the hero is last to act postflop among the live players (in position). */
function inPositionPostflop(state: GameState, seat: number): boolean {
  const n = state.players.length;
  const orderIdx = (s: number) => (s - state.buttonIndex - 1 + n) % n; // 0 = first to act, n-1 = button (last)
  const heroOrder = orderIdx(seat);
  return state.players.every((q) => q.folded || q.id === seat || orderIdx(q.id) < heroOrder);
}

/** Preflop raises made so far this hand (the open counts as the 1st raise), so a
 *  re-raise facing 2+ is a 4-bet. */
function preflopRaiseCount(state: GameState): number {
  return state.log.reduce(
    (acc, l) => acc + (l.handNumber === state.handNumber && l.street === 'preflop' && l.type === 'raise' ? 1 : 0),
    0,
  );
}

/** Bluff-frequency multiplier from card removal: holding an Ace, or a card of a
 *  3-flush board suit, blocks villain's strongest calls → bluff a bit more; holding
 *  no relevant blocker into a flush board → bluff less. Clamped to ~0.5..1.4. */
function bluffBlockerMult(hole: Card[], board: Card[]): number {
  let m = 1;
  if (hole.some((c) => c.rank === 14)) m += 0.18; // ace blocks Ax / top pairs / the nut flush
  const suitCount = new Map<number, number>();
  for (const c of board) suitCount.set(c.suit, (suitCount.get(c.suit) ?? 0) + 1);
  const flushSuit = [...suitCount.entries()].find(([, cnt]) => cnt >= 3)?.[0];
  if (flushSuit !== undefined) m += hole.some((c) => c.suit === flushSuit) ? 0.15 : -0.2;
  return Math.max(0.5, Math.min(1.4, m));
}

/** Reverse-implied-odds multiplier (0..1) for a draw's implied-odds credit. A
 *  NON-nut flush draw gets paid less and pays off more when it loses, so it earns
 *  little implied credit; nut / 2nd-nut draws keep it. Only flush draws are graded
 *  here (the canonical dominated-draw trap); other draws return 1. */
function drawNutMult(hole: Card[], board: Card[]): number {
  for (let s = 0; s < 4; s++) {
    const boardOfSuit = board.filter((c) => c.suit === s).length;
    const heroOfSuit = hole.filter((c) => c.suit === s);
    if (boardOfSuit + heroOfSuit.length === 4 && heroOfSuit.length >= 1) {
      const hi = Math.max(...heroOfSuit.map((c) => c.rank));
      return hi === 14 ? 1 : hi === 13 ? 0.7 : hi === 12 ? 0.45 : hi >= 11 ? 0.3 : 0.2; // A,K,Q,J,else
    }
  }
  return 1;
}
