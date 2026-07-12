import { describe, it, expect } from 'vitest';
import { buildSizingCoach, isFreeGiveUp } from './grade';
import type { NodeStrategy } from '../strategy';

// Minimal strategy: a small best size vs a big oversized line, with the
// equity-when-called drop that makes oversizing a leak.
const strat = (): NodeStrategy => ({
  source: 'postflop-model',
  bestEv: 8.44,
  bestId: 'bet33',
  note: '',
  options: [
    { id: 'bet33', label: 'Bet 33%', freq: 1, ev: 8.44, sizePct: 0.33, calledEq: 0.27 },
    { id: 'betpot', label: 'Bet pot', freq: 0, ev: -1.49, sizePct: 1.0, calledEq: 0.2 },
  ],
});

describe('buildSizingCoach', () => {
  it('teaches the size-up test and that size follows hand strength, not the board', () => {
    const msg = buildSizingCoach(strat(), 'betpot', 9.93, 4, 'Top Pair, Good Kicker');
    expect(msg).toBeDefined();
    // renders as a dot list (lead + bullets joined by " • ")
    expect(msg).toContain(' • ');
    // the equity-when-called drop is named
    expect(msg).toContain('27% → 20%');
    // the two mental tools the user was missing
    expect(msg).toContain('HAND STRENGTH, not the board');
    expect(msg!.toLowerCase()).toContain('size-up test');
    // one-pair hands get the concrete "medium hand, sizes small" lesson
    expect(msg).toContain('is one pair — a medium hand');
    // multiway caution present with 4 opponents
    expect(msg).toContain('Multiway (4 opponents)');
  });

  it('does not fire when the chosen line is not bigger than best', () => {
    // hero took the best (small) line → no oversizing coach
    expect(buildSizingCoach(strat(), 'bet33', 0, 4, 'Top Pair, Good Kicker')).toBeUndefined();
    // a check (no sizePct) is never "too big"
    expect(buildSizingCoach(strat(), 'check', 5, 1)).toBeUndefined();
  });

  it('gives the generic (non-one-pair) size lesson for strong hands', () => {
    const msg = buildSizingCoach(strat(), 'betpot', 2, 1, 'Two Pair');
    expect(msg).toContain('HAND STRENGTH, not the board');
    expect(msg).not.toContain('medium hand'); // Two Pair isn't the medium one-pair tier
  });
});

describe('isFreeGiveUp — declining to bluff air is not a real leak', () => {
  // solver node whose best line is a bet (the turn-solver over-values betting air)
  const betBest = (): NodeStrategy => ({
    source: 'postflop-model',
    bestEv: 3.54,
    bestId: 'bet33',
    note: '',
    options: [
      { id: 'bet33', label: 'Bet 33%', freq: 0.6, ev: 3.54 },
      { id: 'check', label: 'Check', freq: 0.0, ev: 1.34 },
    ],
  });

  it('softens a CHECK of stone-cold air when best is a bet', () => {
    expect(isFreeGiveUp(betBest(), 'check', 0)).toBe(true); // strength 0 = Air
    expect(isFreeGiveUp(betBest(), 'fold', 0)).toBe(true);
  });

  it('does NOT soften a made hand that should bet (keeps the real penalty)', () => {
    expect(isFreeGiveUp(betBest(), 'check', 4)).toBe(false); // strong made hand
    expect(isFreeGiveUp(betBest(), 'check', 2)).toBe(false); // medium hand
  });

  it('only softens give-ups, never the aggressive line itself', () => {
    expect(isFreeGiveUp(betBest(), 'bet33', 0)).toBe(false);
  });

  it('does not fire when the best line is itself a check', () => {
    const checkBest: NodeStrategy = {
      source: 'postflop-model',
      bestEv: 1.34,
      bestId: 'check',
      note: '',
      options: [
        { id: 'check', label: 'Check', freq: 1, ev: 1.34 },
        { id: 'bet33', label: 'Bet 33%', freq: 0, ev: 0.1 },
      ],
    };
    expect(isFreeGiveUp(checkBest, 'check', 0)).toBe(false);
  });

  it('does not apply to preflop-chart nodes (only the postflop model over-penalises)', () => {
    const preflop: NodeStrategy = { ...betBest(), source: 'preflop-chart' };
    expect(isFreeGiveUp(preflop, 'check', 0)).toBe(false);
  });
});
