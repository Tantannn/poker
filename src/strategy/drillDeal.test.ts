import { describe, it, expect } from 'vitest';
import { DRILL_CLASSES, pickDrillCode, type DrillClass } from './drillDeal';
import { makeRng } from '../engine/cards';

// membership predicate mirroring the buckets, checked against every code a class
// can return so a pool can't leak a wrong-class hand.
function belongs(cls: DrillClass, code: string): boolean {
  const pair = code.length === 2;
  const suited = code.endsWith('s');
  const ranks = '23456789TJQKA';
  const hi = ranks.indexOf(code[0]) + 2;
  const lo = ranks.indexOf(code[1]) + 2;
  const gap = hi - lo;
  switch (cls) {
    case 'pairs':
      return pair;
    case 'suited-connectors':
      return suited && gap === 1;
    case 'suited-gappers':
      return suited && gap >= 2 && gap <= 3;
    case 'suited-aces':
      return suited && hi === 14;
    case 'broadway':
      return !pair && lo >= 10;
    case 'offsuit-junk':
      return !pair && !suited && lo < 10;
    default:
      return false;
  }
}

describe('pickDrillCode', () => {
  it("returns null for 'off'", () => {
    expect(pickDrillCode('off')).toBeNull();
  });

  it('only ever returns codes belonging to the requested class', () => {
    const rng = makeRng(12345);
    for (const { id } of DRILL_CLASSES) {
      if (id === 'off') continue;
      for (let i = 0; i < 500; i++) {
        const code = pickDrillCode(id, rng);
        expect(code, `${id} produced null`).not.toBeNull();
        expect(belongs(id, code!), `${id} produced ${code}`).toBe(true);
      }
    }
  });

  it('covers the whole class over many draws (pairs = 13 distinct)', () => {
    const rng = makeRng(999);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(pickDrillCode('pairs', rng)!);
    expect(seen.size).toBe(13); // 22..AA
  });

  it('suited connectors span 43s..AKs', () => {
    const rng = makeRng(7);
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) seen.add(pickDrillCode('suited-connectors', rng)!);
    expect(seen.has('AKs')).toBe(true);
    expect(seen.has('54s')).toBe(true);
    expect(seen.has('32s')).toBe(true);
  });
});
