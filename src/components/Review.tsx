// Review — the home for spaced repetition. The equity flashcards already carry
// an SRS weight per card (missed cards get heavier, mastered ones fade), but that
// state had nowhere to LIVE: no way to see what you've mastered, what's slipping,
// or to drill only the cards that need work. This tab is that home.
//   • A mastery dashboard over every flashcard: tracked / mastered / due / accuracy.
//   • A focused "due review" session that drills only the cards you keep missing,
//     weighted so the worst offenders come up most — and updates the dashboard live.
// It reads and writes the SAME `poker-trainer-srs-v1` store as the Equity Drill, so
// progress carries across both.

import { useMemo, useState } from 'react';
import { CARDS, rollCard, type Flash } from './flashcards';
import { loadSrs, recordSrs, weightOf, NEW_WEIGHT, type SrsMap } from '../store/srs';
import { InfoTip } from './CalcTip';
import { playGrade } from '../sound';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';

// A card counts as "due" once its weight climbs above the unseen baseline — i.e.
// you've missed it and it hasn't been re-mastered yet.
const isDue = (srs: SrsMap, spot: string) => weightOf(srs, spot) > NEW_WEIGHT;

interface Row {
  card: Flash;
  weight: number;
  seen: number;
  correct: number;
  acc: number | null;
  state: 'due' | 'mastered' | 'new';
}

function summarize(srs: SrsMap) {
  let mastered = 0;
  let due = 0;
  let untouched = 0;
  let seenTotal = 0;
  let correctTotal = 0;
  const rows: Row[] = CARDS.map((card) => {
    const st = srs[card.spot];
    const weight = weightOf(srs, card.spot);
    if (!st || st.seen === 0) {
      untouched++;
      return { card, weight, seen: 0, correct: 0, acc: null, state: 'new' };
    }
    seenTotal += st.seen;
    correctTotal += st.correct;
    const dueNow = weight > NEW_WEIGHT;
    if (dueNow) due++;
    else mastered++;
    return { card, weight, seen: st.seen, correct: st.correct, acc: st.correct / st.seen, state: dueNow ? 'due' : 'mastered' };
  });
  return { rows, mastered, due, untouched, acc: seenTotal ? correctTotal / seenTotal : null, seenTotal };
}

