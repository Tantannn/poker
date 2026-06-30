// Equity flashcard drill. Active-recall reps on the handful of equity numbers
// worth memorizing so you DON'T need the calculator at the table: the preflop
// matchup ladder, the Rule-of-2-and-4 draw odds, and a few common postflop
// clashes. Each card shows a spot, you guess the equity from 4 choices, then it
// reveals the true number plus the memory hook. Tracks a session streak.

import { useMemo, useState } from 'react';
import { ruleOf2and4 } from '../engine/equity';
import { RangeDrill } from './EquityRangeDrill';
import { InfoTip } from './CalcTip';
import { playGrade } from '../sound';
import { loadSrs, recordSrs, weightOf, weightedIndex, type SrsMap } from '../store/srs';

type Cat = 'Preflop' | 'Draws' | 'Made hands';

interface Flash {
  spot: string;
  detail: string;
  equity: number; // hero's equity %, the number to remember
  hook: string; // how to remember it without a solver
  recognize: string; // how to spot this pattern at the table
  cat: Cat;
}

// All equities are the well-known textbook figures (heads-up, all-in). Draw rows
// derive straight from the Rule of 2 & 4 so the hook and the number always agree.
const CARDS: Flash[] = [
  // ---- Preflop matchup ladder ----
  { spot: 'Pair vs two overcards', detail: 'e.g. 88 vs AK — the classic "race"', equity: 52, hook: 'Coinflip. Pair is a hair ahead (~52). "Race" = roughly 50/50.', recognize: 'You hold a pocket pair; BOTH of villain\'s cards rank above your pair (e.g. 88 vs A-K). Neither hand is paired-on-paired — it\'s your made pair vs two live overcards.', cat: 'Preflop' },
  { spot: 'Pair vs two undercards', detail: 'e.g. 88 vs 56', equity: 83, hook: 'Pair over both = ~80/20. The undercards need to pair or run a draw.', recognize: 'Your pocket pair outranks BOTH of villain\'s cards (e.g. 88 vs 5-6). They must pair up or make a straight/flush to beat you.', cat: 'Preflop' },
  { spot: 'Higher pair vs lower pair', detail: 'e.g. QQ vs 77', equity: 81, hook: '80/20. Lower pair needs its set (~18%) or a runner straight/flush.', recognize: 'BOTH players hold a pocket pair, yours the bigger one (e.g. QQ vs 77). Their main out is flopping a set (~12% per street).', cat: 'Preflop' },
  { spot: 'Dominated unpaired hand', detail: 'e.g. AK vs AQ (shared ace)', equity: 73, hook: 'Domination ≈ 70/30. Loser only lives via kicker / board.', recognize: 'Both hands share their TOP card; your kicker outranks theirs (A-K vs A-Q). "Domination" = same high card, you win the kicker.', cat: 'Preflop' },
  { spot: 'Two overcards vs a pair', detail: 'e.g. AK vs QQ', equity: 43, hook: 'Overcards are the dog (~43). Still close — two live cards.', recognize: 'You hold two unpaired high cards; villain has a pair that sits below them (A-K vs QQ). The same race, but from the overcard side — you\'re the slight dog.', cat: 'Preflop' },
  { spot: 'AA vs KK', detail: 'best vs 2nd-best pair', equity: 82, hook: '80/20, "cowboys cracked". KK only wins ~18% (set or runner).', recognize: 'The top two pocket pairs collide — your aces vs kings. KK is drawing almost dead unless a king lands.', cat: 'Preflop' },
  { spot: 'Pair vs two higher overcards, suited+connected', detail: 'e.g. 22 vs AKs', equity: 50, hook: 'A true coinflip — the suited+connected overs claw back to ~50.', recognize: 'Same as pair-vs-overcards, but the overcards are BOTH suited and connected (22 vs A-K suited). Those extra straight/flush outs drag it back to a true flip.', cat: 'Preflop' },
  { spot: 'Suited connector vs overpair', detail: 'e.g. JTs vs AA', equity: 22, hook: 'Big dog (~22), but the suited connector has the most outs of any underdog.', recognize: 'Your suited, connected cards are both BELOW villain\'s pocket pair (J-T suited vs AA). Way behind, but the most live underdog there is — straights AND flushes.', cat: 'Preflop' },

  // ---- Draws (Rule of 2 & 4) ----
  { spot: 'Flush draw on the flop', detail: '9 outs · 2 cards to come', equity: ruleOf2and4(9, 2), hook: 'Outs × 4 = 36 (round to ~35). The headline draw number.', recognize: 'Four cards of one suit after the flop (two in hand + two on board, or one + three). 13 − 4 = 9 cards of that suit left = 9 outs.', cat: 'Draws' },
  { spot: 'Open-ended straight draw, flop', detail: '8 outs · 2 cards to come', equity: ruleOf2and4(8, 2), hook: 'Outs × 4 = 32. OESD ≈ a third of the time.', recognize: 'Four cards in a row with room to extend BOTH ends (e.g. 9-8-7-6 wanting a T or a 5). Two ranks complete it × 4 suits = 8 outs.', cat: 'Draws' },
  { spot: 'Gutshot straight draw, flop', detail: '4 outs · 2 cards to come', equity: ruleOf2and4(4, 2), hook: 'Outs × 4 = 16. Gutshot ≈ 1-in-6 by the river.', recognize: 'One missing rank in the MIDDLE fills your straight (e.g. 9-8-6-5 needing a 7). One rank × 4 suits = 4 outs.', cat: 'Draws' },
  { spot: 'Flush + gutshot, flop', detail: '12 outs · 2 cards to come', equity: ruleOf2and4(12, 2), hook: 'Outs × 4 ≈ 48 (minus a touch). Near coinflip vs one pair.', recognize: 'A flush draw (9) AND an inside straight draw (4) at once — subtract the 1 card that does both. 9 + 4 − 1 = 12 outs.', cat: 'Draws' },
  { spot: 'Flush + OESD (monster draw), flop', detail: '15 outs · 2 cards to come', equity: ruleOf2and4(15, 2), hook: 'Outs × 4 ≈ 54 — you are the FAVOURITE vs top pair.', recognize: 'Flush draw (9) AND an open-ended straight draw (8) together — remove the 2 cards counted twice. 9 + 8 − 2 = 15 outs, the biggest standard draw.', cat: 'Draws' },
  { spot: 'Two overcards, flop', detail: '6 outs · 2 cards to come', equity: ruleOf2and4(6, 2), hook: 'Outs × 4 = 24. Six outs to a (maybe-good) pair.', recognize: 'You missed the flop but BOTH your cards beat the board (e.g. A-K on 8-5-2). Pairing either = 2 ranks × 3 remaining suits = 6 outs.', cat: 'Draws' },
  { spot: 'Flush draw on the turn', detail: '9 outs · 1 card to come', equity: ruleOf2and4(9, 1), hook: 'Outs × 2 = 18. One card halves your flop odds.', recognize: 'Same 9-out flush draw, but you\'re now on the turn with only the river left — so use × 2, not × 4.', cat: 'Draws' },
  { spot: 'OESD on the turn', detail: '8 outs · 1 card to come', equity: ruleOf2and4(8, 1), hook: 'Outs × 2 = 16. Need ~2:1 pot odds or implied odds.', recognize: 'Open-ended straight draw (8 outs) with one card to come. River-only, so × 2.', cat: 'Draws' },
  { spot: 'Gutshot on the turn', detail: '4 outs · 1 card to come', equity: ruleOf2and4(4, 1), hook: 'Outs × 2 = 8. Almost never a pure call — implied odds only.', recognize: 'Inside straight draw (4 outs) with only the river to come. × 2 = barely worth a call without implied odds.', cat: 'Draws' },

  // ---- Common postflop clashes ----
  { spot: 'Set vs overpair, on the flop', detail: 'e.g. 99 on 9♣4♦2♠ vs AA', equity: 90, hook: '~90/10. Set is a monster; overpair needs runner-runner or its 2-out set.', recognize: 'You hold a pocket pair that MATCHED the board (three of a kind) vs a bigger pocket pair that didn\'t improve (99 hits a 9; villain has AA). Set crushes overpair.', cat: 'Made hands' },
  { spot: 'Top pair vs flush draw, flop', detail: 'made hand vs 9-out draw', equity: 65, hook: '~65/35 — top pair is ahead but it is a real fight. Charge the draw.', recognize: 'You\'ve made top pair; villain has nothing yet but four to a flush (9 outs). Made hand ahead of a big draw — bet to deny the free card.', cat: 'Made hands' },
  { spot: 'Two pair vs flush draw, flop', detail: 'made hand vs 9-out draw', equity: 70, hook: '~70/30. Two pair also fears the board pairing, so still bet.', recognize: 'You hold two pair vs a flush draw (9 outs). Stronger made hand than top pair, so a bit further ahead — but the board can still pair you out.', cat: 'Made hands' },
  { spot: 'Overpair vs underpair, flop', detail: 'e.g. AA vs KK on a low board', equity: 90, hook: '~90/10 — same as preflop; the underpair is drawing to its set.', recognize: 'BOTH pocket pairs are bigger than every board card, yours the higher (AA vs KK on a 7-4-2 board). Same shape as the preflop pair-over-pair — they need a set.', cat: 'Made hands' },
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

// Spaced-repetition card selection lives at module scope: the react-hooks purity
// rule forbids Math.random inside component-scope functions (they could run during
// render). Component handlers call this. The draw is WEIGHTED by each card's SRS
// weight (missed cards surface more), and `avoidIdx` skips an immediate repeat.
function rollCard(pool: Flash[], srs: SrsMap, avoidIdx?: number): { idx: number; options: number[] } {
  const weights = pool.map((c) => weightOf(srs, c.spot));
  const i = weightedIndex(weights, Math.random, avoidIdx);
  return { idx: i, options: buildOptions(pool[i]) };
}

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
