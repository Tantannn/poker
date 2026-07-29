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
  /** hands where they took the FLOP lead (bet/raise with no bet ahead) */
  ledFlop: number;
  /** …of those, hands where they also led the RIVER. Counted per hand rather than
   *  as riverBetTaken/flopBetTaken so it stays a true conditional, not a ratio of
   *  two independent aggregates. Strong hands are rare in any range, so a high
   *  barrel-through rate is arithmetically bluff-heavy — no showdown needed. */
  ledFlopThroughRiver: number;
}

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
    ledFlop: 0,
    ledFlopThroughRiver: 0,
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
      } else {
        const took = l.type === 'bet' || l.type === 'raise';
        c.betChances++;
        if (took) c.betTaken++;
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
    };
  return {
    hands: c.hands,
    vpip: c.vpipHands / c.hands,
    pfr: c.pfrHands / c.hands,
    af: c.callActions > 0 ? c.aggrActions / c.callActions : null,
    foldToBet: c.facedBet > 0 ? c.foldedToBet / c.facedBet : null,
    betFreq: c.betChances > 0 ? c.betTaken / c.betChances : null,
    facedBetSample: c.facedBet ?? 0,
    betChanceSample: c.betChances ?? 0,
    riverBetFreq: c.riverBetChances > 0 ? c.riverBetTaken / c.riverBetChances : null,
    riverBetChanceSample: c.riverBetChances ?? 0,
    turnBetFreq: c.turnBetChances > 0 ? c.turnBetTaken / c.turnBetChances : null,
    barrelThrough: c.ledFlop > 0 ? c.ledFlopThroughRiver / c.ledFlop : null,
    ledFlopSample: c.ledFlop ?? 0,
  };
}
