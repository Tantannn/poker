import { useState } from 'react';
import { useGame } from '../hooks/useGame';
import { accuracy, bbPer100, evLossPer100, rngAdherence, totalEvLoss } from '../store/stats';
import { PlayingCard } from './PlayingCard';

type G = ReturnType<typeof useGame>;

export function Analytics({ g }: { g: G }) {
  const { stats, leaks, history } = g;
  const acc = accuracy(stats);
  const bb100 = bbPer100(stats);
  const accPct = acc.total ? Math.round((acc.correct / acc.total) * 100) : 0;
  const evLoss100 = evLossPer100(stats);
  const evLossAll = totalEvLoss(stats);
  const rng = rngAdherence(stats);
  const rngPct = rng.total ? Math.round((rng.followed / rng.total) * 100) : 0;
  const [expanded, setExpanded] = useState<number | null>(null);

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
            label="Win rate (bb/100)"
            value={`${bb100 >= 0 ? '+' : ''}${bb100.toFixed(1)}`}
            tone={bb100 > 0 ? 'pos' : bb100 < 0 ? 'neg' : ''}
          />
          <Kpi
            label="Net result"
            value={`${stats.netBB >= 0 ? '+' : ''}${stats.netBB.toFixed(1)} bb`}
            tone={stats.netBB > 0 ? 'pos' : stats.netBB < 0 ? 'neg' : ''}
          />
          <Kpi label="Decision accuracy" value={`${accPct}%`} />
          <Kpi
            label="EV lost / 100"
            value={`${evLoss100.toFixed(2)} bb`}
            tone={evLoss100 > 2 ? 'neg' : evLoss100 > 0.5 ? '' : 'pos'}
          />
          <Kpi label="Total EV lost" value={`${evLossAll.toFixed(2)} bb`} tone={evLossAll > 0 ? 'neg' : 'pos'} />
          <Kpi label="RNG adherence" value={rng.total ? `${rngPct}%` : '—'} />
        </div>
        <p className="note">
          <b>EV loss</b> is the gold-standard metric: a fold that costs 0.02 bb is trivial; one that
          costs 2.5 bb is a real leak. Lower is better. <b>RNG adherence</b> = how often you took the
          action the random roll prescribed for mixed spots.
        </p>
        <div className="decision-bar">
          <Seg cls="good" n={acc.correct} total={acc.total} label="On baseline" />
          <Seg cls="okv" n={acc.ok} total={acc.total} label="Reasonable" />
          <Seg cls="bad" n={acc.mistake} total={acc.total} label="Leaks" />
        </div>
        <p className="note">
          “Decision accuracy” compares each action you took to a transparent baseline (preflop charts +
          equity-vs-pot-odds postflop). It's a yardstick, not a solver — close spots may show as
          “reasonable”.
        </p>
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
              <div key={h.handNumber} className="history-item">
                <button className="history-row" onClick={() => setExpanded(expanded === h.handNumber ? null : h.handNumber)}>
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
                {expanded === h.handNumber && (
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

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
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
