import { describe, expect, it } from 'vitest';
import type { Card } from '../engine/cards';
import { equityVsRange } from '../engine/equity';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { buildTallyGroups, groupTruth, ruleOfFourEstimate, tallyEstimate, UNTOUCHED_PCT } from './rangeTally';

const card = (rank: number, suit: number): Card => ({ rank, suit });
const hero = [card(14, 0), card(13, 0)];
const board = [card(9, 1), card(7, 2), card(2, 3)];
const range = rangeFromSet(RFI_RANGES.BTN);

describe('rangeTally', () => {
  it('splits the whole range into piles whose shares sum to 1', () => {
    const groups = buildTallyGroups(hero, board, range);
    expect(groups.reduce((s, g) => s + g.share, 0)).toBeCloseTo(1, 6);
  });

  it('prices untouched piles at 50%', () => {
    const groups = buildTallyGroups(hero, board, range);
    expect(tallyEstimate(groups, {})).toBeCloseTo(UNTOUCHED_PCT, 6);
  });

  it('a perfect per-pile tally lands on the true equity', () => {
    const groups = buildTallyGroups(hero, board, range);
    const picks = Object.fromEntries(groups.map((g) => [g.id, groupTruth(hero, board, g)]));
    const truth = equityVsRange(hero, board, range, 4000).equity * 100;
    expect(Math.abs(tallyEstimate(groups, picks) - truth)).toBeLessThan(4);
  }, 20000);

  it('corrects the rule of 4 past 8 outs', () => {
    expect(ruleOfFourEstimate(8, 'Flop')).toBe(32);
    expect(ruleOfFourEstimate(15, 'Flop')).toBe(53);
    expect(ruleOfFourEstimate(9, 'Turn')).toBe(18);
  });
});
