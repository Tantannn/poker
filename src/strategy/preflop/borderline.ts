// Borderline-weighted hand selection, shared by the Preflop Trainer (which cards
// to quiz) and live Play-vs-Bots "focus borderline hands" (which hole cards to
// deal the hero). Uniform-random deals mostly land on hands whose answer is never
// in doubt — obvious premiums and obvious trash. The reps worth having are the
// CLOSE ones: mixed-frequency cells and cells sitting on a range boundary. We
// weight toward those so practice lands where memory actually slips.

import type { PreflopScenario } from './preflopChart';
import { cellStrategy, dominantKind } from './preflopChart';

// Grid order (A→2) so cell neighbors map to adjacent hands, matching MiniRangeGrid.
const GRID_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

// The 169 code at grid cell (i,j): pair on the diagonal, suited above, offsuit below.
export function codeAt(i: number, j: number): string {
  const r1 = GRID_RANKS[i];
  const r2 = GRID_RANKS[j];
  return i === j ? r1 + r1 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
}

// Per-cell deal weight for a scenario: mixed cells highest, then boundary cells
// (a neighbor plays a different dominant action), then a low floor for clear
// interior hands and a lower one for deep folds.
export function borderlineWeights(sc: PreflopScenario): { code: string; w: number }[] {
  const N = GRID_RANKS.length;
  const dom: string[][] = [];
  const mixed: boolean[][] = [];
  for (let i = 0; i < N; i++) {
    dom[i] = [];
    mixed[i] = [];
    for (let j = 0; j < N; j++) {
      const opts = cellStrategy(sc, codeAt(i, j));
      dom[i][j] = dominantKind(opts) ?? 'fold';
      mixed[i][j] = opts.length > 1; // a real frequency split (mixOpen / bluff cells)
    }
  }
  const out: { code: string; w: number }[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const k = dom[i][j];
      const nb = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
      const boundary = nb.some(([ni, nj]) => ni >= 0 && nj >= 0 && ni < N && nj < N && dom[ni][nj] !== k);
      const w = mixed[i][j] ? 6 : boundary ? 4 : k === 'fold' ? 0.3 : 1.2;
      out.push({ code: codeAt(i, j), w });
    }
  }
  return out;
}

export function weightedPick(items: { code: string; w: number }[], rng: () => number = Math.random): string {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = rng() * total;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.code;
  }
  return items[items.length - 1].code;
}

/** A borderline-weighted 169 code (e.g. "AJs", "77", "K9o") for a scenario. */
export function pickBorderlineCode(sc: PreflopScenario, rng: () => number = Math.random): string {
  return weightedPick(borderlineWeights(sc), rng);
}
