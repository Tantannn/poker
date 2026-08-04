import { describe, it, expect } from 'vitest';
import { createGame, startHand } from '../engine/table';
import type { GameState } from '../engine/table';
import type { Card } from '../engine/cards';
import { decideAction } from './decide';
import { DIFFICULTIES } from './difficulty';

// Bots reached an all-in only through the commitment guard, which upgrades a bet ALREADY worth
// stacking off. So at any real depth a bot shove was the nuts by construction and the hero could
// fold to it forever. The jam is now a chosen size with the same value-only / balanced split as
// the overbet: every tier shoves its nut end, only adaptive tiers balance the bluff side.
//
// Geometry matters in these tests. `jamSpot` needs the stack between 1.5× and 3× the pot —
// below that the overbet slot already lands on the stack, above it the price (stack/(stack+pot)
// folds needed) stops being one a real player offers.

const card = (rank: number, suit: number): Card => ({ rank, suit });

const BOT = 1;
const POT = 60; // 30 committed each

/** Heads-up postflop node, bot first to act, no bet in front, `stack` chips behind. */
function node(board: Card[], hole: Card[], seed: number, stack: number, profile = 'gto'): GameState {
  let state = createGame(2, 300, 2, [profile, profile], false);
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
    Object.assign(p, { stack, committed: 0, totalCommitted: POT / 2, folded: false, allIn: false, hasActed: false });
  }
  state.players[BOT].holeCards = hole;
  return state;
}

/** Share of sampled decisions that were a clean all-in bet. */
function jamRate(
  board: Card[],
  hole: Card[],
  stack: number,
  diff = DIFFICULTIES.extreme,
  samples = 300,
  profile = 'gto',
): number {
  let jams = 0;
  let bets = 0;
  for (let seed = 1; seed <= samples; seed++) {
    const state = node(board, hole, seed, stack, profile);
    const a = decideAction(state, { diff });
    if (a.type !== 'bet' || !a.amount) continue;
    bets++;
    if (a.amount >= state.players[BOT].stack) jams++;
  }
  return bets === 0 ? 0 : jams / bets;
}

// stack = 2× pot: inside the jam window, and deep enough that a normal bet would not commit
const JAM_STACK = POT * 2;

const QUADS_RIVER = [card(7, 0), card(7, 1), card(2, 2), card(3, 3), card(8, 0)];
const QUADS = [card(7, 2), card(7, 3)];
const AIR_RIVER = [card(13, 0), card(9, 1), card(4, 2), card(2, 3), card(8, 0)];
const AIR = [card(5, 2), card(3, 1)];

describe('bot postflop jam', () => {
  it('shoves the nut end on the river', () => {
    expect(jamRate(QUADS_RIVER, QUADS, JAM_STACK)).toBeGreaterThan(0);
  });

  it('balances the bluff side with the same all-in on an adaptive tier', () => {
    expect(jamRate(AIR_RIVER, AIR, JAM_STACK)).toBeGreaterThan(0);
  });

  it('leaves the tell in on a non-adaptive tier — value jams, air does not', () => {
    expect(jamRate(AIR_RIVER, AIR, JAM_STACK, DIFFICULTIES.normal)).toBe(0);
    expect(jamRate(QUADS_RIVER, QUADS, JAM_STACK, DIFFICULTIES.normal)).toBeGreaterThan(0);
  });

  it('a reg balances it on any tier — his own adapt carries the bluff side', () => {
    // effAdapt = max(diff.adapt, profile.adapt), so the archetype that exists to counter-adjust
    // does not need the difficulty slider raised to stop being readable.
    expect(jamRate(AIR_RIVER, AIR, JAM_STACK, DIFFICULTIES.normal, 300, 'reg')).toBeGreaterThan(0);
  });

  it('never jams past 3× pot — the price stops being one a real player offers', () => {
    expect(jamRate(AIR_RIVER, AIR, POT * 6)).toBe(0);
    expect(jamRate(QUADS_RIVER, QUADS, POT * 6)).toBe(0);
  });

  it('never jams the flop', { timeout: 30_000 }, () => {
    const flop = [card(7, 0), card(7, 1), card(2, 2)];
    expect(jamRate(flop, QUADS, JAM_STACK, DIFFICULTIES.extreme, 60)).toBe(0);
    expect(jamRate(flop, AIR, JAM_STACK, DIFFICULTIES.extreme, 60)).toBe(0);
  });

  it('a bluff jam is rarer than a value jam at the same node', () => {
    // Same size on both sides is what kills the tell; the FREQUENCIES still have to be
    // value-weighted or shoving becomes a losing size rather than a balanced one.
    expect(jamRate(AIR_RIVER, AIR, JAM_STACK)).toBeLessThan(jamRate(QUADS_RIVER, QUADS, JAM_STACK));
  });
});
