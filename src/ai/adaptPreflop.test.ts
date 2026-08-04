// Bots used to play the static preflop charts no matter how the hero played — the
// postflop adapt block never reached the preflop returns. These pin the new preflop
// exploits: a hero who over-folds to 3-bets gets 3-bet-bluffed wider, and a hero who
// over-folds his blinds gets stolen from wider. Same confidence-ramp idiom as the
// postflop reads, so both only fire once a real sample exists.

import { describe, it, expect } from 'vitest';
import { createGame, startHand, type ActionRecord, type GameState } from '../engine/table';
import { decideAction } from './decide';
import { DIFFICULTIES, emptyReads, type HeroReads } from './difficulty';

const KJs = [{ rank: 13, suit: 0 }, { rank: 11, suit: 0 }]; // a 3-bet-BLUFF hand
const J7o = [{ rank: 11, suit: 0 }, { rank: 7, suit: 1 }]; // off-chart junk: base open freq 0

const openRec = (playerId: number, amount: number): ActionRecord => ({
  handNumber: 1, playerId, playerName: 'h', position: 'CO', type: 'raise', amount, street: 'preflop', potAfter: amount + 3,
});

/** Bot (seat 1) faces the hero's single open (raiseCount 1) holding a bluff-3bet hand. */
function threeBetNode(seed: number): GameState {
  let s = createGame(6, 100, 2, ['tag', 'tag', 'tag', 'tag', 'tag']);
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

/** Bot on the BUTTON (seat 1), folded to it, hero (seat 0) waiting in the BB. */
function stealNode(seed: number): GameState {
  let s = createGame(3, 100, 2, ['tag', 'tag']);
  s = startHand(s);
  s.handNumber = 1;
  s.seed = seed;
  s.street = 'preflop';
  s.buttonIndex = 1; // seat 1 = BTN, seat 0 = BB, seat 2 = SB
  s.toAct = 1;
  s.currentBet = 2;
  s.lastRaiseSize = 2;
  s.lastAggressor = -1;
  s.log = [];
  Object.assign(s.players[1], { holeCards: J7o, stack: 200, committed: 0, totalCommitted: 0, folded: false, allIn: false, hasActed: false });
  Object.assign(s.players[0], { committed: 2, totalCommitted: 2, folded: false }); // BB posted, still live
  return s;
}

const overFold3Bet: HeroReads = { ...emptyReads(), faced3Bet: 20, foldTo3Bet: 18 }; // 90% fold
const overFoldBlinds: HeroReads = { ...emptyReads(), blindDefends: 20, blindFolds: 18 };

function countRaises(build: (seed: number) => GameState, reads: HeroReads, n = 300): number {
  let raises = 0;
  for (let seed = 1; seed <= n; seed++) {
    const a = decideAction(build(seed), { diff: DIFFICULTIES.extreme, reads });
    if (a.type === 'raise') raises++;
  }
  return raises;
}

describe('preflop read-driven bots', () => {
  it('3-bet-bluffs a bluff hand MORE vs a hero who over-folds to 3-bets', () => {
    const base = countRaises(threeBetNode, emptyReads());
    const boosted = countRaises(threeBetNode, overFold3Bet);
    expect(base).toBeGreaterThan(0); // not a vacuous comparison — the bot 3-bets KJs sometimes anyway
    expect(boosted).toBeGreaterThan(base);
  });

  it('does NOT widen when the read sample is too small to trust', () => {
    const thin: HeroReads = { ...emptyReads(), faced3Bet: 3, foldTo3Bet: 3 }; // 100% fold but only 3 samples
    const base = countRaises(threeBetNode, emptyReads());
    const withThin = countRaises(threeBetNode, thin);
    expect(withThin).toBe(base); // below the faced3Bet >= 5 gate, no tilt
  });

  it('steals junk from the button vs a hero who over-folds his blinds', () => {
    const base = countRaises(stealNode, emptyReads());
    const boosted = countRaises(stealNode, overFoldBlinds);
    expect(base).toBe(0); // J7o is off-chart — a static bot never opens it
    expect(boosted).toBeGreaterThan(10);
  });
});
