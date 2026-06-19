// Live "situation read" for the Play tab: on the hero's turn it explains the
// spot in words BEFORE you act — street, position vs the villain, board texture,
// and your hand class — using the same helpers the post-action feedback uses.

import type { Card } from '../engine/cards';
import type { VillainInfo } from '../hooks/useGame';
import { describeTexture } from '../engine/board';
import { classifyHandClass } from '../strategy/handClass';

interface Props {
  board: Card[];
  heroCards: Card[];
  street: string;
  active: boolean;
  villain: VillainInfo | null;
}

export function SituationPanel({ board, heroCards, street, active, villain }: Props) {
  if (!active) {
    return (
      <div className="sit-panel">
        <div className="hud-head"><span>🧭 Situation</span></div>
        <div className="hud-hidden">Reads the spot in plain English on your turn.</div>
      </div>
    );
  }
  const preflop = board.length < 3;
  const tex = describeTexture(board);
  const hand = classifyHandClass(heroCards, board);
  const ip = villain?.heroInPosition;

  return (
    <div className="sit-panel">
      <div className="hud-head"><span>🧭 Situation</span></div>

      <div className="sit-line">
        <span className="sit-k">Street</span>
        <span className="sit-v">{street.toUpperCase()}</span>
      </div>
      {villain && (
        <div className="sit-line">
          <span className="sit-k">Position</span>
          <span className={`sit-v ${ip ? 'good' : 'bad'}`}>
            {ip ? 'In position (act after villain)' : 'Out of position (act first)'}
          </span>
        </div>
      )}

      {!preflop && (
        <div className="sit-block">
          <div className="sit-h">Board: {tex.label}</div>
          <p>{tex.sentence}</p>
          {tex.favours && <p className="sit-muted">{tex.favours}</p>}
        </div>
      )}

      <div className="sit-block">
        <div className="sit-h">Your hand: {hand.label}</div>
        <p>{hand.blurb}</p>
      </div>
    </div>
  );
}
