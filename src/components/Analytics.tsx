import { useMemo, useRef, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useGame } from '../hooks/useGame';
import { accuracy, bbPer100, evLossPer100, rngAdherence, totalEvLoss, scoreBuckets, gtowScore, downswing } from '../store/stats';
import type { DecisionRecord } from '../store/stats';
import { recordLeakSnapshot, loadLeakHistory, clearLeakHistory, leakLabels, leakSeries, leakDelta } from '../store/leakHistory';
import type { LeakTrendPoint } from '../store/leakHistory';
import { assessTilt } from '../analysis/tilt';
import { downloadBackup, importBackup } from '../store/backup';
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

  // Cross-session leak trend. Persist a throttled point when the tab opens (for
  // durability across days) — no setState here, the live session is shown as an
  // appended in-memory point below, so the chart always includes "now". The reset
  // button force-captures the session it's about to wipe (see below).
  const [leakTrend, setLeakTrend] = useState<LeakTrendPoint[]>(() => loadLeakHistory());
  useEffect(() => {
    recordLeakSnapshot(stats, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The current (unsaved) session as a trailing trend point, so the chart reflects
  // live progress without a persist→reload round-trip. `at: 0` avoids Date in render.
  const livePoint = useMemo<LeakTrendPoint | null>(() => {
    if ((stats.decisions?.length ?? 0) < 8) return null;
    return {
      at: 0,
      handsPlayed: stats.handsPlayed,
      netBB: stats.netBB,
      score: gtowScore(stats),
      leaks: leaks.map((l) => ({ label: l.label, rate: l.rate, severity: l.severity, sample: l.sample })),
    };
  }, [stats, leaks]);
  const trendPoints = useMemo(
    () => (livePoint ? [...leakTrend, livePoint] : leakTrend),
    [leakTrend, livePoint],
  );

  const buckets = scoreBuckets(stats);
  const score = gtowScore(stats);
  // swings & tilt — the historical view of what the live table shows in-session.
  const ds = useMemo(() => downswing(stats), [stats]);
  const tilt = useMemo(() => assessTilt(stats), [stats]);

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
          <button
            className="btn-small"
            onClick={() => {
              // Preserve the ending session as a leak-trend point before wiping it.
              if (recordLeakSnapshot(stats, { force: true })) setLeakTrend(loadLeakHistory());
              g.doResetStats();
            }}
          >
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

      <DataBackup />

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

            <div className="an-section">
              <div className="an-h">Discipline &amp; swings</div>
              <div className="kpi-grid">
                <Kpi label="Swing size (σ / 100 hands)" value={`${ds.stdPer100.toFixed(0)} bb`} />
                <Kpi label="Worst downswing" value={`−${ds.maxBB.toFixed(0)} bb`} tone={ds.maxBB > 150 ? 'neg' : ''} />
                <Kpi
                  label="Below session peak now"
                  value={ds.currentBB > 0 ? `−${ds.currentBB.toFixed(0)} bb (${ds.buyins.toFixed(1)} bi)` : 'at peak ✓'}
                  tone={ds.buyins >= 1 ? 'neg' : ds.currentBB > 0 ? '' : 'pos'}
                />
                <Kpi label="Tilt pressure" value={tilt ? `${tilt.score}/100` : 'calm ✓'} tone={tilt ? (tilt.level === 'high' ? 'neg' : '') : 'pos'} />
              </div>
              {tilt && (
                <p className="note">
                  {tilt.headline} — {tilt.signals.join(' ')} Feed these swings into the <b>💵 Bankroll</b> tab to
                  see what variance this size implies long-run.
                </p>
              )}
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
                {l.breakdown && l.breakdown.length > 0 && (
                  <div className="leak-breakdown">
                    <div className="lb-head">Where the folds come from</div>
                    {l.breakdown.map((b) => (
                      <div key={b.label} className="lb-row">
                        <span className="lb-label">{b.label}</span>
                        <div className="lb-bar">
                          <div className="lb-fill" style={{ width: `${Math.min(100, b.rate * 100)}%` }} />
                        </div>
                        <span className="lb-rate">
                          {(b.rate * 100).toFixed(0)}% <span className="muted">({b.folded}/{b.spots})</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {leaks.every((l) => l.severity === 'ok' || l.severity === 'low') && (
              <p className="sub good">No major leaks detected — solid, balanced play so far. 👍</p>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="analytics-head">
          <h2>Leaks over time</h2>
          {leakTrend.length > 0 && (
            <button
              className="btn-small"
              onClick={() => {
                clearLeakHistory();
                setLeakTrend([]);
              }}
            >
              Clear trend
            </button>
          )}
        </div>
        <LeakTrend points={trendPoints} />
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

// Cross-session leak trend: one row per leak, its rate charted across snapshots so
// recurrence and improvement are visible — the longitudinal view the single-session
// Leak Finder can't give. A shrinking line is the goal.
function LeakTrend({ points }: { points: LeakTrendPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="sub">
        Not enough history yet. A point is captured when you open this tab (at most once every few hours) and
        whenever you reset stats. Play across a few sessions and your leaks will trend here — a line that falls
        over time is a leak you're fixing.
      </p>
    );
  }
  const labels = leakLabels(points);
  const scores = points.map((p) => p.score / 100);
  return (
    <>
      <div className="an-section">
        <div className="an-h">Move quality (GTOW score) across {points.length} snapshots</div>
        <RateSparkline data={scores} goodHigh />
      </div>
      <div className="leak-trend">
        {labels.map((label) => {
          const series = leakSeries(points, label);
          const latest = series[series.length - 1];
          const delta = leakDelta(points, label);
          const arrow =
            delta == null ? '' : delta < -0.03 ? '▼ improving' : delta > 0.03 ? '▲ worsening' : '► flat';
          const arrowCls = delta == null ? '' : delta < -0.03 ? 'pos' : delta > 0.03 ? 'neg' : '';
          return (
            <div key={label} className="leak-trend-row">
              <div className="leak-trend-head">
                <span className="leak-label">{label}</span>
                <span className={`leak-trend-delta ${arrowCls}`}>
                  {(latest * 100).toFixed(0)}% <span className="muted">{arrow}</span>
                </span>
              </div>
              <RateSparkline data={series} />
            </div>
          );
        })}
      </div>
      <p className="note">
        Each line is one leak's error-rate over time. Lower is better — a falling line means the fix is
        sticking. A leak that keeps climbing is your next study target (try the <b>Leak Quiz</b> tab).
      </p>
    </>
  );
}

// Sparkline for a 0..1 series (leak rate or normalised score). Unlike the bb
// Sparkline this has a fixed [0,1] domain so heights compare across leaks; colour
// keys on the latest value (or its inverse when higher is better, e.g. score).
function RateSparkline({ data, goodHigh = false }: { data: number[]; goodHigh?: boolean }) {
  const W = 600;
  const H = 60;
  const pad = 4;
  const x = (i: number) => pad + (i / Math.max(1, data.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - Math.max(0, Math.min(1, v)) * (H - 2 * pad);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = data[data.length - 1];
  const good = goodHigh ? last >= 0.6 : last <= 0.15;
  const bad = goodHigh ? last < 0.4 : last >= 0.3;
  const cls = good ? 'pos' : bad ? 'neg' : '';
  return (
    <div className="an-spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="an-spark-svg">
        <polyline points={pts} className={`an-spark-line ${cls}`} fill="none" />
      </svg>
      <div className={`an-spark-end ${cls}`}>{(last * 100).toFixed(0)}%</div>
    </div>
  );
}

// Backup & restore: download all training data as JSON, or import a backup to
// replace it. Import reloads the app so every in-memory store re-reads storage.
function DataBackup() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = importBackup(String(reader.result));
      if (!res.ok) {
        setMsg({ ok: false, text: res.error ?? 'Import failed.' });
        return;
      }
      if (!confirm(`Restore ${res.keys} data section(s)? This replaces your current history, stats & journal, then reloads.`)) return;
      location.reload();
    };
    reader.onerror = () => setMsg({ ok: false, text: 'Could not read that file.' });
    reader.readAsText(file);
  };

  return (
    <div className="card">
      <div className="analytics-head">
        <h2>Backup &amp; restore</h2>
      </div>
      <p className="note">
        Your history, stats, journal &amp; in-progress tables live only in this browser — clearing site data wipes them.
        Export a JSON backup for safekeeping or to move between devices; import to restore.
      </p>
      <div className="backup-btns">
        <button className="btn-small" onClick={() => { downloadBackup(); setMsg({ ok: true, text: 'Backup downloaded.' }); }}>
          ⬇ Export backup
        </button>
        <button className="btn-small" onClick={() => fileRef.current?.click()}>
          ⬆ Import backup…
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} />
      </div>
      {msg && <p className={`note ${msg.ok ? 'pos' : 'neg'}`}>{msg.text}</p>}
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
