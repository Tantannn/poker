// Observed villain stats — what a real HUD (or an attentive player) could
// actually know from watching the action, as opposed to the bot's true profile
// parameters. Powers "anonymous villains" mode, where the hero must build reads
// from behavior instead of being handed the archetype, AND the node-lock villain
// model (strategy/villainModel.ts) that shifts the recommended line off the
// balanced baseline toward what beats THIS opponent.
//
// The engine's action log is bounded (LOG_KEEP_HANDS ≈ 10 hands), so stats are
// ACCUMULATED per completed hand into compact counters rather than recomputed
// from the raw log — the sample keeps growing across the whole session.

import type { ActionRecord } from '../engine/table';

/** compact running tally per seat (cheap to keep in React state) */
export interface ObsCounters {
  hands: number; // hands this seat was dealt into (appeared in the log)
  vpipHands: number; // hands with voluntary preflop money (call/bet/raise, not posts)
  pfrHands: number; // hands with a preflop raise
  aggrActions: number; // postflop bets + raises
  callActions: number; // postflop calls
  // ---- exploit reads: the two dimensions the strategy engine can actually act on ----
  /** postflop decisions faced with a bet/raise already in front of them */
  facedBet: number;
  /** …of those, how many were folds. → fold-to-bet, drives contBias */
  foldedToBet: number;
  /** postflop decisions with NO bet in front of them (they could take the lead) */
  betChances: number;
  /** …of those, how many were a bet/raise. → how often they fire, drives bluffFreq */
  betTaken: number;
  // ---- per-street split of the above ----
  // Pooled `betFreq` is dominated by FLOP spots (the most numerous), and a flop
  // c-bet is near-automatic — it says nothing about whether a river bet is air.
  // Splitting lets bluffFreq key on the street the bluff-catch actually happens on.
  riverBetChances: number;
  riverBetTaken: number;
  turnBetChances: number;
  turnBetTaken: number;
  // ---- preflop exploit reads (strategy/preflopModel.ts) ----
  // Kept separate from the postflop block above because the preflop node is a
  // static chart, not the EV model — these drive chart frequencies and the
  // projected range the postflop engines inherit, not contBias/bluffMult.
  /** unopened preflop pots this seat could have raised. Blinds excluded — they have
   *  no unopened pot to open into, so counting their option would deflate RFI%. */
  pfOpenChances: number;
  pfOpenTaken: number;
  /** preflop decisions facing EXACTLY one raise — the 3-bet spot */
  pfThreeBetChances: number;
  pfThreeBetTaken: number;
  /** their own raise got re-raised and they had a decision left */
  pfFacedThreeBet: number;
  pfFoldedToThreeBet: number;
  /** hands where they took the FLOP lead (bet/raise with no bet ahead) */
  ledFlop: number;
  /** …of those, hands where they also led the RIVER. Counted per hand rather than
   *  as riverBetTaken/flopBetTaken so it stays a true conditional, not a ratio of
   *  two independent aggregates. Strong hands are rare in any range, so a high
   *  barrel-through rate is arithmetically bluff-heavy — no showdown needed. */
  ledFlopThroughRiver: number;
  // ---- WINDOWED reads: an EWMA over the seat's RECENT decisions, held against the
  // cumulative rate above to catch a MID-SESSION playstyle change. The lifetime average
  // hides a shift (a reg who has stopped folding to your bets still shows ~55% for a long
  // time); the recent estimate moves within a few decisions. null before the first obs. */
  foldToBetRecent: number | null;
  betFreqRecent: number | null;
}

// EWMA weight on the newest observation. ~0.2 → the last ~6 decisions dominate, so a real
// change surfaces within an orbit or two but a single flukey spot doesn't trip it.
const RECENT_ALPHA = 0.2;
const ewma = (prev: number | null, x: number) => (prev == null ? x : prev * (1 - RECENT_ALPHA) + x * RECENT_ALPHA);
// Cumulative sample the baseline needs before a recent-vs-baseline shift is trustworthy.
const SHIFT_MIN_SAMPLE = 8;

