import { describe, it, expect } from 'vitest';
import { evLoss, rngPrescription, mixFromEv, type NodeStrategy, type ActionId } from './types';
import { matchActionId } from './index';
import type { Action } from '../engine/table';

function strat(options: NodeStrategy['options'], bestId: ActionId): NodeStrategy {
  const bestEv = Math.max(...options.map((o) => o.ev));
  return { options, bestEv, bestId, source: 'postflop-model', note: '' };
}

describe('evLoss', () => {
  const s = strat(
    [
      { id: 'betpot', label: 'Bet pot', freq: 1, ev: 2 },
      { id: 'call', label: 'Call', freq: 0, ev: 0.5 },
      { id: 'fold', label: 'Fold', freq: 0, ev: 0 },
    ],
    'betpot',
  );
  it('is zero for the best action', () => expect(evLoss(s, 'betpot')).toBe(0));
  it('is the EV gap for a worse action', () => expect(evLoss(s, 'call')).toBeCloseTo(1.5));
  it('never goes negative', () => expect(evLoss(s, 'fold')).toBeGreaterThanOrEqual(0));
});

describe('rngPrescription', () => {
  const s = strat(
    [
      { id: 'betpot', label: 'Bet', freq: 0.7, ev: 2 },
      { id: 'check', label: 'Check', freq: 0.3, ev: 1 },
    ],
    'betpot',
  );
  it('lands on the high-frequency branch for a low roll', () => {
    expect(rngPrescription(s, 40)).toBe('betpot');
  });
  it('lands on the tail branch for a high roll', () => {
    expect(rngPrescription(s, 85)).toBe('check');
  });
});

describe('mixFromEv', () => {
  it('gives the top-EV action the most frequency and sums to 1', () => {
    const mix = mixFromEv([
      { id: 'betpot', ev: 3 },
      { id: 'bet75', ev: 2.8 },
      { id: 'fold', ev: 0 },
    ]);
    const total = [...mix.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(mix.get('betpot')!).toBeGreaterThan(mix.get('bet75')!);
  });
  it('zeroes actions outside the EV window', () => {
    const mix = mixFromEv([
      { id: 'betpot', ev: 5 },
      { id: 'fold', ev: 0 }, // 5 bb below best, outside the 1.2 window
    ]);
    expect(mix.get('fold')).toBe(0);
    expect(mix.get('betpot')).toBeCloseTo(1);
  });
});

describe('matchActionId', () => {
  const s = strat(
    [
      { id: 'check', label: 'Check', freq: 0.5, ev: 1 },
      { id: 'bet33', label: 'Bet 33%', freq: 0.3, ev: 1.2, amount: 20 },
      { id: 'betpot', label: 'Bet pot', freq: 0.2, ev: 1.1, amount: 60 },
      { id: 'fold', label: 'Fold', freq: 0, ev: 0 },
    ],
    'bet33',
  );
  it('maps a fold to fold', () => {
    expect(matchActionId(s, { type: 'fold' } as Action, 0)).toBe('fold');
  });
  it('maps a check to the check option', () => {
    expect(matchActionId(s, { type: 'check' } as Action, 0)).toBe('check');
  });
  it('maps a bet to the nearest sized option by amount', () => {
    expect(matchActionId(s, { type: 'bet', amount: 55 } as Action, 0)).toBe('betpot');
    expect(matchActionId(s, { type: 'raise', amount: 18 } as Action, 0)).toBe('bet33');
  });
  it('maps a call with nothing to call to a check', () => {
    expect(matchActionId(s, { type: 'call' } as Action, 0)).toBe('check');
  });
});
