// Equity flashcard drill. Active-recall reps on the handful of equity numbers
// worth memorizing so you DON'T need the calculator at the table: the preflop
// matchup ladder, the Rule-of-2-and-4 draw odds, and a few common postflop
// clashes. Each card shows a spot, you guess the equity from 4 choices, then it
// reveals the true number plus the memory hook. Tracks a session streak.

import { useMemo, useState } from 'react';
import { ruleOf2and4 } from '../engine/equity';
import { RangeDrill } from './EquityRangeDrill';

type Cat = 'Preflop' | 'Draws' | 'Made hands';

interface Flash {
  spot: string;
  detail: string;
  equity: number; // hero's equity %, the number to remember
  hook: string; // how to remember it without a solver
  cat: Cat;
}

// All equities are the well-known textbook figures (heads-up, all-in). Draw rows
// derive straight from the Rule of 2 & 4 so the hook and the number always agree.
const CARDS: Flash[] = [
  // ---- Preflop matchup ladder ----
  { spot: 'Pair vs two overcards', detail: 'e.g. 88 vs AK — the classic "race"', equity: 52, hook: 'Coinflip. Pair is a hair ahead (~52). "Race" = roughly 50/50.', cat: 'Preflop' },
  { spot: 'Pair vs two undercards', detail: 'e.g. 88 vs 56', equity: 83, hook: 'Pair over both = ~80/20. The undercards need to pair or run a draw.', cat: 'Preflop' },
  { spot: 'Higher pair vs lower pair', detail: 'e.g. QQ vs 77', equity: 81, hook: '80/20. Lower pair needs its set (~18%) or a runner straight/flush.', cat: 'Preflop' },
  { spot: 'Dominated unpaired hand', detail: 'e.g. AK vs AQ (shared ace)', equity: 73, hook: 'Domination ≈ 70/30. Loser only lives via kicker / board.', cat: 'Preflop' },
  { spot: 'Two overcards vs a pair', detail: 'e.g. AK vs QQ', equity: 43, hook: 'Overcards are the dog (~43). Still close — two live cards.', cat: 'Preflop' },
  { spot: 'AA vs KK', detail: 'best vs 2nd-best pair', equity: 82, hook: '80/20, "cowboys cracked". KK only wins ~18% (set or runner).', cat: 'Preflop' },
  { spot: 'Pair vs two higher overcards, suited+connected', detail: 'e.g. 22 vs AKs', equity: 50, hook: 'A true coinflip — the suited+connected overs claw back to ~50.', cat: 'Preflop' },
  { spot: 'Suited connector vs overpair', detail: 'e.g. JTs vs AA', equity: 22, hook: 'Big dog (~22), but the suited connector has the most outs of any underdog.', cat: 'Preflop' },

  // ---- Draws (Rule of 2 & 4) ----
  { spot: 'Flush draw on the flop', detail: '9 outs · 2 cards to come', equity: ruleOf2and4(9, 2), hook: 'Outs × 4 = 36 (round to ~35). The headline draw number.', cat: 'Draws' },
  { spot: 'Open-ended straight draw, flop', detail: '8 outs · 2 cards to come', equity: ruleOf2and4(8, 2), hook: 'Outs × 4 = 32. OESD ≈ a third of the time.', cat: 'Draws' },
  { spot: 'Gutshot straight draw, flop', detail: '4 outs · 2 cards to come', equity: ruleOf2and4(4, 2), hook: 'Outs × 4 = 16. Gutshot ≈ 1-in-6 by the river.', cat: 'Draws' },
  { spot: 'Flush + gutshot, flop', detail: '12 outs · 2 cards to come', equity: ruleOf2and4(12, 2), hook: 'Outs × 4 ≈ 48 (minus a touch). Near coinflip vs one pair.', cat: 'Draws' },
  { spot: 'Flush + OESD (monster draw), flop', detail: '15 outs · 2 cards to come', equity: ruleOf2and4(15, 2), hook: 'Outs × 4 ≈ 54 — you are the FAVOURITE vs top pair.', cat: 'Draws' },
  { spot: 'Two overcards, flop', detail: '6 outs · 2 cards to come', equity: ruleOf2and4(6, 2), hook: 'Outs × 4 = 24. Six outs to a (maybe-good) pair.', cat: 'Draws' },
  { spot: 'Flush draw on the turn', detail: '9 outs · 1 card to come', equity: ruleOf2and4(9, 1), hook: 'Outs × 2 = 18. One card halves your flop odds.', cat: 'Draws' },
  { spot: 'OESD on the turn', detail: '8 outs · 1 card to come', equity: ruleOf2and4(8, 1), hook: 'Outs × 2 = 16. Need ~2:1 pot odds or implied odds.', cat: 'Draws' },
  { spot: 'Gutshot on the turn', detail: '4 outs · 1 card to come', equity: ruleOf2and4(4, 1), hook: 'Outs × 2 = 8. Almost never a pure call — implied odds only.', cat: 'Draws' },

  // ---- Common postflop clashes ----
  { spot: 'Set vs overpair, on the flop', detail: 'e.g. 99 on 9♣4♦2♠ vs AA', equity: 90, hook: '~90/10. Set is a monster; overpair needs runner-runner or its 2-out set.', cat: 'Made hands' },
  { spot: 'Top pair vs flush draw, flop', detail: 'made hand vs 9-out draw', equity: 65, hook: '~65/35 — top pair is ahead but it is a real fight. Charge the draw.', cat: 'Made hands' },
  { spot: 'Two pair vs flush draw, flop', detail: 'made hand vs 9-out draw', equity: 70, hook: '~70/30. Two pair also fears the board pairing, so still bet.', cat: 'Made hands' },
  { spot: 'Overpair vs underpair, flop', detail: 'e.g. AA vs KK on a low board', equity: 90, hook: '~90/10 — same as preflop; the underpair is drawing to its set.', cat: 'Made hands' },
];

