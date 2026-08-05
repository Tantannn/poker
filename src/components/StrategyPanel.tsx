// The "Info Button" HUD: solver-model mixed strategy — frequency % and EV (bb)
// for every action, with optional "why / how it's calculated" explanations and
// a popup of the range chart at the hero's position.

import { useState } from 'react';
import type { NodeStrategy, ReadDetail, ReadStat } from '../strategy';
import type { RngInfo } from '../hooks/useGame';
import { InfoTip } from './CalcTip';
import { EngineBadge } from './EngineBadge';

// quality tier of an option vs the best line, by EV loss (bb)
function tierOf(evLoss: number): { cls: string; tag: string } {
  if (evLoss <= 0.04) return { cls: 'tier-best', tag: 'best' };
  if (evLoss <= 0.4) return { cls: 'tier-ok', tag: 'inaccuracy' };
  return { cls: 'tier-bad', tag: 'mistake' };
}

const pct = (x: number) => Math.round(x * 100);

interface Props {
  strategy: NodeStrategy | null;
  rng: RngInfo | null;
  enabled: boolean;
  onToggle: () => void;
  loading: boolean;
  heroStack: number; // chips behind (for the % -of-stack risk on each action)
  heroCommitted: number; // chips already in this street
  bigBlind: number; // current big blind in chips — bet sizes shown in bb against it
  hideAnswer?: boolean; // study mode: hide the mix/EV until the hero acts
  onPeek?: () => void;
}

export function StrategyPanel({ strategy, rng, enabled, onToggle, loading, heroStack, heroCommitted, bigBlind, hideAnswer, onPeek }: Props) {
  // Which mix the rows show. A read moves frequencies silently otherwise, and a
  // deviation you can't see next to its baseline teaches nothing.
  const [view, setView] = useState<'read' | 'chart'>('read');
  const baseline = strategy?.baseline ?? null;
  const showBaseline = view === 'chart' && !!baseline;
  const mix = showBaseline ? baseline.options : (strategy?.options ?? []);
  const bestId = showBaseline ? baseline.bestId : strategy?.bestId;
  const bestEv = showBaseline ? Math.max(...baseline.options.map((o) => o.ev)) : (strategy?.bestEv ?? 0);
  const baseFreq = baseline ? new Map(baseline.options.map((o) => [o.id, o.freq] as const)) : null;

  return (
    <div className="strat-panel">
      <div className="strat-head">
        <span>🧠 Solver strategy</span>
        {strategy && enabled && <EngineBadge strategy={strategy} />}
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
      ) : hideAnswer ? (
        <div className="strat-locked">
          <p>🎓 <b>Study mode</b> — the solver's mix &amp; EVs are hidden so you commit first. They're revealed the moment you act (the Feedback box grades you), or peek now.</p>
          <button className="peek-btn" onClick={onPeek}>👁 Reveal the solver mix</button>
        </div>
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
          {strategy.engineNote && <div className="strat-engine-note">≈ {strategy.engineNote}</div>}
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
          {baseline && (
            <div className="strat-view">
              <div className="strat-view-btns" role="group" aria-label="Which mix to show">
                <button className={view === 'read' ? 'on' : ''} onClick={() => setView('read')}>
                  🎯 Read-adjusted
                </button>
                <button className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>
                  📘 Chart baseline
                </button>
              </div>
              <span className="strat-view-sub">
                {showBaseline
                  ? `${baseline.label} — what you'd play against a player you know nothing about.`
                  : 'Frequencies bent toward this specific opponent. Flip to the chart to see the standard line.'}
              </span>
            </div>
          )}
          <div className={`strat-rows ${showBaseline ? 'baseline-view' : ''}`}>
            {mix.map((o) => {
              const isPrescribed = rng?.prescribed === o.id;
              const isBest = o.id === bestId;
              const evLoss = Math.max(0, bestEv - o.ev);
              const tier = isBest ? { cls: 'tier-best', tag: 'best' } : tierOf(evLoss);
              const from = baseFreq?.get(o.id);
              const moved = !showBaseline && from != null && Math.abs(from - o.freq) >= 0.02;
              // how much of the remaining stack this action commits — the risk
              // EV alone hides. Flags lines that turn into a stack-off.
              const invest = o.amount != null ? Math.max(0, o.amount - heroCommitted) : 0;
              const stackPct = heroStack > 0 && o.amount != null ? Math.min(1, invest / heroStack) : 0;
              const bigCommit = o.id !== 'allin' && stackPct >= 0.5;
              return (
                <div key={o.id} className="strat-rowwrap">
                  <div className={`strat-row ${isPrescribed ? 'prescribed' : ''}`}>
                    <div className="strat-bar-wrap">
                      <div className={`strat-bar kind-${o.kind ?? 'fold'}`} style={{ width: `${o.freq * 100}%` }} />
                      {moved && <div className="strat-bar-ghost" style={{ width: `${from * 100}%` }} title={`Chart baseline: ${pct(from)}%`} />}
                      <span className="strat-label">
                        {o.label}
                        <span className={`tier-tag ${tier.cls}`}>{tier.tag}</span>
                        {moved && (
                          <span className={`freq-delta ${o.freq > from ? 'up' : 'down'}`} title="Chart baseline → after the read">
                            {pct(from)}% {o.freq > from ? '↑' : '↓'}
                          </span>
                        )}
                        {o.id === 'allin' && <span className="risk-tag" title="High-variance: stacking off is hard to recover from in real play">⚠ risky</span>}
                        {bigCommit && <span className="risk-tag" title={`Commits ${Math.round(stackPct * 100)}% of your remaining stack — you'll be pot-committed, expect to call it off`}>⚠ {Math.round(stackPct * 100)}% stack</span>}
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
                      {' '}({(o.amount / bigBlind).toFixed(1)}bb){o.sizePct != null ? ` · ${o.sizePct}% pot` : ''}
                      {stackPct > 0 ? ` · ${Math.round(stackPct * 100)}% stack` : ''}
                    </div>
                  )}
                  {o.sizeNote && <div className="strat-balance">{o.sizeNote}</div>}
                </div>
              );
            })}
          </div>
          {strategy.exploit && <ExploitBox x={strategy.exploit} />}
          {strategy.readDetail && <ReadDetailBox d={strategy.readDetail} />}
          <div className="strat-note">{strategy.note}</div>
        </>
      )}
    </div>
  );
}

