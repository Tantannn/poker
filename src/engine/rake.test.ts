import { describe, it, expect } from 'vitest';
import { rakeInChips, rakeOn, netPot, rakeMarginal } from './rake';
import { createGame, startHand, applyAction, legalActions, type GameState } from './table';

describe('rake model', () => {
  it('none profile is rake-free', () => {
    expect(rakeInChips('none', 2)).toBeUndefined();
    expect(rakeOn(undefined, 500)).toBe(0);
    expect(netPot(undefined, 500)).toBe(500);
  });

  it('takes the percentage until the cap, then only the flat drop', () => {
    const r = rakeInChips('live-1-2', 2)!; // 10%, cap 2bb = 4, drop 0.5bb = 1
    expect(rakeOn(r, 20)).toBeCloseTo(3); // 10% of 20 = 2, under cap, + 1 drop
    expect(rakeOn(r, 200)).toBeCloseTo(5); // capped at 4, + 1 drop
    expect(rakeOn(r, 2000)).toBeCloseTo(5); // still 5 — rake is regressive
  });

  it('never takes more than the pot', () => {
    const r = rakeInChips('live-1-2', 2)!;
    expect(rakeOn(r, 2)).toBeLessThanOrEqual(2);
  });

  it('marginal rate falls to zero past the cap — extra value is free in a big pot', () => {
    const r = rakeInChips('live-1-2', 2)!;
    expect(rakeMarginal(r, 20)).toBeCloseTo(0.1);
    expect(rakeMarginal(r, 200)).toBe(0);
  });
});

function heroWinsCheckdown(rake: GameState['rake']): GameState {
  let s = createGame(2, 100, 2, ['tag']);
  s.rake = rake;
  s = startHand(s);
  // HU: button/SB completes, BB checks, then check it down to showdown.
  while (s.street !== 'complete') {
    const la = legalActions(s);
    s = applyAction(s, la.canCheck ? { type: 'check' } : { type: 'call' });
  }
  return s;
}

describe('table rake', () => {
  it('rakes a pot that saw a flop', () => {
    const s = heroWinsCheckdown('live-1-2');
    expect(s.board.length).toBe(5);
    expect(s.rakePaid).toBe(1); // pot 4 → 10% = 0.4 under cap, + 1 drop, rounded
    expect(s.pots[0].amount).toBe(3);
  });

  it('no flop, no drop', () => {
    let s = createGame(2, 100, 2, ['tag']);
    s.rake = 'live-1-2';
    s = startHand(s);
    s = applyAction(s, { type: 'fold' });
    expect(s.street).toBe('complete');
    expect(s.board.length).toBe(0);
    expect(s.rakePaid ?? 0).toBe(0);
  });

  it('rake leaves the table — chips are conserved minus the drop', () => {
    const s = heroWinsCheckdown('live-1-2');
    const chips = s.players.reduce((t, p) => t + p.stack, 0);
    const start = s.players.reduce((t, p) => t + p.startStack, 0);
    expect(start - chips).toBe(s.rakePaid);
  });

  it('leaves the pot alone when no rake is configured', () => {
    const s = heroWinsCheckdown(undefined);
    expect(s.rakePaid ?? 0).toBe(0);
    expect(s.players.reduce((t, p) => t + p.stack, 0)).toBe(s.players.reduce((t, p) => t + p.startStack, 0));
  });
});
