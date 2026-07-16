// Standalone equity calculator popup. Pick your two hole cards, an optional
// board, and how many opponents, and it runs a Monte-Carlo sim (engine/equity)
// to show your real win / tie / lose share. Unlike the live HUD this works any
// time, on any hand you type in — a scratchpad for "what's my equity here?".

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { RANK_CHARS, SUIT_SYMBOLS, sameCard, suitClass } from '../engine/cards';
import { monteCarloEquity } from '../engine/equity';

const RANKS_DESC = [...RANK_CHARS].reverse(); // A K Q ... 2

export function EquityCalc() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="equity-fab" onClick={() => setOpen(true)} title="Open equity calculator">
        ♠ Equity calc
      </button>
      {open && <EquityModal onClose={() => setOpen(false)} />}
    </>
  );
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function EquityModal({ onClose }: { onClose: () => void }) {
  const [hero, setHero] = useState<Card[]>([]);
  const [board, setBoard] = useState<Card[]>([]);
  const [opponents, setOpponents] = useState(1);
  const [zone, setZone] = useState<'hand' | 'board'>('hand');

  const selected = [...hero, ...board];
  const isSel = (c: Card) => selected.some((s) => sameCard(s, c));

  function toggle(c: Card) {
    if (hero.some((h) => sameCard(h, c))) {
      setHero(hero.filter((h) => !sameCard(h, c)));
      return;
    }
    if (board.some((b) => sameCard(b, c))) {
      setBoard(board.filter((b) => !sameCard(b, c)));
      return;
    }
    // add to the active zone; auto-jump hand -> board once hand is full
    if (zone === 'hand' && hero.length < 2) {
      const next = [...hero, c];
      setHero(next);
      if (next.length === 2) setZone('board');
    } else if (board.length < 5) {
      setBoard([...board, c]);
      if (zone === 'hand') setZone('board');
    }
  }

  // 4000 iters: vs random opponents this runs in a few ms, fast enough to be live.
  const result = useMemo(
    () => (hero.length === 2 ? monteCarloEquity(hero, board, opponents, 4000) : null),
    [hero, board, opponents],
  );

  const ready = hero.length === 2;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>♠ Equity Calculator</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body eq-body">
          <div className="eq-slots">
            <button
              className={`eq-zone ${zone === 'hand' ? 'active' : ''}`}
              onClick={() => setZone('hand')}
            >
              <span className="eq-zone-lbl">Your hand</span>
              <span className="eq-zone-cards">
                {[0, 1].map((i) => <Slot key={i} card={hero[i]} />)}
              </span>
            </button>
            <button
              className={`eq-zone ${zone === 'board' ? 'active' : ''}`}
              onClick={() => setZone('board')}
            >
              <span className="eq-zone-lbl">Board (optional)</span>
              <span className="eq-zone-cards">
                {[0, 1, 2, 3, 4].map((i) => <Slot key={i} card={board[i]} />)}
              </span>
            </button>
          </div>

          <p className="eq-hint">
            Tap the <b>{zone === 'hand' ? 'Your hand' : 'Board'}</b> box, then tap cards below. Tap a
            picked card to remove it.
          </p>

          <div className="eq-grid">
            {[0, 1, 2, 3].map((suit) => (
              <div className="eq-row" key={suit}>
                {RANKS_DESC.map((ch) => {
                  const card: Card = { rank: RANK_CHARS.indexOf(ch) + 2, suit };
                  const sel = isSel(card);
                  return (
                    <button
                      key={ch}
                      className={`eq-card ${suitClass(suit)} ${sel ? 'sel' : ''}`}
                      onClick={() => toggle(card)}
                    >
                      {ch}
                      <span className="eq-card-s">{SUIT_SYMBOLS[suit]}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="eq-controls">
            <label>Opponents (random hands)</label>
            <div className="eq-opp">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={opponents === n ? 'active' : ''}
                  onClick={() => setOpponents(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <button className="eq-clear" onClick={() => { setHero([]); setBoard([]); setZone('hand'); }}>
              Clear
            </button>
          </div>

          <div className="eq-result">
            {!ready ? (
              <div className="eq-wait">Pick your 2 hole cards to see equity.</div>
            ) : (
              <>
                <div className="stat-lbl">Your equity vs {opponents} random hand{opponents > 1 ? 's' : ''}</div>
                <div className="big-stat gold">{pct(result!.equity)}</div>
                <div className="eq-split">
                  <span className="good">Win {pct(result!.win)}</span>
                  <span className="okv">Tie {pct(result!.tie)}</span>
                  <span className="bad">Lose {pct(1 - result!.win - result!.tie)}</span>
                </div>
                <div className="eq-note">
                  {result!.trials.toLocaleString()} simulated run-outs · equity = win% + ½·tie%
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Slot({ card }: { card?: Card }) {
  if (!card) return <span className="eq-slot empty" />;
  return (
    <span className={`eq-slot ${suitClass(card.suit)}`}>
      {RANK_CHARS[card.rank - 2]}
      <span className="eq-card-s">{SUIT_SYMBOLS[card.suit]}</span>
    </span>
  );
}
