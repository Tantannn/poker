// Enter a hand you played at the casino, grade it, and push it into the same history
// and leak finder as in-app play. The 31 other tabs all generate their own spots; this
// is the only one that takes a spot from outside the app.

import { useMemo, useState } from 'react';
import type { useGame } from '../hooks/useGame';
import type { Position } from '../engine/table';
import type { RakeProfileId } from '../engine/rake';
import { RAKE_PROFILES } from '../engine/rake';
import { cardToString } from '../engine/cards';
import { replayLiveHand, parseActionScript, parseCards } from '../analysis/liveHand';
import type { LiveHandResult } from '../analysis/liveHand';

const POSITIONS: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const TIER = (evLoss: number) =>
  evLoss <= 0.05 ? { label: 'Best', cls: 'good' }
    : evLoss <= 0.3 ? { label: 'Fine', cls: 'ok' }
      : evLoss <= 1 ? { label: 'Inaccuracy', cls: 'warn' }
        : { label: 'Mistake', cls: 'bad' };

export function LiveHand({ g }: { g: ReturnType<typeof useGame> }) {
  const [tableSize, setTableSize] = useState(6);
  const [heroPosition, setHeroPosition] = useState<Position>('BTN');
  const [stackBB, setStackBB] = useState(100);
  const [rake, setRake] = useState<RakeProfileId>('live-1-2');
  const [heroText, setHeroText] = useState('Ah Kd');
  const [boardText, setBoardText] = useState('');
  const [script, setScript] = useState('fold, fold, fold, raise 2.5, fold, fold');
  const [result, setResult] = useState<LiveHandResult | null>(null);
  const [saved, setSaved] = useState(false);

  const heroCards = useMemo(() => parseCards(heroText), [heroText]);
  const board = useMemo(() => parseCards(boardText), [boardText]);
  const parsed = useMemo(() => parseActionScript(script), [script]);

  const grade = () => {
    setSaved(false);
    if (parsed.error) {
      setResult({ records: [], consumed: 0, error: parsed.error });
      return;
    }
    setResult(
      replayLiveHand({ tableSize, heroPosition, stackBB, rake, heroCards, board, actions: parsed.actions }),
    );
  };

  const save = () => {
    if (!result?.hand) return;
    g.importLiveHand(result.hand, result.records);
    setSaved(true);
  };

  const decisions = result?.hand?.decisions ?? [];

  return (
    <div className="panel">
      <h2>🎰 Live Hand</h2>
      <p className="muted">
        A hand from a real session, graded by the same engine as the table and added to the same
        history — so Hand Review, the leak finder and bb/100 finally see the game you actually play.
        Villain holdings are never entered: every recommendation is range-based, so they aren't needed.
      </p>

      <div className="row wrap gap">
        <label>
          Seats
          <select value={tableSize} onChange={(e) => setTableSize(Number(e.target.value))}>
            {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}-handed</option>)}
          </select>
        </label>
        <label>
          Your seat
          <select value={heroPosition} onChange={(e) => setHeroPosition(e.target.value as Position)}>
            {POSITIONS.slice(0, tableSize).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>
          Effective stack (bb)
          <input type="number" min={2} max={500} value={stackBB} onChange={(e) => setStackBB(Number(e.target.value))} />
        </label>
        <label>
          Rake
          <select value={rake} onChange={(e) => setRake(e.target.value as RakeProfileId)}>
            {RAKE_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      </div>

      <div className="row wrap gap">
        <label>
          Your cards
          <input value={heroText} onChange={(e) => setHeroText(e.target.value)} placeholder="Ah Kd" />
        </label>
        <label>
          Board (blank if it ended preflop)
          <input value={boardText} onChange={(e) => setBoardText(e.target.value)} placeholder="Kc 7h 2d 9s" />
        </label>
      </div>
      <p className="muted small">
        {heroCards.length}/2 hole cards{heroCards.length ? ` — ${heroCards.map(cardToString).join(' ')}` : ''} ·{' '}
        {board.length} board card{board.length === 1 ? '' : 's'}
        {board.length ? ` — ${board.map(cardToString).join(' ')}` : ''}
      </p>

      <label className="block">
        Action, in the order it happened
        <textarea rows={5} value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
      </label>
      <p className="muted small">
        One per line or comma-separated: <code>fold</code>, <code>check</code>, <code>call</code>,{' '}
        <code>bet 6</code>, <code>raise 15</code>. Sizes are the TOTAL for that street in big blinds —
        what gets said at the table. Start with the first player to act preflop (left of the blinds);
        the engine works out whose turn each action is, so a typo shows up as an illegal action.
      </p>

      <div className="row gap">
        <button className="primary" onClick={grade} disabled={parsed.actions.length === 0}>Grade hand</button>
        <button onClick={save} disabled={!result?.hand || saved}>
          {saved ? 'Saved ✓' : 'Save to history + leaks'}
        </button>
      </div>

      {result?.error && <p className="bad">{result.error}</p>}

      {result?.hand && (
        <>
          <h3>Your decisions ({decisions.length})</h3>
          {decisions.length === 0 && (
            <p className="muted">The hand ended without you facing a decision — nothing to grade.</p>
          )}
          {decisions.map((d, i) => {
            const t = TIER(d.evLoss);
            return (
              <div key={i} className="card">
                <div className="row between">
                  <strong>{d.street} · {d.position} · pot {(d.pot / 2).toFixed(1)}bb{d.toCall ? ` · ${(d.toCall / 2).toFixed(1)}bb to call` : ''}</strong>
                  <span className={t.cls}>{t.label}</span>
                </div>
                <p>
                  You {d.chosenLabel.toLowerCase()}. Best: <strong>{d.bestLabel}</strong>
                  {d.evLoss > 0.05 && <> — {d.evLoss.toFixed(2)}bb worse</>}.
                </p>
                <p className="muted small">{d.note}</p>
              </div>
            );
          })}
          <p className="muted small">
            Net for the hand: {result.hand.deltaBB >= 0 ? '+' : ''}{result.hand.deltaBB.toFixed(1)}bb.
            Saving adds it to Hand Review and folds its decisions into the leak finder.
          </p>
        </>
      )}
    </div>
  );
}
