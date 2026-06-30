// Backup / restore of all training data. Everything the app stores lives in
// localStorage under a `poker.` or `poker-trainer-` key (history, stats, journal,
// settings, the cash + tournament game slots). This bundles them into one JSON
// file the user can download and re-import — durable, portable across devices,
// and shareable with a coach. Without it a browser-data clear wipes everything.

const BACKUP_PREFIX = /^poker[-.]/;

export interface Backup {
  app: 'poker-trainer';
  version: 1;
  exportedAt: string;
  data: Record<string, string>;
}

function pokerKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && BACKUP_PREFIX.test(k)) keys.push(k);
  }
  return keys;
}

/** Snapshot every poker-trainer localStorage key into a portable object. */
export function exportBackup(): Backup {
  const data: Record<string, string> = {};
  for (const k of pokerKeys()) {
    const v = localStorage.getItem(k);
    if (v != null) data[k] = v;
  }
  return { app: 'poker-trainer', version: 1, exportedAt: new Date().toISOString(), data };
}

/** Trigger a download of the backup as a dated JSON file. */
export function downloadBackup(): void {
  const blob = new Blob([JSON.stringify(exportBackup(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `poker-trainer-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  keys?: number;
}

/** Restore from a backup file's text. Replaces ALL existing poker-trainer keys
 *  (a restore is a full swap, not a merge) and reports how many keys were written.
 *  Caller should reload the app afterward so in-memory state re-reads storage. */
export function importBackup(json: string): ImportResult {
  let parsed: Backup;
  try {
    parsed = JSON.parse(json) as Backup;
  } catch {
    return { ok: false, error: 'That file isn’t valid JSON.' };
  }
  if (!parsed || parsed.app !== 'poker-trainer' || typeof parsed.data !== 'object' || parsed.data === null) {
    return { ok: false, error: 'Not a poker-trainer backup file.' };
  }
  // wipe current poker keys first so a restore replaces rather than half-merges
  for (const k of pokerKeys()) localStorage.removeItem(k);
  let n = 0;
  for (const [k, v] of Object.entries(parsed.data)) {
    if (BACKUP_PREFIX.test(k) && typeof v === 'string') {
      localStorage.setItem(k, v);
      n++;
    }
  }
  return { ok: true, keys: n };
}
