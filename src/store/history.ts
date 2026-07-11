// Persistent hand history. The in-memory list used to vanish on reload; this
// stores it (capped) to localStorage. Each hand also carries DECISION SNAPSHOTS
// — the real solved node the hero faced at each action (pot, villain range,
// equity, option mix). These are captured live during play (where the strategy
// already reflects the true villain/pot/facing-bet) so Hand Review can show what
// ACTUALLY happened instead of recomputing a generic spot.

import type { Card } from '../engine/cards';
import type { Street } from '../engine/table';
import type { ActionId } from '../strategy/types';

export interface SnapOption {
  id: ActionId;
  label: string;
  freq: number;
  ev: number;
  kind?: string;
  amount?: number;
  sizePct?: number;
  /** hero's equity WHEN CALLED (0..1) for a bet/raise — drives the oversizing
   *  coach's "equity-when-called drops X → Y" line in Hand Review. */
  calledEq?: number;
}

export interface DecisionSnapshot {
  street: Street;
  boardLen: number; // board cards visible when the hero acted
  pot: number;
  toCall: number;
  position: string;
  villainName: string;
  villainTag: string;
  chosenId: ActionId;
  chosenLabel: string;
  bestId: ActionId;
  bestLabel: string;
  evLoss: number;
  equity?: number;
  rngMatch: boolean | null;
  note: string;
  rangeNote?: string;
  options: SnapOption[];
  /** live opponents (not folded, excluding hero) when the hero acted — drives the
   *  multiway caution in Hand Review's sizing coach. Optional: hands captured
   *  before this field default to heads-up (1) in review. */
  opponents?: number;
  /** serialized villain WeightedRange (Map) for the range chart. */
  villainRange: [string, number][];
}

export interface HistoryHand {
  /** stable unique id (uuid). handNumber restarts on reset, so it can't be the key. */
  id: string;
  /** session this hand belongs to — one contiguous run between table rebuilds
   *  (reset / mode switch / size or stack change). Hand Review groups by this so
   *  a tournament reads as one arc instead of interleaving with cash hands. */
  sessionId: string;
  /** true when played in a freezeout (no rebuys) — drives the group's badge. */
  tournament: boolean;
  /** hero's finishing place, stamped only on the terminal hand of a tournament
   *  (1 = champion). Undefined on every other hand, incl. cash. */
  place?: number;
  /** big blind in chips for this hand — bb figures in review use it so escalating
   *  tournament blinds read correctly (older hands backfill to the base BB of 2). */
  bigBlind: number;
  handNumber: number;
  heroCards: Card[];
  board: Card[];
  log: { text: string }[];
  result: string;
  deltaBB: number;
  showdown: { name: string; cards: Card[]; folded: boolean }[];
  decisions?: DecisionSnapshot[];
}

const KEY = 'poker-trainer-history-v1';
// Cap by SESSION, not by a flat hand count: a freezeout can run well past any
// per-hand limit, and truncating it mid-tournament would defeat the grouping.
// Keep the most-recent sessions whole, bounded by a hard hand ceiling — but the
// newest session is always kept intact even if it alone exceeds the ceiling.
const MAX_SESSIONS = 8;
const MAX_HANDS = 400;

/** Trim history newest-first, keeping whole sessions. Hands arrive newest-first
 *  and a session is contiguous in time, so first-seen order groups them. */
export function capHistory(hands: HistoryHand[]): HistoryHand[] {
  const order: string[] = [];
  const bySession = new Map<string, HistoryHand[]>();
  for (const h of hands) {
    const sid = h.sessionId ?? 'legacy';
    if (!bySession.has(sid)) { bySession.set(sid, []); order.push(sid); }
    bySession.get(sid)!.push(h);
  }
  const out: HistoryHand[] = [];
  let sessions = 0;
  for (const sid of order) {
    if (sessions >= MAX_SESSIONS) break;
    const group = bySession.get(sid)!;
    // always keep the first (most-recent) session whole; for older ones, stop
    // before blowing past the hand ceiling.
    if (out.length > 0 && out.length + group.length > MAX_HANDS) break;
    out.push(...group);
    sessions++;
  }
  return out;
}

export function loadHistory(): HistoryHand[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryHand[];
    if (!Array.isArray(parsed)) return [];
    // backfill ids + session fields for hands saved before those migrations
    // (deterministic so tagged-journal links by the same legacy id still match).
    return parsed.map((h) => ({
      ...h,
      id: h.id ?? `legacy-${h.handNumber}`,
      sessionId: h.sessionId ?? 'legacy',
      tournament: h.tournament ?? false,
      bigBlind: h.bigBlind ?? 2,
    }));
  } catch {
    return [];
  }
}

export function saveHistory(hands: HistoryHand[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(capHistory(hands)));
  } catch {
    /* ignore quota / private mode */
  }
}
