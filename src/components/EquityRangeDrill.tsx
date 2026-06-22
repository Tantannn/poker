// Equity-vs-range calibration drill — the skill that actually wins money. You
// can't memorize range equity (it shifts with hand × board × range), so instead
// this trains your GUT: random hero + board vs a real villain range, you call
// the bucket (behind / underdog / coinflip / ahead / crushing), and it reveals
// the true equityVsRange. Reps tune the read you use at the table.

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard } from '../engine/board';
import { equityVsRange } from '../engine/equity';
import { rangeFromSet } from '../engine/range';
import type { WeightedRange } from '../engine/range';
import { RFI_RANGES, THREEBET_RANGE, BB_DEFEND_RANGE } from '../ai/preflop';
import { classifyHandClass } from '../strategy/handClass';
import { PlayingCard } from './PlayingCard';

interface RangeOpt {
  id: string;
  label: string;
  note: string;
  range: WeightedRange;
}

// Static villain ranges (built once). These are the spots you face constantly.
const RANGES: RangeOpt[] = [
  { id: 'btn', label: 'BTN open', note: "Button opening range — wide steal", range: rangeFromSet(RFI_RANGES.BTN) },
  { id: 'co', label: 'CO open', note: 'Cutoff open — fairly wide', range: rangeFromSet(RFI_RANGES.CO) },
  { id: 'utg', label: 'UTG open', note: 'Early-position open — tight & strong', range: rangeFromSet(RFI_RANGES.UTG) },
  { id: '3bet', label: '3-bet value', note: 'Re-raise range — QQ+/AK heavy', range: rangeFromSet(THREEBET_RANGE) },
  { id: 'bbdef', label: 'BB defend', note: 'BB calling a button open — very wide', range: rangeFromSet(BB_DEFEND_RANGE) },
];

// Buckets = how you actually think at the table. Boundaries are [lo, hi).
const BANDS = [
  { lbl: 'Drawing / behind', sub: '< 30%', cls: 'bad' },
  { lbl: 'Underdog', sub: '30–45%', cls: 'okv' },
  { lbl: 'Coinflip', sub: '45–55%', cls: 'okv' },
  { lbl: 'Ahead', sub: '55–70%', cls: 'good' },
  { lbl: 'Crushing', sub: '> 70%', cls: 'good' },
];
function bandOf(e: number): number {
  if (e < 30) return 0;
  if (e < 45) return 1;
  if (e < 55) return 2;
  if (e < 70) return 3;
  return 4;
}

function dealHero(): Card[] {
  const a = randomCard([]);
  let b = randomCard([a]);
  while (b.rank === a.rank && b.suit === a.suit) b = randomCard([a]);
  return [a, b];
}

interface Spot { hero: Card[]; board: Card[]; label: string }

function genSpot(): Spot {
  const hero = dealHero();
  let board = randomFlop('any', hero);
  if (Math.random() < 0.5) board = [...board, randomCard([...hero, ...board])]; // sometimes a turn
  return { hero, board, label: classifyHandClass(hero, board).label };
}

export function RangeDrill() {
  const [rangeId, setRangeId] = useState('btn');
  const [spot, setSpot] = useState<Spot>(genSpot);
  const [chosen, setChosen] = useState<number | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });

  const ropt = RANGES.find((r) => r.id === rangeId)!;

  // truth — recomputed when the hand or the villain range changes. 2500 iters
  // is plenty stable for bucketing and runs in a few ms.
  const equity = useMemo(
    () => equityVsRange(spot.hero, spot.board, ropt.range, 2500).equity * 100,
    [spot, ropt],
  );
  const trueBand = bandOf(equity);

  const revealed = chosen != null;
  const correct = revealed && chosen === trueBand;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  function pick(b: number) {
    if (revealed) return;
    setChosen(b);
    setScore((s) => ({ correct: s.correct + (b === trueBand ? 1 : 0), total: s.total + 1 }));
  }
  function next() { setSpot(genSpot()); setChosen(null); }
  function switchRange(id: string) { setRangeId(id); setChosen(null); } // same hand, new villain — see the swing

  const street = spot.board.length === 3 ? 'Flop' : 'Turn';

  return (
    <>
      <div className="rd-ranges">
        <span className="rd-vs">vs villain:</span>
        {RANGES.map((r) => (
          <button key={r.id} className={`rd-range ${rangeId === r.id ? 'active' : ''}`} onClick={() => switchRange(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="rd-rangenote">{ropt.note}</div>

      <div className="quiz-score rd-score">Streak: <b>{score.correct}/{score.total}</b> ({pctScore}%)</div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand · {spot.label}</span>
          <div className="lab-cards">{spot.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">{street}</span>
          <div className="lab-cards">{spot.board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
      </div>

      {!revealed && <div className="lab-prompt">How does your equity stack up vs <b>{ropt.label}</b>?</div>}

      <div className="rd-bands">
        {BANDS.map((band, i) => (
          <button
            key={i}
            className={`rd-band ${chosen === i ? 'chosen' : ''} ${revealed && i === trueBand ? 'is-best' : ''} ${revealed && chosen === i && i !== trueBand ? 'is-wrong' : ''}`}
            onClick={() => pick(i)}
          >
            <span className="rd-band-lbl">{band.lbl}</span>
            <span className="rd-band-sub">{band.sub}</span>
          </button>
        ))}
      </div>

      {revealed && (
        <>
          <div className="rd-truth">
            <div className="big-stat gold">{equity.toFixed(1)}%</div>
            <div className="stat-lbl">true equity vs {ropt.label} → <b>{BANDS[trueBand].lbl}</b></div>
          </div>
          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct
              ? `✓ Right read — ${spot.label} is ${BANDS[trueBand].lbl.toLowerCase()} here (${equity.toFixed(1)}%).`
              : `✗ You said ${BANDS[chosen!].lbl}, but it's ${BANDS[trueBand].lbl} (${equity.toFixed(1)}%).`}
            <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
          </div>
          <div className="rd-tip">
            Tip: switch the villain range above (same hand) to feel how much the <i>range</i> moves your
            equity — that's the read you can't get from a fixed chart.
          </div>
        </>
      )}
    </>
  );
}
