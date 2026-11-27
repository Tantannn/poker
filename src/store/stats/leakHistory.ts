// Cross-session leak TREND tracking. `findLeaks` (stats.ts) is a snapshot of ONE
// rolling session — it answers "what am I doing wrong right now?" but not "is this
// leak shrinking over weeks?". This store keeps a small, capped time series of leak
// snapshots so the Analytics tab can show recurrence and improvement, the thing a
// player actually studies from. Key prefix matches backup.ts's /^poker[-.]/ filter,
// so the history rides along in export/import automatically.

import type { SessionStats, Leak } from './stats';
import { findLeaks, gtowScore } from './stats';

const KEY = 'poker-trainer-leak-history-v1';
const MAX_POINTS = 60;
// Auto-capture at most one point per this gap when the Analytics tab mounts, so a
// player who never manually resets still builds a trend across days.
const DEFAULT_GAP_MS = 6 * 60 * 60 * 1000;
// A snapshot needs enough decisions to be a real signal (matches the Leak Finder gate).
const MIN_DECISIONS = 8;

/** One leak reading at a point in time — a flattened, storage-friendly slice of a Leak. */
export interface LeakReading {
  label: string;
  rate: number; // 0..1
  severity: Leak['severity'];
  sample: number;
}

export interface LeakTrendPoint {
  at: number; // epoch ms
  handsPlayed: number;
  netBB: number;
  score: number; // gtowScore 0..100 at capture time
  leaks: LeakReading[];
}

function stamp(): number {
  return typeof Date !== 'undefined' ? Date.now() : 0;
}

export function loadLeakHistory(): LeakTrendPoint[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LeakTrendPoint[]) : [];
  } catch {
    return [];
  }
}

function save(points: LeakTrendPoint[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(points));
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearLeakHistory(): void {
  save([]);
}

/**
 * Append a leak snapshot of the current session to the history.
 *  - `force: true` always records (used when a session is being reset — the ending
 *    session is the meaningful unit to preserve).
 *  - otherwise records only if `minGapMs` has elapsed since the last point, so an
 *    auto-capture on tab-open doesn't spam near-duplicate rows.
 * Returns the new point, or null when it was skipped (too little data / too soon).
 */
export function recordLeakSnapshot(
  s: SessionStats,
  opts: { force?: boolean; minGapMs?: number } = {},
): LeakTrendPoint | null {
  if ((s.decisions?.length ?? 0) < MIN_DECISIONS) return null;
  const history = loadLeakHistory();
  const now = stamp();
  if (!opts.force) {
    const last = history[history.length - 1];
    const gap = opts.minGapMs ?? DEFAULT_GAP_MS;
    if (last && now - last.at < gap) return null;
  }
  const point: LeakTrendPoint = {
    at: now,
    handsPlayed: s.handsPlayed,
    netBB: s.netBB,
    score: gtowScore(s),
    leaks: findLeaks(s).map((l) => ({ label: l.label, rate: l.rate, severity: l.severity, sample: l.sample })),
  };
  const next = [...history, point];
  if (next.length > MAX_POINTS) next.splice(0, next.length - MAX_POINTS);
  save(next);
  return point;
}

/** Every distinct leak label seen across the history, ordered by worst current rate. */
export function leakLabels(points: LeakTrendPoint[]): string[] {
  const latestRate = new Map<string, number>();
  for (const p of points) {
    for (const l of p.leaks) latestRate.set(l.label, l.rate); // later points overwrite → "current"
  }
  return [...latestRate.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
}

/** The rate series (0..1) for one leak across the points; 0 when a point didn't record it. */
export function leakSeries(points: LeakTrendPoint[], label: string): number[] {
  return points.map((p) => p.leaks.find((l) => l.label === label)?.rate ?? 0);
}

/** Trend direction for a leak: compares its first vs last recorded rate.
 *  Negative delta = the leak is shrinking (good). */
export function leakDelta(points: LeakTrendPoint[], label: string): number | null {
  const seen = points.filter((p) => p.leaks.some((l) => l.label === label));
  if (seen.length < 2) return null;
  const first = seen[0].leaks.find((l) => l.label === label)!.rate;
  const last = seen[seen.length - 1].leaks.find((l) => l.label === label)!.rate;
  return last - first;
}
