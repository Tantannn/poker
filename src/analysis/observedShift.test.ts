// Windowed reads: the lifetime average hides a mid-session playstyle change, so an EWMA over
// recent decisions is held against it. These pin that a real shift (a reg who stops folding /
// starts barrelling) is flagged, and that steady play is NOT — the honest "nothing new" signal.

import { describe, it, expect } from 'vitest';
import { accumulateHand, toStats, readShifts, type ObsCounters } from './observed';
import type { ActionRecord } from '../engine/table';

const rec = (handNumber: number, playerId: number, type: ActionRecord['type'], street: ActionRecord['street'] = 'flop'): ActionRecord => ({
  handNumber, playerId, playerName: playerId === 0 ? 'V' : 'X', position: 'BTN', type, amount: 6, street, potAfter: 20,
});

// Seat 0 leads the flop; seat 1 (the seat under test) faces the bet and folds or calls.
const facedBetHand = (h: number, folds: boolean): ActionRecord[] => [rec(h, 0, 'bet'), rec(h, 1, folds ? 'fold' : 'call')];
// Seat 1 is first to act with no bet ahead — a lead CHANCE it either takes (bet) or passes (check).
const leadHand = (h: number, bets: boolean): ActionRecord[] => [rec(h, 1, bets ? 'bet' : 'check')];

function run(hands: ActionRecord[][]) {
  let counters: Record<number, ObsCounters> = {};
  hands.forEach((log, i) => { counters = accumulateHand(counters, log, i + 1); });
  return toStats(counters[1]);
}

describe('windowed reads detect a mid-session playstyle change', () => {
  it('flags a villain who STOPS folding to bets', () => {
    // a folder for 15 hands, then calls everything for 12 — a reg who adjusted to your bluffs
    const hands = [...Array(15)].map((_, i) => facedBetHand(i + 1, true))
      .concat([...Array(12)].map((_, i) => facedBetHand(16 + i, false)));
    const s = run(hands);
    expect(s.foldToBet!).toBeGreaterThan(0.4); // lifetime average still reads "folder"
    expect(s.foldToBetRecent!).toBeLessThan(0.2); // but recently he isn't folding
    expect(readShifts(s).some((a) => a.stat === 'foldToBet')).toBe(true);
  });

  it('flags a villain who STARTS barrelling more', () => {
    const hands = [...Array(15)].map((_, i) => leadHand(i + 1, false)) // rarely bet
      .concat([...Array(12)].map((_, i) => leadHand(16 + i, true))); // now barrels
    const s = run(hands);
    expect(s.betFreqRecent!).toBeGreaterThan(0.7);
    expect(readShifts(s).some((a) => a.stat === 'betFreq')).toBe(true);
  });

  it('does NOT flag steady, unchanged play', () => {
    const steady = [...Array(25)].map((_, i) => facedBetHand(i + 1, true)); // always folds — no change
    const s = run(steady);
    expect(readShifts(s)).toHaveLength(0);
  });

  it('marks a fight-back as LEVELING only when the hero has been the aggressor', () => {
    // villain stopped folding to bets (the fight-back)
    const hands = [...Array(15)].map((_, i) => facedBetHand(i + 1, true))
      .concat([...Array(12)].map((_, i) => facedBetHand(16 + i, false)));
    const s = run(hands);
    const passive = readShifts(s, { heroAggro: 0.2 }); // hero hasn't been firing → just drift
    const aggro = readShifts(s, { heroAggro: 0.8 }); // hero has been hammering → he's countering YOU
    expect(passive.find((a) => a.stat === 'foldToBet')!.leveling).toBe(false);
    expect(aggro.find((a) => a.stat === 'foldToBet')!.leveling).toBe(true);
  });

  it('does NOT flag before the baseline has a real sample', () => {
    // 3 folds then 3 calls — a swing, but too few faced-bet decisions to trust
    const thin = [facedBetHand(1, true), facedBetHand(2, true), facedBetHand(3, true),
      facedBetHand(4, false), facedBetHand(5, false), facedBetHand(6, false)];
    const s = run(thin);
    expect(s.foldToBetShift).toBeNull(); // below SHIFT_MIN_SAMPLE
    expect(readShifts(s)).toHaveLength(0);
  });
});
