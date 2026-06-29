// Persist the live game + table settings to localStorage so a refresh (F5)
// resumes exactly where you left off instead of dealing a fresh table.

import type { GameState } from '../engine/table';

const GAME_KEY = 'poker.game.v1';
const SETTINGS_KEY = 'poker.settings.v1';
const DEALT_KEY = 'poker.dealt.v1';

export function saveGame(g: GameState): void {
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(g));
  } catch {
    /* storage full / disabled — fall back to in-memory only */
  }
}

export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as GameState;
    // minimal shape sanity-check so a corrupt/old blob can't crash the app
    if (!g || !Array.isArray(g.players) || typeof g.handNumber !== 'number') return null;
    return g;
  } catch {
    return null;
  }
}

export function clearGame(): void {
  try {
    localStorage.removeItem(GAME_KEY);
  } catch {
    /* ignore */
  }
}

// The "repeat hand" snapshot — the freshly-dealt state (same hole cards + deck),
// persisted so Repeat Hand still works after a refresh.
export function saveDealt(g: GameState | null): void {
  try {
    if (g) localStorage.setItem(DEALT_KEY, JSON.stringify(g));
    else localStorage.removeItem(DEALT_KEY);
  } catch {
    /* ignore */
  }
}

export function loadDealt(): GameState | null {
  try {
    const raw = localStorage.getItem(DEALT_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as GameState;
    if (!g || !Array.isArray(g.players)) return null;
    return g;
  } catch {
    return null;
  }
}

export interface PersistSettings {
  profiles: string[];
  stackDepth: number;
  scenario: string;
  speed: string;
  watchAfterFold: boolean;
  difficulty: string;
  tableSize?: number;
  tournament?: boolean;
  /** current session id, persisted so hands recorded after a refresh stay in the
   *  same Hand Review group as those before it (else a reload splits a session). */
  sessionId?: string;
}

export function saveSettings(s: PersistSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function loadSettings(): PersistSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistSettings;
  } catch {
    return null;
  }
}
