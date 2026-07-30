import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from '../index';
import { parseCard } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const cards = (s: string) => s.split(' ').map(parseCard);

// Minimal heads-up flop state: seat0 = button/SB (hero), seat1 = BB (villain).
function flopState(heroCards: string, boardStr: string, currentBet = 0): GameState {
  return {
    handNumber: 1,
    buttonIndex: 0,
    board: cards(boardStr),
    street: 'flop',
    currentBet,
    toAct: 0,
    lastAggressor: -1,
    bigBlind: 2,
    log: [],
    players: [
      { id: 0, name: 'You', isHero: true, holeCards: cards(heroCards), stack: 300, committed: 0, totalCommitted: 15, folded: false },
      { id: 1, name: 'V', isHero: false, holeCards: [], stack: 300, committed: 0, totalCommitted: 15, folded: false },
    ],
  } as unknown as GameState;
}

describe('live wiring: hero-first flop node routes through the range-vs-range solver', () => {
  it('returns a solved NodeStrategy whose best line matches the equilibrium mix', () => {
    const strat = getNodeStrategy(flopState('Ks Kc', 'Kh 8h 3c'), 0);
    expect(strat.note).toContain('Flop solver'); // proves the solver path was taken

    const ids = strat.options.map((o) => o.id);
    expect(ids).toContain('check');

    const total = strat.options.reduce((a, o) => a + o.freq, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05); // a valid probability mix

    // best line = the highest-EV action (tie-break: frequency), so EV-loss is a true regret.
    const best = strat.options.find((o) => o.id === strat.bestId)!;
    const maxEv = Math.max(...strat.options.map((o) => o.ev));
    expect(best.ev).toBeCloseTo(maxEv, 5);

    // top set on a wet flop should bet (value + protection) far more than it checks
    const check = strat.options.find((o) => o.id === 'check')!;
    expect(best.freq).toBeGreaterThan(check.freq);
    console.log(
      `flop KK: best=${strat.bestId} | ` +
        strat.options.filter((o) => o.freq > 0.01).map((o) => `${o.id}:${(o.freq * 100).toFixed(0)}%`).join(' '),
    );
  });

  it('facing a bet on the flop routes to the vs-bet solver (fold / call / raise)', () => {
    const strat = getNodeStrategy(flopState('Ks Kc', 'Kh 8h 3c', 12), 0);
    expect(strat.note).toContain('facing a bet');
    const ids = strat.options.map((o) => o.id);
    expect(ids).toContain('fold');
    expect(ids).toContain('call');
    // top set on the flop must never fold facing a bet
    const fold = strat.options.find((o) => o.id === 'fold')!;
    expect(fold.freq).toBeLessThan(0.05);
  });
});
