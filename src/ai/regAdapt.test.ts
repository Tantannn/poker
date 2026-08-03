// The 'reg' archetype carries its OWN adaptation (profile.adapt) so it counter-adjusts to the
// hero even on Normal difficulty, where the difficulty slider's adapt is 0. A static archetype
// (tag) does not. This is what makes the reg the sparring partner for the leveling war.

import { describe, it, expect } from 'vitest';
import { createGame, startHand, type ActionRecord, type GameState } from '../engine/table';
import { decideAction } from './decide';
import { DIFFICULTIES, emptyReads, type HeroReads } from './difficulty';

const KJs = [{ rank: 13, suit: 0 }, { rank: 11, suit: 0 }]; // a 3-bet-BLUFF hand
const openRec = (playerId: number, amount: number): ActionRecord => ({
  handNumber: 1, playerId, playerName: 'h', position: 'CO', type: 'raise', amount, street: 'preflop', potAfter: amount + 3,
});

/** Bot (seat 1, profile `bot`) faces the hero's single open holding a bluff-3bet hand. */
function threeBetNode(bot: string, seed: number): GameState {
  let s = createGame(6, 100, 2, [bot, 'tag', 'tag', 'tag', 'tag']);
  s = startHand(s);
  s.handNumber = 1;
  s.seed = seed;
  s.street = 'preflop';
  s.toAct = 1;
  s.currentBet = 6;
  s.lastRaiseSize = 4;
  s.lastAggressor = 0;
  s.log = [openRec(0, 6)];
  Object.assign(s.players[1], { holeCards: KJs, stack: 200, committed: 0, totalCommitted: 0, folded: false, allIn: false, hasActed: false });
  Object.assign(s.players[0], { committed: 6, totalCommitted: 6, folded: false, allIn: false });
  return s;
}

const overFold3Bet: HeroReads = { ...emptyReads(), faced3Bet: 20, foldTo3Bet: 18 }; // hero over-folds to 3-bets

// difficulty NORMAL → diff.adapt = 0, so ANY adaptation must come from profile.adapt.
function raises(bot: string, reads: HeroReads, n = 220): number {
  let count = 0;
  for (let seed = 1; seed <= n; seed++) {
    if (decideAction(threeBetNode(bot, seed), { diff: DIFFICULTIES.normal, reads }).type === 'raise') count++;
  }
  return count;
}

describe('reg archetype counter-adjusts even on Normal difficulty', () => {
  it('a REG 3-bet-bluffs MORE vs an over-folding hero — its own adapt fires with the slider at 0', () => {
    const base = raises('reg', emptyReads());
    const boosted = raises('reg', overFold3Bet);
    expect(base).toBeGreaterThan(0);
    expect(boosted).toBeGreaterThan(base);
  });

  it('a static TAG does NOT adjust on Normal — the read leaves its frequency unchanged', () => {
    expect(raises('tag', overFold3Bet)).toBe(raises('tag', emptyReads()));
  });
});
