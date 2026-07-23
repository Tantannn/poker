// Persistent hand history. The in-memory list used to vanish on reload; this
// stores it (capped) to localStorage. Each hand also carries DECISION SNAPSHOTS
// — the real solved node the hero faced at each action (pot, villain range,
// equity, option mix). These are captured live during play (where the strategy
// already reflects the true villain/pot/facing-bet) so Hand Review can show what
// ACTUALLY happened instead of recomputing a generic spot.

import type { Card } from '../engine/cards';
import type { Street } from '../engine/table';
import type { ActionId } from '../strategy/types';
import { moveTier } from './stats';

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
// Hard ceiling on stored hands. UNDER it, nothing is trimmed. OVER it, the review
// is MISTAKE-FIRST: clean hands (every decision sound) are dropped before hands
// that carry a lesson, so the archive stays dense with spots worth studying.
// The most-recent hands and every tagged hand are always kept regardless — a
// tagged hand is only reviewable while it's still in history, so it must never
// be evicted by the cap.
const MAX_HANDS = 400;
const ALWAYS_KEEP_RECENT = 60;

/** Did the hero misplay any decision in this hand (inaccuracy / wrong / blunder)?
 *  Uses the same moveTier as the live grade + scorecard, so "clean" here means
 *  exactly what "no mistakes" means everywhere else. Hands with no captured
 *  decisions (legacy) count as clean and are droppable. */
function handHasLeak(h: HistoryHand): boolean {
  for (const d of h.decisions ?? []) {
    const chosenEv = d.options.find((o) => o.id === d.chosenId)?.ev ?? 0;
    const t = moveTier(d.evLoss, chosenEv);
    if (t === 'inaccuracy' || t === 'wrong' || t === 'blunder') return true;
  }
  return false;
}

/** Trim history newest-first. Under the ceiling nothing is dropped. Over it,
 *  keep the most-recent hands (whatever you just played), every tagged hand, and
 *  every hand with a leak — dropping only clean, untagged, older hands. If leaks
 *  + tags alone still overflow, keep the newest of them, but tagged hands are
 *  never evicted. Hands arrive newest-first, and every filter preserves order. */
export function capHistory(hands: HistoryHand[], protectedIds: Set<string> = new Set()): HistoryHand[] {
  if (hands.length <= MAX_HANDS) return hands;
  // The current session (hands are newest-first, so hands[0]'s session) is kept
  // whole — its net/arc stay accurate while you're reviewing it live. Older
  // sessions are curated: keep tagged hands, tournament-result hands (place), and
  // any hand with a leak; drop only clean, untagged, older hands.
  const newestSid = hands[0]?.sessionId;
  const curated = hands.filter(
    (h, i) =>
      h.sessionId === newestSid ||
      i < ALWAYS_KEEP_RECENT ||
      protectedIds.has(h.id) ||
      h.place != null ||
      handHasLeak(h),
  );
  if (curated.length <= MAX_HANDS) return curated;
  // Even the curated set overflows (a long run of leaks/tags): keep all tagged
  // hands plus the newest untagged ones up to the ceiling.
  const tagged = curated.filter((h) => protectedIds.has(h.id));
  const room = Math.max(0, MAX_HANDS - tagged.length);
  const keptUntagged = new Set(
    curated.filter((h) => !protectedIds.has(h.id)).slice(0, room).map((h) => h.id),
  );
  return curated.filter((h) => protectedIds.has(h.id) || keptUntagged.has(h.id));
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

export function saveHistory(hands: HistoryHand[], protectedIds: Set<string> = new Set()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(capHistory(hands, protectedIds)));
  } catch {
    /* ignore quota / private mode */
  }
}
