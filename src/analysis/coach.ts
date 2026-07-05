// Leak-targeted drill suggestions: map the analytics engine's detected leaks
// (store/stats findLeaks) to a concrete table setup that attacks that leak with
// rep density — the right villains, the right seat, over and over. One click in
// the ScenarioBar applies it.

import type { Leak } from '../store/stats';

export interface CoachDrill {
  /** the leak this drill attacks (matches Leak.label) */
  leak: string;
  /** one-line pitch shown in the coach chip */
  why: string;
  /** villain lineup for the drill (profile ids, seats 1..5) */
  profiles: string[];
  /** per-seat difficulty for the drill ('' = table default) */
  seatDiffs: string[];
  /** hero seat to force ('random' | position) */
  scenario: string;
}

// Drill table per known leak label. Lineups are chosen so the CORRECT play is
// also the one that fixes the leak — e.g. stations make bluffing burn money, so
// an over-bluffer literally feels the leak cost chips.
const DRILLS: Record<string, Omit<CoachDrill, 'leak'>> = {
  'Over-folding preflop': {
    why: 'You fold too much preflop — defend your big blind vs relentless stealers.',
    profiles: ['lag', 'tag', 'lag', 'tag', 'lag'],
    seatDiffs: ['hard', 'normal', 'hard', 'normal', 'hard'],
    scenario: 'BB',
  },
  'Playing too loose preflop': {
    why: 'You play too many hands — open from UTG vs a reg-heavy field, where only tight opens survive.',
    profiles: ['tag', 'tag', 'gto', 'gto', 'nit'],
    seatDiffs: ['hard', 'hard', 'hard', 'hard', 'normal'],
    scenario: 'UTG',
  },
  'Too passive (missing value/aggression)': {
    why: 'You miss value — bet bigger and thinner vs calling stations who pay everything off.',
    profiles: ['lp', 'lp', 'lp', 'lp', 'lp'],
    seatDiffs: ['easy', 'easy', 'normal', 'easy', 'normal'],
    scenario: 'BTN',
  },
  'Calling too much (station)': {
    why: 'You pay off too much — vs nits and TAGs, a big bet means it. Practice folding.',
    profiles: ['nit', 'tag', 'nit', 'tag', 'nit'],
    seatDiffs: ['hard', 'hard', 'normal', 'hard', 'normal'],
    scenario: 'BB',
  },
  'Over-bluffing / spewing': {
    why: 'You bluff too much — stations never fold, so practice giving up with air.',
    profiles: ['lp', 'lp', 'lp', 'maniac', 'lp'],
    seatDiffs: ['easy', 'normal', 'easy', 'normal', 'easy'],
    scenario: 'random',
  },
};

/** Pick the worst actionable leak (high before medium; low/ok are noise) and
 *  return its drill, or null when the hero has no leak worth drilling yet. */
export function coachDrill(leaks: Leak[]): CoachDrill | null {
  for (const sev of ['high', 'medium'] as const) {
    const leak = leaks.find((l) => l.severity === sev && DRILLS[l.label]);
    if (leak) return { leak: leak.label, ...DRILLS[leak.label] };
  }
  return null;
}
