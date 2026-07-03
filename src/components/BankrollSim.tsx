// Bankroll & Variance simulator. Net result and bb/100 tell you your EDGE; they
// say nothing about the SWINGS around it. This tab runs a Monte-Carlo over your
// win rate + standard deviation to show the range of outcomes over N hands, the
// odds of a losing stretch, and — for a given bankroll — your risk of going broke.
// Seed the inputs from your own tracked session with one click, or explore any
// what-if. All local, all in big blinds (1 buy-in = 100bb).

import { useMemo, useState } from 'react';
import { simulateVariance, type VarianceResult } from '../analysis/variance';
import { bbPer100, downswing, type SessionStats } from '../store/stats';

interface Params {
  winRate: number;
  stdDev: number;
  hands: number;
  bankroll: number;
  trials: number;
}
const DEFAULTS: Params = { winRate: 5, stdDev: 100, hands: 20000, bankroll: 2000, trials: 2000 };

const bi = (bb: number) => bb / 100; // buy-ins (100bb)
const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`;
const pctTone = (p: number, warn: number, bad: number) => (p >= bad ? 'neg' : p >= warn ? '' : 'pos');

export function BankrollSim({ g }: { g?: { stats: SessionStats } }) {
  const [form, setForm] = useState<Params>(DEFAULTS);
  const [params, setParams] = useState<Params>(DEFAULTS);
  const set = (k: keyof Params, v: number) => setForm((f) => ({ ...f, [k]: v }));

  const result = useMemo(() => simulateVariance(params), [params]);

  const run = () =>
    setParams({
      winRate: form.winRate,
      stdDev: Math.max(0, form.stdDev),
      hands: Math.min(1_000_000, Math.max(100, Math.round(form.hands))),
      bankroll: Math.max(0, form.bankroll),
      trials: Math.min(5000, Math.max(100, Math.round(form.trials))),
    });

  // prefill from the player's own tracked cash session, when there's enough data.
  const mine = g && g.stats.handsPlayed >= 100
    ? { wr: bbPer100(g.stats), sd: downswing(g.stats).stdPer100, hands: g.stats.handsPlayed }
    : null;
  const useMine = () => {
    if (!mine) return;
    const next = { ...form, winRate: Math.round(mine.wr * 10) / 10, stdDev: Math.round(mine.sd) || DEFAULTS.stdDev };
    setForm(next);
    setParams((p) => ({ ...p, winRate: next.winRate, stdDev: next.stdDev }));
  };

  return (
    <div className="card">
      <h2>💵 Bankroll & Variance</h2>
      <p className="sub">
        Your win rate is the trend; variance is the noise around it. Simulate {params.trials.toLocaleString()} possible
        futures to see the spread of results, the chance of a downswing, and your risk of ruin for a bankroll.
        Everything's in big blinds — <b>1 buy-in = 100 bb</b>.
      </p>

      <div className="bk-form">
        <Field label="Win rate (bb/100)" value={form.winRate} step={0.5} onChange={(v) => set('winRate', v)} />
        <Field label="Std dev (bb/100)" value={form.stdDev} step={5} min={0} onChange={(v) => set('stdDev', v)} />
        <Field label="Hands" value={form.hands} step={5000} min={100} onChange={(v) => set('hands', v)} />
        <Field label="Bankroll (bb)" value={form.bankroll} step={500} min={0} onChange={(v) => set('bankroll', v)} />
        <Field label="Trials" value={form.trials} step={500} min={100} onChange={(v) => set('trials', v)} />
        <button className="btn btn-deal bk-run" onClick={run}>Run simulation</button>
      </div>
      {mine && (
        <button className="btn-small bk-mine" onClick={useMine}>
          Use my session: {mine.wr >= 0 ? '+' : ''}{mine.wr.toFixed(1)} bb/100 · σ≈{Math.round(mine.sd)} over {mine.hands} hands
        </button>
      )}

      <div className="kpi-grid bk-kpis">
        <Kpi label="Expected profit" value={`${fmt(result.expected)} bb`} sub={`${fmt(bi(result.expected))} buy-ins`} tone={result.expected >= 0 ? 'pos' : 'neg'} />
        <Kpi label="Median (p50)" value={`${fmt(result.percentiles.p50)} bb`} sub={`${fmt(bi(result.percentiles.p50))} bi`} tone={result.percentiles.p50 >= 0 ? 'pos' : 'neg'} />
        <Kpi label="5th–95th %ile" value={`${fmt(result.percentiles.p5)} … ${fmt(result.percentiles.p95)}`} sub="bb range (90% band)" />
        <Kpi label="Chance of loss" value={`${(result.probLoss * 100).toFixed(1)}%`} sub={`over ${result.hands.toLocaleString()} hands`} tone={pctTone(result.probLoss, 0.2, 0.4)} />
        <Kpi label="Risk of ruin" value={params.bankroll > 0 ? `${(result.riskOfRuinSim * 100).toFixed(1)}%` : '—'} sub={params.bankroll > 0 ? `${bi(params.bankroll).toFixed(0)} buy-in roll` : 'set a bankroll'} tone={pctTone(result.riskOfRuinSim, 0.05, 0.2)} />
        <Kpi label="Downswing risk" value={`${fmt(result.worst)} bb`} sub={`worst of ${result.trials.toLocaleString()} trials`} tone="neg" />
      </div>

      <Fan result={result} />

      <div className="bk-notes">
        <p className="note">
          <b>Risk of ruin</b> — sim {params.bankroll > 0 ? `${(result.riskOfRuinSim * 100).toFixed(1)}%` : '—'} vs
          closed-form {params.bankroll > 0 ? `${(result.riskOfRuinAnalytic * 100).toFixed(1)}%` : '—'}
          {' '}(<code>e^(−2·wr·roll/σ²)</code>). They should roughly agree; the sim also counts busting <i>mid-sample</i>.
          {result.riskOfRuinAnalytic >= 0.99 && params.winRate <= 0 && ' A break-even or losing player busts any finite bankroll eventually.'}
        </p>
        {result.breakEvenHands != null ? (
          <p className="note">
            <b>Break-even horizon</b> ≈ {result.breakEvenHands.toLocaleString()} hands — that's when your expected
            profit first equals one standard-deviation swing. Below it, variance dominates and results say little
            about your true edge.
          </p>
        ) : (
          <p className="note">With a non-positive win rate there's no horizon where the edge overtakes variance — the model only shows how fast a roll erodes.</p>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, step = 1, min }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return (
    <label className="bk-field">
      <span className="inline-label">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onChange(Number.isFinite(v) ? v : 0);
        }}
      />
    </label>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="kpi">
      <div className={`kpi-value ${tone ?? ''}`}>{value}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="bk-kpi-sub">{sub}</div>}
    </div>
  );
}

// Spaghetti/fan chart: a handful of simulated equity curves, the straight EV line,
// and the break-even axis. Shows at a glance how wide the outcomes fan out.
function Fan({ result }: { result: VarianceResult }) {
  const W = 640;
  const H = 200;
  const pad = 8;
  const paths = result.samplePaths;
  if (!paths.length) return null;
  const allY = paths.flat();
  const min = Math.min(0, ...allY);
  const max = Math.max(0, ...allY);
  const span = max - min || 1;
  const nx = result.blocks;
  const x = (i: number) => pad + (i / Math.max(1, nx)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const zeroY = y(0);
  const line = (pts: number[]) => pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const evPts = `${x(0)},${y(0)} ${x(nx)},${y(result.expected)}`;

  return (
    <div className="bk-fan">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="bk-fan-svg">
        <line x1={pad} x2={W - pad} y1={zeroY} y2={zeroY} className="bk-fan-zero" />
        {paths.map((p, i) => (
          <polyline key={i} points={line(p)} className={`bk-fan-path ${p[p.length - 1] >= 0 ? 'pos' : 'neg'}`} fill="none" />
        ))}
        <polyline points={evPts} className="bk-fan-ev" fill="none" />
      </svg>
      <div className="bk-fan-cap">
        {paths.length} sample runs over {result.hands.toLocaleString()} hands · dashed = expected (EV) line ·
        curves ending green finished a winner
      </div>
    </div>
  );
}
