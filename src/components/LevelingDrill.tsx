// Leveling War drill — the dynamic-exploit loop, as a drill. Every other reads tab trains a
// read against a FIXED opponent; this one trains the thing that actually beats a reg: a stat
// moves mid-session, you decide whether the sample earns an adjustment, you pick the counter,
// and then he moves BACK and you re-level first.
//
// The trust question is the one most players get wrong, so it is asked before the counter and
// half the spots are unactionable on purpose. Answers come from the live read pipeline
// (levelingSpot.ts), so the drill and the table's "⚠ he's adjusting" panel can never disagree.

import { useCallback, useMemo, useState } from 'react';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';
import { playGrade } from '../sound';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';
import { COUNTERS, genSpot, type CounterId, type Round, type Spot } from './levelingSpot';

const FIRST = genSpot();

type Phase = 'trust' | 'counter' | 'relevel' | 'done';

const TRUST: { id: 'act' | 'wait'; label: string; hint: string }[] = [
  { id: 'act', label: 'Real adjustment — act on it', hint: 'The move is big enough and the sample deep enough to change your line.' },
  { id: 'wait', label: 'Not yet — keep watching', hint: 'Too few decisions, or a move small enough to be normal variance.' },
];

const COUNTER_ORDER: CounterId[] = ['stop-bluff', 'barrel-more', 'bluffcatch', 'take-lead', 'keep-watching'];

function StatLine({ round, statLabel, seat }: { round: Round; statLabel: string; seat: string }) {
  return (
    <div className="bc-price">
      <div className="bc-price-row">
        <span>
          <b>{seat}</b> {statLabel}: all session <b>{round.fromPct}%</b> → last few decisions{' '}
          <b>{round.toPct}%</b>
        </span>
      </div>
      <div className="bc-price-row gp-muted">
        {round.sample} decisions behind the season-long number.
      </div>
    </div>
  );
}

