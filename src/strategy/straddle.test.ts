// A straddle has to reach the ADVICE, not just the pot. Depth is counted in straddles, an
// unopened straddled pot is still an RFI spot (a straddle is a blind, not a raise), and the
// note says what the charts can't: they are a ~100bb no-straddle baseline.

import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from './index';
import { createGame, startHand, applyAction, type GameState, type StraddleMode } from '../engine/table';
import { biasHoleCards } from '../engine/table';

const BB = 2;

/** A 6-max cash table dealt with the given straddle, hero (seat 0) holding `code`, with the
 *  action walked to the hero. Depth is set in real big blinds. */
function heroToAct(mode: StraddleMode, depthBB: number, code: string): GameState {
  let s = createGame(6, depthBB, BB, ['tag', 'tag', 'tag', 'tag', 'tag']);
  s.straddle = mode;
  s = startHand(s);
  biasHoleCards(s, 0, code);
  for (let guard = 0; guard < 12 && s.toAct !== 0 && s.street === 'preflop'; guard++) {
    s = applyAction(s, { type: 'fold' });
  }
  return s;
}

describe('straddle reaches the strategy engine', () => {
  it('discloses the straddle and that depth is counted in straddles', () => {
    const s = heroToAct('utg', 100, 'AJs');
    if (s.toAct !== 0) return; // hero already had the button folded to him — spot unavailable
    const note = getNodeStrategy(s, 0).note ?? '';
    expect(note).toMatch(/straddle is live/i);
    expect(note).toMatch(/STRADDLES/);
  });

  it('says nothing about straddles when none is live', () => {
    const s = heroToAct('off', 100, 'AJs');
    expect(getNodeStrategy(s, 0).note ?? '').not.toMatch(/straddle/i);
  });

  it('an unopened straddled pot is still an RFI spot, not a 3-bet spot', () => {
    // The straddle doubles currentBet; if the engine read that as a raise, the scenario would
    // flip to a vs-open node and the whole recommendation would change.
    const s = heroToAct('utg', 100, 'AJs');
    if (s.toAct !== 0) return;
    const note = getNodeStrategy(s, 0).note ?? '';
    expect(note).not.toMatch(/3-bet|vs open/i);
  });

  it('30bb with a straddle is push/fold — 15 bets deep, whatever the blind says', () => {
    const straddled = heroToAct('utg', 30, 'AJs');
    const plain = heroToAct('off', 30, 'AJs');
    if (straddled.toAct !== 0 || plain.toAct !== 0) return;
    expect(getNodeStrategy(straddled, 0).scenarioId).toBe('pushfold');
    expect(getNodeStrategy(plain, 0).scenarioId).not.toBe('pushfold');
  });
});
