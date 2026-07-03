// Equity-vs-range calibration drill — the skill that actually wins money. You
// can't memorize range equity (it shifts with hand × board × range), so instead
// this trains your GUT: random hero + board vs a real villain range, you call
// the bucket (behind / underdog / coinflip / ahead / crushing), and it reveals
// the true equityVsRange. Reps tune the read you use at the table.

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard } from '../engine/board';
import { equityVsRange, countOuts } from '../engine/equity';
import { rangeFromSet } from '../engine/range';
import type { WeightedRange } from '../engine/range';
import { RFI_RANGES, THREEBET_RANGE, BB_DEFEND_RANGE } from '../ai/preflop';
import { classifyHandClass } from '../strategy/handClass';
import type { HandClass } from '../strategy/handClass';
import { playGrade } from '../sound';
import { PlayingCard } from './PlayingCard';
import { PositionCheatSheet } from './PositionCheatSheet';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

interface RangeOpt {
  id: string;
  label: string;
  note: string;
  /** how wide the range is — the other half of the equity read. */
  width: 'wide' | 'tight';
  range: WeightedRange;
}

// Static villain ranges (built once). These are the spots you face constantly.
const RANGES: RangeOpt[] = [
  { id: 'btn', label: 'BTN open', note: "Button opening range — wide steal", width: 'wide', range: rangeFromSet(RFI_RANGES.BTN) },
  { id: 'co', label: 'CO open', note: 'Cutoff open — fairly wide', width: 'wide', range: rangeFromSet(RFI_RANGES.CO) },
  { id: 'utg', label: 'UTG open', note: 'Early-position open — tight & strong', width: 'tight', range: rangeFromSet(RFI_RANGES.UTG) },
  { id: '3bet', label: '3-bet value', note: 'Re-raise range — QQ+/AK heavy', width: 'tight', range: rangeFromSet(THREEBET_RANGE) },
  { id: 'bbdef', label: 'BB defend', note: 'BB calling a button open — very wide', width: 'wide', range: rangeFromSet(BB_DEFEND_RANGE) },
];

// Reason for the equity read — now WITH the math, so the number isn't a mystery.
// Equity vs a range is driven by two things you can eyeball: how strong YOUR hand
// is, and how WIDE their range is. For draws we show the actual decomposition:
//   raw draw equity (Rule of 2 & 4) + the slice of their air you beat unimproved
//   = the % you saw. Each line ends with a memorizable anchor.
function whyRange(
  hc: HandClass,
  width: 'wide' | 'tight',
  equity: number,
  outs: number,
  street: 'Flop' | 'Turn',
): string {
  const isDrawLabel = /draw|over-ender|open-end|gutshot|overcards/i.test(hc.label);
  // a PURE draw (no made pair) vs a made hand that also has draw outs
  const isPureDraw = isDrawLabel && hc.strength < 4 && !/pair/i.test(hc.label);
  const s = hc.strength;
  const eq = Math.round(equity);

  const hand =
    isPureDraw ? `You have a draw (${hc.label}) — outs, but nothing made yet`
    : s >= 4 ? `You have a strong made hand (${hc.label})`
    : s >= 3 ? `You have a solid made hand (${hc.label})`
    : s === 0 ? `You have air (${hc.label}) — no pair, no draw`
    : `You have a weak made hand (${hc.label})`;

  const range =
    width === 'wide'
      ? `their range is wide — mostly unpaired air and weak hands`
      : `their range is tight — big pairs and strong aces, few weak hands`;

  // THE NUMBER — where this exact % comes from.
  let math: string;
  if (isPureDraw && outs > 0) {
    const mult = street === 'Flop' ? 4 : 2; // Rule of 2 & 4
    const hit = outs * mult; // % chance you complete by the river
    const bump = eq - hit;
    const bumpTxt =
      bump >= 4
        ? `Their air adds ~${bump} pts you scoop unimproved → about ${eq}%.`
        : bump <= -4
        ? `But you must actually hit — their made hands pull it to about ${eq}%.`
        : `That lands right around ${eq}%.`;
    math = `~${outs} outs → Rule of ${mult}: ${outs}×${mult} ≈ ${hit}% to hit. ${bumpTxt}`;
  } else if (s === 0) {
    math =
      width === 'wide'
        ? `You win only when you out-flop or bluff — about ${eq}% raw.`
        : `Against strength you're near drawing dead — about ${eq}%.`;
  } else if (s >= 4) {
    math =
      width === 'wide'
        ? `You beat almost their whole range → ~${eq}%.`
        : `Even a strong hand only beats the bottom of a tight value range → ~${eq}%.`;
  } else if (s >= 3) {
    math =
      width === 'wide'
        ? `You beat all their air and flip with their pairs → ~${eq}%.`
        : `You're only ahead of the worst of a tight range → ~${eq}%.`;
  } else {
    math =
      width === 'wide'
        ? `You beat their air but lose to any pair → a thin ~${eq}%.`
        : `They out-pair or out-kick you most of the time → ~${eq}%.`;
  }
  // made hand that ALSO has draw outs — note the backup equity
  if (!isPureDraw && isDrawLabel && outs > 0) math += ` Plus ~${outs} outs of backup.`;

  const hook =
    isPureDraw
      ? `💡 Draw% ≈ outs × ${street === 'Flop' ? 4 : 2}; a wide range adds a few points.`
    : s === 0
      ? `💡 No pair, no draw = behind.`
    : s >= 3
      ? (width === 'wide'
          ? `💡 Strong hand + wide range = crushing.`
          : `💡 Tighter range → less equity for you.`)
    : (width === 'wide'
        ? `💡 Any pair vs a wide range ≈ ahead but thin.`
        : `💡 Weak hand + tight range = behind.`);

  return `${hand}; ${range}. ${math} ${hook}`;
}

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

