// Shared popup that renders the range chart for a node — either the hero's
// preflop strategy grid or the villain's postflop range — with the hero hand
// highlighted. Used by the Solver-strategy panel and the mistake feedback.

import type { NodeStrategy } from '../strategy';
import { MiniRangeGrid } from './MiniRangeGrid';
import { KIND_COLOR, KIND_LABEL } from './chartColors';

export function RangeChartModal({ strategy, onClose }: { strategy: NodeStrategy; onClose: () => void }) {
  const isPreflop = strategy.source === 'preflop-chart';
  const villainCalls = /defend|call/i.test(strategy.rangeNote ?? '');
  const inRgb = villainCalls ? '58,160,224' : '46,194,126';
  const villainActLabel = villainCalls ? 'Villain calls / defends these' : 'Villain raises (opens) these';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{isPreflop ? `Your range — ${strategy.rangeNote}` : `Villain's range — ${strategy.rangeNote}`}</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <MiniRangeGrid
            scenarioId={isPreflop ? strategy.scenarioId : undefined}
            weights={isPreflop ? undefined : strategy.villainRange}
            highlight={strategy.heroCode}
            inRangeRgb={inRgb}
          />
          <div className="modal-side">
            {isPreflop ? (
              <>
                <p className="modal-note">
                  This is your strategy grid for the spot. Your hand <b>{strategy.heroCode}</b> is outlined in gold —
                  its color shows the action mix.
                </p>
                <div className="legend chart-legend">
                  <div><span className="sw" style={{ background: KIND_COLOR.value }} /> {KIND_LABEL.value}</div>
                  <div><span className="sw" style={{ background: KIND_COLOR.call }} /> Call</div>
                  <div><span className="sw" style={{ background: KIND_COLOR.bluff }} /> 3-Bet bluff</div>
                  <div><span className="sw" style={{ background: KIND_COLOR.fold }} /> Fold</div>
                </div>
              </>
            ) : (
              <>
                <p className="modal-note">
                  Each shaded hand is one villain can hold here (darker = more combos). Your hand{' '}
                  <b>{strategy.heroCode}</b> is outlined in gold. Your equity of{' '}
                  <b>{((strategy.equity ?? 0) * 100).toFixed(1)}%</b> is measured against this whole range.
                </p>
                <div className="legend chart-legend">
                  <div><span className="sw" style={{ background: `rgba(${inRgb},0.85)` }} /> {villainActLabel}</div>
                  <div><span className="sw" style={{ background: '#2a3a31' }} /> Not in range (folds)</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
