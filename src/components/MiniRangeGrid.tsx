// Compact 13x13 grid for popups. Either renders a preflop scenario (action
// colors) or a weighted villain range (green shading), with an optional
// highlighted hero cell. Cells are clickable: tapping one pins its exact
// frequency mix (or range weight) in a readout under the grid, so the popup
// grid answers "how often?" the same way the full Preflop Charts tab does.

import { useState } from 'react';
import { cellStrategy, getScenario } from '../strategy/preflopChart';
import type { WeightedRange } from '../engine/range';
import { cellBackground, KIND_COLOR } from './chartColors';

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
  const [sel, setSel] = useState<string | null>(null);
  const selOpts = sc && sel ? cellStrategy(sc, sel) : null;
  const selWeight = !sc && weights && sel ? (weights.get(sel) ?? 0) : null;
  return (
    <div className="mini-grid-wrap">
      <div className="mini-grid">
        {RANKS.map((r1, i) =>
          RANKS.map((r2, j) => {
            const code = i === j ? r1 + r1 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
            let bg = '#2a3a31';
            let tip = code;
            if (sc) {
              const opts = cellStrategy(sc, code);
              bg = cellBackground(opts);
              tip = `${code} — ${opts.map((o) => `${o.label} ${(o.freq * 100).toFixed(0)}%`).join(', ')}`;
            } else if (weights) {
              const w = weights.get(code) ?? 0;
              bg = w > 0 ? `rgba(${inRangeRgb},${0.3 + 0.6 * w})` : '#2a3a31';
              tip = `${code} — ${w > 0 ? `${(w * 100).toFixed(0)}% of combos in range` : 'not in range'}`;
            }
            return (
              <button
                type="button"
                key={`${i}-${j}`}
                className={`mini-cell ${highlight === code ? 'hl' : ''} ${sel === code ? 'sel' : ''}`}
                style={{ background: bg }}
                onClick={() => setSel(code === sel ? null : code)}
                title={tip}
                aria-label={tip}
              >
                {code}
              </button>
            );
          }),
        )}
      </div>

      {selOpts ? (
        <div className="mini-detail">
          <b>{sel}</b>
          {selOpts.map((o) => (
            <span key={o.id + (o.label ?? '')} className="mini-detail-act">
              <span className="dot" style={{ background: KIND_COLOR[o.kind ?? 'fold'] }} />
              {o.label} <b>{(o.freq * 100).toFixed(0)}%</b>
            </span>
          ))}
        </div>
      ) : selWeight !== null ? (
        <div className="mini-detail">
          <b>{sel}</b>
          <span className="mini-detail-act">
            {selWeight > 0
              ? <>in villain&apos;s range at <b>{(selWeight * 100).toFixed(0)}%</b> weight</>
              : <>not in villain&apos;s range (<b>folds</b>)</>}
          </span>
        </div>
      ) : (
        <div className="mini-detail mini-detail-hint">Tap any hand for its exact %.</div>
      )}
    </div>
  );
}
