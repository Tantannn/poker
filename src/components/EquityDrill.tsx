// Equity flashcard drill. Active-recall reps on the handful of equity numbers
// worth memorizing so you DON'T need the calculator at the table: the preflop
// matchup ladder, the Rule-of-2-and-4 draw odds, and a few common postflop
// clashes. Each card shows a spot, you guess the equity from 4 choices, then it
// reveals the true number plus the memory hook. Tracks a session streak.
// Card data + weighted draw live in ./flashcards (shared with the Review tab).

import { useMemo, useState } from 'react';
import { RangeDrill } from './EquityRangeDrill';
import { InfoTip } from './CalcTip';
import { playGrade } from '../sound';
import { loadSrs, recordSrs, weightOf, type SrsMap } from '../store/srs';
import { CARDS, rollCard, type Cat } from './flashcards';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';

const CATS: ('All' | Cat)[] = ['All', 'Preflop', 'Draws', 'Made hands'];

// Initial card, computed once at module load — NOT during render. React forbids
// impure calls (Math.random) in the render phase, and a useState lazy initializer
// runs during render; module scope runs at import, so it's safe.
const FIRST_SRS = loadSrs();
const FIRST = rollCard(CARDS, FIRST_SRS);
const FIRST_IDX = FIRST.idx;
const FIRST_OPTIONS = FIRST.options;

export function EquityDrill() {
  const [mode, setMode] = useState<'flash' | 'range'>('range');
  return (
    <div className="card">
      <h2>Equity Drill</h2>
      <p className="sub">
        Train the two equity skills: the fixed <b>matchup numbers</b> worth memorizing, and — the one
        that actually wins money — estimating your <b>equity vs a villain's range</b>.
      </p>
      <div className="quiz-bar">
        <div className="quiz-drills">
          <button className={mode === 'range' ? 'active' : ''} onClick={() => setMode('range')}>🎯 vs Range</button>
          <button className={mode === 'flash' ? 'active' : ''} onClick={() => setMode('flash')}>🧠 Flashcards</button>
        </div>
      </div>
      {mode === 'range' ? <RangeDrill /> : <FlashcardDrill />}
    </div>
  );
}

function FlashcardDrill() {
  const [cat, setCat] = useState<'All' | Cat>('All');
  const pool = useMemo(() => (cat === 'All' ? CARDS : CARDS.filter((c) => c.cat === cat)), [cat]);

  const [idx, setIdx] = useState(FIRST_IDX);
  const [options, setOptions] = useState<number[]>(FIRST_OPTIONS);
  const [chosen, setChosen] = useState<number | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [srs, setSrs] = useState<SrsMap>(FIRST_SRS);

  const card = pool[idx] ?? pool[0];
  // cards still being learned (weight above the unseen baseline) — a progress hint
  const needWork = pool.filter((c) => weightOf(srs, c.spot) > 1.5).length;

  function deal() {
    const r = rollCard(pool, srs, idx); // weighted by SRS, avoid immediate repeat
    setIdx(r.idx);
    setOptions(r.options);
    setChosen(null);
  }

  function switchCat(c: 'All' | Cat) {
    const np = c === 'All' ? CARDS : CARDS.filter((x) => x.cat === c);
    setCat(c);
    setScore({ correct: 0, total: 0 });
    const r = rollCard(np, srs);
    setIdx(r.idx);
    setOptions(r.options);
    setChosen(null);
  }

  function pick(v: number) {
    if (chosen != null) return;
    const right = v === card.equity;
    setChosen(v);
    setScore((s) => ({ correct: s.correct + (right ? 1 : 0), total: s.total + 1 }));
    setSrs((s) => recordSrs(s, card.spot, right)); // missed cards come back sooner
    playGrade(right);
  }

  const revealed = chosen != null;
  const correct = revealed && chosen === card.equity;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  // keyboard: 1..4 picks an equity option, Space/Enter deals the next card.
  useDrillKeys({ choices: options.length, onPick: (i) => pick(options[i]), onNext: deal, revealed });

  return (
    <>
      <p className="sub">
        Memorize the matchup numbers worth knowing cold — so you read them off the spot, not the
        calculator. Guess, then check the answer and its memory hook. <span className="muted">{drillKeysHint(options.length)}</span>
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          {CATS.map((c) => (
            <button key={c} className={cat === c ? 'active' : ''} onClick={() => switchCat(c)}>{c}</button>
          ))}
        </div>
        <div className="quiz-score">Streak: <b>{score.correct}/{score.total}</b> ({pctScore}%)</div>
      </div>
      <p className="note">
        🔁 Adaptive — cards you miss come back more often, mastered ones fade.
        {needWork > 0 ? <> <b>{needWork}</b> card{needWork === 1 ? '' : 's'} still need work.</> : ' All caught up — nice.'}
      </p>

      <div className="drill-spot">
        <span className="drill-cat">{card.cat}</span>
        <div className="drill-q">
          {card.spot}
          <InfoTip
            content={
              <span className="tip-body">
                <b className="tip-title">How to spot it</b>
                <span className="tip-what">{card.recognize}</span>
              </span>
            }
          />
        </div>
        <div className="drill-detail">{card.detail}</div>
      </div>

      {!revealed && <div className="lab-prompt">What's your equity?</div>}

      <div className="drill-opts">
        {options.map((o) => {
          const isAnswer = o === card.equity;
          return (
            <button
              key={o}
              className={`drill-opt ${chosen === o ? 'chosen' : ''} ${revealed && isAnswer ? 'is-best' : ''} ${revealed && chosen === o && !isAnswer ? 'is-wrong' : ''}`}
              onClick={() => pick(o)}
            >
              {o}%
            </button>
          );
        })}
      </div>

      {revealed && (
        <>
          <div className="drill-hook">
            <span className="drill-hook-tag">💡 Remember</span>
            <p>{card.hook}</p>
          </div>
          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct ? `✓ Right — ${card.equity}%.` : `✗ It's ${card.equity}%, not ${chosen}%.`}
            <button className="btn btn-deal lab-next" onClick={() => deal()}>Next card →</button>
          </div>
        </>
      )}
    </>
  );
}
