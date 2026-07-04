// Mental-game state — the off-table toolkit from The Mental Game of Poker:
// a pre-session warmup checklist, your A-game / C-game profile, and a tilt-trigger
// plan (trigger → the logic you inject to stop the spiral). Persisted in ONE
// localStorage entry under the `poker-` prefix so it's captured by backup.ts's
// export/import automatically. All writes happen from event handlers.

const KEY = 'poker-trainer-mental-v1';

export interface TiltTrigger {
  id: string;
  trigger: string; // what sets you off ("bad beat", "losing to a fish", "down a buy-in")
  reframe: string; // the logic you inject ("variance is how fish pay me", …)
}

export interface MentalState {
  warmup: Record<string, boolean>; // checklist item id → ticked
  lastWarmupAt: number | null; // epoch ms of the last COMPLETED warmup
  aGame: string; // your best-game traits, in your words
  cGame: string; // your tilt/worst-game traits — name them to catch them
  triggers: TiltTrigger[];
}

// The fixed warmup checklist. Ids are stable so ticks survive a reload.
export const WARMUP_ITEMS: { id: string; label: string }[] = [
  { id: 'fit', label: "I'm rested & fed — not playing to escape boredom or a bad mood." },
  { id: 'stop', label: 'I set a stop-loss and a time limit before sitting down.' },
  { id: 'agame', label: 'I re-read my A-game reminders (below).' },
  { id: 'variance', label: 'I accept variance — tonight I grade my decisions, not the result.' },
  { id: 'settle', label: 'First orbit: tight-solid, no hero plays until I have reads.' },
];

const DEFAULT: MentalState = {
  warmup: {},
  lastWarmupAt: null,
  aGame: '',
  cGame: '',
  triggers: [],
};

export function loadMental(): MentalState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') return { ...DEFAULT };
    return {
      warmup: m.warmup && typeof m.warmup === 'object' ? m.warmup : {},
      lastWarmupAt: typeof m.lastWarmupAt === 'number' ? m.lastWarmupAt : null,
      aGame: typeof m.aGame === 'string' ? m.aGame : '',
      cGame: typeof m.cGame === 'string' ? m.cGame : '',
      triggers: Array.isArray(m.triggers) ? m.triggers.filter((t: unknown): t is TiltTrigger =>
        !!t && typeof (t as TiltTrigger).id === 'string') : [],
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveMental(m: MentalState): MentalState {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore quota / private mode */
  }
  return m;
}

/** True once every warmup item is ticked. */
export function warmupComplete(m: MentalState): boolean {
  return WARMUP_ITEMS.every((it) => m.warmup[it.id]);
}
