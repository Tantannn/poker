import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useGame } from '../hooks/useGame';
import { accuracy, bbPer100, evLossPer100, rngAdherence, totalEvLoss, scoreBuckets, gtowScore } from '../store/stats';
import type { DecisionRecord } from '../store/stats';
import { PlayingCard } from './PlayingCard';
import { CalcLabel } from './CalcTip';

type G = ReturnType<typeof useGame>;

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'] as const;

interface GroupStat {
  key: string;
  n: number;
  accPct: number; // % correct
  avgLoss: number; // bb
}

function groupBy(decisions: DecisionRecord[], pick: (d: DecisionRecord) => string): GroupStat[] {
  const map = new Map<string, { n: number; correct: number; loss: number }>();
  for (const d of decisions) {
    const k = pick(d);
    const g = map.get(k) ?? { n: 0, correct: 0, loss: 0 };
    g.n++;
    if (d.verdict === 'correct') g.correct++;
    g.loss += d.evLoss ?? 0;
    map.set(k, g);
  }
  return [...map.entries()].map(([key, v]) => ({
    key,
    n: v.n,
    accPct: v.n ? Math.round((v.correct / v.n) * 100) : 0,
    avgLoss: v.n ? v.loss / v.n : 0,
  }));
}

export function Analytics({ g }: { g: G }) {
  const { stats, leaks, history } = g;
  const acc = accuracy(stats);
  const bb100 = bbPer100(stats);
  const accPct = acc.total ? Math.round((acc.correct / acc.total) * 100) : 0;
  const evLoss100 = evLossPer100(stats);
  const evLossAll = totalEvLoss(stats);
  const rng = rngAdherence(stats);
  const rngPct = rng.total ? Math.round((rng.followed / rng.total) * 100) : 0;
  const [expanded, setExpanded] = useState<string | null>(null);

  const buckets = scoreBuckets(stats);
  const score = gtowScore(stats);

  // cumulative net bb over hands (chronological — history is newest-first).
  // Built with reduce-push (no captured-variable reassignment) to satisfy the
  // react-hooks immutability rule — mutating the fresh local accumulator is fine.
  const curve = useMemo(() => {
    return [...history].reverse().reduce<number[]>((acc, h) => {
      acc.push((acc.length ? acc[acc.length - 1] : 0) + h.deltaBB);
      return acc;
    }, []);
  }, [history]);

  const byStreet = useMemo(
    () =>
      groupBy(stats.decisions, (d) => d.street).sort(
        (a, b) => STREET_ORDER.indexOf(a.key as never) - STREET_ORDER.indexOf(b.key as never),
      ),
    [stats.decisions],
  );
  const byPos = useMemo(
    () => groupBy(stats.decisions, (d) => d.position).sort((a, b) => b.n - a.n),
    [stats.decisions],
  );

  return (
    <>
      <div className="card">
        <div className="analytics-head">
          <h2>Session Analytics</h2>
          <button className="btn-small" onClick={g.doResetStats}>
            Reset stats
          </button>
        </div>
        <div className="kpi-grid">
          <Kpi label="Hands played" value={`${stats.handsPlayed}`} />
          <Kpi
            label={<CalcLabel id="bb100" pos="bottom">Win rate (bb/100)</CalcLabel>}
            value={`${bb100 >= 0 ? '+' : ''}${bb100.toFixed(1)}`}
            tone={bb100 > 0 ? 'pos' : bb100 < 0 ? 'neg' : ''}
          />
          <Kpi
            label={<CalcLabel id="netBB" pos="bottom">Net result</CalcLabel>}
            value={`${stats.netBB >= 0 ? '+' : ''}${stats.netBB.toFixed(1)} bb`}
            tone={stats.netBB > 0 ? 'pos' : stats.netBB < 0 ? 'neg' : ''}
          />
          <Kpi label={<CalcLabel id="accuracy" pos="bottom">Decision accuracy</CalcLabel>} value={`${accPct}%`} />
          <Kpi
            label={<CalcLabel id="evLoss100" pos="bottom">EV lost / 100</CalcLabel>}
            value={`${evLoss100.toFixed(2)} bb`}
            tone={evLoss100 > 2 ? 'neg' : evLoss100 > 0.5 ? '' : 'pos'}
          />
          <Kpi label={<CalcLabel id="evLoss" pos="bottom">Total EV lost</CalcLabel>} value={`${evLossAll.toFixed(2)} bb`} tone={evLossAll > 0 ? 'neg' : 'pos'} />
          <Kpi label={<CalcLabel id="rngAdherence" pos="bottom">RNG adherence</CalcLabel>} value={rng.total ? `${rngPct}%` : '—'} />
        </div>
        <p className="note">Hover any metric for its formula &amp; a memory hook. Lower EV loss is better.</p>
        <div className="decision-bar">
          <Seg cls="good" n={acc.correct} total={acc.total} label="On baseline" />
          <Seg cls="okv" n={acc.ok} total={acc.total} label="Reasonable" />
          <Seg cls="bad" n={acc.mistake} total={acc.total} label="Leaks" />
        </div>
        <p className="note">
          “Decision accuracy” compares each move to a transparent baseline — a yardstick, not a solver.
        </p>
      </div>

      <div className="card">
        <h2>Performance breakdown</h2>
        {stats.decisions.length === 0 ? (
          <p className="sub">Play some hands to populate charts and per-street / per-position breakdowns.</p>
        ) : (
          <>
            <div className="an-section">
              <div className="an-h">Bankroll — cumulative net (bb)</div>
              {curve.length < 2 ? (
                <p className="sub">Need ≥2 hands for a trend line.</p>
              ) : (
                <Sparkline data={curve} />
              )}
            </div>

            <div className="an-section">
              <div className="an-h">Move quality — <CalcLabel id="gtowScore">GTOW score</CalcLabel> {score}%</div>
              <div className="an-tiers">
                <TierSeg cls="tbest" n={buckets.best} total={buckets.moves} label="Best" />
                <TierSeg cls="tcorrect" n={buckets.correct} total={buckets.moves} label="Correct" />
                <TierSeg cls="tinacc" n={buckets.inaccuracy} total={buckets.moves} label="Inaccuracy" />
                <TierSeg cls="twrong" n={buckets.wrong} total={buckets.moves} label="Wrong" />
                <TierSeg cls="tblunder" n={buckets.blunder} total={buckets.moves} label="Blunder" />
              </div>
              <div className="an-tier-legend">
                <span><i className="sw tbest" /> Best {buckets.best}</span>
                <span><i className="sw tcorrect" /> Correct {buckets.correct}</span>
                <span><i className="sw tinacc" /> Inaccuracy {buckets.inaccuracy}</span>
                <span><i className="sw twrong" /> Wrong {buckets.wrong}</span>
                <span><i className="sw tblunder" /> Blunder {buckets.blunder}</span>
              </div>
            </div>

            <div className="an-grids">
              <GroupTable title="By street" rows={byStreet} />
              <GroupTable title="By position" rows={byPos} />
            </div>
            <p className="note">
              Highest avg-EV-loss spots are where to focus study. Hover the column headers for details.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>Leak Finder</h2>
        {stats.decisions.length < 8 ? (
          <p className="sub">Play ~10+ hands at the table to surface patterns in your decisions.</p>
        ) : (
          <div className="leak-list">
            {leaks.map((l) => (
              <div key={l.label} className={`leak leak-${l.severity}`}>
                <div className="leak-top">
                  <span className="leak-label">{l.label}</span>
                  <span className="leak-rate">
                    {(l.rate * 100).toFixed(0)}% <span className="muted">({l.sample} spots)</span>
                  </span>
                </div>
                <div className="leak-bar">
                  <div className="leak-fill" style={{ width: `${Math.min(100, l.rate * 100)}%` }} />
                </div>
                {l.severity !== 'ok' && l.severity !== 'low' && <div className="leak-detail">{l.detail}</div>}
              </div>
            ))}
            {leaks.every((l) => l.severity === 'ok' || l.severity === 'low') && (
              <p className="sub good">No major leaks detected — solid, balanced play so far. 👍</p>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Hand History</h2>
        {history.length === 0 ? (
          <p className="sub">Played hands will appear here for step-by-step review.</p>
        ) : (
          <div className="history-list">
            {history.map((h) => (
              <div key={h.id} className="history-item">
                <button className="history-row" onClick={() => setExpanded(expanded === h.id ? null : h.id)}>
                  <span className="hh-num">#{h.handNumber}</span>
                  <span className="hh-cards">
                    {h.heroCards.map((c, i) => (
                      <PlayingCard key={i} card={c} size="sm" />
                    ))}
                  </span>
                  <span className="hh-board">
                    {h.board.length ? h.board.map((c, i) => <PlayingCard key={i} card={c} size="sm" />) : <span className="muted">no flop</span>}
                  </span>
                  <span className={`hh-delta ${h.deltaBB > 0 ? 'pos' : h.deltaBB < 0 ? 'neg' : ''}`}>
                    {h.deltaBB >= 0 ? '+' : ''}
                    {h.deltaBB.toFixed(1)} bb
                  </span>
                </button>
                {expanded === h.id && (
                  <div className="history-detail">
                    <div className="hh-result">{h.result}</div>
                    <ol className="hh-log">
                      {h.log.map((l, i) => (
                        <li key={i}>{l.text}</li>
                      ))}
                    </ol>
                    <div className="hh-showdown">
                      {h.showdown
                        .filter((s) => !s.folded)
                        .map((s, i) => (
                          <div key={i} className="hh-sd">
                            <span>{s.name}</span>
                            {s.cards.map((c, j) => (
                              <PlayingCard key={j} card={c} size="sm" />
                            ))}
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Kpi({ label, value, tone }: { label: ReactNode; value: string; tone?: string }) {
  return (
    <div className="kpi">
      <div className={`kpi-value ${tone ?? ''}`}>{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function Seg({ cls, n, total, label }: { cls: string; n: number; total: number; label: string }) {
  const pct = total ? (n / total) * 100 : 0;
  return (
    <div className={`seg ${cls}`} style={{ flexGrow: Math.max(0.02, pct) }} title={`${label}: ${n}`}>
      {pct > 8 ? `${Math.round(pct)}%` : ''}
    </div>
  );
}

function TierSeg({ cls, n, total, label }: { cls: string; n: number; total: number; label: string }) {
  const pct = total ? (n / total) * 100 : 0;
  if (n === 0) return null;
  return (
    <div className={`an-tier ${cls}`} style={{ flexGrow: Math.max(0.02, pct) }} title={`${label}: ${n} (${Math.round(pct)}%)`}>
      {pct > 7 ? `${Math.round(pct)}%` : ''}
    </div>
  );
}

// Simple cumulative-net sparkline (SVG). Green above 0, red below, zero baseline.
function Sparkline({ data }: { data: number[] }) {
  const W = 600;
  const H = 120;
  const pad = 6;
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = data[data.length - 1];
  const zeroY = y(0);
  return (
    <div className="an-spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="an-spark-svg">
        <line x1={pad} x2={W - pad} y1={zeroY} y2={zeroY} className="an-spark-zero" />
        <polyline points={pts} className={`an-spark-line ${last >= 0 ? 'pos' : 'neg'}`} fill="none" />
      </svg>
      <div className={`an-spark-end ${last >= 0 ? 'pos' : 'neg'}`}>{last >= 0 ? '+' : ''}{last.toFixed(1)} bb</div>
    </div>
  );
}

function GroupTable({ title, rows }: { title: string; rows: GroupStat[] }) {
  return (
    <div className="an-gt">
      <div className="an-h">{title}</div>
      <div className="an-gt-head">
        <span>Spot</span><span>n</span><span>Acc</span><span>Avg EV loss</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="an-gt-row">
          <span className="an-gt-k">{r.key}</span>
          <span>{r.n}</span>
          <span className={r.accPct >= 70 ? 'pos' : r.accPct >= 45 ? '' : 'neg'}>{r.accPct}%</span>
          <span className={r.avgLoss <= 0.2 ? 'pos' : r.avgLoss <= 0.8 ? '' : 'neg'}>{r.avgLoss.toFixed(2)} bb</span>
        </div>
      ))}
    </div>
  );
}
