// Honest provenance chip, shared by the strategy panel and the grade box: a real
// range-vs-range CFR solve, the per-hand heuristic EV model, or a preflop chart.
// README: never present the per-hand estimate as solver output.

import type { NodeStrategy } from '../strategy/types';

export function EngineBadge({ strategy }: { strategy: NodeStrategy }) {
  if (strategy.source === 'preflop-chart')
    return <span className="engine-badge chart" title="Preflop chart — a ~100bb teaching baseline, not a per-node solve.">chart</span>;
  if (strategy.engine === 'cfr')
    return <span className="engine-badge cfr" title="A real range-vs-range CFR solve of this exact node.">✓ solved</span>;
  if (strategy.engine === 'heuristic')
    return (
      <span
        className="engine-badge heur"
        title={
          strategy.engineNote ??
          'Per-hand heuristic EV model — a teaching estimate, NOT a range-vs-range solve. Used where the solver gates don\'t reach: villain-first or facing-a-bet multiway, or when a read routes to the exploit path.'
        }
      >
        ≈ estimate
      </span>
    );
  return null;
}
