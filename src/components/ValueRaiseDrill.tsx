// Value-Raise drill — the OTHER half of the marry-a-hand leak. Cold Fold trains folding
// the marginal hand; this trains RAISING the strong one instead of passively calling it
// down. You face a bet with a made hand and choose raise / call / fold. The real engine
// (solvePostflop) grades it, so "just call" a hand that wants to raise shows up as the EV
// you left on the table — value not extracted, equity not denied. OOP spots are check-raises.

import { useCallback, useMemo, useState } from 'react';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys } from '../hooks/useDrillKeys';
import { playGrade } from '../sound';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';
import { genSpot, type Cat, type Spot } from './valueRaiseSpot';

const FIRST = genSpot();

const CHOICES: { id: Cat; label: string; hint: string }[] = [
  { id: 'raise', label: 'Raise', hint: 'Extract value / deny equity — don’t let it just call.' },
  { id: 'call', label: 'Call', hint: 'Keep his range wide / pot-control, no raise.' },
  { id: 'fold', label: 'Fold', hint: 'Behind his betting range with no equity to continue.' },
];
const CATLABEL: Record<Cat, string> = { raise: 'Raise', call: 'Call', fold: 'Fold' };

export function ValueRaiseDrill() {
  const [spot, setSpot] = useState<Spot>(FIRST);
  const [pickId, setPickId] = useState<Cat | null>(null);
  const [score, setScore] = useState(() => loadDrillScore('valueraise'));
  const revealed = pickId !== null;

  const next = useCallback(() => { setSpot(genSpot()); setPickId(null); }, []);
  const choose = useCallback(
    (id: Cat) => {
      if (revealed) return;
      setPickId(id);
      const correct = id === spot.best;
      setScore(recordDrillScore('valueraise', correct));
      playGrade(correct ? 'good' : 'bad');
    },
    [revealed, spot],
  );
  useDrillKeys({ choices: CHOICES.length, onPick: (i) => choose(CHOICES[i].id), onNext: next, revealed });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const correct = revealed && pickId === spot.best;
  // the leak: raise was best but you (would) just call → the EV you left behind
  const leakLoss = useMemo(() => Math.max(0, spot.raiseEv - spot.callEv), [spot]);

  return (
    <div className="card">
      <h2>💥 Value Raise</h2>
      <p className="sub">
        The other half of marrying a hand: <b>Cold Fold</b> trains laying down the marginal hand — this trains
        <b> raising the strong one</b> instead of passively calling it down. You’re facing a bet. Raise for value,
        just call, or fold — the engine grades it, so a passive call of a hand that wanted to raise shows up as the
        EV you left on the table.
      </p>

      <div className="quiz-bar">
        <div className="quiz-score" style={{ marginLeft: 0 }}>
          Raised right: <b>{score.correct}/{score.total}</b> ({pct}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore('valueraise'))} title="Reset saved score">↺</button>
          )}
        </div>
      </div>

      <div className="hr-board">
        {spot.board.map((c, i) => <PlayingCard key={i} card={c} size="md" />)}
      </div>
      <div className="cf-hero">
        <span className="cf-hero-lbl">You hold</span>
        {spot.hole.map((c, i) => <PlayingCard key={i} card={c} size="md" />)}
        <span className="cf-hand">{spot.handName}</span>
        <span className="cf-tier">{spot.position === 'oop' ? 'out of position — a raise here is a check-raise' : 'in position'}</span>
      </div>

      <div className="bc-price">
        <div className="bc-price-row">
          <span>{spot.street === 'flop' ? 'Flop' : 'Turn'}. Pot <b>{spot.potBB}bb</b>. Villain bets <b>{spot.betBB}bb</b> into you.</span>
        </div>
      </div>

      <div className="lab-prompt">Raise, call, or fold?</div>

      <div className="et-reads bc-choices">
        {CHOICES.map((c) => {
          const isPicked = pickId === c.id;
          const isAnswer = revealed && c.id === spot.best;
          const isWrong = revealed && isPicked && c.id !== spot.best;
          return (
            <button
              key={c.id}
              className={`et-read ${isPicked ? 'picked' : ''} ${isAnswer ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
              onClick={() => choose(c.id)}
              disabled={revealed}
            >
              <span className="et-read-label">{c.label}{c.id === 'raise' && revealed && spot.best === 'raise' ? ` (${spot.raiseLabel})` : ''}</span>
              {revealed && <span className="et-read-hint">{c.hint}</span>}
            </button>
          );
        })}
      </div>

      {revealed && (
        <div className="et-reveal">
          <div className={`et-readres ${correct ? 'good' : 'bad'}`}>
            {correct ? '✓ Right.' : `✗ Off — the play is "${CATLABEL[spot.best]}".`}
          </div>

          <div className="gp-block">
            <div className="gp-h">Best line: {CATLABEL[spot.best]}</div>
            <p>
              {spot.best === 'raise'
                ? `Raise (${spot.raiseLabel}) is worth ${(spot.raiseEv - spot.callEv >= 0 ? '+' : '')}${(spot.raiseEv - spot.callEv).toFixed(2)}bb over calling. ${spot.why || 'A strong made hand raises to get called by worse and to charge the draws that would peel — flat-calling collects neither.'}`
                : spot.best === 'call'
                  ? `Calling beats raising here (raise EV ${spot.raiseEv.toFixed(2)}bb ≤ call ${spot.callEv.toFixed(2)}bb): the hand is good enough to continue but a raise only folds out worse and gets called by better. Keep his range wide.`
                  : `Both raising and calling are −EV — you're behind his betting range with too little equity to continue. Fold.`}
            </p>
          </div>

          {spot.best === 'raise' && pickId === 'call' && (
            <div className="gp-block">
              <div className="gp-h">⚠ The leak</div>
              <p>
                This is the exact spot the marry-a-hand leak leaks: you called a hand that wanted to raise and left{' '}
                <b>{leakLoss.toFixed(2)}bb</b> on the table — value not extracted and equity not denied. A strong hand
                that only ever calls never gets paid.
              </p>
            </div>
          )}

          <button className="btn btn-deal" onClick={next}>Next spot →</button>
        </div>
      )}
    </div>
  );
}
