import { describe, expect, it } from 'vitest';
import { rangeFromSet } from '../../engine/range';
import { BB_DEFEND_RANGE, RFI_RANGES } from '../../ai/preflop';
import { betConditionedWeight } from '../index';
import { solveFlopVsBetNode } from './riverAdapter';

const card = (rank: number, suit: number) => ({ rank, suit });

describe('node lock vs the called line', () => {
  it('the raise lock must not drag the CALL line (AK on Q92, in position, small bet)', () => {
    const board = [card(9, 0), card(12, 3), card(2, 0)];
    const base = {
      heroCards: [card(14, 2), card(13, 1)],
      board,
      potBeforeBet: 13,
      bet: 7,
      minRaiseTo: 21,
      maxRaiseTo: 223,
      heroRange: rangeFromSet(RFI_RANGES.UTG),
      villainRange: rangeFromSet(BB_DEFEND_RANGE),
      villainComboWeight: (a: ReturnType<typeof card>, b: ReturnType<typeof card>) => betConditionedWeight(a, b, board, true, 7 / 13, 0.25),
      bigBlind: 2,
      stackAfterCall: 216,
      heroActsFirst: false,
    };
    const callEv = (lock?: number) =>
      solveFlopVsBetNode({ ...base, villainFoldToBet: lock })!.options.find((o) => o.kind === 'call')!.ev;
    expect(Math.abs(callEv(0.27) - callEv())).toBeLessThan(0.75);
  }, 120000);
});
