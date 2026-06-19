// The "Info Button" HUD: solver-model mixed strategy — frequency % and EV (bb)
// for every action, with optional "why / how it's calculated" explanations and
// a popup of the range chart at the hero's position.

import { useState } from 'react';
import type { NodeStrategy } from '../strategy';
import type { RngInfo } from '../hooks/useGame';
import { BIG_BLIND } from '../hooks/useGame';
import { RangeChartModal } from './RangeChartModal';

// quality tier of an option vs the best line, by EV loss (bb)
function tierOf(evLoss: number): { cls: string; tag: string } {
  if (evLoss <= 0.04) return { cls: 'tier-best', tag: 'best' };
  if (evLoss <= 0.4) return { cls: 'tier-ok', tag: 'inaccuracy' };
  return { cls: 'tier-bad', tag: 'mistake' };
}

interface Props {
  strategy: NodeStrategy | null;
  rng: RngInfo | null;
  enabled: boolean;
  onToggle: () => void;
  loading: boolean;
}

export function StrategyPanel({ strategy, rng, enabled, onToggle, loading }: Props) {
  const [explain, setExplain] = useState(false);
  const [showChart, setShowChart] = useState(false);

  return (
    <div className="strat-panel">
      <div className="strat-head">
        <span>🧠 Solver strategy</span>
        <div className="strat-head-btns">
          {enabled && strategy && (
            <>
              <button className={`toggle ${explain ? 'on' : ''}`} onClick={() => setExplain((v) => !v)} title="Show why & the EV math">
                ⓘ Explain
              </button>
              <button className="toggle" onClick={() => setShowChart(true)} title="See the range chart at your position">
                📊 Chart
              </button>
            </>
          )}
          <button className="toggle" onClick={onToggle}>
            {enabled ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {!enabled ? (
        <div className="strat-hidden">Frequencies hidden — toggle to reveal the GTO-model mix.</div>
      ) : loading ? (
        <div className="strat-hidden">Solving node…</div>
      ) : !strategy ? (
        <div className="strat-hidden">Waiting for your turn…</div>
      ) : (
        <>
          {rng && (
            <div className="rng-box">
              <div className="rng-roll">🎲 {rng.roll}</div>
              <div className="rng-text">
                Random 1–100 roll → play{' '}
                <b>{strategy.options.find((o) => o.id === rng.prescribed)?.label ?? rng.prescribed}</b>
                <div className="rng-sub">Mixed strategies require an RNG to pick which branch to take.</div>
              </div>
            </div>
          )}
          <div className="strat-rows">
            {strategy.options.map((o) => {
              const isPrescribed = rng?.prescribed === o.id;
              const isBest = o.id === strategy.bestId;
              const evLoss = Math.max(0, strategy.bestEv - o.ev);
              const tier = isBest ? { cls: 'tier-best', tag: 'best' } : tierOf(evLoss);
              return (
                <div key={o.id} className="strat-rowwrap">
                  <div className={`strat-row ${isPrescribed ? 'prescribed' : ''}`}>
                    <div className="strat-bar-wrap">
                      <div className={`strat-bar kind-${o.kind ?? 'fold'}`} style={{ width: `${o.freq * 100}%` }} />
                      <span className="strat-label">
                        {o.label}
                        <span className={`tier-tag ${tier.cls}`}>{tier.tag}</span>
                        {o.id === 'allin' && <span className="risk-tag" title="High-variance: stacking off is hard to recover from in real play">⚠ risky</span>}
                      </span>
                      <span className="strat-freq">{(o.freq * 100).toFixed(0)}%</span>
                    </div>
                    <div className={`strat-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>
                      {o.ev >= 0 ? '+' : ''}
                      {o.ev.toFixed(2)} bb
                    </div>
                  </div>
                  {o.amount != null && (
                    <div className="strat-amt">
                      {o.id === 'call' ? 'call' : o.id === 'raise' ? 'raise to' : o.id === 'open' ? 'open to' : 'bet to'} <b>{o.amount}</b>
                      {' '}({(o.amount / BIG_BLIND).toFixed(1)}bb){o.sizePct != null ? ` · ${o.sizePct}% pot` : ''}
                    </div>
                  )}
                  {explain && (o.why || o.math) && (
                    <div className="strat-explain">
                      {o.why && <div className="se-why">{o.why}</div>}
                      {o.math && <div className="se-math">{o.math}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="strat-note">{strategy.note}</div>
        </>
      )}

      {showChart && strategy && (
        <RangeChartModal strategy={strategy} onClose={() => setShowChart(false)} />
      )}
    </div>
  );
}
