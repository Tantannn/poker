// Persist the live game + table settings to localStorage so a refresh (F5)
// resumes exactly where you left off instead of dealing a fresh table.
//
// Cash and tournament are SEPARATE persisted sessions (one slot each), so you
// can leave a freezeout half-played, run some cash hands, and come back to the
// tournament exactly where it stood. The game/dealt blobs are namespaced by
// mode; settings (shared preferences + which mode was last active) are single.

import type { GameState } from '../engine/table';
import type { VillainLock } from '../strategy/villainModel';

export type GameMode = 'cash' | 'tourney';

const GAME_KEY = (m: GameMode) => `poker.game.${m}.v1`;
const DEALT_KEY = (m: GameMode) => `poker.dealt.${m}.v1`;
const SETTINGS_KEY = 'poker.settings.v1';
// Pre-split single-slot keys — migrated once into the matching mode slot below.
const LEGACY_GAME_KEY = 'poker.game.v1';
const LEGACY_DEALT_KEY = 'poker.dealt.v1';

function modeOf(g: GameState): GameMode {
  return g.tournament ? 'tourney' : 'cash';
}

// One-time migration: route a pre-split blob to whichever mode it actually was,
// then drop the legacy key so it can't shadow future saves.
function migrateLegacy(legacyKey: string, keyFor: (m: GameMode) => string): void {
  try {
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return;
    const g = JSON.parse(raw) as GameState;
    const dest = keyFor(modeOf(g));
    if (!localStorage.getItem(dest)) localStorage.setItem(dest, raw);
    localStorage.removeItem(legacyKey);
  } catch {
    /* ignore — a corrupt legacy blob just gets dropped */
  }
}

export function saveGame(g: GameState, mode: GameMode): void {
  try {
    localStorage.setItem(GAME_KEY(mode), JSON.stringify(g));
  } catch {
    /* storage full / disabled — fall back to in-memory only */
  }
}

export function loadGame(mode: GameMode): GameState | null {
  try {
    migrateLegacy(LEGACY_GAME_KEY, GAME_KEY);
    const raw = localStorage.getItem(GAME_KEY(mode));
    if (!raw) return null;
    const g = JSON.parse(raw) as GameState;
    // minimal shape sanity-check so a corrupt/old blob can't crash the app
    if (!g || !Array.isArray(g.players) || typeof g.handNumber !== 'number') return null;
    return g;
  } catch {
    return null;
  }
}

export function clearGame(mode: GameMode): void {
  try {
    localStorage.removeItem(GAME_KEY(mode));
  } catch {
    /* ignore */
  }
}

// The "repeat hand" snapshot — the freshly-dealt state (same hole cards + deck),
// persisted so Repeat Hand still works after a refresh.
export function saveDealt(g: GameState | null, mode: GameMode): void {
  try {
    if (g) localStorage.setItem(DEALT_KEY(mode), JSON.stringify(g));
    else localStorage.removeItem(DEALT_KEY(mode));
  } catch {
    /* ignore */
  }
}

export function loadDealt(mode: GameMode): GameState | null {
  try {
    migrateLegacy(LEGACY_DEALT_KEY, DEALT_KEY);
    const raw = localStorage.getItem(DEALT_KEY(mode));
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
  /** show tilt banner + post-swing cool-off gate. Defaults on; false disables both. */
  tiltWarnings?: boolean;
  difficulty: string;
  /** when the graded answer surfaces: 'immediate' shows it the moment you act
   *  (default, drill mode); 'deferred' hides every decision's answer until the
   *  hand is over, then shows a full per-decision review (exam mode — no live
   *  feedback leaking into your later-street reads). */
  feedbackMode?: 'immediate' | 'deferred';
  /** per-seat difficulty overrides aligned with `profiles` (seat 1..N-1);
   *  '' / missing = follow the table-wide `difficulty`. Enables a mixed table
   *  (one fish, two regs, a shark) like a real game. */
  seatDiffs?: string[];
  /** hide bot archetypes — hero builds reads from observed stats and guesses. */
  anonymousVillains?: boolean;
  /** manual node locks per seat index: assert what a villain does (fold-to-bet,
   *  bet frequency, and the preflop rates in strategy/preflopModel.ts) and the
   *  strategy engine solves against that instead of the observed read. Typed from
   *  `VillainLock` rather than restated — an inline shape silently DROPS any field
   *  added to the lock, since saveSettings round-trips through this interface. */
  villainLocks?: Record<number, VillainLock>;
  /** use observed reads (VPIP/fold-to-bet/bet-freq) as the villain model the
   *  strategy engine solves against, instead of the bot's hidden archetype.
   *  Defaults ON — an archetype the player can't see shouldn't drive the advice. */
  readDrivenModel?: boolean;
  /** bias the hero's dealt hole cards toward mixed/edge preflop hands. */
  edgeFocus?: boolean;
  /** drill deal-filter: force each dealt hero hand into a starting-hand class
   *  ('off' | 'pairs' | 'suited-connectors' | …). Overrides edgeFocus when set. */
  drillClass?: string;
  /** cash only: when any seat busts to 0, the next deal starts fresh equal
   *  stacks instead of rebuying — keeps a focused drill table even. */
  autoResetOnBust?: boolean;
  tableSize?: number;
  /** house rake profile id (engine/rake.ts). Missing/'none' = rake-free, solver-style EV. */
  rake?: string;
  /** live straddle mode (engine/table.ts StraddleMode). Missing/'off' = no straddle. */
  straddle?: string;
  /** whether bots initiate a UTG straddle when the hero hasn't set one. */
  botStraddle?: boolean;
  /** legacy single-mode flag — kept for back-compat reads; `activeMode` supersedes it. */
  tournament?: boolean;
  /** which mode's table was last on screen, so a refresh reopens the same tab. */
  activeMode?: GameMode;
  /** active session id, persisted so hands recorded after a refresh stay in the
   *  same Hand Review group as those before it (else a reload splits a session). */
  sessionId?: string;
  /** per-mode session ids so cash and tournament each group as their own arc. */
  cashSessionId?: string;
  tourneySessionId?: string;
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
