// Review journal — the durable half of the "play then review" loop. During play
// you TAG a finished hand; here it's snapshotted to localStorage so it survives
// reload (the in-memory hand history does not). Each entry carries a one-line
// TAKEAWAY you write — the principle extracted from the hand, which is where the
// real learning lives. This is your persistent study-notes artifact.

import type { Card } from '../engine/cards';

export interface JournalEntry {
  /** stable unique id (matches the HistoryHand it was tagged from). */
  id: string;
  handNumber: number; // for display only
  heroCards: Card[];
  board: Card[];
  result: string;
  deltaBB: number;
  takeaway: string;
  createdAt: number;
}

const KEY = 'poker-trainer-journal-v1';
const MAX_ENTRIES = 200;

function stamp(): number {
  return typeof Date !== 'undefined' ? Date.now() : 0;
}

export function loadJournal(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as JournalEntry[];
    if (!Array.isArray(parsed)) return [];
    // backfill ids for entries saved before the uuid migration
    return parsed.map((e) => (e.id ? e : { ...e, id: `legacy-${e.handNumber}` }));
  } catch {
    return [];
  }
}

export function saveJournal(entries: JournalEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* ignore quota / private mode */
  }
}

export function isTagged(entries: JournalEntry[], id: string): boolean {
  return entries.some((e) => e.id === id);
}

/** Add a hand to the journal (no-op if already there). Newest first. */
export function addEntry(
  entries: JournalEntry[],
  hand: Omit<JournalEntry, 'takeaway' | 'createdAt'>,
): JournalEntry[] {
  if (isTagged(entries, hand.id)) return entries;
  const next = [{ ...hand, takeaway: '', createdAt: stamp() }, ...entries];
  return next.slice(0, MAX_ENTRIES);
}

export function removeEntry(entries: JournalEntry[], id: string): JournalEntry[] {
  return entries.filter((e) => e.id !== id);
}

export function setTakeaway(entries: JournalEntry[], id: string, takeaway: string): JournalEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, takeaway } : e));
}
