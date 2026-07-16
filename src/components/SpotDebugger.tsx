// Custom Spot / Debug — type in your OWN hero + board + situation and see what the
// solver-model says. Unlike the Postflop Lab (which deals random spots to drill),
// nothing is hidden and nothing is graded: pick two hole cards, a 3–5 card board,
// set the villain range / position / pot / to-call / stack, and it runs the SAME
// solvePostflop the trainer uses, printing every action's EV, frequency, the why,
// and the narrative note. A scratchpad for "in THIS exact spot, what should I do?".

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { RANK_CHARS, SUIT_SYMBOLS, sameCard, suitClass } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import type { WeightedRange } from '../engine/range';
import { RFI_RANGES, BB_DEFEND_RANGE, THREEBET_RANGE } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { classifyHandClass } from '../strategy/handClass';
import { describeTexture } from '../engine/board';
import { actionRule, KIND_COLOR } from '../strategy/actionRules';
import type { ActionId } from '../strategy/types';
import { SpotBoard } from './SpotBoard';

const BB = 2;
const RANKS_DESC = [...RANK_CHARS].reverse(); // A K Q ... 2

type Pos = 'ip' | 'oop';

// Same villain ranges as the Postflop Lab, built from the shared preflop ranges.
const VILLAINS: { id: string; label: string; range: WeightedRange }[] = [
  { id: 'utg', label: 'UTG open (~14%, tight)', range: rangeFromSet(RFI_RANGES.UTG) },
  { id: 'mp', label: 'MP open (~18%)', range: rangeFromSet(RFI_RANGES.MP) },
  { id: 'co', label: 'CO open (~25%)', range: rangeFromSet(RFI_RANGES.CO) },
  { id: 'btn', label: 'BTN open (~45%, wide)', range: rangeFromSet(RFI_RANGES.BTN) },
  { id: 'sb', label: 'SB open (~40%)', range: rangeFromSet(RFI_RANGES.SB) },
  { id: 'bbdef', label: 'BB defend (very wide)', range: rangeFromSet(BB_DEFEND_RANGE) },
  { id: '3bet', label: '3-bet range (very tight)', range: rangeFromSet(THREEBET_RANGE) },
];
const villainById = (id: string) => VILLAINS.find((v) => v.id === id) ?? VILLAINS[0];

// Quick pot presets (chips, BB=2) — mirror the Lab's flop-pot / stack-behind by pot type.
const POT_PRESETS: { id: string; label: string; pot: number; behind: number }[] = [
  { id: 'srp', label: 'Single-raised', pot: 12, behind: 188 },
  { id: '3bet', label: '3-bet pot', pot: 36, behind: 164 },
  { id: '4bet', label: '4-bet pot', pot: 90, behind: 110 },
];

const ACTION_ORDER: ActionId[] = ['fold', 'check', 'call', 'bet33', 'bet50', 'bet75', 'betpot', 'allin', 'raise', 'open'];
const orderRank = (id: ActionId) => {
  const i = ACTION_ORDER.indexOf(id);
  return i < 0 ? 99 : i;
};

