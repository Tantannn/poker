// AI decision function. Reads a profile's parameters + the live game state and
// returns a legal Action. Heuristic, not a solver — but architecturally the
// single seam where smarter engines can be swapped in.

import type { Action, GameState } from '../engine/table';
import { chartPosition, effectiveBigBlind, legalActions, positionLabel, potTotal, sixMaxRfiEquivalent } from '../engine/table';
import { makeRng } from '../engine/cards';
import type { Card } from '../engine/cards';
import { equityVsRange, equityVsField, countOuts } from '../engine/equity';
import { boardWetScore } from '../engine/board';
import { buildVillainRange, primaryVillainIdx, roleBaseRange } from '../strategy';
import { rangeFromSet } from '../engine/range';
import { depthValueMult } from '../strategy/depth';
import { multFor, rakeTaxRate } from '../strategy/preflopRake';
import { marginality } from '../strategy/preflopModel';
import { getScenario } from '../strategy/preflopChart';
import { rakeInChips, netPot, rakeMarginal } from '../engine/rake';
import {
  handCode, handCombos, preflopStrength, RFI_RANGES, BLUFF_THREEBET_RANGE, BLUFF_THREEBET_WIDE, looksPremium, isSpeculative,
} from './preflop';
import { getProfile } from './profiles';
import { rfiOpenFreq, limpedRaiseFreq, entryPercentile, vs3BetContinueShare, strengthPercentile, vsOpenPlan } from './blueprint';
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
  // House rake makes the bots play the SAME raked game the trainer grades — no-op at
  // rake='none' (netPot is the identity, rakeMarginal 0). Two effects, both regressive
  // (the cap tapers them with pot size): a CALL's break-even equity rises to call/(pot after
  // rake), so marginal calls — SB flats, thin peels — become folds; and a THIN value bet's
  // extra chips are shaved, so the value bar lifts. Mirrors strategy/preflopRake + postflopModel.
  const rake = rakeInChips(state.rake ?? 'none', state.bigBlind);
  const reqEqRaked = (potBefore: number, toCall: number) =>
    toCall > 0 ? toCall / Math.max(1, netPot(rake, potBefore + toCall)) : 0;
  const reqEqRaw = (potBefore: number, toCall: number) => (toCall > 0 ? toCall / Math.max(1, potBefore + toCall) : 0);
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
  // How strongly THIS opponent exploits the hero's leaks: the difficulty slider OR the
  // archetype's own `adapt`, whichever is higher. A reg counter-adjusts even on Normal; the
  // slider still makes every bot adapt at Hard/Extreme. Drives the same read-tilt blocks below.
  const effAdapt = Math.max(diff.adapt, profile.adapt ?? 0);
  const reads = opts?.reads;
  // easy = raw beginner: doesn't play a real strategy at all. Limps everything
  // preflop, only raises when its cards look good, calls too much, and fires the
  // occasional random bluff. Handled by its own path below, not the skill knobs.
  const isNoob = diff.id === 'easy';

  // ---- preflop adaptation: attack the hero's preflop folding — the one street the
  // postflop adapt block below never reaches (bots played the static charts here).
  // Only hard/extreme adapt, only while the hero is still live (a folded hero can't
  // be punished), and ramped in by sample like the postflop reads. ----
  const stealSeat = ['CO', 'BTN', 'SB'].includes(chartPosition(pos));
  let openWiden = 0; // hero folds blinds too much → steal wider
  let threeBetTilt = 1; // hero over-folds to 3-bets → 3-bet (value + bluff) more
  let fourBetBluffTilt = 1;
  if (reads && effAdapt > 0 && !state.players[0].folded) {
    const a = effAdapt;
    const conf = (n: number, k: number) => Math.min(1, n / k);
    if (reads.faced3Bet >= 5) {
      const f = reads.foldTo3Bet / reads.faced3Bet;
      const c = conf(reads.faced3Bet, 12);
      if (f > 0.6) { threeBetTilt += a * 0.8 * c; fourBetBluffTilt += a * 0.6 * c; } // over-folds → attack
      else if (f < 0.35) threeBetTilt -= a * 0.4 * c; // hero fights back → 3-bet him tighter
    }
    if (reads.blindDefends >= 5 && reads.blindFolds / reads.blindDefends > 0.7)
      openWiden += a * 0.18 * conf(reads.blindDefends, 12);
  }

  const liveOpponents = state.players.filter((q) => !q.folded && q.id !== p.id).length;
  // effective stack (bb): the shorter of hero vs the deepest live opponent — drives
  // short-stack push/fold preflop and implied-odds depth postflop.
  const effStackBB =
    Math.min(
      p.stack + p.committed,
      Math.max(0, ...state.players.filter((q) => !q.folded && q.id !== p.id).map((q) => q.stack + q.committed)),
    ) / effectiveBigBlind(state);

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
      // jitter the SPR commitment line (~0.36..0.44) so the stack-off threshold
      // isn't a fixed, readable 0.4 every time.
      const commitLine = 0.4 + (r() - 0.5) * 0.08;
      const committing = crumbs || (potAfter > 0 && behindAfter / potAfter < commitLine);
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
    // Shaded for the stack actually behind — the SAME multiplier the trainer applies to the
    // charts (strategy/depth.ts), so a bot at 25bb and the graded answer at 25bb still agree.
    // No-ops at the ~100bb the charts are authored at and at push/fold depth.
    const strength = preflopStrength(code) * depthValueMult(code, effStackBB);
    // A straddle is a blind, not a raise: measure against the effective blind or every
    // straddled pot reads as "facing a raise" and the bots play 3-bet ranges into it.
    const facingRaise = state.currentBet > effectiveBigBlind(state);
    // Rake: the trainer's own per-action shade (preflopRake.ts) — a call is raked in full, a
    // raise only on its called branch, a fold never. Premiums are exempt, as in the charts' taper.
    const rakeTax = PREMIUMS.has(code) ? 0 : rakeTaxRate(state.rake, (pot + la.callAmount) / state.bigBlind);
    const rakeMultiway = facingRaise && liveOpponents >= 2;
    const callKeep = multFor('call', rakeTax, marginality(code), rakeMultiway);
    const raiseKeep = multFor('raise', rakeTax, marginality(code), rakeMultiway);
    // Draws only when shaded, so rake 'none' consumes the identical RNG stream.
    const survives = (keep: number) => keep >= 1 || r() < keep;
    // A shaded-out flat turns into a raise at the raise's fold-equity relief over the call.
    const flatToRaise = () => r() < raiseKeep - callKeep;

    // ---- easy = raw beginner preflop ----
    // A real fish limps in with everything, raises only when the cards "look
    // good" (a premium), and every so often spazzes a random bluff-raise. It
    // never open-raises a normal hand and hates folding, so it just calls.
    if (isNoob) {
      const goodHand = looksPremium(code); // TT+/AQ+/AJs/KQs — "ooh, good cards, raise!"
      const monster = code === 'AA' || code === 'KK' || code === 'QQ' || code === 'AKs' || code === 'AKo';
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
      if ((monster || bluffRaise) && la.canRaise) return sizeTo(1.0, false);
      if (strength < 0.3 && r() < 0.5) return { type: 'fold' };
      return la.callAmount > 0 ? { type: 'call' } : { type: 'check' };
    }

    // charts are keyed by the 6-max seats-behind equivalent, the same mapping the
    // grader uses — otherwise a 9-max UTG+1 has no chart and the bot folds everything.
    // Heads-up the button (= SB) opens ~82% (the trainer's `hu-sb-rfi`), not the 6-max button's ~45%.
    const headsUpTable = state.players.length === 2;
    const rfiChart = headsUpTable && pos !== 'BB' ? HU_OPEN : RFI_RANGES[sixMaxRfiEquivalent(pos, state.players.length) ?? 'BB'];

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
      // it's folded to us (or limps in front) — enter by the archetype's blueprint width.
      // openWiden steals wider from late position vs a hero who over-folds his blinds.
      const limpers = preflopLimpers(state);
      if (r() < rfiOpenFreq(rfiChart, code, profile.openLooseness) + (stealSeat ? openWiden : 0)) {
        // A limper archetype limps whatever it doesn't "see" as premium; behind limpers,
        // speculative hands over-limp for a cheap multiway flop instead of isolating.
        const overLimp = limpers > 0 && isSpeculative(code) ? 0.5 * (1 - profile.aggression) : 0;
        if (!looksPremium(code) && r() < Math.max(profile.limp ?? 0, overLimp)) {
          if (survives(callKeep)) return { type: 'call' };
          if (!flatToRaise()) return { type: 'fold' };
        } else if (!survives(raiseKeep)) return { type: 'fold' };
        // Open SIZE scales with DEPTH, not just the board (openSizing.ts). Deep
        // stacks build the pot (~2.5–3bb), but as the tournament clock lifts the
        // blinds the effective stack shrinks and a fat 3–4bb open over-commits — so
        // shrink toward a min-raise the shorter we get. Antes shave another notch
        // (dead money = a cheaper steal, risk less to win it), and position adds a
        // touch (early seats / SB open bigger — less position, more players behind).
        // Push/fold (≤15bb) already returned above, so depth here is always >15bb.
        const depthBB = effStackBB >= 60 ? 2.5 : effStackBB >= 40 ? 2.3 : effStackBB >= 25 ? 2.1 : 2.0;
        const chartPos = chartPosition(pos); // 9-max UTG+1/+2/LJ all bump as early seats
        const posBump = chartPos === 'SB' ? 0.5 : chartPos === 'UTG' || chartPos === 'MP' ? 0.3 : 0;
        const anteShave = state.ante > 0 ? 0.2 : 0;
        // Isolating limpers: +1bb for the iso plus 1bb per limper, or the limpers get the
        // right price to call and the raise buys neither fold equity nor a heads-up pot.
        const isoBump = limpers > 0 ? 1 + limpers : 0;
        const openToBB = Math.max(2, depthBB + posBump - anteShave + isoBump);
        // × the EFFECTIVE blind: over a straddle the standard open is ~2.5× the STRADDLE.
        // Sizing off the big blind would make every open a min-raise and hand the field
        // an irresistible price — the classic mistake in a straddled game.
        const target = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, Math.round(openToBB * effectiveBigBlind(state))));
        return { type: 'raise', amount: target };
      }
      return { type: 'fold' };
    }

    // ---- facing a raise: mixed 3-bet / 4-bet / 5-bet / flat / fold nodes ----
    // Level by how many raises are already in this hand: 1 = facing an OPEN (hero
    // 3-bets), 2 = facing a 3-BET (hero 4-bets), 3+ = facing a 4-BET (hero 5-bets).
    // Sizing is position-aware (3-bet 3x IP / 4x OOP, 4-bet ~2.2x), and every node
    // MIXES value, bluff, flat and fold by frequency — so the range isn't a fixed,
    // readable set (the old "only AA/KK/AK ever 4-bets, no flats" leak).
    const raiseCount = preflopRaiseCount(state);
    // 3-bet/4-bet sizing is a multiple of the bet being raised, so it too is denominated in
    // the effective blind — over a straddle every preflop number doubles together.
    const bb = effectiveBigBlind(state);
    const villainToBB = state.currentBet / bb; // the raise hero faces, in bb
    const raiser = state.lastAggressor;
    const nP = state.players.length;
    const ord = (s: number) => (s - state.buttonIndex - 1 + nP) % nP; // 0 = first to act … n-1 = button
    const ipPre = raiser < 0 || ord(i) > ord(raiser); // hero acts after the raiser postflop
    const raiseToBB = (xBB: number): Action => ({
      type: 'raise',
      amount: Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, Math.round(xBB * bb))),
    });
    const threeBetSize = () => raiseToBB((ipPre ? 3 : 4) * villainToBB);
    const fourBetSize = () => raiseToBB(2.2 * villainToBB);
    const jamAllIn = (): Action => ({ type: 'raise', amount: la.maxRaiseTo });

    if (raiseCount >= 3) {
      // facing a 4-bet → 5-bet jam or fold. Flatting a 4-bet is rare (IP only).
      // A PREMIUM never folds preflop: it jams when it can still raise, and when the
      // hero already shoved (la.canRaise === false because hero covers us) it CALLS
      // the shove off instead of folding. The old code only jammed on canRaise, so a
      // covered AA/KK/AKs fell through to the fold return below — e.g. a maniac 3-bets,
      // hero 4-bet-jams, and the maniac's AA folded. Aces stack off, always.
      if (code === 'AA' || code === 'KK' || code === 'AKs') {
        if (la.canRaise) return jamAllIn();
        return la.callAmount > 0 ? { type: 'call' } : { type: 'check' };
      }
      if (code === 'AKo' || code === 'QQ') {
        if (la.canRaise && r() < 0.5) return jamAllIn();
        if (la.callAmount > 0 && r() < 0.55) return { type: 'call' }; // mostly stack off vs a 5-bet
        return la.callAmount > 0 ? { type: 'fold' } : { type: 'check' };
      }
      // JJ/TT/AQs vs a 4-bet: an aggressive 3-bettor (maniac/lag) was 3-betting light and
      // won't fold its good hands; a station just calls. A tag/nit lets these go.
      if (code === 'JJ' || code === 'TT' || code === 'AQs') {
        const stickiness =
          Math.max(0, profile.aggression - 0.6) * 1.2 + (profile.callStation > 0.7 ? 0.3 : 0) + (ipPre ? 0.1 : 0);
        if (r() < stickiness) {
          if (la.canRaise && profile.aggression >= 0.85) return jamAllIn();
          if (la.callAmount > 0) return { type: 'call' };
        }
      }
      return la.callAmount > 0 ? { type: 'fold' } : { type: 'check' };
    }

    if (raiseCount === 2) {
      // facing a 3-bet → 4-bet (value/bluff), flat, or fold. Premiums MIX 4-bet with a
      // trap-flat but NEVER fold; QQ mixes 4-bet/flat; blockers bluff-4-bet; the top of
      // the bot's own range continues by archetype; the rest fold.
      const premium = code === 'AA' || code === 'KK' || code === 'AKs' || code === 'AKo';
      if (premium) {
        if (la.canRaise && r() < 0.9) return fourBetSize();
        return la.callAmount > 0 ? { type: 'call' } : jamAllIn(); // trap-flat, never fold a premium
      }
      if (code === 'QQ') {
        if (la.canRaise && r() < 0.5) return fourBetSize();
        return la.callAmount > 0 ? { type: 'call' } : { type: 'check' }; // else flat, never fold QQ
      }
      // 4-bet BLUFF: suited wheel aces block AA/AK — a thin, blocker-only bluff so the
      // 4-bet range isn't pure value (was AA/KK/AK only, trivially read).
      if ((code === 'A5s' || code === 'A4s' || code === 'A3s') && la.canRaise && r() < profile.bluffFreq * 0.35 * fourBetBluffTilt)
        return survives(raiseKeep) ? fourBetSize() : { type: 'fold' };
      // Continue the top share of the bot's OWN entering range (see vs3BetContinueShare).
      // A 3-bet jam is called only by the top of that; small pairs set-mine only with depth.
      const ownChart = rfiChart.size ? rfiChart : RFI_RANGES.SB;
      const pct = entryPercentile(ownChart, code, profile.openLooseness);
      const share = vs3BetContinueShare(profile, ipPre) * (la.isAllInCall ? 0.4 : 1);
      const setMineNeedsDepth = code.length === 2 && strength < 0.9 && effStackBB < 60;
      const continues = !setMineNeedsDepth && r() < Math.max(0, Math.min(1, 0.5 + (share - pct) / 0.08));
      if (continues) {
        // light 4-bets: a maniac's 4-bet range is not AA/KK
        const fourBetLight = profile.aggression > 0.8 ? (profile.aggression - 0.7) * 0.8 : profile.bluffFreq * 0.12;
        const canFourBetLight = la.canRaise && !la.isAllInCall;
        if (canFourBetLight && r() < fourBetLight * fourBetBluffTilt) return survives(raiseKeep) ? fourBetSize() : { type: 'fold' };
        if (la.callAmount > 0) {
          if (survives(callKeep)) return { type: 'call' };
          return canFourBetLight && fourBetLight > 0 && flatToRaise() ? fourBetSize() : { type: 'fold' };
        }
      }
      return la.callAmount > 0 ? { type: 'fold' } : { type: 'check' };
    }

    // facing an OPEN → 3-bet (value / bluff), flat, or fold, by target SHARES of the deck
    // (vsOpenPlan). A strength threshold can't do this: preflopStrength is compressed
    // (K7o ≈ 0.55), so any cut near 0.5 flatted half the deck and the BB defended ~97%.
    const callBB = la.callAmount / bb;
    const bigShove = la.isAllInCall || callBB >= 12;
    const pct = strengthPercentile(code);
    const soft = (share: number, band = 0.02) => Math.max(0, Math.min(1, 0.5 + (share - pct) / band));
    if (bigShove) {
      // Nobody stacks off 100bb light: continue the top ~6% vs 12bb, ~3% at 50bb+.
      const share = 0.06 - Math.min(1, callBB / 50) * 0.03 + Math.max(0, profile.callStation - 0.7) * 0.05;
      if (r() < soft(share, 0.01)) {
        const jam = la.canRaise && !la.isAllInCall && pct < share / 2;
        return jam ? jamAllIn() : { type: 'call' };
      }
      return { type: 'fold' };
    }
    const defendSeat = pos === 'BB' ? 'BB' : pos === 'SB' ? 'SB' : 'cold';
    const openerPos = raiser >= 0 ? sixMaxRfiEquivalent(positionLabel(raiser, state.buttonIndex, nP), nP) : null;
    const openerChart = headsUpTable ? HU_OPEN : RFI_RANGES[openerPos && openerPos !== 'BB' ? openerPos : 'CO'];
    const openerShare = [...openerChart].reduce((n, c) => n + handCombos(c), 0) / 1326;
    // Rake-free price: the rake reaches this node through callKeep/raiseKeep, not twice.
    const plan = vsOpenPlan(profile, defendSeat, openerShare, reqEqRaw(pot, la.callAmount));
    const threeBetShare = plan.threeBet * threeBetTilt;
    // Polar 3-bet: ~⅔ value from the top (10% trap-flat), ~⅓ bluffs — 60% of the bluff
    // mass from the blocker rung (~2.4% of hands), the rest from the wide rung (~6%).
    const valueShare = threeBetShare * 0.65;
    const bluffShare = threeBetShare - valueShare;
    const blockerFreq = Math.min(1, (bluffShare * 0.6) / 0.024);
    const bluffFreq = BLUFF_THREEBET_RANGE.has(code)
      ? blockerFreq
      : BLUFF_THREEBET_WIDE.has(code)
        ? Math.min(1, (bluffShare - blockerFreq * 0.024) / 0.06)
        : 0;
    const threeBetFreq = Math.max(soft(valueShare) * 0.9, bluffFreq);
    if (la.canRaise && r() < threeBetFreq) return survives(raiseKeep) ? threeBetSize() : { type: 'fold' };
    // Bluffs take their share of `cont` from below the flat range, so the flat cut is lower.
    if (r() < soft(plan.cont - bluffShare)) {
      if (la.callAmount === 0) return { type: 'check' };
      if (survives(callKeep)) return { type: 'call' };
      return la.canRaise && threeBetFreq > 0 && flatToRaise() ? threeBetSize() : { type: 'fold' };
    }
    return { type: 'fold' };
  }

  // =================== POSTFLOP ===================
  // Hand-read: estimate equity against the opponent's *actual* range (built from
  // their position + preflop action), not vs random cards. This is the core
  // smartness upgrade — bots now fold weak hands to strong ranges and value-bet
  // correctly, instead of treating every opponent as a random hand.
  const { range: villainRange, comboWeight } = buildVillainRange(state, i);
  // Multiway: each opponent gets his OWN preflop role range (a limper is not a 3-bettor),
  // and only the primary villain's range is conditioned on this street's action.
  const fieldSeats = state.players.flatMap((q, k) => (!q.folded && k !== i ? [k] : []));
  const primary = primaryVillainIdx(state, i);
  const eqRes =
    liveOpponents > 1
      ? equityVsField(
          p.holeCards,
          state.board,
          fieldSeats.map((s) => (s === primary ? villainRange : rangeFromSet(roleBaseRange(state, s).baseSet))),
          diff.iters,
          r,
          undefined,
          fieldSeats.map((s) => (s === primary ? comboWeight : undefined)),
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
  // Read the running tally of how the hero plays and tilt bluff/value/call/size
  // tendencies to attack SPECIFIC leaks — by bet size, by street, at showdown, and
  // by position — not one blunt "folds too much" dial. Each read is gated on its
  // OWN sample and ramped in by confidence, so a bot starts nudging early and leans
  // harder as the sample grows (instead of a hard nothing-until-12-decisions cliff).
  let bluffTilt = 1; // general bluff frequency
  let valueTilt = 1; // value-bet frequency
  let callWiden = 0; // widen calls vs an over-aggressive hero
  let cbetTilt = 1; // flop c-bet frequency
  let riverBluffTilt = 1; // river bluff frequency (kill it vs a station)
  let riverValueTilt = 1; // river thin-value frequency (raise it vs a station)
  let preferBigBluff = false; // hero overfolds big → size bluffs UP (polar)
  let bluffSmallTilt = 1; // hero sticky vs small bets → bluff small less
  if (reads && effAdapt > 0) {
    const a = effAdapt;
    const conf = (n: number, k: number) => Math.min(1, n / k); // 0..1 ramp by sample
    // general fold-to-bet
    if (reads.betsFaced >= 6) {
      const f2b = reads.foldToBet / reads.betsFaced;
      const c = conf(reads.betsFaced, 14);
      if (f2b > 0.55) bluffTilt += a * 0.9 * c; // over-folds → bluff more
      if (f2b < 0.35) { bluffTilt -= a * 0.6 * c; valueTilt += a * 0.5 * c; } // station → bluff less, value more
    }
    if (reads.passiveActions >= 6 && reads.aggrActions / reads.passiveActions > 1.6)
      callWiden += a * 0.07; // over-aggressive → call lighter
    // SIZE-specific: overfold vs big bets → size bluffs up; sticky vs small → bluff small less, value small more
    if (reads.bigBetsFaced >= 5 && reads.foldToBig / reads.bigBetsFaced > 0.55) preferBigBluff = true;
    if (reads.smallBetsFaced >= 5 && reads.foldToSmall / reads.smallBetsFaced < 0.4) {
      bluffSmallTilt = 1 - a * 0.5; valueTilt += a * 0.3 * conf(reads.smallBetsFaced, 10);
    }
    // STREET: flop c-bet defence
    if (reads.flopBetsFaced >= 5) {
      const fFlop = reads.foldToFlopBet / reads.flopBetsFaced;
      const c = conf(reads.flopBetsFaced, 12);
      if (fFlop > 0.55) cbetTilt += a * 0.6 * c;
      if (fFlop < 0.35) cbetTilt -= a * 0.4 * c;
    }
    // SHOWDOWN: river station → stop bluffing the river, value-bet it thinner
    if (reads.riverBetsFaced >= 4 && reads.riverCalls / reads.riverBetsFaced > 0.6) {
      riverBluffTilt = 1 - a * 0.7; riverValueTilt = 1 + a * 0.4;
    }
    // POSITION: hero passive out of position → attack it (bluff a touch more overall)
    if (reads.oopActions >= 6 && reads.oopPassive / reads.oopActions > 0.7)
      bluffTilt += a * 0.25 * conf(reads.oopActions, 12);
  }
  const isRiver = state.street === 'river';

  // RANGE RESPECT. The equity read above narrows villain's range by THIS street's bet only,
  // so a hand that faced a flop bet, a turn barrel and a river bet still measured itself
  // against something close to his preflop range — every bot read as a calling station
  // (folded ~25% to c-bets, reached showdown ~50% of flops). Each earlier street he bet and a
  // raise of our own bet make his range far stronger than modelled; `respect` is how much an
  // archetype believes that line — a nit nearly fully, a station almost not at all, and a
  // maniac (who assumes everyone bluffs like him) less than a TAG.
  const respect = Math.pow(1 - profile.callStation, 1.5) * (1.3 - 0.6 * profile.aggression);
  const streetIdx = ['flop', 'turn', 'river'].indexOf(state.street);
  const bettorId = state.lastAggressor >= 0 ? state.players[state.lastAggressor].id : -1;
  const priorBarrels = new Set(
    state.log
      .filter(
        (l) =>
          l.handNumber === state.handNumber &&
          l.playerId === bettorId &&
          (l.type === 'bet' || l.type === 'raise') &&
          ['flop', 'turn', 'river'].indexOf(l.street) >= 0 &&
          ['flop', 'turn', 'river'].indexOf(l.street) < streetIdx,
      )
      .map((l) => l.street),
  ).size;
  const myBetRaised = la.callAmount > 0 && p.committed > 0;
  // a raise of our own bet scares a nit off far more than a maniac, who assumes it's a bluff
  const lineStrength = 0.14 + 0.06 * priorBarrels + (myBetRaised ? 0.22 * (2 - 1.6 * profile.aggression) : 0);

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
  // FOLD EQUITY vs the field: a bluff needs EVERYONE to fold, and that chance
  // collapses fast with more players. Heads-up = full; each extra live opponent
  // roughly halves the through-rate. Replaces the old "bluff heads-up only" gate —
  // the bot now barrels / semi-bluffs multiway, just far less often (thinning a
  // field on a good board) instead of turning into a pure-value robot 3+ ways.
  const fieldFold = Math.pow(0.5, Math.max(0, liveOpponents - 1)); // 1 · .5 · .25 …
  const wet = state.board.length >= 3 ? boardWetScore(state.board) : 0;
  const wetBoard = wet >= 2;
  // Trap/slowplay frequency by texture: safe to trap on a dry/static board (few
  // draws to hand a free card to), but a wet board must be charged — so trap rarely.
  // Replaces the old flat r()<0.3 that slowplayed the same on every texture.
  const trapFreq = wet <= 0 ? 0.42 : wet === 1 ? 0.3 : 0.14;
  // Value/bluff bet size for THIS board — shared so a bluff fires the same fraction a
  // value hand would here (no size tell). Polar (wet) boards bet big; dry bet small.
  const polarBase = wetBoard ? 0.8 : 0.6;
  // OVERBET. Turn/river only, and only with stack left to make it hurt: a polar
  // range (near-nuts + pure air) can bet more than the pot because the caller's
  // range is capped and can never hold the top of it. Deliberately NOT scaled by
  // textureMult — the classic overbet node is a dry, static board where villain's
  // range is capped, not a wet one.
  const overbetSpot = (state.street === 'turn' || isRiver) && behindBB > potBB * 1.2;
  const rollOverbet = () => r() < diff.overbet;
  const overbetFrac = () => jitter(1.45);
  // JAM. The all-in as a CHOSEN size rather than a by-product of the commitment guard, which
  // only ever upgraded a bet already worth stacking off — so every deep bot shove was the nuts
  // and the hero could fold to it forever. Bounded on both sides: below ~1.5× pot the overbet
  // slot already lands on the stack, and past 3× pot the price stops being one a real player
  // offers (risking `stack` to win `pot` needs stack/(stack+pot) folds — 75% at 3×).
  const jamSpot = (state.street === 'turn' || isRiver) && behindBB > potBB * 1.5 && behindBB <= potBB * 3;
  const rollJam = () => r() < diff.jam;
  // Any fraction past jamSpot's 3× ceiling lands on the stack via sizeTo's maxRaiseTo clamp;
  // `shove` is what skips the guard that would otherwise size a bluff back down.
  const jamBet = (): Action => sizeTo(4, true, { shove: true });

  if (la.callAmount > 0) {
    // facing a bet
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
    const margin = eqR - reqEqRaked(pot, la.callAmount) + impliedCredit - respect * lineStrength;

    // value raise with strong hands — but sometimes just flat to trap (slowplay)
    if (equity > 0.72 && la.canRaise && r() < profile.aggression * 0.7 * mood) {
      if (equity > 0.85 && r() < trapFreq * 0.8) return { type: 'call' }; // trap the monster (rarely on wet)
      // only stack off with a genuinely strong hand (sets/strong two pair+)
      return sizeTo(tFrac(0.7), false, { willCommit: equity > 0.8 });
    }
    // semi-bluff raise — now fires multiway too, scaled by field fold-through (a
    // draw with backup equity can still raise 3-way on a good board, just less).
    // Never into a jam we can't profitably inflate.
    if (
      !bigBet &&
      margin > 0 &&
      equity < 0.55 &&
      la.canRaise &&
      r() < profile.bluffFreq * 0.5 * mood * bluffTilt * blockerMult * fieldFold * (isRiver ? riverBluffTilt : 1)
    ) {
      // commit only on a strong draw (decent equity when called); weak draws size down
      return sizeTo(tFrac(0.8), false, { willCommit: equity > 0.5 });
    }
    // pure bluff-RAISE — the aggressive archetypes' weapon (a nit almost never; a maniac often).
    // Air with blockers, heads-up, not into a big bet. Re-raising a raise of our own bet is a
    // separate, rarer move that only the most aggressive archetypes make (a maniac ~19%).
    const bluffRaiseP = myBetRaised
      ? Math.max(0, profile.aggression - 0.75) * profile.bluffFreq * 1.2
      : profile.bluffFreq * Math.max(0, profile.aggression - 0.5) * 0.35;
    if (
      !bigBet &&
      heads &&
      equity < 0.3 &&
      la.canRaise &&
      r() < bluffRaiseP * mood * bluffTilt * blockerMult * (isRiver ? riverBluffTilt : 1)
    ) {
      return sizeTo(tFrac(0.8), false);
    }
    // FLOAT: an aggressive player calls a flop/turn bet in position with little, planning to
    // take the pot away later (the barrel/bluff branches above fire when it checks to him).
    if (
      !bigBet &&
      heads &&
      inPosition &&
      cardsToCome &&
      !myBetRaised &&
      r() < Math.max(0, profile.aggression - 0.55) * profile.bluffFreq * 1.4 * mood
    ) {
      return { type: 'call' };
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
    if (r() < Math.max(0, profile.callStation - 0.3) * 0.6 && eqR > 0.15 && reqEqRaked(pot, la.callAmount) < 0.4) return { type: 'call' };
    return { type: 'fold' };
  }

  // can check or bet
  const wasAggressor = state.lastAggressor === i || state.lastAggressor === -1;
  const canSlowplay = state.street === 'flop' || state.street === 'turn';
  // trap: check a monster to induce bluffs / keep their range in — board-dependent
  // (often on dry, rarely on wet where a free card is dangerous).
  if (equity > 0.85 && canSlowplay && r() < trapFreq) {
    return { type: 'check' };
  }
  // value bet, polarized: the NUT end overbets (deep, wet/polar board) for max value
  // and to share a size with bluffs; strong value bets big; thin value sizes down.
  // Vs a river station, value thinner/more often (riverValueTilt).
  // Under rake a THIN value bet earns less — its extra chips are shaved by the marginal
  // rake (zero past the cap, so big pots are unaffected). Lift the value bar accordingly.
  const valueBar = 0.62 + rakeMarginal(rake, pot) * 0.6;
  if (eqR > valueBar && r() < (0.6 + profile.aggression * 0.35) * mood * valueTilt * (isRiver ? riverValueTilt : 1)) {
    if (equity > 0.9 && jamSpot && heads && rollJam()) return jamBet();
    if (equity > 0.88 && overbetSpot && rollOverbet()) return sizeTo(overbetFrac(), true, { willCommit: true });
    return sizeTo(tFrac(equity > 0.8 ? 0.8 : 0.6), true, { willCommit: equity > 0.78 });
  }

  // Bluff side of the JAM — the same all-in the value branch above offers, so the shove itself
  // stops being information. Only tiers that adapt balance it (a `reg` counts on any tier via
  // effAdapt); the rest jam their nuts alone and leave the tell in, exactly like the overbet.
  // Tighter equity bar than the overbet's because the price is worse: this is near-pure air,
  // and blockerMult means the air that fires is the air holding the right cards.
  if (
    jamSpot &&
    heads &&
    effAdapt > 0 &&
    equity < 0.22 &&
    rollJam() &&
    r() < profile.bluffFreq * 0.7 * mood * bluffTilt * blockerMult * (isRiver ? riverBluffTilt : 1)
  ) {
    return jamBet();
  }

  // Bluff side of the overbet — same size as the value side, so the size itself
  // carries no information. Only tiers that adapt balance it; weaker tiers overbet
  // their nuts alone and leave the tell in. Heads-up only: an overbet needs one
  // capped range to attack, not a field.
  if (
    overbetSpot &&
    heads &&
    effAdapt > 0 &&
    equity < 0.25 &&
    rollOverbet() &&
    r() < profile.bluffFreq * 0.9 * mood * bluffTilt * blockerMult * (isRiver ? riverBluffTilt : 1)
  ) {
    return sizeTo(overbetFrac(), true);
  }
  // continuation / barrel as the aggressor — now MULTIWAY too, scaled by field
  // fold-through (thinning a field on a good board). Flop c-bet wide; turn/river
  // barrel less often and only with equity or fold equity. cbetTilt exploits a hero
  // who over/under-folds flop c-bets. Size mirrors the value bet (no size tell), or
  // sizes up when the hero overfolds big bets (preferBigBluff).
  if (wasAggressor) {
    // turn/river barrels scale with aggression: a maniac keeps firing, a nit gives up
    const streetMult = state.street === 'flop' ? 1 : state.street === 'turn' ? 0.25 + 0.55 * profile.aggression : 0.15 + 0.45 * profile.aggression;
    const canBarrel = state.street === 'flop' || eqR > 0.32;
    if (canBarrel && r() < profile.cbetFreq * streetMult * mood * bluffTilt * blockerMult * fieldFold * cbetTilt) {
      return sizeTo(tFrac(preferBigBluff ? Math.min(1.1, polarBase + 0.25) : polarBase), true, { willCommit: equity > 0.78 });
    }
  }
  // pure bluff — fires multiway only on a DRY board (fold equity survives a field
  // only when nobody likely connected), scaled hard by field fold-through. Killed
  // vs a river station (riverBluffTilt), thinned vs a hero who calls small bets
  // (bluffSmallTilt), and sized up vs one who overfolds big (preferBigBluff).
  const smallBluff = !wetBoard && !preferBigBluff;
  if (
    (heads || !wetBoard) &&
    equity < 0.4 &&
    r() < profile.bluffFreq * 0.5 * mood * bluffTilt * blockerMult * fieldFold *
      (isRiver ? riverBluffTilt : 1) * (smallBluff ? bluffSmallTilt : 1)
  ) {
    return sizeTo(tFrac(preferBigBluff ? Math.min(1.1, polarBase + 0.25) : polarBase), true);
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
export function inPositionPostflop(state: GameState, seat: number): boolean {
  const n = state.players.length;
  const orderIdx = (s: number) => (s - state.buttonIndex - 1 + n) % n; // 0 = first to act, n-1 = button (last)
  const heroOrder = orderIdx(seat);
  return state.players.every((q) => q.folded || q.id === seat || orderIdx(q.id) < heroOrder);
}

const HU_OPEN = getScenario('hu-sb-rfi').open!;
const PREMIUMS = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo']);

/** Preflop raises made so far this hand (the open counts as the 1st raise), so a
 *  re-raise facing 2+ is a 4-bet. */
function preflopRaiseCount(state: GameState): number {
  return state.log.reduce(
    (acc, l) => acc + (l.handNumber === state.handNumber && l.street === 'preflop' && l.type === 'raise' ? 1 : 0),
    0,
  );
}

/** Players who limped in this hand. Only meaningful while the pot is unraised, where
 *  every preflop call is a limp (a straddle posts as a blind, so calling one is a limp). */
function preflopLimpers(state: GameState): number {
  return state.log.reduce(
    (acc, l) => acc + (l.handNumber === state.handNumber && l.street === 'preflop' && l.type === 'call' ? 1 : 0),
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
