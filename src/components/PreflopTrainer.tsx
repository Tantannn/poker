import { useCallback, useEffect, useState } from 'react';
import type { Position } from '../engine/table';
import type { Card } from '../engine/cards';
import { handCode, RFI_RANGES } from '../ai/preflop';
import { PlayingCard } from './PlayingCard';
import { MiniRangeGrid } from './MiniRangeGrid';
import { KIND_COLOR } from './chartColors';

const POSITIONS: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB'];

interface Dealt {
  pos: Position;
  cards: Card[];
  code: string;
  shouldRaise: boolean;
}

function dealRandom(enabled: Position[]): Dealt {
  const pos = enabled[Math.floor(Math.random() * enabled.length)];
  // random two distinct cards
  const a: Card = { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
  let b: Card;
  do {
    b = { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
  } while (b.rank === a.rank && b.suit === a.suit);
  const code = handCode([a, b]);
  return { pos, cards: [a, b], code, shouldRaise: RFI_RANGES[pos].has(code) };
}

export function PreflopTrainer() {
  const [enabled, setEnabled] = useState<Position[]>([...POSITIONS]);
  const [cur, setCur] = useState<Dealt | null>(null);
  const [answered, setAnswered] = useState(false);
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0, streak: 0 });
  const [showChart, setShowChart] = useState(false);

  const deal = useCallback(() => {
    setCur(dealRandom(enabled));
    setAnswered(false);
    setLastCorrect(null);
    setShowChart(false);
  }, [enabled]);

  const answer = useCallback(
    (raise: boolean) => {
      if (!cur || answered) return;
      const correct = raise === cur.shouldRaise;
      setAnswered(true);
      setLastCorrect(correct);
      setScore((s) => ({
        correct: s.correct + (correct ? 1 : 0),
        total: s.total + 1,
        streak: correct ? s.streak + 1 : 0,
      }));
    },
    [cur, answered],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // let browser shortcuts (Ctrl/Cmd+C/V/F, etc.) through
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'r' || e.key === 'R') answer(true);
      else if (e.key === 'f' || e.key === 'F') answer(false);
      else if (e.key === ' ') {
        e.preventDefault();
        deal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer, deal]);

  const acc = score.total ? Math.round((score.correct / score.total) * 100) : 0;

  return (
    <div className="card trainer-card">
      <h2>Preflop Range Trainer</h2>
      <p className="sub">
        It folds to you — raise or fold? Keys: <kbd>R</kbd> raise · <kbd>F</kbd> fold · <kbd>Space</kbd>{' '}
        next.
      </p>

      <div className="trainer-filter">
        {POSITIONS.map((p) => {
          const on = enabled.includes(p);
          return (
            <button
              key={p}
              className={on ? 'active' : ''}
              onClick={() =>
                setEnabled((cur2) =>
                  on ? (cur2.length > 1 ? cur2.filter((x) => x !== p) : cur2) : [...cur2, p],
                )
              }
            >
              {p}
            </button>
          );
        })}
      </div>

      <div className="trainer-scenario">
        {cur ? (
          <>
            Position: <b>{cur.pos}</b> · folds to you
          </>
        ) : (
          'Press Deal to start'
        )}
      </div>

      <div className="trainer-cards">
        {cur ? (
          cur.cards.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)
        ) : (
          <>
            <div className="pcard back lg" />
            <div className="pcard back lg" />
          </>
        )}
      </div>

      <div className="trainer-actions">
        <button className="btn btn-raise" disabled={!cur || answered} onClick={() => answer(true)}>
          Raise
        </button>
        <button className="btn btn-fold" disabled={!cur || answered} onClick={() => answer(false)}>
          Fold
        </button>
      </div>

      <div className={`trainer-fb ${lastCorrect === null ? '' : lastCorrect ? 'good' : 'bad'}`}>
        {answered && cur
          ? lastCorrect
            ? `✓ Correct — ${cur.code} is a ${cur.shouldRaise ? 'RAISE' : 'FOLD'} from ${cur.pos}.`
            : `✗ ${cur.code} should be ${cur.shouldRaise ? 'RAISE' : 'FOLD'} from ${cur.pos}.`
          : 'Raise or fold?'}
      </div>

      <button className="btn btn-deal" onClick={deal}>
        Deal Hand <kbd>Space</kbd>
      </button>

      <div className="trainer-score">
        <div>
          Correct <b>{score.correct}</b>
        </div>
        <div>
          Total <b>{score.total}</b>
        </div>
        <div>
          Accuracy <b>{score.total ? acc + '%' : '—'}</b>
        </div>
        <div>
          Streak <b>{score.streak}</b>
        </div>
      </div>

      {cur && (
        <button className="btn-chart-seat trainer-chart-btn" onClick={() => setShowChart(true)}>
          📊 Range chart — {cur.pos}
        </button>
      )}

      {showChart && cur && (
        <div className="modal-backdrop" onClick={() => setShowChart(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>RFI range — open from {cur.pos}</span>
              <button className="modal-close" onClick={() => setShowChart(false)}>✕</button>
            </div>
            <div className="modal-body">
              <MiniRangeGrid scenarioId={`rfi-${cur.pos}`} highlight={cur.code} />
              <div className="modal-side">
                <p className="modal-note">
                  Full opening range from <b>{cur.pos}</b>. Your hand <b>{cur.code}</b> is outlined in gold —
                  its color shows the action.
                </p>
                <div className="legend chart-legend">
                  <div><span className="sw" style={{ background: KIND_COLOR.value }} /> Open / raise</div>
                  <div><span className="sw" style={{ background: `linear-gradient(to right, ${KIND_COLOR.value} 50%, ${KIND_COLOR.fold} 50%)` }} /> Mixed (≈50% open)</div>
                  <div><span className="sw" style={{ background: KIND_COLOR.fold }} /> Fold</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
