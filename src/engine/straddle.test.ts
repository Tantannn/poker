// Straddle mechanics. The three things that must be right, because everything downstream
// (bot sizing, push/fold, chart depth notes) reads them: the money is in the pot, the
// straddler acts LAST preflop, and the live bet everyone measures against is the straddle.

import { describe, it, expect } from 'vitest';
import {
  createGame,
  startHand,
  applyAction,
  legalActions,
  effectiveBigBlind,
  potTotal,
  type GameState,
  type StraddleMode,
} from './table';

const BB = 2;

function dealt(mode: StraddleMode, seats = 6, tournament = false): GameState {
  let s = createGame(seats, 100, BB, ['tag', 'tag', 'tag', 'tag', 'tag'], tournament);
  s.straddle = mode;
  s = startHand(s);
  return s;
}

/** Seat order from the button: 0 = button, 1 = SB, 2 = BB, 3 = UTG … */
const seatAt = (s: GameState, off: number) => (s.buttonIndex + off) % s.players.length;

describe('posting the straddle', () => {
  it('off: nothing posted, the live bet is the big blind', () => {
    const s = dealt('off');
    expect(s.straddleTo ?? 0).toBe(0);
    expect(s.currentBet).toBe(BB);
    expect(effectiveBigBlind(s)).toBe(BB);
    expect(potTotal(s)).toBe(BB + BB / 2);
  });

  it('utg: UTG posts 2× the blind and the live bet doubles', () => {
    const s = dealt('utg');
    const utg = s.players[seatAt(s, 3)];
    expect(utg.committed).toBe(2 * BB);
    expect(s.currentBet).toBe(2 * BB);
    expect(s.straddleTo).toBe(2 * BB);
    expect(effectiveBigBlind(s)).toBe(2 * BB);
    expect(potTotal(s)).toBe(BB / 2 + BB + 2 * BB);
  });

  it('utg: a min-raise is to twice the STRADDLE, not twice the blind', () => {
    const s = dealt('utg');
    expect(legalActions(s).minRaiseTo).toBe(4 * BB);
  });

  it('double: UTG posts 2× and the next seat re-straddles to 4×', () => {
    const s = dealt('double');
    expect(s.players[seatAt(s, 3)].committed).toBe(2 * BB);
    expect(s.players[seatAt(s, 4)].committed).toBe(4 * BB);
    expect(effectiveBigBlind(s)).toBe(4 * BB);
  });

  it('button (Mississippi): the button posts and the small blind is first to act', () => {
    const s = dealt('button');
    expect(s.players[s.buttonIndex].committed).toBe(2 * BB);
    expect(s.toAct).toBe(seatAt(s, 1)); // SB, not UTG
    expect(effectiveBigBlind(s)).toBe(2 * BB);
  });

  it('a tournament never straddles', () => {
    const s = dealt('utg', 6, true);
    expect(s.straddleTo ?? 0).toBe(0);
    expect(s.currentBet).toBe(s.bigBlind);
  });

  it('heads-up never straddles — there is no seat that could act last', () => {
    const s = dealt('utg', 2);
    expect(s.straddleTo ?? 0).toBe(0);
  });
});

describe('action order', () => {
  it('utg: action starts LEFT of the straddler, who keeps the option', () => {
    const s = dealt('utg');
    expect(s.toAct).toBe(seatAt(s, 4)); // UTG+1, not UTG
    expect(s.players[seatAt(s, 3)].hasActed).toBe(false); // straddler still to act
  });

  it('utg: the straddler acts LAST — everyone folding to him ends the hand in his favour', () => {
    let s = dealt('utg');
    const straddler = seatAt(s, 3);
    // fold everyone except the straddler; the blinds fold too, so he wins uncontested.
    for (let guard = 0; guard < 10 && s.street === 'preflop'; guard++) {
      if (s.toAct === straddler) break;
      s = applyAction(s, { type: 'fold' });
    }
    expect(s.street).toBe('complete');
    expect(s.winners[0].playerId).toBe(s.players[straddler].id);
  });

  it('utg: the straddler can still raise his own straddle (the option)', () => {
    let s = dealt('utg');
    const straddler = seatAt(s, 3);
    while (s.toAct !== straddler && s.street === 'preflop') s = applyAction(s, { type: 'call' });
    expect(s.toAct).toBe(straddler);
    const la = legalActions(s);
    expect(la.canCheck).toBe(true); // his blind already matches the bet
    expect(la.canRaise).toBe(true);
  });

  it('a called straddle reaches the flop with everyone matched', () => {
    let s = dealt('utg');
    for (let guard = 0; guard < 12 && s.street === 'preflop'; guard++) {
      const la = legalActions(s);
      s = applyAction(s, la.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(s.street).toBe('flop');
    expect(s.board.length).toBe(3);
    for (const p of s.players) expect(p.totalCommitted).toBe(2 * BB);
  });
});

describe('depth', () => {
  it('a 100bb table is 50 bets deep with a straddle live', () => {
    const s = dealt('utg');
    const hero = s.players[0];
    const depth = (hero.stack + hero.committed) / effectiveBigBlind(s);
    expect(depth).toBeCloseTo(50, 0);
  });
});
