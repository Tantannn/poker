// Postflop Lab: isolate a flop spot by board texture and villain range, then
// drill the solver-model — full frequencies, per-action EV, RNG, EV loss.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop } from '../engine/board';
import type { TextureFilter } from '../engine/board';
import { TEXTURE_LABELS } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import type { WeightedRange } from '../engine/range';
import { RFI_RANGES, BB_DEFEND_RANGE, THREEBET_RANGE } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { evLoss, rngPrescription } from '../strategy/types';
import type { ActionId } from '../strategy/types';
import { PlayingCard } from './PlayingCard';

const BB = 2;
const STACK = 200;
const POT = 12; // ~6bb single-raised pot

const VILLAINS: { id: string; label: string; range: WeightedRange }[] = [
  { id: 'utg', label: 'UTG open (~14%, tight)', range: rangeFromSet(RFI_RANGES.UTG) },
  { id: 'co', label: 'CO open (~27%)', range: rangeFromSet(RFI_RANGES.CO) },
  { id: 'btn', label: 'BTN open (~45%, wide)', range: rangeFromSet(RFI_RANGES.BTN) },
  { id: 'bbdef', label: 'BB defend (very wide)', range: rangeFromSet(BB_DEFEND_RANGE) },
  { id: '3bet', label: '3-bet range (very tight)', range: rangeFromSet(THREEBET_RANGE) },
];

interface Spot {
  hero: Card[];
  board: Card[];
  roll: number;
}

function dealSpot(texture: TextureFilter): Spot {
  // random hero hand
  const a: Card = { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
  let b: Card;
  do {
    b = { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
  } while (b.rank === a.rank && b.suit === a.suit);
  const hero = [a, b];
  const board = randomFlop(texture, hero);
  return { hero, board, roll: Math.floor(Math.random() * 100) + 1 };
}

const KIND_COLOR: Record<string, string> = {
  value: '#2ec27e',
  bluff: '#e0843a',
  passive: '#3aa0e0',
  fold: '#2a3a31',
  aggressive: '#2ec27e',
};

export function PostflopLab() {
  const [villainId, setVillainId] = useState('btn');
  const [texture, setTexture] = useState<TextureFilter>('any');
  const [spot, setSpot] = useState<Spot>(() => dealSpot('any'));
  const [chosen, setChosen] = useState<ActionId | null>(null);

  const villain = VILLAINS.find((v) => v.id === villainId) ?? VILLAINS[0];

  const strategy = useMemo(
    () =>
      solvePostflop({
        hero: spot.hero,
        board: spot.board,
        oppRange: villain.range,
        pot: POT,
        toCall: 0,
        heroCommitted: 0,
        currentBet: 0,
        minRaiseTo: BB,
        maxRaiseTo: STACK,
        canCheck: true,
        canRaise: true,
        bigBlind: BB,
        iterations: 2500,
        rangeNote: villain.label,
      }),
    [spot, villain],
  );

  const prescribed = rngPrescription(strategy, spot.roll);

  const newSpot = useCallback(
    (tx?: TextureFilter) => {
      setSpot(dealSpot(tx ?? texture));
      setChosen(null);
    },
    [texture],
  );

  const loss = chosen ? evLoss(strategy, chosen) : 0;
  const chosenLabel = chosen ? strategy.options.find((o) => o.id === chosen)?.label : '';
  const bestLabel = strategy.options.find((o) => o.id === strategy.bestId)?.label;

  return (
    <div className="card">
      <h2>Postflop Lab</h2>
      <p className="sub">
        Isolate a flop by texture and villain range, then act. The model shows the full mixed strategy
        (frequency + EV), an RNG roll, and your EV loss. You're first to act in a {POT / BB}bb pot,
        100bb deep.
      </p>

      <div className="lab-controls">
        <div className="lab-field">
          <label className="inline-label">Villain range</label>
          <select value={villainId} onChange={(e) => { setVillainId(e.target.value); setChosen(null); }}>
            {VILLAINS.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </div>
        <div className="lab-field">
          <label className="inline-label">Board texture</label>
          <select
            value={texture}
            onChange={(e) => {
              const tx = e.target.value as TextureFilter;
              setTexture(tx);
              newSpot(tx);
            }}
          >
            {(Object.keys(TEXTURE_LABELS) as TextureFilter[]).map((t) => (
              <option key={t} value={t}>{TEXTURE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-deal lab-deal" onClick={() => newSpot()}>New spot</button>
      </div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand</span>
          <div className="lab-cards">
            {spot.hero.map((c, i) => <PlayingCard key={i} card={c} size="md" />)}
          </div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">Flop</span>
          <div className="lab-cards">
            {spot.board.map((c, i) => <PlayingCard key={i} card={c} size="md" />)}
          </div>
        </div>
        <div className="lab-eq">
          <div className="big-stat gold">{((strategy.equity ?? 0) * 100).toFixed(1)}%</div>
          <div className="stat-lbl">equity vs range</div>
        </div>
      </div>

      <div className="lab-rng">
        🎲 RNG <b>{spot.roll}</b> → prescribed{' '}
        <b>{strategy.options.find((o) => o.id === prescribed)?.label ?? prescribed}</b>
      </div>

      <div className="lab-actions">
        {strategy.options.map((o) => (
          <button
            key={o.id}
            className={`lab-act ${chosen === o.id ? 'chosen' : ''} ${o.id === strategy.bestId ? 'is-best' : ''}`}
            onClick={() => setChosen(o.id)}
          >
            <span className="la-label">{o.label}</span>
            <span className="la-freq" style={{ color: KIND_COLOR[o.kind ?? 'fold'] }}>
              {(o.freq * 100).toFixed(0)}%
            </span>
            <span className={`la-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>
              {o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb
            </span>
            <span className="la-bar" style={{ width: `${o.freq * 100}%`, background: KIND_COLOR[o.kind ?? 'fold'] }} />
          </button>
        ))}
      </div>

      {chosen && (
        <div className={`lab-feedback ${loss <= 0.04 ? 'good' : loss <= 0.4 ? 'okv' : 'bad'}`}>
          {loss <= 0.04
            ? `✓ ${chosenLabel} is on the solver line.`
            : `You picked ${chosenLabel}. Best was ${bestLabel} — EV loss −${loss.toFixed(2)} bb.`}
          {chosen === prescribed
            ? ' 🎲 You also matched the RNG branch.'
            : ` 🎲 RNG said ${strategy.options.find((o) => o.id === prescribed)?.label}.`}
        </div>
      )}

      <p className="note">{strategy.note}</p>
    </div>
  );
}
