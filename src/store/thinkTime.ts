// Persisted decision-tempo stats for the live-table timer. Tracks how long the
// hero takes per postflop/preflop decision so they can learn their own pace and
// keep it CONSISTENT (uneven tempo — slow bluffs, snap value — is a live tell).
// One localStorage entry; the `poker-` prefix rides along in backup export/import.

const KEY = 'poker-thinktime-v1';

export interface ThinkTime {
  totalMs: number;
  count: number;
}

export function loadThinkTime(): ThinkTime {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { totalMs: 0, count: 0 };
    const t = JSON.parse(raw);
    return t && typeof t.totalMs === 'number' && typeof t.count === 'number'
      ? { totalMs: t.totalMs, count: t.count }
      : { totalMs: 0, count: 0 };
  } catch {
    return { totalMs: 0, count: 0 };
  }
}

/** Add one decision's think time (ms) to the running total and persist. */
export function recordThinkTime(ms: number): ThinkTime {
  const cur = loadThinkTime();
  const next = { totalMs: cur.totalMs + ms, count: cur.count + 1 };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
  return next;
}

export function resetThinkTime(): ThinkTime {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return { totalMs: 0, count: 0 };
}

/** Average think time in ms, or 0 with no samples. */
export function avgThinkMs(t: ThinkTime): number {
  return t.count > 0 ? t.totalMs / t.count : 0;
}
