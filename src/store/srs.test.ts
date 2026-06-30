import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordSrs, weightOf, weightedIndex, NEW_WEIGHT, type SrsMap } from './srs';

// jsdom isn't configured for these node tests, so stub a minimal localStorage.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe('recordSrs', () => {
  it('raises weight on a miss and lowers it on a hit', () => {
    let m: SrsMap = {};
    m = recordSrs(m, 'card-A', false); // miss
    const afterMiss = weightOf(m, 'card-A');
    expect(afterMiss).toBeGreaterThan(NEW_WEIGHT); // surfaces more

    m = recordSrs(m, 'card-A', true); // hit
    expect(weightOf(m, 'card-A')).toBeLessThan(afterMiss); // fades
  });

  it('tracks seen/correct counts', () => {
    let m: SrsMap = {};
    m = recordSrs(m, 'x', true);
    m = recordSrs(m, 'x', false);
    expect(m['x'].seen).toBe(2);
    expect(m['x'].correct).toBe(1);
  });

  it('clamps weight within bounds even after a long streak', () => {
    let m: SrsMap = {};
    for (let i = 0; i < 20; i++) m = recordSrs(m, 'hard', false);
    expect(weightOf(m, 'hard')).toBeLessThanOrEqual(8);
    for (let i = 0; i < 20; i++) m = recordSrs(m, 'hard', true);
    expect(weightOf(m, 'hard')).toBeGreaterThanOrEqual(0.25);
  });
});

describe('weightedIndex', () => {
  it('favours higher-weighted entries', () => {
    // entry 2 has 10x the weight; with rng≈0.99 it should win, rng≈0 picks entry 0
    const weights = [1, 1, 10];
    expect(weightedIndex(weights, () => 0.99)).toBe(2);
    expect(weightedIndex(weights, () => 0)).toBe(0);
  });

  it('never returns the avoided index when alternatives exist', () => {
    const weights = [5, 5];
    expect(weightedIndex(weights, () => 0.0, 0)).toBe(1);
    expect(weightedIndex(weights, () => 0.99, 1)).toBe(0);
  });

  it('falls back gracefully when all weight is zeroed', () => {
    expect(weightedIndex([0, 0], () => 0.5)).toBeTypeOf('number');
  });
});
