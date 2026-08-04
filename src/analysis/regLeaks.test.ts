// The two reg-specific leak stats: turn give-up (he c-bets the flop and quits) and
// fold-to-raise (his bet gets raised and he folds). Both are CONDITIONAL reads — the
// denominator is the spots where the decision was actually offered — so the tests pin the
// denominator as hard as the rate. A wrong denominator is the failure mode that makes a
// stat look measured while being noise.

import { describe, it, expect } from 'vitest';
import { accumulateHand, emptyObs, toStats, type ObsCounters } from './observed';
import type { ActionRecord } from '../engine/table';

type Street = ActionRecord['street'];
const rec = (playerId: number, street: Street, type: ActionRecord['type'], amount = 0): ActionRecord =>
  ({ handNumber: 1, playerId, street, type, amount, position: 'BTN' }) as ActionRecord;

const run = (log: ActionRecord[]): ObsCounters => {
  const seats: Record<number, ObsCounters> = { 0: emptyObs(), 1: emptyObs() };
  return accumulateHand(seats, log, 1)[1];
};
const stats = (log: ActionRecord[]) => toStats(run(log));

describe('turn give-up', () => {
  it('counts a flop c-bet followed by a turn check as a give-up', () => {
    const s = stats([
      rec(1, 'flop', 'bet', 10),
      rec(0, 'flop', 'call', 10),
      rec(0, 'turn', 'check'),
      rec(1, 'turn', 'check'),
    ]);
    expect(s.turnGiveUpSample).toBe(1);
    expect(s.turnGiveUp).toBe(1);
  });

  it('does not count a second barrel as a give-up', () => {
    const s = stats([
      rec(1, 'flop', 'bet', 10),
      rec(0, 'flop', 'call', 10),
      rec(0, 'turn', 'check'),
      rec(1, 'turn', 'bet', 25),
    ]);
    expect(s.turnGiveUpSample).toBe(1);
    expect(s.turnGiveUp).toBe(0);
  });

  it('excludes hands where someone bet into him first — he was never offered the barrel', () => {
    const s = stats([
      rec(1, 'flop', 'bet', 10),
      rec(0, 'flop', 'call', 10),
      rec(0, 'turn', 'bet', 25),
      rec(1, 'turn', 'call', 25),
    ]);
    expect(s.turnGiveUpSample).toBe(0);
    expect(s.turnGiveUp).toBeNull();
  });

  it('treats a turn check-raise as taking the street, not giving up', () => {
    const s = stats([
      rec(1, 'flop', 'bet', 10),
      rec(0, 'flop', 'call', 10),
      rec(1, 'turn', 'check'),
      rec(0, 'turn', 'bet', 25),
      rec(1, 'turn', 'raise', 70),
    ]);
    expect(s.turnGiveUpSample).toBe(1);
    expect(s.turnGiveUp).toBe(0);
  });

  it('needs a flop LEAD — checking the flop then checking the turn is not a give-up', () => {
    const s = stats([
      rec(1, 'flop', 'check'),
      rec(0, 'flop', 'check'),
      rec(1, 'turn', 'check'),
      rec(0, 'turn', 'check'),
    ]);
    expect(s.turnGiveUpSample).toBe(0);
  });
});

describe('fold-to-raise', () => {
  it('counts only a decision his OWN bet created', () => {
    const s = stats([
      rec(1, 'flop', 'bet', 10),
      rec(0, 'flop', 'raise', 35),
      rec(1, 'flop', 'fold'),
    ]);
    expect(s.foldToRaiseSample).toBe(1);
    expect(s.foldToRaise).toBe(1);
    // still a faced-bet decision too — the narrower stat doesn't replace the pooled one
    expect(s.facedBetSample).toBe(1);
  });

  it('does not count facing the FIRST bet of a street as facing a raise', () => {
    const s = stats([rec(0, 'flop', 'bet', 10), rec(1, 'flop', 'fold')]);
    expect(s.foldToRaiseSample).toBe(0);
    expect(s.foldToRaise).toBeNull();
    expect(s.facedBetSample).toBe(1);
  });

  it('counts a continue as a raise faced but not a fold', () => {
    const s = stats([
      rec(1, 'turn', 'bet', 20),
      rec(0, 'turn', 'raise', 60),
      rec(1, 'turn', 'call', 40),
    ]);
    expect(s.foldToRaiseSample).toBe(1);
    expect(s.foldToRaise).toBe(0);
  });

  it('resets per street — his flop bet being raised does not taint the turn', () => {
    const s = stats([
      rec(1, 'flop', 'bet', 10),
      rec(0, 'flop', 'raise', 35),
      rec(1, 'flop', 'call', 25),
      rec(0, 'turn', 'bet', 40),
      rec(1, 'turn', 'fold'),
    ]);
    expect(s.foldToRaiseSample).toBe(1);
    expect(s.foldToRaise).toBe(0);
  });

  it('is postflop only — a preflop 3-bet is the preflop counter, not this one', () => {
    const s = stats([
      rec(1, 'preflop', 'raise', 6),
      rec(0, 'preflop', 'raise', 20),
      rec(1, 'preflop', 'fold'),
    ]);
    expect(s.foldToRaiseSample).toBe(0);
    expect(s.foldToThreeBetSample).toBe(1);
  });
});
