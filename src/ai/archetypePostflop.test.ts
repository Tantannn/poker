// Postflop archetype bands, measured the way a HUD would on a bots-only table. Before the
// range-respect fix every bot played like a calling station (folded ~25% to c-bets, reached
// showdown ~50% of flops) and the archetypes were indistinguishable after the flop.
// 900 hands is too few to rank single archetypes (a nit's fold-to-c-bet swung 27–68% across
// seeds), so the claims pool the solid archetypes and compare against the station / maniac.
// Per-archetype numbers: SIM=1 npx vitest run src/ai/_sim.test.ts --silent=false --reporter=verbose
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { simulateBots, type ArchStats } from './botSim';
import { makeRng } from '../engine/cards';

const SOLID = ['tag', 'nit', 'gto', 'reg'];

describe('bots play their archetype after the flop (hard)', () => {
  let s: Record<string, ArchStats>;
  const pooled = (k: keyof ArchStats) => SOLID.reduce((a, x) => a + s[x][k], 0) / SOLID.length;
  beforeAll(() => {
    vi.spyOn(Math, 'random').mockImplementation(makeRng(20261120));
    s = simulateBots('hard', 900, 3, { iters: 120 });
  }, 120000);
  afterAll(() => vi.restoreAllMocks());

  it('solid players fold to c-bets and reach showdown at real rates, not like stations', () => {
    expect(pooled('foldToCbet')).toBeGreaterThan(35);
    expect(pooled('wtsd')).toBeLessThan(34);
  });

  it('the calling station stays a station', () => {
    expect(s.lp.foldToCbet).toBeLessThan(pooled('foldToCbet') - 12);
    expect(s.lp.wtsd).toBeGreaterThan(pooled('wtsd') + 8);
    expect(s.lp.foldToRaise).toBeLessThan(pooled('foldToRaise') - 15);
    expect(s.lp.af).toBeLessThan(1);
  });

  it('the maniac is the most aggressive player at the table', () => {
    expect(s.maniac.af).toBeGreaterThan(pooled('af') + 0.8);
    expect(s.maniac.af).toBeGreaterThan(s.lp.af + 2);
  });
});