export function Review() {
  // one SRS snapshot in state, updated as the session records answers so the
  // dashboard reflects progress without a reload.
  const [srs, setSrs] = useState<SrsMap>(() => loadSrs());
  const [session, setSession] = useState<Flash[] | null>(null);

  const s = useMemo(() => summarize(srs), [srs]);
  const weakest = useMemo(
    () => s.rows.filter((r) => r.seen > 0).sort((a, b) => b.weight - a.weight).slice(0, 8),
    [s.rows],
  );

  const record = (spot: string, correct: boolean) => setSrs((m) => recordSrs(m, spot, correct));

  const startSession = (all: boolean) => {
    const pool = all ? CARDS : CARDS.filter((c) => isDue(srs, c.spot));
    setSession(pool.length ? pool : CARDS);
  };

  if (session) {
    return (
      <div className="card">
        <div className="rv-head">
          <h2>🔁 Review session</h2>
          <button className="btn-small" onClick={() => setSession(null)}>← Dashboard</button>
        </div>
        <ReviewSession pool={session} srs={srs} onRecord={record} />
      </div>
    );
  }

  const total = CARDS.length;
  const masteredPct = Math.round((s.mastered / total) * 100);

  return (
    <div className="card">
      <h2>🔁 Review — Spaced Repetition</h2>
      <p className="sub">
        Your flashcard progress lives here. Cards you miss gain weight and resurface often; cards you
        nail fade out. Drill only what's <b>due</b>, and watch mastery climb. Shares progress with the
        Equity Drill's flashcards.
      </p>

      <div className="kpi-grid">
        <div className="kpi"><div className="kpi-value">{total}</div><div className="kpi-label">Cards tracked</div></div>
        <div className="kpi"><div className="kpi-value pos">{s.mastered}</div><div className="kpi-label">Mastered</div></div>
        <div className="kpi"><div className={`kpi-value ${s.due ? 'neg' : ''}`}>{s.due}</div><div className="kpi-label">Due for review</div></div>
        <div className="kpi"><div className="kpi-value">{s.acc == null ? '—' : `${Math.round(s.acc * 100)}%`}</div><div className="kpi-label">Overall accuracy</div></div>
      </div>

      <div className="rv-mastery" title={`${s.mastered} mastered · ${s.due} due · ${s.untouched} not seen`}>
        <div className="rv-seg mastered" style={{ flexGrow: Math.max(0.001, s.mastered) }} />
        <div className="rv-seg due" style={{ flexGrow: Math.max(0.001, s.due) }} />
        <div className="rv-seg new" style={{ flexGrow: Math.max(0.001, s.untouched) }} />
      </div>
      <div className="rv-legend">
        <span><i className="sw mastered" /> Mastered {s.mastered}</span>
        <span><i className="sw due" /> Due {s.due}</span>
        <span><i className="sw new" /> Not seen {s.untouched}</span>
        <span className="muted">{masteredPct}% mastered</span>
      </div>

      <div className="rv-mastery-actions">
        <button className="btn btn-deal" onClick={() => startSession(false)} disabled={s.due === 0}>
          {s.due > 0 ? `Review ${s.due} due card${s.due === 1 ? '' : 's'} →` : 'Nothing due — caught up ✓'}
        </button>
        <button className="btn-small" onClick={() => startSession(true)}>Review all {total} cards</button>
      </div>

      {weakest.length > 0 && (
        <div className="rv-weak">
          <div className="an-h">Weakest cards — where to focus</div>
          {weakest.map((r) => (
            <div key={r.card.spot} className={`rv-weak-row ${r.state}`}>
              <span className="rv-weak-spot">{r.card.spot}</span>
              <span className="rv-weak-tag">{r.state === 'due' ? 'due' : 'mastered'}</span>
              <span className={`rv-weak-acc ${r.acc != null && r.acc >= 0.7 ? 'pos' : r.acc != null && r.acc < 0.45 ? 'neg' : ''}`}>
                {r.acc == null ? '—' : `${Math.round(r.acc * 100)}%`} <span className="muted">({r.seen})</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {s.seenTotal === 0 && (
        <p className="note">No reps yet. Start a review — or use the <b>Equity Drill → Flashcards</b> tab — and your progress will show up here.</p>
      )}
    </div>
  );
}

// Focused session over a fixed pool, weighted toward the worst cards. First card
// is the heaviest (deterministic, so render stays pure — no Math.random here);
// every subsequent draw is weighted-random inside the click handler.
function argmaxWeight(pool: Flash[], srs: SrsMap): number {
  let best = 0;
  let bestW = -1;
  pool.forEach((c, i) => {
    const w = weightOf(srs, c.spot);
    if (w > bestW) {
      bestW = w;
      best = i;
    }
  });
  return best;
}
// Deterministic 4-option set for the FIRST card only (buildOptions shuffles with
// Math.random, which must not run during render). Later cards use buildOptions.
function fixedOptions(card: Flash): number[] {
  const picks = [card.equity];
  for (const e of CARDS.map((c) => c.equity)) {
    if (picks.length >= 4) break;
    if (picks.every((p) => Math.abs(p - e) >= 6)) picks.push(e);
  }
  return picks.sort((a, b) => a - b);
}

function ReviewSession({ pool, srs, onRecord }: { pool: Flash[]; srs: SrsMap; onRecord: (spot: string, correct: boolean) => void }) {
  const [idx, setIdx] = useState(() => argmaxWeight(pool, srs));
  const [options, setOptions] = useState<number[]>(() => fixedOptions(pool[argmaxWeight(pool, srs)]));
  const [chosen, setChosen] = useState<number | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });

  const card = pool[idx] ?? pool[0];
  const dueLeft = pool.filter((c) => weightOf(srs, c.spot) > NEW_WEIGHT).length;

  function next() {
    const r = rollCard(pool, srs, idx); // weighted by SRS, avoid immediate repeat
    setIdx(r.idx);
    setOptions(r.options);
    setChosen(null);
  }
  function pick(v: number) {
    if (chosen != null) return;
    const right = v === card.equity;
    setChosen(v);
    setScore((sc) => ({ correct: sc.correct + (right ? 1 : 0), total: sc.total + 1 }));
    onRecord(card.spot, right);
    playGrade(right);
  }

  const revealed = chosen != null;
  const correct = revealed && chosen === card.equity;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  // keyboard: 1..4 picks an option, Space/Enter draws the next due card.
  useDrillKeys({ choices: options.length, onPick: (i) => pick(options[i]), onNext: next, revealed });

  return (
    <>
      <div className="quiz-bar">
        <div className="quiz-score">Score: <b>{score.correct}/{score.total}</b> ({pctScore}%) <span className="muted">{drillKeysHint(options.length)}</span></div>
        <div className="quiz-score">{dueLeft > 0 ? <><b>{dueLeft}</b> still due</> : <span className="pos">All caught up ✓</span>}</div>
      </div>

      <div className="drill-spot">
        <span className="drill-cat">{card.cat}</span>
        <div className="drill-q">
          {card.spot}
          <InfoTip content={<span className="tip-body"><b className="tip-title">How to spot it</b><span className="tip-what">{card.recognize}</span></span>} />
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
            <button className="btn btn-deal lab-next" onClick={next}>Next card →</button>
          </div>
        </>
      )}
    </>
  );
}
