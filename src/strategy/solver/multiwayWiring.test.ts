import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from '../index';
import { parseCard } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const cards = (s: string) => s.split(' ').map(parseCard);

// 3-handed pot, hero first to act (seat0 = button), two live villains → liveOpps === 2.
function threeWayState(heroCards: string, boardStr: string, street: string, currentBet = 0): GameState {
  return {
    handNumber: 1,
    buttonIndex: 0,
    board: cards(boardStr),
    street,
    currentBet,
    lastRaiseSize: 2,
    toAct: 0,
    lastAggressor: currentBet > 0 ? 1 : -1,
    bigBlind: 2,
    seed: 999,
    log: [],
    players: [
      { id: 0, name: 'You', isHero: true, profileId: 'gto', holeCards: cards(heroCards), stack: 300, committed: 0, totalCommitted: 20, folded: false, allIn: false },
      { id: 1, name: 'V1', isHero: false, profileId: 'gto', holeCards: [], stack: 300, committed: 0, totalCommitted: 20, folded: false, allIn: false },
      { id: 2, name: 'V2', isHero: false, profileId: 'gto', holeCards: [], stack: 300, committed: 0, totalCommitted: 20, folded: false, allIn: false },
    ],
  } as unknown as GameState;
}

describe('live wiring: hero-first 3-way nodes route through the multiway solver', () => {
  it('a 3-way river node routes to the 3-way river solver', () => {
    const strat = getNodeStrategy(threeWayState('As Ac', 'Ah 7d 2c 9h Jd', 'river'), 0);
    expect(strat.note).toContain('3-way river');
    const total = strat.options.reduce((a, o) => a + o.freq, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
    const best = strat.options.find((o) => o.id === strat.bestId)!;
    expect(best.ev).toBeCloseTo(Math.max(...strat.options.map((o) => o.ev)), 5);
  });

  it('a 3-way turn node routes to the 3-way turn solver', () => {
    const strat = getNodeStrategy(threeWayState('Ks Kc', 'Ah 7d 2c 9h', 'turn'), 0);
    expect(strat.note).toContain('3-way turn');
    const total = strat.options.reduce((a, o) => a + o.freq, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });

  it('a 4-way node stays on the per-hand model (multiway CFR is 3-way only)', () => {
    const st = threeWayState('As Ac', 'Ah 7d 2c 9h Jd', 'river');
    (st.players as unknown as unknown[]).push({
      id: 3, name: 'V3', isHero: false, profileId: 'gto', holeCards: [], stack: 300, committed: 0, totalCommitted: 20, folded: false, allIn: false,
    });
    const strat = getNodeStrategy(st, 0);
    expect(strat.note ?? '').not.toContain('3-way');
  });
});