export interface ObservedStats {
  hands: number;
  /** voluntarily put money in preflop, 0..1 */
  vpip: number;
  /** raised preflop, 0..1 */
  pfr: number;
  /** postflop aggression factor: (bets+raises) / calls. null = no postflop calls yet */
  af: number | null;
  /** folds ÷ decisions faced with a bet, postflop. null = never faced one yet.
   *  The single most exploitable number a low-stakes opponent leaks. */
  foldToBet: number | null;
  /** bets+raises ÷ decisions with no bet ahead, postflop. null = no such spot yet.
   *  High = barrels a lot (bluff-heavy range); low = only bets made hands. */
  betFreq: number | null;
  /** decisions behind foldToBet — sample size for that read specifically, which
   *  grows far slower than `hands` and is what the shrinkage should key on. */
  facedBetSample: number;
  /** decisions behind betFreq. */
  betChanceSample: number;
  /** bets+raises ÷ lead chances on the RIVER only. The number that actually maps to
   *  "is his river bet air?" — unlike pooled betFreq, which flop c-bets dominate. */
  riverBetFreq: number | null;
  /** decisions behind riverBetFreq. Accrues ~2.5× slower than the flop's. */
  riverBetChanceSample: number;
  /** turn equivalent, for display — no engine knob reads it yet. */
  turnBetFreq: number | null;
  /** of hands he led the flop, the share he also led the river. null = never led a
   *  flop. The headline "does he bluff" read: observable every hand, no showdown. */
  barrelThrough: number | null;
  /** flop leads behind barrelThrough. */
  ledFlopSample: number;
  // ---- windowed reads + the change they imply (null until the baseline is trustworthy) ----
  /** recent (EWMA) fold-to-bet, and its SIGNED shift from the lifetime baseline (recent −
   *  baseline). Negative = folding less now (adjusted to your aggression). */
  foldToBetRecent: number | null;
  foldToBetShift: number | null;
  /** recent (EWMA) bet-when-checked-to, and its signed shift. Positive = barreling more now. */
  betFreqRecent: number | null;
  betFreqShift: number | null;
  /** raises ÷ unopened pots they could have opened, blinds excluded. null = no spot yet.
   *  How wide they steal — i.e. how weak their opening range is when you defend. */
  openFreq: number | null;
  openSample: number;
  /** raises ÷ decisions facing exactly one raise. The headline preflop leak. */
  threeBetFreq: number | null;
  threeBetSample: number;
  /** folds ÷ decisions where their own raise got re-raised. Drives whether a 3-bet
   *  bluff prints against them. Accrues slowest of the three. */
  foldToThreeBet: number | null;
  foldToThreeBetSample: number;
}

export function emptyObs(): ObsCounters {
  return {
    hands: 0,
    vpipHands: 0,
    pfrHands: 0,
    aggrActions: 0,
    callActions: 0,
    facedBet: 0,
    foldedToBet: 0,
    betChances: 0,
    betTaken: 0,
    riverBetChances: 0,
    riverBetTaken: 0,
    turnBetChances: 0,
    turnBetTaken: 0,
    pfOpenChances: 0,
    pfOpenTaken: 0,
    pfThreeBetChances: 0,
    pfThreeBetTaken: 0,
    pfFacedThreeBet: 0,
    pfFoldedToThreeBet: 0,
    ledFlop: 0,
    ledFlopThroughRiver: 0,
    foldToBetRecent: null,
    betFreqRecent: null,
  };
}

/** Fold ONE completed hand's log entries into per-seat counters (pure — returns
 *  a new map). Call once per hand at completion, before the log rolls off. */
