// Drill deal-filter: force the hero's dealt hole cards into a chosen starting-
// hand class so a session drills that class in repetition (e.g. 50 suited
// connectors in a row) instead of waiting for it to come up at random. Rides the
// same path as "Focus borderline hands": pick a 169 code here, then the engine's
// biasHoleCards swaps the hero's cards to it and keeps the deck valid.
//
// Caveat baked into the UI hint: a class dealt in a vacuum teaches the hand, not
// the range — real EV lives in hand-class × board × position. This is a drill
// aid, not normal play, so it defaults off.

import { rankToChar } from '../engine/cards';

export type DrillClass =
  | 'off'
  | 'pairs'
  | 'suited-connectors'
  | 'suited-gappers'
  | 'suited-aces'
  | 'broadway'
  | 'offsuit-junk';

export const DRILL_CLASSES: { id: DrillClass; label: string; hint: string }[] = [
  { id: 'off', label: 'Off (random deal)', hint: 'Deal normally.' },
  { id: 'pairs', label: 'Pocket pairs', hint: 'Set-mining & overpair play (22–AA).' },
  { id: 'suited-connectors', label: 'Suited connectors', hint: 'Draws & implied odds (43s–AKs, adjacent).' },
  { id: 'suited-gappers', label: 'Suited gappers', hint: 'One/two-gap suited (86s, 95s).' },
  { id: 'suited-aces', label: 'Suited aces', hint: 'Nut-flush draws & blockers (A2s–AKs).' },
  { id: 'broadway', label: 'Broadway', hint: 'Top-pair & kicker discipline (JTs–AK).' },
  { id: 'offsuit-junk', label: 'Offsuit junk', hint: 'Fold-discipline reps (K9o, J4o…).' },
];

interface Combo {
  code: string; // 169-hand code: "77", "AJs", "K9o"
  hi: number;
  lo: number;
  suited: boolean;
  pair: boolean;
}

// Enumerate all 169 starting-hand codes once. hi >= lo; a pair has hi === lo and
// no suit suffix.
function allCombos(): Combo[] {
  const out: Combo[] = [];
  for (let hi = 14; hi >= 2; hi--) {
    for (let lo = hi; lo >= 2; lo--) {
      if (hi === lo) {
        out.push({ code: `${rankToChar(hi)}${rankToChar(hi)}`, hi, lo, suited: false, pair: true });
      } else {
        out.push({ code: `${rankToChar(hi)}${rankToChar(lo)}s`, hi, lo, suited: true, pair: false });
        out.push({ code: `${rankToChar(hi)}${rankToChar(lo)}o`, hi, lo, suited: false, pair: false });
      }
    }
  }
  return out;
}

function matches(cls: DrillClass, c: Combo): boolean {
  const gap = c.hi - c.lo;
  switch (cls) {
    case 'pairs':
      return c.pair;
    case 'suited-connectors':
      return c.suited && gap === 1;
    case 'suited-gappers':
      return c.suited && gap >= 2 && gap <= 3;
    case 'suited-aces':
      return c.suited && c.hi === 14;
    case 'broadway':
      return !c.pair && c.lo >= 10; // both cards ten-or-higher (T=10)
    case 'offsuit-junk':
      return !c.suited && !c.pair && c.lo < 10; // offsuit, at least one low card
    default:
      return false;
  }
}

// pool of codes per class, built once. Buckets may overlap (AKs is a suited ace,
// a suited connector, and broadway) — each pick draws from its own pool.
const COMBOS = allCombos();
const POOLS: Record<Exclude<DrillClass, 'off'>, string[]> = {
  pairs: COMBOS.filter((c) => matches('pairs', c)).map((c) => c.code),
  'suited-connectors': COMBOS.filter((c) => matches('suited-connectors', c)).map((c) => c.code),
  'suited-gappers': COMBOS.filter((c) => matches('suited-gappers', c)).map((c) => c.code),
  'suited-aces': COMBOS.filter((c) => matches('suited-aces', c)).map((c) => c.code),
  broadway: COMBOS.filter((c) => matches('broadway', c)).map((c) => c.code),
  'offsuit-junk': COMBOS.filter((c) => matches('offsuit-junk', c)).map((c) => c.code),
};

/** A random 169 code from the drill class, or null for 'off' / an empty pool.
 *  Feed the result to biasHoleCards to force the hero's next hand into it. */
export function pickDrillCode(cls: DrillClass, rng: () => number = Math.random): string | null {
  if (cls === 'off') return null;
  const pool = POOLS[cls];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(rng() * pool.length)];
}