const CATS: ('All' | Cat)[] = ['All', 'Preflop', 'Draws', 'Made hands'];

function buildOptions(card: Flash): number[] {
  // 3 distractors from other cards, each ≥6 pts from the answer and from each other
  const pool = CARDS.map((c) => c.equity).filter((e) => Math.abs(e - card.equity) >= 6);
  const picks: number[] = [card.equity];
  // shuffle pool
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (const e of pool) {
    if (picks.length >= 4) break;
    if (picks.every((p) => Math.abs(p - e) >= 6)) picks.push(e);
  }
  // shuffle the 4 options so the answer isn't always first
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  return picks;
}

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

  const [idx, setIdx] = useState(() => Math.floor(Math.random() * CARDS.length));
  const [options, setOptions] = useState<number[]>(() => buildOptions(CARDS[idx]));
  const [chosen, setChosen] = useState<number | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });

  const card = pool[idx] ?? pool[0];

  function deal() {
    let i = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && pool[i] === card) i = (i + 1) % pool.length; // avoid immediate repeat
    setIdx(i);
    setOptions(buildOptions(pool[i]));
    setChosen(null);
  }

  function switchCat(c: 'All' | Cat) {
    const np = c === 'All' ? CARDS : CARDS.filter((x) => x.cat === c);
    setCat(c);
    setScore({ correct: 0, total: 0 });
    const i = Math.floor(Math.random() * np.length);
    setIdx(i);
    setOptions(buildOptions(np[i]));
    setChosen(null);
  }

  function pick(v: number) {
    if (chosen != null) return;
    setChosen(v);
    setScore((s) => ({ correct: s.correct + (v === card.equity ? 1 : 0), total: s.total + 1 }));
  }

  const revealed = chosen != null;
  const correct = revealed && chosen === card.equity;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  return (
    <>
      <p className="sub">
        Memorize the matchup numbers worth knowing cold — so you read them off the spot, not the
        calculator. Guess, then check the answer and its memory hook.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          {CATS.map((c) => (
            <button key={c} className={cat === c ? 'active' : ''} onClick={() => switchCat(c)}>{c}</button>
          ))}
        </div>
        <div className="quiz-score">Streak: <b>{score.correct}/{score.total}</b> ({pctScore}%)</div>
      </div>

      <div className="drill-spot">
        <span className="drill-cat">{card.cat}</span>
        <div className="drill-q">{card.spot}</div>
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
