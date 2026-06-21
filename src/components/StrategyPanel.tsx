// The "Info Button" HUD: solver-model mixed strategy — frequency % and EV (bb)
// for every action, with optional "why / how it's calculated" explanations and
// a popup of the range chart at the hero's position.

import type { NodeStrategy } from '../strategy';
import type { RngInfo } from '../hooks/useGame';
import { BIG_BLIND } from '../hooks/useGame';
import { InfoTip } from './CalcTip';

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
  return (
    <div className="strat-panel">
      <div className="strat-head">
        <span>🧠 Solver strategy</span>
        <div className="strat-head-btns">
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
          <div className="strat-sizing">
            <span>💡 Size by <b>polarization</b>, not "am I winning": monsters + bluffs → <b>big</b> · medium made → <b>small</b> · no-equity air → <b>check</b>.</span>
            <InfoTip
              content={
                <span className="tip-body">
                  <b className="tip-title">Why size this way</b>
                  <span className="tip-what">
                    <b>Value</b> = get called by worse. <b>Bluff</b> = fold out better. You can't value-bet
                    air — nothing worse calls, so betting big with nothing is a <b>bluff</b>, not value.
                  </span>
                  <span className="tip-what">
                    <b>Monsters + bluffs → big</b> (polar): value gets paid, bluffs fold out better hands.
                    {' '}<b>Medium made → small</b> (thin value/merge): worse hands keep calling, don't blow
                    them off. <b>Trash with no fold equity → check</b>.
                  </span>
                  <span className="tip-remember"><b>Remember:</b> the axis is how polarized you are, not
                    winning vs losing. The EVs below already price this in.</span>
                </span>
              }
            />
          </div>
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
                        {(o.why || o.math) && (
                          <InfoTip
                            content={
                              <span className="tip-body">
                                {o.why && <span className="tip-what">{o.why}</span>}
                                {o.math && <code className="tip-formula">{o.math}</code>}
                              </span>
                            }
                          />
                        )}
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
                </div>
              );
            })}
          </div>
          <div className="strat-note">{strategy.note}</div>
        </>
      )}
    </div>
  );
}