export function LevelingDrill() {
  const [spot, setSpot] = useState<Spot>(FIRST);
  const [phase, setPhase] = useState<Phase>('trust');
  const [trustPick, setTrustPick] = useState<'act' | 'wait' | null>(null);
  const [counterPick, setCounterPick] = useState<CounterId | null>(null);
  const [relevelPick, setRelevelPick] = useState<CounterId | null>(null);
  const [score, setScore] = useState(() => loadDrillScore('leveling'));

  const trustAnswer: 'act' | 'wait' = spot.first.alert ? 'act' : 'wait';

  const next = useCallback(() => {
    setSpot(genSpot());
    setPhase('trust');
    setTrustPick(null);
    setCounterPick(null);
    setRelevelPick(null);
  }, []);

  const record = useCallback((correct: boolean) => {
    setScore(recordDrillScore('leveling', correct));
    playGrade(correct ? 'good' : 'bad');
  }, []);

  const chooseTrust = useCallback(
    (id: 'act' | 'wait') => {
      if (phase !== 'trust') return;
      setTrustPick(id);
      record(id === trustAnswer);
      setPhase('counter');
    },
    [phase, trustAnswer, record],
  );

  const chooseCounter = useCallback(
    (id: CounterId) => {
      if (phase !== 'counter') return;
      setCounterPick(id);
      record(id === spot.first.answer);
      setPhase(spot.second ? 'relevel' : 'done');
    },
    [phase, spot, record],
  );

  const chooseRelevel = useCallback(
    (id: CounterId) => {
      if (phase !== 'relevel') return;
      setRelevelPick(id);
      record(id === spot.second?.answer);
      setPhase('done');
    },
    [phase, spot, record],
  );

  const choices = phase === 'trust' ? TRUST.length : phase === 'counter' || phase === 'relevel' ? COUNTER_ORDER.length : 0;
  const onPick = useCallback(
    (i: number) => {
      if (phase === 'trust') chooseTrust(TRUST[i].id);
      else if (phase === 'counter') chooseCounter(COUNTER_ORDER[i]);
      else if (phase === 'relevel') chooseRelevel(COUNTER_ORDER[i]);
    },
    [phase, chooseTrust, chooseCounter, chooseRelevel],
  );
  useDrillKeys({ choices, onPick, onNext: next, revealed: phase === 'done' });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const leveling = useMemo(() => spot.first.alert?.leveling ?? false, [spot]);

  return (
    <div className="card">
      <h2>🔄 Leveling War</h2>
      <p className="sub">
        A reg has no static leak to attack — he <b>adjusts to you</b>, and the lifetime average never shows it.
        Three questions per spot: is the shift <b>trustworthy</b>, what's the <b>counter</b>, and when he moves back,
        do you <b>re-level first</b>? The answers come from the same read pipeline as the table's
        “⚠ he's adjusting” panel, so what you drill is what you'll see.
      </p>

      <div className="quiz-bar">
        <div className="quiz-score" style={{ marginLeft: 0 }}>
          Levelled right: <b>{score.correct}/{score.total}</b> ({pct}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore('leveling'))} title="Reset saved score">↺</button>
          )}
        </div>
        <span className="gp-muted">{drillKeysHint(choices || 5)}</span>
      </div>

      <StatLine round={spot.first} statLabel={spot.statLabel} seat={spot.seat} />
      <div className="bc-price">
        <div className="bc-price-row gp-muted">
          Your own recent lead frequency: <b>{spot.heroAggroPct}%</b> — how much you've been the aggressor.
        </div>
      </div>

      {phase === 'trust' ? (
        <>
          <div className="lab-prompt">Does this earn an adjustment?</div>
          <div className="et-reads bc-choices">
            {TRUST.map((t) => (
              <button key={t.id} className="et-read" onClick={() => chooseTrust(t.id)}>
                <span className="et-read-label">{t.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className={`et-readres ${trustPick === trustAnswer ? 'good' : 'bad'}`}>
          {trustPick === trustAnswer ? '✓ ' : '✗ '}
          {trustAnswer === 'act'
            ? `Trustworthy — ${spot.first.sample} decisions behind the baseline and the window has moved far enough to be a real adjustment.`
            : spot.first.sample < 8
              ? `Too thin — ${spot.first.sample} decisions can't distinguish an adjustment from a run of hands. The window needs a baseline to be measured against.`
              : `Inside variance — the window moved, but not far enough to be anything but noise. Acting on this is an invented read.`}
        </div>
      )}

      {(phase === 'counter' || phase === 'relevel' || phase === 'done') && (
        <>
          {leveling && (
            <div className="opp-shift leveling">
              <span className="opp-shift-lbl">🎯 He's levelling YOU</span>
              <div className="opp-shift-row">
                <div className="opp-shift-head">{spot.first.alert?.headline}</div>
              </div>
            </div>
          )}
          <div className="lab-prompt">
            {phase === 'counter' ? 'What do you change?' : 'Round 1 counter'}
          </div>
          <div className="et-reads bc-choices">
            {COUNTER_ORDER.map((id) => {
              const c = COUNTERS[id];
              const revealed = phase !== 'counter';
              const isPicked = counterPick === id;
              const isAnswer = revealed && id === spot.first.answer;
              const isWrong = revealed && isPicked && id !== spot.first.answer;
              return (
                <button
                  key={id}
                  className={`et-read ${isPicked ? 'picked' : ''} ${isAnswer ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
                  onClick={() => chooseCounter(id)}
                  disabled={revealed}
                >
                  <span className="et-read-label">{c.label}</span>
                  {revealed && <span className="et-read-hint">{c.hint}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}

      {(phase === 'relevel' || (phase === 'done' && spot.second)) && spot.second && (
        <>
          <div className="gp-block">
            <div className="gp-h">…and now he moves again</div>
            <p>
              You made that adjustment. Several orbits later the window has flipped the other way — he has read
              your change and countered it. This is the level that decides the match.
            </p>
          </div>
          <StatLine round={spot.second} statLabel={spot.statLabel} seat={spot.seat} />
          <div className="lab-prompt">{phase === 'relevel' ? 'Re-level. What now?' : 'Your re-level'}</div>
          <div className="et-reads bc-choices">
            {COUNTER_ORDER.map((id) => {
              const c = COUNTERS[id];
              const revealed = phase === 'done';
              const isPicked = relevelPick === id;
              const isAnswer = revealed && id === spot.second?.answer;
              const isWrong = revealed && isPicked && id !== spot.second?.answer;
              return (
                <button
                  key={id}
                  className={`et-read ${isPicked ? 'picked' : ''} ${isAnswer ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
                  onClick={() => chooseRelevel(id)}
                  disabled={revealed}
                >
                  <span className="et-read-label">{c.label}</span>
                  {revealed && <span className="et-read-hint">{c.hint}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}

      {phase === 'done' && (
        <div className="et-reveal">
          {spot.first.alert && (
            <div className="gp-block">
              <div className="gp-h">What the table would have told you</div>
              <p>
                <b>{spot.first.alert.headline}</b> ({spot.first.alert.fromPct}% → {spot.first.alert.toPct}%)
              </p>
              <p>{spot.first.alert.advice}</p>
            </div>
          )}
          {spot.second?.alert && (
            <div className="gp-block">
              <div className="gp-h">The re-level</div>
              <p>
                <b>{spot.second.alert.headline}</b> ({spot.second.alert.fromPct}% → {spot.second.alert.toPct}%)
              </p>
              <p>{spot.second.alert.advice}</p>
            </div>
          )}
          {!spot.first.alert && (
            <div className="gp-block">
              <div className="gp-h">Why nothing changes here</div>
              <p>
                A read needs both a big enough move and enough decisions behind the baseline to measure it against.
                This spot has neither, and the cost of a wrong leveling adjustment is worse than the cost of
                waiting — you hand him the counter for free.
              </p>
            </div>
          )}
          <button className="btn btn-deal" onClick={next}>Next spot →</button>
        </div>
      )}
    </div>
  );
}