export function accumulateHand(
  prev: Record<number, ObsCounters>,
  log: ActionRecord[],
  handNumber: number,
): Record<number, ObsCounters> {
  const mine = log.filter((l) => l.handNumber === handNumber);
  // group this hand's entries by player
  const byPlayer = new Map<number, ActionRecord[]>();
  for (const l of mine) {
    const arr = byPlayer.get(l.playerId) ?? [];
    arr.push(l);
    byPlayer.set(l.playerId, arr);
  }
  const next: Record<number, ObsCounters> = { ...prev };
  for (const [id, entries] of byPlayer) {
    // spread emptyObs FIRST so a counter object from an older shape can't leave a
    // field undefined and turn every later `++` into NaN
    const c = (next[id] = { ...emptyObs(), ...(next[id] ?? {}) });
    c.hands++;
    // once-per-hand preflop flags: a call then a re-raise is still ONE VPIP hand
    if (entries.some((l) => l.street === 'preflop' && (l.type === 'call' || l.type === 'bet' || l.type === 'raise')))
      c.vpipHands++;
    if (entries.some((l) => l.street === 'preflop' && (l.type === 'raise' || l.type === 'bet'))) c.pfrHands++;
    for (const l of entries) {
      if (l.street === 'preflop') continue;
      if (l.type === 'bet' || l.type === 'raise') c.aggrActions++;
      else if (l.type === 'call') c.callActions++;
    }
  }

  // ---- preflop reads: also order-dependent, and keyed on the RAISE LEVEL a decision
  // was made at. Unopened → an RFI chance; one raise ahead → a 3-bet chance; a raise
  // ahead of THEIR OWN raise → they are facing a 3-bet. Level, not "is there a bet
  // ahead", is what separates them: a blind is posted in front of everyone preflop.
  let pfRaises = 0;
  const raisedAtLevel = new Map<number, number>();
  for (const l of mine) {
    if (l.street !== 'preflop') break;
    if (l.type === 'post') continue;
    const c = next[l.playerId];
    const aggressive = l.type === 'raise' || l.type === 'bet';
    if (c) {
      const own = raisedAtLevel.get(l.playerId);
      if (own != null && pfRaises > own) {
        c.pfFacedThreeBet++;
        if (l.type === 'fold') c.pfFoldedToThreeBet++;
      } else if (pfRaises === 0) {
        if (l.position !== 'SB' && l.position !== 'BB') {
          c.pfOpenChances++;
          if (aggressive) c.pfOpenTaken++;
        }
      } else if (pfRaises === 1 && own == null) {
        c.pfThreeBetChances++;
        if (aggressive) c.pfThreeBetTaken++;
      }
    }
    if (aggressive) raisedAtLevel.set(l.playerId, ++pfRaises);
  }

  // Exploit reads need the log in ORDER, not grouped: whether a decision was made
  // "facing a bet" depends on what happened EARLIER in the same street. Walk the
  // hand once, resetting the flag at each street boundary. Postflop only — the two
  // knobs these feed (contBias / bluffMult) are postflop-only, and preflop has a
  // blind posted in front of everyone, which would read as a permanent "faced bet".
  let street = '';
  let betAhead = false;
  const ledFlop = new Set<number>();
  const riverLeadChance = new Set<number>();
  const ledRiver = new Set<number>();
  for (const l of mine) {
    if (l.street !== street) {
      street = l.street;
      betAhead = false;
    }
    if (l.street === 'preflop' || l.type === 'post') {
      if (l.type === 'bet' || l.type === 'raise') betAhead = true;
      continue;
    }
    const c = next[l.playerId];
    if (c) {
      if (betAhead) {
        c.facedBet++;
        if (l.type === 'fold') c.foldedToBet++;
        c.foldToBetRecent = ewma(c.foldToBetRecent, l.type === 'fold' ? 1 : 0);
      } else {
        const took = l.type === 'bet' || l.type === 'raise';
        c.betChances++;
        if (took) c.betTaken++;
        c.betFreqRecent = ewma(c.betFreqRecent, took ? 1 : 0);
        if (l.street === 'turn') {
          c.turnBetChances++;
          if (took) c.turnBetTaken++;
        } else if (l.street === 'river') {
          c.riverBetChances++;
          if (took) c.riverBetTaken++;
          riverLeadChance.add(l.playerId);
          if (took) ledRiver.add(l.playerId);
        }
        if (took && l.street === 'flop') ledFlop.add(l.playerId);
      }
    }
    if (l.type === 'bet' || l.type === 'raise') betAhead = true;
  }
  // Barrel-through denominator is flop leads that ALSO reached a river lead chance.
  // A hand the hero ended on the flop, or where the hero led the river himself,
  // teaches nothing about villain's river tendency — counting it would understate.
  for (const id of ledFlop) {
    const c = next[id];
    if (!c || !riverLeadChance.has(id)) continue;
    c.ledFlop++;
    if (ledRiver.has(id)) c.ledFlopThroughRiver++;
  }
  return next;
}

