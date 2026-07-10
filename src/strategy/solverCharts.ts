// Solver-chart override layer. Reads true-GTO preflop solutions from
// data/solverPreflop.json (PioSolver / TexasSolver / GTO Wizard exports) and, when
// present, OVERRIDES the app's built-in heuristic charts — for the range grid, the
// preflop trainer, live feedback, and the villain ranges the bots & Postflop Lab
// face. When a scenario (or a specific hand) is absent, callers fall back to the
// heuristic, so a partial chart is safe. The shipped JSON is empty → no behaviour
// change until real data is dropped in. See data/README.md for the format.

import rawFile from '../data/solverPreflop.json';
import type { ActionId, ActionOption } from './types';

/** One action for a hand in a solved node. */
interface SolverAction {
  a: ActionId;
  f: number;
  k?: ActionOption['kind'];
  ev?: number;
}
type SolverChart = Record<string, SolverAction[]>;
interface SolverFile {
  meta?: { source?: string; stackBB?: number; notes?: string };
  charts?: Record<string, SolverChart>;
}

const file = rawFile as SolverFile;
const charts: Record<string, SolverChart> = file.charts ?? {};

/** Normalised action the callers consume (label is built by the caller so it stays
 *  consistent with the heuristic path's wording). */
export interface SolverActionOut {
  id: ActionId;
  freq: number;
  kind?: ActionOption['kind'];
  ev?: number;
}

/** Any solver charts loaded at all? (false for the shipped empty file). */
export function solverActive(): boolean {
  return Object.keys(charts).length > 0;
}

export function solverMeta(): SolverFile['meta'] | null {
  return file.meta ?? null;
}

/** Is there a non-empty solved chart for this scenario id? */
export function hasSolverChart(id: string): boolean {
  const c = charts[id];
  return c != null && Object.keys(c).length > 0;
}

/** Solved mixed strategy for one hand in a scenario — or null to fall back to the
 *  heuristic (no chart for this scenario, or the hand isn't listed). */
export function solverActions(id: string, code: string): SolverActionOut[] | null {
  const chart = charts[id];
  if (!chart) return null;
  const actions = chart[code];
  if (!actions || !actions.length) return null;
  return actions.map((x) => ({ id: x.a, freq: x.f, kind: x.k, ev: x.ev }));
}

/** Project a solved chart to a BINARY range Set (the model the ranges use): every
 *  hand whose summed NON-FOLD frequency is at least `minPlay`. Pure — exported for
 *  tests and reused by solverRangeSet. */
export function projectRangeSet(chart: SolverChart, minPlay = 0.5): Set<string> {
  const s = new Set<string>();
  for (const code in chart) {
    const played = chart[code].filter((x) => x.a !== 'fold').reduce((a, x) => a + x.f, 0);
    if (played >= minPlay) s.add(code);
  }
  return s;
}

/** Binary range Set from a solved chart, or null if there's no chart for this id. */
export function solverRangeSet(id: string, minPlay = 0.5): Set<string> | null {
  const chart = charts[id];
  return chart ? projectRangeSet(chart, minPlay) : null;
}

/** Solver range Set when a chart exists for `id`, else the heuristic `fallback`. */
export function resolveRangeSet(id: string, fallback: Set<string>, minPlay = 0.5): Set<string> {
  return solverRangeSet(id, minPlay) ?? fallback;
}
