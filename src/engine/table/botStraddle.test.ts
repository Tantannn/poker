// Bots initiate a UTG straddle when the hero hasn't set one — live tables straddle
// constantly, and it's the depth lesson happening unprompted. Guards: only a BOT ever
// posts it (the hero is never force-straddled), cash only, and it flows through
// effectiveBigBlind so the whole table plays the shorter effective depth.

import { describe, it, expect } from 'vitest';
import { createGame, startHand, effectiveBigBlind, positionLabel } from './table';

const bots = (n: number) => Array.from({ length: n - 1 }, () => 'tag');

function dealt(freq: number, opts: { tournament?: boolean; button?: number; straddle?: 'off' | 'utg' } = {}) {
  const g = createGame(6, 100, 2, bots(6), opts.tournament ?? false);
  g.botStraddleFreq = freq;
  if (opts.straddle) g.straddle = opts.straddle;
  if (opts.button !== undefined) g.buttonIndex = opts.button;
  return startHand(g);
}

describe('bots initiate a UTG straddle', () => {
  it('a bot in the UTG seat straddles at freq 1 — the live bet doubles', () => {
    const s = dealt(1); // button advances to 0 → UTG is seat 3 (a bot)
    expect(positionLabel(3, s.buttonIndex, 6)).toBe('UTG');
    expect(s.players[3].isHero).toBe(false);
    expect(s.straddleTo).toBe(2 * s.bigBlind);
    expect(effectiveBigBlind(s)).toBe(2 * s.bigBlind); // depth logic sees the shorter table
  });

  it('never straddles at freq 0', () => {
    expect(dealt(0).straddleTo).toBeFalsy();
  });

  it('never force-straddles the hero when the hero is UTG', () => {
    const s = dealt(1, { button: 2 }); // startHand advances to button 3 → UTG is seat 0 (hero)
    expect(positionLabel(0, s.buttonIndex, 6)).toBe('UTG');
    expect(s.straddleTo).toBeFalsy();
  });

  it('never straddles in a tournament (cash mechanic only)', () => {
    expect(dealt(1, { tournament: true }).straddleTo).toBeFalsy();
  });

  it('does not override a straddle the hero explicitly set', () => {
    const s = dealt(0, { straddle: 'utg' }); // hero's choice stands even with bot straddle off
    expect(s.straddleTo).toBe(2 * s.bigBlind);
  });
});
