import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from '../index';
import { resolveVillainModel } from '../villainModel';
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

  it('a read on the FIXED second opponent is applied and disclosed (primary stays solved)', () => {
    // currentBet 0 → primaryVillain = seat 1 (the SOLVED villain); seat 2 is the fixed
    // MDF player. Locking seat 2 leaves the primary read-free, so the multiway CFR runs
    // and the second player's fold read re-anchors its policy.
    const models = { 2: resolveVillainModel(undefined, null, { enabled: true, foldToBet: 0.85 }) };
    const strat = getNodeStrategy(threeWayState('As Ac', 'Ah 7d 2c 9h Jd', 'river'), 0, undefined, undefined, models);
    expect(strat.note).toContain('3-way river');
    expect(strat.note).toMatch(/fold read/);
  });

  // The flop is the heaviest path in the app (two chance layers × a field precompute): ~1.7s
  // for one node, so these get an explicit budget rather than the 5s default, which the
  // full suite's parallel workers can otherwise blow through under load.
  it('a 3-way FLOP node routes to the multiway flop solver', () => {
    const strat = getNodeStrategy(threeWayState('9s 9c', '9h 8h 5c', 'flop'), 0);
    expect(strat.note).toContain('3-way flop');
    const total = strat.options.reduce((a, o) => a + o.freq, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
    for (const o of strat.options) expect(Number.isFinite(o.ev)).toBe(true);
  }, 60000);

  it('extra live players widen the same gate — a 5-way flop still solves', () => {
    const st = withExtraSeats(threeWayState('9s 9c', '9h 8h 5c', 'flop'), 2);
    expect(getNodeStrategy(st, 0).note).toContain('5-way flop');
  }, 60000);

  // 6-way is the app's own maximum table (useGame caps seats at 6), so the FULL-RING limped
  // pot is the modal live spot — and at a cap of 4 it was the one family pot that fell out of
  // the solver built for family pots. It survives the bump because `scaleCap` shrinks the
  // per-player combo caps as the field grows, offsetting the 2^field caller-set enumeration.
  it('a full 6-way table still solves — the cap reaches the app\'s own table maximum', () => {
    const st = withExtraSeats(threeWayState('9s 9c', '9h 8h 5c', 'flop'), 3);
    expect(getNodeStrategy(st, 0).note).toContain('6-way flop');
  }, 60000);

  it('past MAX_MULTIWAY_OPPONENTS the field precompute stops paying — 7-way falls back', () => {
    const st = withExtraSeats(threeWayState('9s 9c', '9h 8h 5c', 'flop'), 4);
    expect(getNodeStrategy(st, 0).note ?? '').not.toMatch(/-way flop solver/);
  }, 60000);
});

/** Seat more live opponents at the same node, so one state shape covers 3- to 6-way. */
function withExtraSeats(st: GameState, n: number): GameState {
  for (let k = 0; k < n; k++) {
    (st.players as unknown as unknown[]).push({
      id: 3 + k, name: `V${3 + k}`, isHero: false, profileId: 'gto', holeCards: [],
      stack: 300, committed: 0, totalCommitted: 20, folded: false, allIn: false,
    });
  }
  return st;
}
