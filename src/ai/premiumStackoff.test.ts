import { describe, it, expect } from 'vitest';
import { createGame, startHand, legalActions } from '../engine/table';
import type { ActionRecord } from '../engine/table';
import { decideAction } from './decide';
import { DIFFICULTIES } from './difficulty';

// Regression: a premium (AA/KK/AKs) must NEVER fold preflop. The 5-bet node
// (facing a 4-bet, raiseCount >= 3) used to jam ONLY when `canRaise` was true, so
// when the hero already SHOVED and covered the bot (canRaise === false) the aces
// fell through to the fold return — e.g. a maniac 3-bets, hero 4-bet-jams KK, and
// the maniac's AA folded. Now premiums stack off: jam if they can, else call.
describe('premium never folds preflop to a 5-bet shove', () => {
  const AA = [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }];
  const rec = (playerId: number, amount: number): ActionRecord => ({
    handNumber: 1,
    playerId,
    playerName: 'x',
    position: 'BTN',
    type: 'raise',
    amount,
    street: 'preflop',
    potAfter: amount,
  });

  // Build a preflop node: 3 raises already in (open, 3-bet, 4-bet), bot with AA to
  // act facing the last raise. `covers` = the shove amount vs the bot's stack.
  const fiveBetNode = (opts: { botStack: number; currentBet: number }) => {
    let state = createGame(2, 400, 2, ['tag', 'lag'], true);
    state = startHand(state);
    state.handNumber = 1;
    const hero = 0;
    const bot = 1;
    state.street = 'preflop';
    state.toAct = bot;
    state.currentBet = opts.currentBet;
    state.lastRaiseSize = 100;
    state.lastAggressor = hero;
    state.log = [rec(hero, 6), rec(bot, 18), rec(hero, opts.currentBet)];
    Object.assign(state.players[bot], {
      holeCards: AA,
      stack: opts.botStack,
      committed: 6,
      totalCommitted: 6,
      folded: false,
      allIn: false,
      hasActed: false,
    });
    Object.assign(state.players[hero], {
      stack: 0,
      committed: opts.currentBet,
      totalCommitted: opts.currentBet,
      folded: false,
      allIn: true,
    });
    return state;
  };

  it('calls off when the hero covers the bot (canRaise === false)', () => {
    // hero shoved to 400, bot only has 200 behind → cannot raise, must call or fold
    const state = fiveBetNode({ botStack: 200, currentBet: 400 });
    expect(legalActions(state).canRaise).toBe(false);
    const action = decideAction(state, { diff: DIFFICULTIES.extreme });
    expect(action.type).toBe('call');
  });

  it('jams when the bot still has chips behind the shove (canRaise === true)', () => {
    // hero shoved to 200, bot has 400 → can (re-)jam over the top
    const state = fiveBetNode({ botStack: 400, currentBet: 200 });
    expect(legalActions(state).canRaise).toBe(true);
    const action = decideAction(state, { diff: DIFFICULTIES.extreme });
    expect(action.type).toBe('raise');
  });
});
