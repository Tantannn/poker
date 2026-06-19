// Compact 13x13 grid for popups. Either renders a preflop scenario (action
// colors) or a weighted villain range (green shading), with an optional
// highlighted hero cell.

import { cellStrategy, getScenario } from '../strategy/preflopChart';
import type { WeightedRange } from '../engine/range';
import { cellBackground } from './chartColors';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

interface Props {
  scenarioId?: string;
  weights?: WeightedRange;
  highlight?: string;
  /** RGB triple for shading the weighted (villain) range, e.g. "46,194,126". */
  inRangeRgb?: string;
}

export function MiniRangeGrid({ scenarioId, weights, highlight, inRangeRgb = '46,194,126' }: Props) {
  const sc = scenarioId ? getScenario(scenarioId) : null;
  return (
    <div className="mini-grid">
      {RANKS.map((r1, i) =>
        RANKS.map((r2, j) => {
          const code = i === j ? r1 + r1 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
          let bg = '#2a3a31';
          if (sc) {
            bg = cellBackground(cellStrategy(sc, code));
          } else if (weights) {
            const w = weights.get(code) ?? 0;
            bg = w > 0 ? `rgba(${inRangeRgb},${0.3 + 0.6 * w})` : '#2a3a31';
          }
          return (
            <div
              key={`${i}-${j}`}
              className={`mini-cell ${highlight === code ? 'hl' : ''}`}
              style={{ background: bg }}
              title={code}
            >
              {code}
            </div>
          );
        }),
      )}
    </div>
  );
}
