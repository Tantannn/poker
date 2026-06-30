// Spaced-repetition weighting for the equity flashcards. Instead of dealing cards
// uniformly at random, each card carries a WEIGHT that rises when you miss it and
// falls when you nail it (a Leitner-style box). The next card is drawn weighted, so
// the spots you keep getting wrong come back often and mastered ones fade out.
// Persisted across sessions, keyed by the card's stable id (its prompt text).

const KEY = 'poker-trainer-srs-v1';

export interface SrsStat {
  seen: number;
  correct: number;
  weight: number; // higher = surfaced more often
}
export type SrsMap = Record<string, SrsStat>;

// Unseen cards start a bit above "mastered" so new material surfaces, but below a
// freshly-missed card (which jumps to ~3). Bounds keep one card from dominating.
export const NEW_WEIGHT = 1.5;
const MIN_WEIGHT = 0.25;
const MAX_WEIGHT = 8;

export function loadSrs(): SrsMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? (m as SrsMap) : {};
  } catch {
    return {};
  }
}

function save(m: SrsMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore quota / private mode */
  }
}

export function weightOf(m: SrsMap, id: string): number {
  return m[id]?.weight ?? NEW_WEIGHT;
}

/** Record an answer and return the updated map (persisted). A miss roughly doubles
 *  the card's weight (+1 so a mastered card revives), a hit halves it. */
export function recordSrs(m: SrsMap, id: string, correct: boolean): SrsMap {
  const cur = m[id] ?? { seen: 0, correct: 0, weight: NEW_WEIGHT };
  const weight = correct
    ? Math.max(MIN_WEIGHT, cur.weight * 0.5)
    : Math.min(MAX_WEIGHT, cur.weight * 2 + 1);
  const next: SrsMap = {
    ...m,
    [id]: { seen: cur.seen + 1, correct: cur.correct + (correct ? 1 : 0), weight },
  };
  save(next);
  return next;
}

/** Weighted random index into `weights`. `avoid` (if given and there are other
 *  options) is excluded so the same card never repeats back-to-back. Pure given
 *  the rng, so callers pass Math.random from an event handler (never in render). */
export function weightedIndex(weights: number[], rng: () => number, avoid?: number): number {
  if (weights.length === 0) return 0;
  const w = weights.slice();
  if (avoid != null && weights.length > 1) w[avoid] = 0;
  const total = w.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return avoid != null ? (avoid + 1) % weights.length : 0;
  let t = rng() * total;
  for (let i = 0; i < w.length; i++) {
    t -= Math.max(0, w[i]);
    // strict `< 0` (not `<= 0`) so a zero-weight entry — e.g. the avoided index —
    // is never returned when t lands exactly on its (zero-width) boundary.
    if (t < 0) return i;
  }
  return w.length - 1;
}
