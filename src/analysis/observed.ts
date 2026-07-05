// Observed villain stats — what a real HUD (or an attentive player) could
// actually know from watching the action, as opposed to the bot's true profile
// parameters. Powers "anonymous villains" mode, where the hero must build reads
// from behavior instead of being handed the archetype.
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
}

export interface ObservedStats {
  hands: number;
  /** voluntarily put money in preflop, 0..1 */
  vpip: number;
  /** raised preflop, 0..1 */
  pfr: number;
  /** postflop aggression factor: (bets+raises) / calls. null = no postflop calls yet */
  af: number | null;
}

export function emptyObs(): ObsCounters {
  return { hands: 0, vpipHands: 0, pfrHands: 0, aggrActions: 0, callActions: 0 };
}

/** Fold ONE completed hand's log entries into per-seat counters (pure — returns
 *  a new map). Call once per hand at completion, before the log rolls off. */
export function accumulateHand(
  prev: Record<number, ObsCounters>,
  log: ActionRecord[],
  handNumber: number,
): Record<number, ObsCounters> {
  // group this hand's entries by player
  const byPlayer = new Map<number, ActionRecord[]>();
  for (const l of log) {
    if (l.handNumber !== handNumber) continue;
    const arr = byPlayer.get(l.playerId) ?? [];
    arr.push(l);
    byPlayer.set(l.playerId, arr);
  }
  const next: Record<number, ObsCounters> = { ...prev };
  for (const [id, mine] of byPlayer) {
    const c = (next[id] = { ...(next[id] ?? emptyObs()) });
    c.hands++;
    // once-per-hand preflop flags: a call then a re-raise is still ONE VPIP hand
    if (mine.some((l) => l.street === 'preflop' && (l.type === 'call' || l.type === 'bet' || l.type === 'raise')))
      c.vpipHands++;
    if (mine.some((l) => l.street === 'preflop' && (l.type === 'raise' || l.type === 'bet'))) c.pfrHands++;
    for (const l of mine) {
      if (l.street === 'preflop') continue;
      if (l.type === 'bet' || l.type === 'raise') c.aggrActions++;
      else if (l.type === 'call') c.callActions++;
    }
  }
  return next;
}

/** counters → display stats */
export function toStats(c: ObsCounters | undefined): ObservedStats {
  if (!c || c.hands === 0) return { hands: 0, vpip: 0, pfr: 0, af: null };
  return {
    hands: c.hands,
    vpip: c.vpipHands / c.hands,
    pfr: c.pfrHands / c.hands,
    af: c.callActions > 0 ? c.aggrActions / c.callActions : null,
  };
}
