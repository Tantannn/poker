// Tells / Timing / Table-Image Trainer — the "reading people" half of the game,
// drilled as a quiz. Every scenario is a BEHAVIORAL read (online-style: no faces,
// no avatars) built from the Reference tab's "Reading people — tells, timing &
// table image" section: bet-timing patterns, sizing signatures, frequency /
// story-consistency tells, table image & leveling, and the meta-lesson that a
// single tell is noise while a CLUSTER + a deviation from baseline is the signal.
// The sizing-tell scenarios reflect the real model the easy bots use (see
// ai/decide.ts: "a fish sizes its bet by how good its hand looks").
//
// Matches the BetSizingDrill / MathDrill pattern: static, deterministic questions
// (no solver), a module-load first question (React forbids Math.random in render),
// keyboard 1–4 / Space, reveal-then-explain, and a lifetime score persisted per
// drill id (store/drillScore, id 'tells').

import { useState } from 'react';
import { playGrade } from '@/sound';
import { useDrillKeys, drillKeysHint } from '@/hooks/useDrillKeys';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '@/store/training';


import { type QType, type ScenarioView, pickView } from './tellScenarios';

const DRILL_ID = 'tells';


// First scenario at module load — a useState lazy initializer runs in render,
// where Math.random is forbidden.
const FIRST = pickView(Math.random);

const QTYPE_LABEL: Record<QType, string> = {
  read: "What's the read?",
  exploit: "What's the exploit?",
};

export function TellsTrainer() {
  const [view, setView] = useState<ScenarioView>(FIRST);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(() => loadDrillScore(DRILL_ID));
  const [streak, setStreak] = useState(0); // current session run of correct answers

  const revealed = picked != null;
  const correct = revealed && picked === view.answer;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  function pick(i: number) {
    if (revealed) return;
    const ok = i === view.answer;
    setPicked(i);
    setScore(recordDrillScore(DRILL_ID, ok));
    setStreak((s) => (ok ? s + 1 : 0));
    playGrade(ok);
  }
  function next() {
    setView(pickView(Math.random, view.scenario.id));
    setPicked(null);
  }

  useDrillKeys({ choices: view.options.length, onPick: pick, onNext: next, revealed });

  const s = view.scenario;

  return (
    <div className="card">
      <h2>Tells &amp; Timing Trainer</h2>
      <p className="sub">
        The <b>reading-people</b> half of poker, drilled. Online-style, so every read is
        <b> behavioral</b> — bet-timing patterns, sizing signatures, story consistency, table image &amp;
        leveling. Pick the correct <b>read</b> or the correct <b>exploit</b>, then see the reasoning. The
        Reference tab's <b>👁 Reading people</b> section is the source; this makes it stick.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          <span className="bsd-pill pos">{s.category}</span>
          <span className="bsd-pill polar">🔥 streak {streak}</span>
        </div>
        <div className="quiz-score">
          Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)
          {score.total > 0 && (
            <button
              className="btn-small qs-reset"
              onClick={() => {
                setScore(resetDrillScore(DRILL_ID));
                setStreak(0);
              }}
              title="Reset this drill's saved score & streak"
            >
              ↺
            </button>
          )}
        </div>
      </div>
      <p className="note">{drillKeysHint(view.options.length)} · score is saved across sessions.</p>

      <div className="lab-prompt">{s.prompt}</div>
      <p className="note" style={{ marginTop: 0 }}>
        {QTYPE_LABEL[s.type]}
      </p>

      <div className="rd-bands bsd-sizes">
        {view.options.map((o, i) => (
          <button
            key={i}
            className={`rd-band ${picked === i ? 'chosen' : ''} ${revealed && i === view.answer ? 'is-best' : ''} ${revealed && picked === i && i !== view.answer ? 'is-wrong' : ''}`}
            onClick={() => pick(i)}
          >
            <span className="rd-band-lbl">{o}</span>
          </button>
        ))}
      </div>

      <div className="hr-controls">
        <button className="btn btn-deal" onClick={next}>
          New hand ⟳
        </button>
      </div>

      {revealed && (
        <>
          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct ? '✓ Correct.' : `✗ Answer: ${view.options[view.answer]}`}
          </div>
          <div className="bsd-lesson">
            <span className="bsd-lesson-tag">📌 Why</span>
            <p>{s.explain}</p>
          </div>
        </>
      )}

      <div className="bsd-cheat">
        <h4>Reading people — the cheat sheet</h4>
        <div className="bsd-cheat-grid">
          <div>
            <span className="bsd-pill small">Timing</span> Instant = automatic (draw / routine c-bet). Long
            tank → bet = strong. Snap-call = capped (draw / medium). Instant check = give-up, steal.
            Announced pause → raise = staged strength.
          </div>
          <div>
            <span className="bsd-pill big">Physical (Caro)</span> Strong means weak. Trembling after a bet =
            adrenaline / monster. Freeze &amp; held breath = bluff. The theatrical, strong act wants a fold.
          </div>
          <div>
            <span className="bsd-pill polar">Sizing</span> Learn the baseline, read the deviation. Fish size
            to strength (big = strong, small = weak). A random raiser's size is noise — play the range.
          </div>
          <div>
            <span className="bsd-pill check">Story</span> Does the line represent a real hand?
            Bet-bet-check = give-up / pot-control, rarely a trap. A passive player's sudden min-raise = a
            made hand.
          </div>
          <div>
            <span className="bsd-pill pos">Image &amp; leveling</span> Play the image you've given: tight →
            bluff more, loose → value more. Play one level above — beat a level-0 with value, a level-2 with
            deception.
          </div>
          <div>
            <span className="bsd-pill polar">Cluster &gt; single tell</span> One tell on one hand is noise.
            The signal is a cluster of tells + a deviation from baseline. Archetype first, betting story
            second, physical tell only as a tie-breaker.
          </div>
        </div>
        <p className="bsd-note">
          Core idea: <b>categorize the archetype, read the betting story, treat a lone tell as a
          tie-breaker</b> — never the whole decision. And guard your own: <b>same tempo, same sizing, every
          hand.</b>
        </p>
      </div>
    </div>
  );
}
