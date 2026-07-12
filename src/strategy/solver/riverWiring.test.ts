import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from '../index';
import { parseCard } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const cards = (s: string) => s.split(' ').map(parseCard);

// Minimal heads-up river state: seat0 = button/SB (hero), seat1 = BB (villain).
function riverState(heroCards: string, boardStr: string, currentBet = 0): GameState {
  return {
    handNumber: 1,
    buttonIndex: 0,
    board: cards(boardStr),
    street: 'river',
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

describe('live wiring: river-first node routes through the range-vs-range solver', () => {
  it('returns a solved NodeStrategy whose best line matches the equilibrium mix', () => {
    const strat = getNodeStrategy(riverState('As Ac', 'Ah 7d 2c 9h Jd'), 0);
    expect(strat.note).toContain('River solver'); // proves the solver path was taken

    const ids = strat.options.map((o) => o.id);
    expect(ids).toContain('check');
    expect(ids).toContain('betpot');

    const total = strat.options.reduce((a, o) => a + o.freq, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05); // a valid probability mix

    // best line = the highest-EV action (tie-break: frequency) — matches the
    // "highest-EV line" the grader/UI reports, so EV-loss is a true regret.
    const best = strat.options.find((o) => o.id === strat.bestId)!;
    const maxEv = Math.max(...strat.options.map((o) => o.ev));
    expect(best.ev).toBeCloseTo(maxEv, 5);

    // the nuts on a dry board should value-bet big far more than it checks
    const check = strat.options.find((o) => o.id === 'check')!;
    expect(best.freq).toBeGreaterThan(check.freq);
  });

  it('a hero-first turn node routes to the turn solver', () => {
    const st = riverState('Ks Kc', 'Ah 7d 2c 9h'); // 4-card board = turn
    (st as unknown as { street: string }).street = 'turn';
    const strat = getNodeStrategy(st, 0);
    expect(strat.note).toContain('Turn solver');
    const total = strat.options.reduce((a, o) => a + o.freq, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
    console.log(`turn KK: best=${strat.bestId} | ${strat.options.filter((o) => o.freq > 0.01).map((o) => `${o.id}:${(o.freq * 100).toFixed(0)}%`).join(' ')}`);
  });

  it('facing a bet routes to the vs-bet solver (fold / call / raise)', () => {
    const strat = getNodeStrategy(riverState('As Ac', 'Ah 7d 2c 9h Jd', 20), 0);
    expect(strat.note).toContain('facing a bet');
    const ids = strat.options.map((o) => o.id);
    expect(ids).toContain('fold');
    expect(ids).toContain('call');
    // trip aces (nuts) facing a bet must not fold
    const fold = strat.options.find((o) => o.id === 'fold')!;
    expect(fold.freq).toBeLessThan(0.05);
    console.log(`nuts vs bet: ${strat.options.map((o) => `${o.id}:${(o.freq * 100).toFixed(0)}%`).join(' ')}`);
  });
});
