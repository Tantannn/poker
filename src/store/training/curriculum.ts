// Curriculum progress — which learning-path steps the user has checked off.
// One localStorage key under the `poker-` prefix so it's captured by backups.
// The path CONTENT lives in the component; this only stores done/not-done.

const KEY = 'poker-trainer-curriculum-v1';

export type DoneMap = Record<string, boolean>;

export function loadCurriculum(): DoneMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? (m as DoneMap) : {};
  } catch {
    return {};
  }
}

export function toggleStep(m: DoneMap, id: string): DoneMap {
  const next = { ...m, [id]: !m[id] };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
  return next;
}