/** The exploit delta: what balanced play does here vs what beats THIS villain, and
 *  what the deviation is worth. Only rendered when the engine solved the node
 *  against a read or a manual node lock AND the two lines actually differ — a
 *  balanced opponent produces no box, which is the honest signal that there is
 *  nothing to exploit yet. */
function ExploitBox({ x }: { x: NonNullable<NodeStrategy['exploit']> }) {
  return (
    <div className="strat-exploit">
      <span className="strat-exploit-lbl">
        🎯 Exploit — {x.source === 'locked' ? 'your locked read' : `read, ${Math.round(x.confidence * 100)}% confidence`}
      </span>
      <div className="strat-exploit-lines">
        <span>
          Balanced: <b>{x.baselineLabel}</b>
        </span>
        <span>
          Vs this villain: <b>{x.exploitLabel}</b>
        </span>
        <span className="strat-exploit-gain">+{x.gainBb.toFixed(2)} bb</span>
      </div>
      <p className="strat-exploit-why">{x.why}</p>
    </div>
  );
}

/** The full audit of a read-adjusted preflop node: whose read, which numbers, what
 *  each one prices HERE, which frequencies moved, and how firm the evidence is. The
 *  `spot` lines are the live-table version of each stat — the app's target player has
 *  no HUD, so a stat he can't collect by watching is a stat he can't use. */
function ReadDetailBox({ d }: { d: ReadDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="strat-read">
      <div className="strat-read-head">
        <span className="strat-read-lbl">
          🔎 Why this isn't the chart — {d.source === 'locked' ? 'your locked read' : `observed, ${Math.round(d.confidence * 100)}% confidence`}
        </span>
        <button className="toggle" onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'Break it down'}
        </button>
      </div>
      <div className="strat-read-who">
        Read on <b>{d.who}</b>
      </div>
      <p className="strat-read-headline">{d.headline}</p>

      {d.moves.length > 0 && (
        <div className="strat-read-moves">
          {d.moves.map((m) => (
            <div key={m.id} className="strat-read-move">
              <span className="strat-read-move-lbl">{m.label}</span>
              <span className={`strat-read-move-num ${m.to > m.from ? 'up' : 'down'}`}>
                {pct(m.from)}% → <b>{pct(m.to)}%</b>
              </span>
              <span className="strat-read-move-why">{m.why}</span>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="strat-read-stats">
          {d.stats.map((s) => (
            <StatRow key={s.label} s={s} />
          ))}
        </div>
      )}

      <p className="strat-read-caution">⚠ {d.caution}</p>
    </div>
  );
}

function StatRow({ s }: { s: ReadStat }) {
  // Per-stat scale: a 26%-baseline stat and a 55%-baseline stat share no useful axis,
  // so each bar is drawn against its own headroom with the balanced value marked.
  const max = Math.max(0.4, s.baseline * 2.2, s.value * 1.2);
  const off = s.value - s.baseline;
  return (
    <div className={`strat-read-stat ${s.active ? 'active' : 'idle'}`}>
      <div className="strat-read-stat-head">
        <span className="strat-read-stat-lbl">{s.label}</span>
        <span className="strat-read-stat-val">
          <b>{pct(s.value)}%</b> vs {pct(s.baseline)}% balanced
          <span className={`strat-read-stat-off ${off > 0 ? 'up' : 'down'}`}>
            {off > 0 ? '+' : ''}
            {pct(off)}
          </span>
        </span>
      </div>
      <span className="strat-read-stat-track">
        <span className="strat-read-stat-fill" style={{ width: `${(s.value / max) * 100}%` }} />
        <span className="strat-read-stat-mark" style={{ left: `${(s.baseline / max) * 100}%` }} title="balanced" />
      </span>
      <div className="strat-read-stat-sample">
        {s.sample > 0 ? `${s.sample} decisions seen` : 'locked by hand — no sample'}
        {s.active ? '' : ' · not priced at this node'}
      </div>
      <p className="strat-read-stat-effect">{s.effect}</p>
      <p className="strat-read-stat-spot">👁 Spot it live: {s.spot}</p>
    </div>
  );
}
