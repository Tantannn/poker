import { describe, it, expect } from 'vitest';
import { createGame, startHand, potTotal } from '../engine/table';
import type { GameState } from '../engine/table';
import type { Card } from '../engine/cards';
import { decideAction } from './decide';
import { DIFFICULTIES } from './difficulty';

// Bots used to cap their sizing at ~1.25× pot in one narrow nut-on-a-wet-board case,
// so the hero never faced a real overbet and the "big-pot bleed" stat could never
// fire. Turn/river polar overbets are now a difficulty knob: every tier overbets the
// nut end, only adaptive tiers (adapt > 0) balance the bluff side at the same size.

const card = (rank: number, suit: number): Card => ({ rank, suit });

const BOT = 1;

/** Heads-up postflop node with the bot first to act, deep, no bet in front. */
function node(board: Card[], hole: Card[], seed: number): GameState {
  let state = createGame(2, 300, 2, ['gto', 'gto'], false);
  state = startHand(state);
  state.seed = seed;
  state.handNumber = 1;
  state.street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';
  state.board = board;
  state.toAct = BOT;
  state.currentBet = 0;
  state.lastRaiseSize = 0;
  state.lastAggressor = -1;
  state.log = [];
  for (const p of state.players) {
    Object.assign(p, { stack: 600, committed: 0, totalCommitted: 30, folded: false, allIn: false, hasActed: false });
  }
  state.players[BOT].holeCards = hole;
  return state;
}

/** Bet sizes as a fraction of the pot, over many seeds (the RNG is seed-derived). */
function betFracs(board: Card[], hole: Card[], diff = DIFFICULTIES.extreme, samples = 300): number[] {
  const out: number[] = [];
  for (let seed = 1; seed <= samples; seed++) {
    const state = node(board, hole, seed);
    const a = decideAction(state, { diff });
    if (a.type === 'bet' && a.amount) out.push(a.amount / potTotal(state));
  }
  return out;
}

// quad sevens — nothing in villain's range is close, so the value branch is certain
const QUADS_RIVER = [card(7, 0), card(7, 1), card(2, 2), card(3, 3), card(8, 0)];
const QUADS = [card(7, 2), card(7, 3)];
// no pair, no draw left on the river — pure air, the bluff side of the same size
const AIR_RIVER = [card(13, 0), card(9, 1), card(4, 2), card(2, 3), card(8, 0)];
const AIR = [card(5, 2), card(3, 1)];

describe('bot polar overbets', () => {
  it('overbets the nuts on the river', () => {
    const fracs = betFracs(QUADS_RIVER, QUADS);
    const over = fracs.filter((f) => f > 1.05);
    expect(over.length).toBeGreaterThan(0);
    expect(Math.max(...over)).toBeLessThan(2);
  });

  it('balances the bluff side at the same size on an adaptive tier', () => {
    const over = betFracs(AIR_RIVER, AIR).filter((f) => f > 1.05);
    expect(over.length).toBeGreaterThan(0);
  });

  it('leaves the tell in on non-adaptive tiers — value overbets, air does not', () => {
    expect(betFracs(AIR_RIVER, AIR, DIFFICULTIES.normal).filter((f) => f > 1.05)).toHaveLength(0);
    expect(betFracs(QUADS_RIVER, QUADS, DIFFICULTIES.normal).filter((f) => f > 1.05).length).toBeGreaterThan(0);
  });

  // two cards to come makes each equity sim far heavier — fewer seeds, longer budget
  it('never overbets the flop', { timeout: 30_000 }, () => {
    const flop = [card(7, 0), card(7, 1), card(2, 2)];
    expect(betFracs(flop, QUADS, DIFFICULTIES.extreme, 60).filter((f) => f > 1.05)).toHaveLength(0);
  });

  it('never overbets without stack behind to make it hurt', () => {
    const shallow: number[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const state = node(QUADS_RIVER, QUADS, seed);
      for (const p of state.players) p.stack = 60; // pot is 60 → SPR 1, no room
      const a = decideAction(state, { diff: DIFFICULTIES.extreme });
      if (a.type === 'bet' && a.amount) shallow.push(a.amount / potTotal(state));
    }
    expect(shallow.filter((f) => f > 1.05)).toHaveLength(0);
  });
});
