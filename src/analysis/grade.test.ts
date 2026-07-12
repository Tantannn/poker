import { describe, it, expect } from 'vitest';
import { buildSizingCoach, isFreeGiveUp, isSizingNearTie } from './grade';
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

describe('isSizingNearTie — adjacent bet/raise sizes are the same decision', () => {
  // The reported spot: pot-raise rated best, ¾-pot 1.81bb behind, in a 24.5bb pot.
  const raiseNode = (): NodeStrategy => ({
    source: 'postflop-model',
    bestEv: 27.74,
    bestId: 'betpot',
    note: '',
    options: [
      { id: 'betpot', label: 'Raise pot', freq: 1, ev: 27.74, sizePct: 1.0 },
      { id: 'bet75', label: 'Raise 75%', freq: 0, ev: 25.93, sizePct: 0.75 },
      { id: 'bet50', label: 'Raise 50%', freq: 0, ev: 22.67, sizePct: 0.5 },
      { id: 'bet33', label: 'Raise 33%', freq: 0, ev: 19.68, sizePct: 0.33 },
      { id: 'call', label: 'Call', freq: 0, ev: 11.91 },
      { id: 'allin', label: 'All-in', freq: 0, ev: 5.59, sizePct: 8 },
    ],
  });

  it('softens ¾-pot vs a pot-sized best (1.81bb apart, inside ~10% of a 24.5bb pot)', () => {
    expect(isSizingNearTie(raiseNode(), 'bet75', 25.93, 1.81, 24.5)).toBe(true);
  });

  it('does NOT soften a clearly-off size: ½-pot is 5.07bb behind, past tolerance', () => {
    expect(isSizingNearTie(raiseNode(), 'bet50', 22.67, 5.07, 24.5)).toBe(false);
  });

  it('does NOT soften the min-raise punt (8.06bb behind)', () => {
    expect(isSizingNearTie(raiseNode(), 'bet33', 19.68, 8.06, 24.5)).toBe(false);
  });

  it('does not soften across families: a call vs a raise-best is a real choice', () => {
    expect(isSizingNearTie(raiseNode(), 'call', 11.91, 15.83, 24.5)).toBe(false);
  });

  it('does not soften an all-in vs a sized raise (a jam is a commitment, not a size)', () => {
    expect(isSizingNearTie(raiseNode(), 'allin', 5.59, 22.15, 24.5)).toBe(false);
  });

  it('does not soften the best line itself, nor a truly-tied line (≤0.5bb is already "correct")', () => {
    expect(isSizingNearTie(raiseNode(), 'betpot', 27.74, 0, 24.5)).toBe(false);
    expect(isSizingNearTie(raiseNode(), 'bet75', 25.93, 0.3, 24.5)).toBe(false);
  });

  it('does not soften a -EV line even if the gap is small', () => {
    expect(isSizingNearTie(raiseNode(), 'bet75', -0.5, 1.0, 24.5)).toBe(false);
  });

  it('tolerance is pot-relative but capped at 3bb (a huge pot does not over-forgive)', () => {
    // 2.9bb gap: forgiven in a 40bb pot (tol 3.0, capped), not in a 20bb pot (tol 2.0).
    expect(isSizingNearTie(raiseNode(), 'bet75', 24, 2.9, 40)).toBe(true);
    expect(isSizingNearTie(raiseNode(), 'bet75', 24, 2.9, 20)).toBe(false);
  });

  it('does not apply to preflop-chart nodes (graded by frequency instead)', () => {
    const preflop: NodeStrategy = { ...raiseNode(), source: 'preflop-chart' };
    expect(isSizingNearTie(preflop, 'bet75', 25.93, 1.81, 24.5)).toBe(false);
  });
});
