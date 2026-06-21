// Decision curve (inspired by dickreuter/Poker's equity-vs-call strategy curves):
// plots the equity you NEED to continue against the bet size, splitting the chart
// into fold (below) and call (above) regions, with a value-raise band on top.
// Your live spot is dropped on it so you can SEE why a call is +EV or a fold.

import { requiredEquityForBet } from '../engine/potOdds';

interface Props {
  equity: number; // hero equity 0..1
  pot: number; // total pot incl. the bet faced
  toCall: number; // chips to call (0 = can check)
}

const F_MAX = 2; // x-axis runs 0 .. 2× pot
const VALUE_RAISE_EQ = 0.62; // equity at/above which you can raise for value

const X_TICKS: { f: number; label: string }[] = [
  { f: 1 / 3, label: '⅓' },
  { f: 1 / 2, label: '½' },
  { f: 3 / 4, label: '¾' },
  { f: 1, label: '1×' },
  { f: 1.5, label: '1½' },
  { f: 2, label: '2×' },
];
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

export function DecisionCurve({ equity, pot, toCall }: Props) {
  const W = 280;
  const H = 178;
  const padL = 30;
  const padR = 12;
  const padT = 12;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (f: number) => padL + (Math.min(f, F_MAX) / F_MAX) * plotW;
  const y = (e: number) => padT + (1 - Math.max(0, Math.min(1, e))) * plotH;

  // sample the required-equity curve  need(f) = f / (1 + 2f)
  const N = 48;
  const pts: string[] = [];
  for (let k = 0; k <= N; k++) {
    const f = (k / N) * F_MAX;
    pts.push(`${k ? 'L' : 'M'}${x(f).toFixed(1)},${y(requiredEquityForBet(f)).toFixed(1)}`);
  }
  const curve = pts.join(' ');
  const foldArea = `${curve} L${x(F_MAX)},${y(0)} L${x(0)},${y(0)} Z`;
  const callArea = `${curve} L${x(F_MAX)},${y(1)} L${x(0)},${y(1)} Z`;

  const potBefore = Math.max(1, pot - toCall);
  const fNow = toCall > 0 ? toCall / potBefore : 0;
  const need = requiredEquityForBet(Math.min(fNow, F_MAX));
  const isCall = equity >= need;

  return (
    <div className="dcurve-panel">
      <div className="dcurve-head">📈 Call / fold curve</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="dcurve-svg" role="img" aria-label="equity needed versus bet size">
        <path d={callArea} className="dcurve-call" />
        <path d={foldArea} className="dcurve-fold" />
        {/* value-raise threshold */}
        <line x1={padL} y1={y(VALUE_RAISE_EQ)} x2={W - padR} y2={y(VALUE_RAISE_EQ)} className="dcurve-raise-line" />
        <text x={W - padR} y={y(VALUE_RAISE_EQ) - 3} className="dcurve-band" textAnchor="end">
          raise
        </text>
        <path d={curve} className="dcurve-curve" />
        {/* y axis (%) */}
        {Y_TICKS.map((e) => (
          <text key={e} x={padL - 5} y={y(e) + 3} className="dcurve-axis" textAnchor="end">
            {Math.round(e * 100)}
          </text>
        ))}
        {/* x axis (bet size) */}
        {X_TICKS.map((t) => (
          <text key={t.f} x={x(t.f)} y={H - padB + 14} className="dcurve-axis" textAnchor="middle">
            {t.label}
          </text>
        ))}
        <text x={padL + plotW / 2} y={H - 2} className="dcurve-axis-title" textAnchor="middle">
          bet size (× pot)
        </text>
        {/* current spot */}
        {toCall > 0 && (
          <>
            <line x1={x(fNow)} y1={padT} x2={x(fNow)} y2={H - padB} className="dcurve-guide" />
            <line x1={padL} y1={y(equity)} x2={W - padR} y2={y(equity)} className="dcurve-guide" />
            <circle cx={x(fNow)} cy={y(equity)} r={5} className={`dcurve-dot ${isCall ? 'call' : 'fold'}`} />
          </>
        )}
      </svg>
      <div className="dcurve-legend">
        {toCall > 0 ? (
          <span>
            Facing ~{fNow.toFixed(1)}× pot — need <b>{Math.round(need * 100)}%</b>, you have{' '}
            <b>{Math.round(equity * 100)}%</b> →{' '}
            <b className={isCall ? 'good' : 'bad'}>{isCall ? 'call is +EV' : 'pot odds say fold'}</b>
          </span>
        ) : (
          <span>No bet to call. The curve shows the equity each bet size needs — green calls, red folds.</span>
        )}
      </div>
    </div>
  );
}