/** A detected mid-session playstyle change on one exploit dimension, with the counter it
 *  calls for. This is the whole point of the windowed reads: a reg who ADJUSTS to you is the
 *  hardest opponent, and the lifetime average never shows it. */
export interface ShiftAlert {
  stat: 'foldToBet' | 'betFreq';
  fromPct: number; // lifetime baseline, %
  toPct: number; // recent (windowed), %
  headline: string;
  advice: string;
  /** true when the shift is a FIGHT-BACK (folding less / betting more) AND the hero has been
   *  the aggressor lately — i.e. he's adapting to YOU, not just drifting. The leveling war. */
  leveling: boolean;
}

// A shift this large (recent vs baseline) reads as a real adjustment rather than variance.
const SHIFT_MAG = 0.22;
// Hero's recent lead frequency above this reads as "you have been the aggressor" — the
// context that turns a villain fight-back into a read that he is countering YOU specifically.
const HERO_AGGRO_HI = 0.55;

/** Turn the windowed shifts into human "he just changed — do this" alerts. Pass the hero's own
 *  recent aggression (obsCounters[0]'s betFreqRecent) to also detect LEVELING — a fight-back
 *  aimed at the hero. Empty when the opponent is playing the same way he has all session. */
export function readShifts(s: ObservedStats, ctx?: { heroAggro?: number | null }): ShiftAlert[] {
  const out: ShiftAlert[] = [];
  const heroBeenAggro = ctx?.heroAggro != null && ctx.heroAggro >= HERO_AGGRO_HI;
  if (s.foldToBetShift != null && s.foldToBet != null && s.foldToBetRecent != null && Math.abs(s.foldToBetShift) >= SHIFT_MAG) {
    const down = s.foldToBetShift < 0;
    const leveling = down && heroBeenAggro; // he stopped folding BECAUSE you kept firing
    out.push({
      stat: 'foldToBet',
      fromPct: Math.round(s.foldToBet * 100),
      toPct: Math.round(s.foldToBetRecent * 100),
      headline: down ? (leveling ? 'Countering YOUR aggression — folding less' : 'Folding LESS to bets now') : 'Folding MORE to bets now',
      advice: leveling
        ? "He's adapting to YOU — you've been firing, so he's stopped folding and started calling to catch your bluffs. Change gears FIRST: stop bluffing, value-bet your strong hands bigger, and check your air. Make his adjustment the wrong one."
        : down
          ? 'He stopped respecting your aggression — cut the bluffs, value-bet thinner and bigger, and let him pay you off.'
          : 'He tightened up under pressure — barrel wider and bluff more; your fold equity just went up.',
      leveling,
    });
  }
  if (s.betFreqShift != null && s.betFreq != null && s.betFreqRecent != null && Math.abs(s.betFreqShift) >= SHIFT_MAG) {
    const up = s.betFreqShift > 0;
    const leveling = up && heroBeenAggro; // he's answering your aggression with his own
    out.push({
      stat: 'betFreq',
      fromPct: Math.round(s.betFreq * 100),
      toPct: Math.round(s.betFreqRecent * 100),
      headline: up ? (leveling ? 'Fighting back at YOU — betting more' : 'Betting / barrelling MORE now') : 'Betting LESS now',
      advice: leveling
        ? "He's answering your aggression with his own — counter-barrelling and raising back. Don't get into a bluff war you're now behind in: tighten your own bluffs and bluff-CATCH his extra betting, because a lot of it is a reaction, not a real hand."
        : up
          ? 'His betting range just got more bluff-heavy — bluff-catch wider and stop folding your medium hands to him.'
          : 'He went passive / straightforward — give his bets more credit, and take the betting lead yourself more often.',
      leveling,
    });
  }
  return out;
}

