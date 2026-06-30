import { describe, it, expect } from 'vitest';
import { aggressionWarning } from './aggression';
import type { ActionRecord } from '../engine/table';

const rec = (handNumber: number, playerId: number, type: ActionRecord['type'], potAfter: number): ActionRecord => ({
  handNumber,
  playerId,
  playerName: playerId === 0 ? 'You' : 'Bot',
  position: playerId === 0 ? 'BB' : 'BTN',
  type,
  amount: 0,
  street: 'flop',
  potAfter,
});

// One hand: villain checks (pot 100), hero fires 80 into 100 (big, ≥60%), villain responds.
function hand(n: number, villainResponse: 'call' | 'raise' | 'fold'): ActionRecord[] {
  return [
    rec(n, 1, 'check', 100),
    rec(n, 0, 'bet', 180),
    rec(n, 1, villainResponse, villainResponse === 'fold' ? 180 : 260),
  ];
}

function log(response: 'call' | 'raise' | 'fold', hands = 6): ActionRecord[] {
  return Array.from({ length: hands }, (_, i) => hand(i + 1, response)).flat();
}

function deltas(hands: number, perHand: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i <= hands; i++) m.set(i, perHand);
  return m;
}

describe('aggressionWarning', () => {
  it('warns when big bets get called and bleed meaningfully', () => {
    const w = aggressionWarning(log('call'), deltas(6, -10), 0);
    expect(w).not.toBeNull();
    expect(w!.callRaiseRate).toBe(1);
    expect(w!.netBB).toBe(-60);
  });

  it('stays silent when the same called bets WIN (value betting works)', () => {
    expect(aggressionWarning(log('call'), deltas(6, +10), 0)).toBeNull();
  });

  it('stays silent on a mild loss within variance (one cooler, not a leak)', () => {
    // -1bb/hand × 6 = -6, above the -2/hand floor → not flagged
    expect(aggressionWarning(log('call'), deltas(6, -1), 0)).toBeNull();
  });

  it('stays silent when the big bets fold everyone out (aggression working)', () => {
    expect(aggressionWarning(log('fold'), deltas(6, -10), 0)).toBeNull();
  });

  it('flags re-raised bets as high severity', () => {
    const w = aggressionWarning(log('raise'), deltas(6, -10), 0);
    expect(w).not.toBeNull();
    expect(w!.level).toBe('high');
    expect(w!.raiseRate).toBe(1);
  });

  it('needs a real sample before nagging', () => {
    expect(aggressionWarning(log('call', 3), deltas(3, -10), 0)).toBeNull();
  });
});
