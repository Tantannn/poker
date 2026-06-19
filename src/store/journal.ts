// Review journal — the durable half of the "play then review" loop. During play
// you TAG a finished hand; here it's snapshotted to localStorage so it survives
// reload (the in-memory hand history does not). Each entry carries a one-line
// TAKEAWAY you write — the principle extracted from the hand, which is where the
// real learning lives. This is your persistent study-notes artifact.

import type { Card } from '../engine/cards';

export interface JournalEntry {
  handNumber: number;
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
    return Array.isArray(parsed) ? parsed : [];
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

export function isTagged(entries: JournalEntry[], handNumber: number): boolean {
  return entries.some((e) => e.handNumber === handNumber);
}

/** Add a hand to the journal (no-op if already there). Newest first. */
export function addEntry(
  entries: JournalEntry[],
  hand: Omit<JournalEntry, 'takeaway' | 'createdAt'>,
): JournalEntry[] {
  if (isTagged(entries, hand.handNumber)) return entries;
  const next = [{ ...hand, takeaway: '', createdAt: stamp() }, ...entries];
  return next.slice(0, MAX_ENTRIES);
}

export function removeEntry(entries: JournalEntry[], handNumber: number): JournalEntry[] {
  return entries.filter((e) => e.handNumber !== handNumber);
}

export function setTakeaway(
  entries: JournalEntry[],
  handNumber: number,
  takeaway: string,
): JournalEntry[] {
  return entries.map((e) => (e.handNumber === handNumber ? { ...e, takeaway } : e));
}
