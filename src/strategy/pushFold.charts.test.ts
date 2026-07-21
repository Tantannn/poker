import { describe, it, expect } from 'vitest';
import { SHOVE_SETS, PF_POSITIONS, bucketFor, jamPct, shouldJam, type PfBucket } from './pushFold';
import { parseCard } from '../engine/cards';

const BUCKETS: PfBucket[] = ['short', 'mid', 'deep'];
const isSuperset = (big: Set<string>, small: Set<string>) => [...small].every((c) => big.has(c));

describe('push/fold charts', () => {
  it('every entry is a valid 169 code', () => {
    for (const b of BUCKETS)
      for (const p of PF_POSITIONS)
        for (const code of SHOVE_SETS[b][p]) expect(code).toMatch(/^[2-9TJQKA]{2}[so]?$/);
  });

  it('wider in later position (for each stack bucket): UTG ⊆ MP ⊆ CO ⊆ BTN ⊆ SB', () => {
    for (const b of BUCKETS) {
      for (let i = 1; i < PF_POSITIONS.length; i++) {
        const tighter = SHOVE_SETS[b][PF_POSITIONS[i - 1]];
        const wider = SHOVE_SETS[b][PF_POSITIONS[i]];
        expect(isSuperset(wider, tighter)).toBe(true);
      }
    }
  });

  it('wider the shorter the stack (for each seat): deep ⊆ mid ⊆ short', () => {
    for (const p of PF_POSITIONS) {
      expect(isSuperset(SHOVE_SETS.mid[p], SHOVE_SETS.deep[p])).toBe(true);
      expect(isSuperset(SHOVE_SETS.short[p], SHOVE_SETS.mid[p])).toBe(true);
    }
  });

  it('bucketFor maps bb to the right band', () => {
    expect(bucketFor(6)).toBe('short');
    expect(bucketFor(10)).toBe('short');
    expect(bucketFor(11)).toBe('mid');
    expect(bucketFor(16)).toBe('mid');
    expect(bucketFor(17)).toBe('deep');
    expect(bucketFor(25)).toBe('deep');
  });

  it('AA jams everywhere, 72o jams nowhere', () => {
    for (const b of BUCKETS)
      for (const p of PF_POSITIONS) {
        expect(SHOVE_SETS[b][p].has('AA')).toBe(true);
        expect(SHOVE_SETS[b][p].has('72o')).toBe(false);
      }
  });

  it('shouldJam agrees with the chart set', () => {
    const aa = [parseCard('Ah'), parseCard('As')];
    const trash = [parseCard('7h'), parseCard('2s')];
    expect(shouldJam(aa, 8, 'UTG')).toBe(true);
    expect(shouldJam(trash, 8, 'SB')).toBe(false); // widest spot still folds 72o
  });

  it('jamPct is a sane %, widest late & short', () => {
    const wide = jamPct(6, 'SB');
    const tight = jamPct(24, 'UTG');
    expect(wide).toBeGreaterThan(tight);
    expect(tight).toBeGreaterThan(0);
    expect(wide).toBeLessThan(100);
  });
});