interface Spot { hero: Card[]; board: Card[]; hc: HandClass }

function genSpot(): Spot {
  const hero = dealHero();
  let board = randomFlop('any', hero);
  if (Math.random() < 0.5) board = [...board, randomCard([...hero, ...board])]; // sometimes a turn
  return { hero, board, hc: classifyHandClass(hero, board) };
}

// First spot generated at module load, not during render (Math.random is impure
// and a useState initializer runs in the render phase). Handlers reroll after.
const FIRST_SPOT = genSpot();

export function RangeDrill() {
  const [rangeId, setRangeId] = useState('btn');
  const [spot, setSpot] = useState<Spot>(FIRST_SPOT);
  const [chosen, setChosen] = useState<number | null>(null);
  // lifetime calibration score, persisted across sessions (store/drillScore).
  const [score, setScore] = useState(() => loadDrillScore('rangedrill'));
  const [showCheat, setShowCheat] = useState(false);

  const ropt = RANGES.find((r) => r.id === rangeId)!;

  // truth — recomputed when the hand or the villain range changes. 2500 iters
  // is plenty stable for bucketing and runs in a few ms.
  const equity = useMemo(
    () => equityVsRange(spot.hero, spot.board, ropt.range, 2500).equity * 100,
    [spot, ropt],
  );
  const trueBand = bandOf(equity);
  const outs = useMemo(() => countOuts(spot.hero, spot.board).outs, [spot]);

  const revealed = chosen != null;
  const correct = revealed && chosen === trueBand;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  function pick(b: number) {
    if (revealed) return;
    setChosen(b);
    setScore(recordDrillScore('rangedrill', b === trueBand));
    playGrade(b === trueBand);
  }
  function next() { setSpot(genSpot()); setChosen(null); }
  function switchRange(id: string) { setRangeId(id); setChosen(null); } // same hand, new villain — see the swing

  // keyboard: 1..5 picks the equity band, Space/Enter deals the next spot.
  useDrillKeys({ choices: BANDS.length, onPick: pick, onNext: next, revealed, enabled: !showCheat });

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
        <button className="rd-cheat" onClick={() => setShowCheat(true)} title="How position swings your equity">
          📊 cheat sheet
        </button>
      </div>
      {showCheat && <PositionCheatSheet onClose={() => setShowCheat(false)} />}
      <div className="rd-rangenote">{ropt.note}</div>

      <div className="quiz-score rd-score">
        Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)
        {score.total > 0 && (
          <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore('rangedrill'))} title="Reset your saved score">↺</button>
        )}
        <span className="muted"> {drillKeysHint(BANDS.length)}</span>
      </div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand · {spot.hc.label}</span>
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
              ? `✓ Right read — ${spot.hc.label} is ${BANDS[trueBand].lbl.toLowerCase()} here (${equity.toFixed(1)}%).`
              : `✗ You said ${BANDS[chosen!].lbl}, but it's ${BANDS[trueBand].lbl} (${equity.toFixed(1)}%).`}
            <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
          </div>
          <div className="drill-hook">
            <span className="drill-hook-tag">💡 Why</span>
            <p>{whyRange(spot.hc, ropt.width, equity, outs, street)}</p>
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
