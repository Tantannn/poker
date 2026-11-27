import { describe, it, expect } from 'vitest';
import { classifyLeak, summarizeBlock, type BlockEntry } from './blockReview';
import type { NodeFeedback } from './grade';
import type { ActionId } from '@/strategy/core';


const entry = (street: string, chosen: ActionId, best: ActionId, evLoss: number, handNumber = 1): BlockEntry => ({
  handNumber,
  street,
  heroCards: [],
  board: [],
  actions: [],
  fb: { chosen, best, evLoss } as NodeFeedback,
});

describe('classifyLeak', () => {
  it('flags call-down where raise or fold was best', () => {
    expect(classifyLeak('call', 'raise')).toBe('passiveCall');
    expect(classifyLeak('call', 'fold')).toBe('passiveCall');
  });
  it('separates over-fold, missed value, over-aggression and sizing', () => {
    expect(classifyLeak('fold', 'call')).toBe('overFold');
    expect(classifyLeak('check', 'bet75')).toBe('missedValue');
    expect(classifyLeak('bet75', 'check')).toBe('overAggro');
    expect(classifyLeak('bet33', 'betpot')).toBe('sizing');
    expect(classifyLeak('call', 'call')).toBeNull();
  });
});

describe('summarizeBlock', () => {
  it('ignores mix-noise below the threshold and ranks worst spots', () => {
    const s = summarizeBlock([
      entry('river', 'call', 'raise', 3, 1),
      entry('turn', 'call', 'fold', 1, 2),
      entry('flop', 'bet33', 'bet75', 0.1, 3),
      entry('preflop', 'fold', 'open', 0.5, 4),
    ], 30);
    expect(s.decisions).toBe(4);
    expect(s.mistakes).toBe(3);
    expect(s.callsWhenRaiseOrFold).toBe(2);
    expect(s.leaks[0].kind).toBe('passiveCall');
    expect(s.worst.map((w) => w.handNumber)).toEqual([1, 2, 4]);
    expect(s.evLossPer100).toBeCloseTo((4.6 / 30) * 100);
  });
});
