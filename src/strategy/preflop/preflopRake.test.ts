// Rake is DIRECTIONAL, not calibrated — these pin the direction and the two mechanics
// (regressive cap, no-flop-no-drop), never exact frequencies.

import { describe, it, expect } from 'vitest';
import { rakeTaxRate, shadeForRake, rakeNote } from './preflopRake';

const mix = (call: number, raise: number) => [
  { id: 'call', freq: call },
  { id: 'raise', freq: raise },
  { id: 'fold', freq: 1 - call - raise },
];
const freq = (opts: { id: string; freq: number }[], id: string) => opts.find((o) => o.id === id)?.freq ?? 0;
const MARGINAL = 'K9s';
const PREMIUM = 'AA';

describe('rakeTaxRate', () => {
  it('is zero rake-free, and zero for an undefined profile', () => {
    expect(rakeTaxRate('none', 12)).toBe(0);
    expect(rakeTaxRate(undefined, 12)).toBe(0);
  });

  it('is REGRESSIVE — the cap makes a small pot pay a far higher rate than a big one', () => {
    expect(rakeTaxRate('live-1-2', 8)).toBeGreaterThan(rakeTaxRate('live-1-2', 80));
  });

  it('ranks the profiles the way the structures do', () => {
    expect(rakeTaxRate('live-1-2', 12)).toBeGreaterThan(rakeTaxRate('live-5-10', 12));
    expect(rakeTaxRate('live-5-10', 12)).toBeGreaterThan(rakeTaxRate('none', 12));
  });
});

describe('shadeForRake', () => {
  it('leaves a rake-free table untouched', () => {
    const base = mix(0.4, 0.3);
    expect(shadeForRake(base, MARGINAL, 'none', 12, false)).toBe(base);
  });

  it('leaves PREMIUMS untouched — rake kills marginal spots, not coolers', () => {
    const base = mix(0.1, 0.9);
    expect(shadeForRake(base, PREMIUM, 'live-1-2', 12, false)).toBe(base);
  });

  it('taxes the marginal tail into folding more', () => {
    const base = mix(0.4, 0.3);
    const shaded = shadeForRake(base, MARGINAL, 'live-1-2', 12, false);
    expect(freq(shaded, 'fold')).toBeGreaterThan(freq(base, 'fold'));
    expect(shaded.reduce((a, o) => a + o.freq, 0)).toBeCloseTo(1, 6);
  });

  it('NO FLOP, NO DROP: the flat loses more of its frequency than the raise', () => {
    const base = mix(0.4, 0.4);
    const shaded = shadeForRake(base, MARGINAL, 'live-1-2', 12, false);
    const callCut = 1 - freq(shaded, 'call') / 0.4;
    const raiseCut = 1 - freq(shaded, 'raise') / 0.4;
    expect(callCut).toBeGreaterThan(raiseCut);
    expect(raiseCut).toBeGreaterThan(0);
  });

  it('multiway strips most of the raise relief — someone always calls', () => {
    const base = mix(0.4, 0.4);
    const hu = shadeForRake(base, MARGINAL, 'live-1-2', 12, false);
    const field = shadeForRake(base, MARGINAL, 'live-1-2', 12, true);
    expect(freq(field, 'raise')).toBeLessThan(freq(hu, 'raise'));
  });

  it('bites harder in a small pot than a big one, same hand', () => {
    const base = mix(0.4, 0.3);
    const small = shadeForRake(base, MARGINAL, 'live-1-2', 8, false);
    const big = shadeForRake(base, MARGINAL, 'live-1-2', 80, false);
    expect(freq(small, 'fold')).toBeGreaterThan(freq(big, 'fold'));
  });

  it('never scales a mix with no fold to absorb it', () => {
    const base = [{ id: 'check', freq: 1 }];
    expect(shadeForRake(base, MARGINAL, 'live-1-2', 12, false)).toBe(base);
  });
});

describe('rakeNote', () => {
  it('is silent rake-free and on premiums, and speaks on a marginal raked spot', () => {
    expect(rakeNote(MARGINAL, 'none', 12, false)).toBeUndefined();
    expect(rakeNote(PREMIUM, 'live-1-2', 12, false)).toBeUndefined();
    expect(rakeNote(MARGINAL, 'live-1-2', 12, false)).toContain('raise-or-fold');
  });
});
