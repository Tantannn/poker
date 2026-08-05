// A node answered by the per-hand model must SAY so. The two engines can prefer
// different lines at the same node, so an undisclosed engine switch reads as the app
// contradicting itself when a spot is replayed after a read lands.

import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from './index';
import { resolveVillainModel } from './villainModel';
import { parseCard } from '../engine/cards';
import type { GameState } from '../engine/table';

const cards = (s: string) => s.split(' ').map(parseCard);

function threeWayState(heroCards: string, boardStr: string, street: string, currentBet = 0): GameState {
  return {
    handNumber: 1,
    buttonIndex: 0,
    board: cards(boardStr),
    street,
    currentBet,
    lastRaiseSize: 2,
    toAct: 0,
    lastAggressor: currentBet > 0 ? 1 : -1,
    bigBlind: 2,
    seed: 999,
    log: [],
    players: [
      { id: 0, name: 'You', isHero: true, profileId: 'gto', holeCards: cards(heroCards), stack: 300, committed: 0, totalCommitted: 20, folded: false, allIn: false },
      { id: 1, name: 'V1', isHero: false, profileId: 'gto', holeCards: [], stack: 300, committed: currentBet, totalCommitted: 20 + currentBet, folded: false, allIn: false },
      { id: 2, name: 'V2', isHero: false, profileId: 'gto', holeCards: [], stack: 300, committed: 0, totalCommitted: 20, folded: false, allIn: false },
    ],
  } as unknown as GameState;
}

const READ = { enabled: true, foldToBet: 0.85 };

describe('engineNote: which engine answered, and why not the other one', () => {
  it('a CFR node carries no fallback note (its solve is disclosed in `note`)', () => {
    const strat = getNodeStrategy(threeWayState('Ks Kc', 'Ah 7d 2c 9h', 'turn'), 0);
    expect(strat.engine).toBe('cfr');
    expect(strat.engineNote).toBeUndefined();
  });

  it('a read on the SOLVED villain drops the node to the per-hand model and says so', () => {
    const models = { 1: resolveVillainModel(undefined, null, READ) };
    const strat = getNodeStrategy(threeWayState('Ks Kc', 'Ah 7d 2c 9h', 'turn'), 0, undefined, undefined, models);
    expect(strat.engine).toBe('heuristic');
    expect(strat.engineNote).toMatch(/read\/lock/);
    expect(strat.engineNote).toMatch(/no read is solved by CFR/);
  });

  it('facing a bet multiway names the heads-up-only gate, read or no read', () => {
    const bet = threeWayState('Ks Kc', 'Ah 7d 2c 9h', 'turn', 8);
    for (const models of [undefined, { 1: resolveVillainModel(undefined, null, READ) }]) {
      const strat = getNodeStrategy(bet, 0, undefined, undefined, models);
      expect(strat.engine).toBe('heuristic');
      expect(strat.engineNote).toMatch(/heads-up only/);
    }
  });
});
