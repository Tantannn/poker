import { useMemo, useState } from 'react';
import { SCENARIOS, cellStrategy, getScenario } from '../strategy/preflopChart';
import { KIND_COLOR, KIND_LABEL, cellBackground } from './chartColors';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

export function RangeGrid() {
  const [scId, setScId] = useState(SCENARIOS[0].id);
  const [sel, setSel] = useState<string | null>(null);
  const sc = getScenario(scId);

  const { cells, tally } = useMemo(() => {
    const t = { value: 0, bluff: 0, call: 0, fold: 0 } as Record<string, number>;
    const c = RANKS.flatMap((r1, i) =>
      RANKS.map((r2, j) => {
        const code = i === j ? r1 + r1 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
        const opts = cellStrategy(sc, code);
        const combos = code.length === 2 ? 6 : code.endsWith('s') ? 4 : 12;
        for (const o of opts) {
          const k = o.kind ?? 'fold';
          t[k] = (t[k] ?? 0) + o.freq * combos;
        }
        return { code, opts, i, j };
      }),
    );
    return { cells: c, tally: t };
  }, [sc]);

  const selOpts = sel ? cellStrategy(sc, sel) : null;

  return (
    <div className="card">
      <h2>Preflop Range Charts</h2>
      <p className="sub">
        Color-coded 13×13 matrix with mixed frequencies. Pick a scenario — opening, defending,
        3-betting, or 4-betting. Click any hand for its exact action mix.
      </p>

      <div className="chart-scenario">
        <label className="inline-label">Scenario</label>
        <select value={scId} onChange={(e) => { setScId(e.target.value); setSel(null); }}>
          <optgroup label="Open (RFI)">
            {SCENARIOS.filter((s) => s.facing === 'rfi').map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </optgroup>
          <optgroup label="Versus an open">
            {SCENARIOS.filter((s) => s.facing === 'vsopen').map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </optgroup>
          <optgroup label="Versus a 3-bet">
            {SCENARIOS.filter((s) => s.facing === 'vs3bet').map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </optgroup>
          <optgroup label="Versus a 4-bet">
            {SCENARIOS.filter((s) => s.facing === 'vs4bet').map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </optgroup>
        </select>
      </div>

      <div className="grid-wrap">
        <div className="hand-grid">
          {cells.map(({ code, opts, i, j }) => (
            <div
              key={`${i}-${j}`}
              className={`grid-cell ${sel === code ? 'sel' : ''} ${i === j ? 'pair' : ''}`}
              style={{ background: cellBackground(opts) }}
              onClick={() => setSel(code === sel ? null : code)}
              title={code}
            >
              {code}
            </div>
          ))}
        </div>

        <div className="grid-side">
          <div className="legend chart-legend">
            <div><span className="sw" style={{ background: KIND_COLOR.value }} /> {KIND_LABEL.value}</div>
            {sc.facing !== 'rfi' && <div><span className="sw" style={{ background: KIND_COLOR.call }} /> Call</div>}
            {sc.facing !== 'rfi' && <div><span className="sw" style={{ background: KIND_COLOR.bluff }} /> 3-Bet bluff</div>}
            <div><span className="sw" style={{ background: KIND_COLOR.fold }} /> Fold</div>
          </div>

          <div className="info-block">
            <b>{sc.label}</b>
            <div className="tally">
              <span style={{ color: KIND_COLOR.value }}>Value {combosPct(tally.value)}</span>
              {sc.facing !== 'rfi' && <span style={{ color: KIND_COLOR.call }}>Call {combosPct(tally.call)}</span>}
              {sc.facing !== 'rfi' && <span style={{ color: KIND_COLOR.bluff }}>Bluff {combosPct(tally.bluff)}</span>}
            </div>
          </div>

          {selOpts ? (
            <div className="info-block cell-detail">
              <b>{sel}</b>
              {selOpts.map((o) => (
                <div key={o.id + (o.label ?? '')} className="cell-act">
                  <span className="dot" style={{ background: KIND_COLOR[o.kind ?? 'fold'] }} />
                  <span className="cell-act-label">{o.label}</span>
                  <span className="cell-act-freq">{(o.freq * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="info-block">Click a hand to see its mixed strategy.</div>
          )}
        </div>
      </div>
      <p className="note">
        Teaching-baseline charts with representative mixed frequencies (bluffs are split with fold/call).
        Real solver outputs shift with sizing, stack depth, and rake — use these as a strong reference.
      </p>
    </div>
  );
}

function combosPct(combos: number): string {
  return `${((combos / 1326) * 100).toFixed(1)}%`;
}