/** counters → display stats */
export function toStats(c: ObsCounters | undefined): ObservedStats {
  if (!c || c.hands === 0)
    return {
      hands: 0,
      vpip: 0,
      pfr: 0,
      af: null,
      foldToBet: null,
      betFreq: null,
      facedBetSample: 0,
      betChanceSample: 0,
      riverBetFreq: null,
      riverBetChanceSample: 0,
      turnBetFreq: null,
      barrelThrough: null,
      ledFlopSample: 0,
      foldToBetRecent: null,
      foldToBetShift: null,
      betFreqRecent: null,
      betFreqShift: null,
      openFreq: null,
      openSample: 0,
      threeBetFreq: null,
      threeBetSample: 0,
      foldToThreeBet: null,
      foldToThreeBetSample: 0,
    };
  const foldToBet = c.facedBet > 0 ? c.foldedToBet / c.facedBet : null;
  const betFreq = c.betChances > 0 ? c.betTaken / c.betChances : null;
  // A shift is only trustworthy once the BASELINE has a real sample; else the EWMA and the
  // average are the same few points and every read looks like a "change".
  const foldToBetShift =
    foldToBet != null && c.foldToBetRecent != null && c.facedBet >= SHIFT_MIN_SAMPLE ? c.foldToBetRecent - foldToBet : null;
  const betFreqShift =
    betFreq != null && c.betFreqRecent != null && c.betChances >= SHIFT_MIN_SAMPLE ? c.betFreqRecent - betFreq : null;
  return {
    hands: c.hands,
    vpip: c.vpipHands / c.hands,
    pfr: c.pfrHands / c.hands,
    af: c.callActions > 0 ? c.aggrActions / c.callActions : null,
    foldToBet,
    betFreq,
    foldToBetRecent: c.foldToBetRecent ?? null,
    foldToBetShift,
    betFreqRecent: c.betFreqRecent ?? null,
    betFreqShift,
    facedBetSample: c.facedBet ?? 0,
    betChanceSample: c.betChances ?? 0,
    riverBetFreq: c.riverBetChances > 0 ? c.riverBetTaken / c.riverBetChances : null,
    riverBetChanceSample: c.riverBetChances ?? 0,
    turnBetFreq: c.turnBetChances > 0 ? c.turnBetTaken / c.turnBetChances : null,
    barrelThrough: c.ledFlop > 0 ? c.ledFlopThroughRiver / c.ledFlop : null,
    ledFlopSample: c.ledFlop ?? 0,
    openFreq: c.pfOpenChances > 0 ? c.pfOpenTaken / c.pfOpenChances : null,
    openSample: c.pfOpenChances ?? 0,
    threeBetFreq: c.pfThreeBetChances > 0 ? c.pfThreeBetTaken / c.pfThreeBetChances : null,
    threeBetSample: c.pfThreeBetChances ?? 0,
    foldToThreeBet: c.pfFacedThreeBet > 0 ? c.pfFoldedToThreeBet / c.pfFacedThreeBet : null,
    foldToThreeBetSample: c.pfFacedThreeBet ?? 0,
  };
}
