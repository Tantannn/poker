// Live "situation read" for the Play tab: on the hero's turn it explains the
// spot in words BEFORE you act — street, position vs the villain, board texture,
// and your hand class — using the same helpers the post-action feedback uses.

import { useState } from 'react';
import type { Card } from '../engine/cards';
import type { VillainInfo } from '../hooks/useGame';
import { describeTexture, boardWetness } from '../engine/board';
import { classifyHandClass } from '../strategy/handClass';
import { SizingCheatSheet } from './SizingCheatSheet';

const BOARD_TYPE: Record<'dry' | 'semi' | 'wet', string> = { dry: 'Dry', semi: 'Semi-wet', wet: 'Wet' };

interface Props {
  board: Card[];
  heroCards: Card[];
  street: string;
  active: boolean;
  villain: VillainInfo | null;
  /** live opponents still in the hand (excludes hero). */
  opponents?: number;
  /** effective-stack-to-pot ratio (0 = unknown). */
  spr?: number;
}

// Map the current spot to the usual play, straight from the cheat sheet rules:
// commitment (SPR) first, then hand strength × board wetness × field size.
function usualPlay(
  street: string,
  wet: 'dry' | 'semi' | 'wet',
  strength: number,
  spr: number,
  opponents: number,
  ip: boolean,
): { action: string; why: string } {
  const size = wet === 'wet' ? '66–75%' : wet === 'semi' ? '~50%' : '25–33%';
  const mw = opponents >= 2;

  // 1) committed — stacks go in regardless of size
  if (spr > 0 && spr < 1) {
    if (strength >= 4) return { action: 'Get it in — jam or bet ≥ 75%.', why: `SPR ${spr.toFixed(1)} < 1: committed with a strong hand, stacks go in anyway.` };
    if (strength <= 1) return { action: 'Check / fold — no token bets.', why: `SPR ${spr.toFixed(1)} < 1 but the hand is weak; committing burns chips.` };
    return { action: 'Small bet or check.', why: `SPR ${spr.toFixed(1)} < 1 with a medium hand — keep the pot manageable.` };
  }

  // 2) river — no protection, no draws
  if (street === 'river') {
    if (strength >= 4) return { action: `Bet thin value (${size}).`, why: 'River: worse hands still call; nothing to protect from.' };
    return { action: 'Check / bluff-catch.', why: 'River: ask “how often is he bluffing?”, not “am I ahead?”' };
  }

  // 3) flop / turn — strength × texture
  if (strength >= 4) return { action: `Bet for value${mw ? ' (size up)' : ''} — ${size}.`, why: mw ? `${opponents + 1}-way: size up, need more equity to value-bet, protect vs the field.` : ip ? 'In position — you may also check back to trap.' : 'Out of position — bet now, you realize less equity.' };
  if (strength === 3) return { action: wet === 'wet' ? `Semi-bluff big (${size}) or check-call.` : `Bet ${size} or check for a free card.`, why: 'A draw / decent hand — pressure on wet boards, realize cheaply on dry.' };
  if (strength === 2) return { action: 'Check — pot control / bluff-catch.', why: 'Medium made hand; keep the pot small.' };
  return { action: 'Check or give up.', why: 'Weak / air — bluff only with blockers + a plan.' };
}

export function SituationPanel({ board, heroCards, street, active, villain, opponents = 1, spr = 0 }: Props) {
  const [showCheat, setShowCheat] = useState(false);
  const [showPlay, setShowPlay] = useState(false);
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
  const boardType = preflop ? '' : BOARD_TYPE[boardWetness(board)];
  const hand = classifyHandClass(heroCards, board);
  const ip = villain?.heroInPosition;
  const play = preflop ? null : usualPlay(street, boardWetness(board), hand.strength, spr, opponents, !!ip);

  return (
    <div className="sit-panel">
      <div className="hud-head">
        <span>🧭 Situation</span>
        <div className="sit-head-btns">
          {play && (
            <button
              type="button"
              className={`toggle ${showPlay ? 'on' : ''}`}
              onClick={() => setShowPlay((v) => !v)}
              title="What to usually do in this exact spot"
            >
              💡 Play
            </button>
          )}
          <button
            type="button"
            className={`toggle ${showCheat ? 'on' : ''}`}
            onClick={() => setShowCheat((v) => !v)}
            title="Postflop sizing cheat sheet — what to do in each spot"
          >
            📐 Cheat sheet
          </button>
        </div>
      </div>

      {showPlay && play && (
        <div className="sit-block sit-play">
          <div className="sit-h">💡 Usual play</div>
          <p className="sit-play-action">{play.action}</p>
          <p className="sit-muted">{play.why}</p>
        </div>
      )}

      {showCheat && <div className="sit-cheat"><SizingCheatSheet /></div>}

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
          <div className="sit-h">
            Board: {tex.label}
            {boardType && <span className={`board-type ${boardType.toLowerCase().replace('-', '')}`}>{boardType}</span>}
          </div>
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
