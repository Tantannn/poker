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
  /** serialized villain WeightedRange (Map) for the range chart. */
  villainRange: [string, number][];
}

export interface HistoryHand {
  /** stable unique id (uuid). handNumber restarts on reset, so it can't be the key. */
  id: string;
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
const MAX_HANDS = 50;

export function loadHistory(): HistoryHand[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryHand[];
    if (!Array.isArray(parsed)) return [];
    // backfill ids for hands saved before the uuid migration (deterministic so
    // any tagged-journal links by the same legacy id still match)
    return parsed.map((h) => (h.id ? h : { ...h, id: `legacy-${h.handNumber}` }));
  } catch {
    return [];
  }
}

export function saveHistory(hands: HistoryHand[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(hands.slice(0, MAX_HANDS)));
  } catch {
    /* ignore quota / private mode */
  }
}
