// Persistent per-drill scores. The drill tabs used to keep their streak in
// useState only — a reload wiped it. This stores {correct,total} per drill key
// in ONE localStorage entry (key prefix matches backup.ts's /^poker[-.]/ filter,
// so scores ride along in export/import automatically).

const KEY = 'poker-trainer-drillscore-v1';

export interface DrillScore {
  correct: number;
  total: number;
}
type ScoreMap = Record<string, DrillScore>;

function loadAll(): ScoreMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? (m as ScoreMap) : {};
  } catch {
    return {};
  }
}

function saveAll(m: ScoreMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore quota / private mode */
  }
}

export function loadDrillScore(id: string): DrillScore {
  return loadAll()[id] ?? { correct: 0, total: 0 };
}

/** Add one answer to a drill's lifetime score and persist. Returns the update. */
export function recordDrillScore(id: string, correct: boolean): DrillScore {
  const all = loadAll();
  const cur = all[id] ?? { correct: 0, total: 0 };
  const next = { correct: cur.correct + (correct ? 1 : 0), total: cur.total + 1 };
  all[id] = next;
  saveAll(all);
  return next;
}

/** Zero a drill's persisted score (the drills' "reset streak" affordance). */
export function resetDrillScore(id: string): DrillScore {
  const all = loadAll();
  all[id] = { correct: 0, total: 0 };
  saveAll(all);
  return all[id];
}