export function SpotDebugger() {
  const [hero, setHero] = useState<Card[]>([]);
  const [board, setBoard] = useState<Card[]>([]);
  const [zone, setZone] = useState<'hand' | 'board'>('hand');

  const [villainId, setVillainId] = useState('btn');
  const [position, setPosition] = useState<Pos>('ip');
  const [opponents, setOpponents] = useState<1 | 2>(1);
  const [pot, setPot] = useState(12);
  const [toCall, setToCall] = useState(0);
  const [behind, setBehind] = useState(188);

  const selected = [...hero, ...board];
  const isSel = (c: Card) => selected.some((s) => sameCard(s, c));

  function toggle(c: Card) {
    if (hero.some((h) => sameCard(h, c))) return setHero(hero.filter((h) => !sameCard(h, c)));
    if (board.some((b) => sameCard(b, c))) return setBoard(board.filter((b) => !sameCard(b, c)));
    if (zone === 'hand' && hero.length < 2) {
      const next = [...hero, c];
      setHero(next);
      if (next.length === 2) setZone('board');
    } else if (board.length < 5) {
      setBoard([...board, c]);
      if (zone === 'hand') setZone('board');
    }
  }

  const ready = hero.length === 2 && board.length >= 3;

  const strategy = useMemo(() => {
    if (!ready) return null;
    const v = villainById(villainId);
    const currentBet = toCall; // villain's commit this street (hero has put in 0)
    return solvePostflop({
      hero,
      board,
      oppRange: v.range,
      oppRanges: opponents > 1 ? Array.from({ length: opponents }, () => v.range) : undefined,
      pot,
      toCall,
      heroCommitted: 0,
      currentBet,
      minRaiseTo: currentBet + Math.max(BB, toCall),
      maxRaiseTo: behind,
      canCheck: toCall === 0,
      canRaise: behind > toCall,
      bigBlind: BB,
      iterations: 3000,
      rangeNote: v.label,
      position,
      effStack: behind,
    });
  }, [ready, hero, board, villainId, opponents, pot, toCall, behind, position]);

  const ordered = useMemo(
    () => (strategy ? [...strategy.options].sort((a, b) => orderRank(a.id) - orderRank(b.id)) : []),
    [strategy],
  );
  const bestOpt = strategy?.options.find((o) => o.id === strategy.bestId);
  const spr = pot > 0 ? (behind / pot).toFixed(1) : '—';

  const applyPreset = (p: { pot: number; behind: number }) => { setPot(p.pot); setBehind(p.behind); };

  return (
    <div className="card">
      <h2>🧪 Custom Spot — Debug</h2>
      <p className="sub">
        Type in your <b>own</b> hand, board and situation and see exactly what the solver-model says —
        every action's EV, frequency and reasoning. Nothing hidden, nothing graded. This is the same
        engine the Postflop Lab drills you against, run on a spot <i>you</i> choose.
      </p>

      {/* ---- card picker ---- */}
      <div className="eq-slots">
        <button className={`eq-zone ${zone === 'hand' ? 'active' : ''}`} onClick={() => setZone('hand')}>
          <span className="eq-zone-lbl">Your hand</span>
          <span className="eq-zone-cards">{[0, 1].map((i) => <Slot key={i} card={hero[i]} />)}</span>
        </button>
        <button className={`eq-zone ${zone === 'board' ? 'active' : ''}`} onClick={() => setZone('board')}>
          <span className="eq-zone-lbl">Board (3–5 cards)</span>
          <span className="eq-zone-cards">{[0, 1, 2, 3, 4].map((i) => <Slot key={i} card={board[i]} />)}</span>
        </button>
      </div>
      <p className="eq-hint">
        Tap the <b>{zone === 'hand' ? 'Your hand' : 'Board'}</b> box, then tap cards below. Tap a picked
        card to remove it.
      </p>
      <div className="eq-grid">
        {[0, 1, 2, 3].map((suit) => (
          <div className="eq-row" key={suit}>
            {RANKS_DESC.map((ch) => {
              const card: Card = { rank: RANK_CHARS.indexOf(ch) + 2, suit };
              return (
                <button
                  key={ch}
                  className={`eq-card ${suitClass(suit)} ${isSel(card) ? 'sel' : ''}`}
                  onClick={() => toggle(card)}
                >
                  {ch}<span className="eq-card-s">{SUIT_SYMBOLS[suit]}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* ---- situation controls ---- */}
      <div className="lab-controls">
        <div className="lab-field">
          <label className="inline-label">Villain range</label>
          <select value={villainId} onChange={(e) => setVillainId(e.target.value)}>
            {VILLAINS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
        <div className="lab-field">
          <label className="inline-label">Position</label>
          <div className="pos-toggle">
            <button className={position === 'ip' ? 'active' : ''} onClick={() => setPosition('ip')}>In position</button>
            <button className={position === 'oop' ? 'active' : ''} onClick={() => setPosition('oop')}>Out of position</button>
          </div>
        </div>
        <div className="lab-field">
          <label className="inline-label">Players in pot</label>
          <div className="pos-toggle">
            <button className={opponents === 1 ? 'active' : ''} onClick={() => setOpponents(1)}>Heads-up</button>
            <button className={opponents === 2 ? 'active' : ''} onClick={() => setOpponents(2)}>3-way</button>
          </div>
        </div>
        <div className="lab-field">
          <label className="inline-label">Pot preset</label>
          <div className="pos-toggle">
            {POT_PRESETS.map((p) => (
              <button key={p.id} onClick={() => applyPreset(p)}>{p.label}</button>
            ))}
          </div>
        </div>
        <div className="lab-field">
          <label className="inline-label">Pot (chips)</label>
          <input type="number" min={0} value={pot} onChange={(e) => setPot(Math.max(0, +e.target.value))} />
        </div>
        <div className="lab-field">
          <label className="inline-label">To call (0 = you can check)</label>
          <input type="number" min={0} value={toCall} onChange={(e) => setToCall(Math.max(0, +e.target.value))} />
        </div>
        <div className="lab-field">
          <label className="inline-label">Your stack behind</label>
          <input type="number" min={0} value={behind} onChange={(e) => setBehind(Math.max(0, +e.target.value))} />
        </div>
      </div>

      {!ready ? (
        <div className="lab-prompt">Pick your 2 hole cards and at least 3 board cards to solve the spot.</div>
      ) : strategy ? (
        <>
          <div className="lab-meta">
            vs {villainById(villainId).label} · {opponents > 1 ? '3-way' : 'heads-up'} · pot {pot} ({(pot / BB).toFixed(1)}bb)
            {toCall > 0 ? ` · facing ${toCall}` : ' · no bet to face'} · stack {behind} · SPR {spr}
          </div>
          <SpotBoard
            hero={hero}
            board={board}
            handLabel={classifyHandClass(hero, board).label}
            boardTag={<>Board · {describeTexture(board).label}</>}
            equity={strategy.equity ?? 0}
            posNote={position}
          />

          <div className="lab-rng">
            ✅ Solver says: <b>{bestOpt?.label ?? strategy.bestId}</b> (highest EV {strategy.bestEv >= 0 ? '+' : ''}{strategy.bestEv.toFixed(2)} bb)
          </div>

          <div className="lab-actions">
            {ordered.map((o) => (
              <div key={o.id} className={`lab-act ${o.id === strategy.bestId ? 'is-best' : ''}`}>
                <span className="la-label">{o.label}</span>
                <span className="la-freq" style={{ color: KIND_COLOR[o.kind ?? 'fold'] }}>{(o.freq * 100).toFixed(0)}%</span>
                <span className={`la-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>{o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb</span>
                <span className="la-bar" style={{ width: `${o.freq * 100}%`, background: KIND_COLOR[o.kind ?? 'fold'] }} />
              </div>
            ))}
          </div>

          <div className="lab-why">
            <div className="lab-why-row">
              <span className="lab-why-tag best">Best · {bestOpt?.label}</span>
              {bestOpt?.why && <p>{bestOpt.why}</p>}
              {actionRule(strategy.bestId, board) && (
                <div className="bsd-rule"><b>💡 Rule:</b> {actionRule(strategy.bestId, board)}</div>
              )}
              {bestOpt?.sizeNote && <div className="bsd-rule"><b>⚖ Balance:</b> {bestOpt.sizeNote}</div>}
              {bestOpt?.math && <pre className="lab-math">{bestOpt.math}</pre>}
            </div>
          </div>

          <p className="note">{strategy.note}</p>
        </>
      ) : null}
    </div>
  );
}

function Slot({ card }: { card?: Card }) {
  if (!card) return <span className="eq-slot empty" />;
  return (
    <span className={`eq-slot ${suitClass(card.suit)}`}>
      {RANK_CHARS[card.rank - 2]}<span className="eq-card-s">{SUIT_SYMBOLS[card.suit]}</span>
    </span>
  );
}
