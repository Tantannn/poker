import { describe, it, expect } from 'vitest';
import { projectRangeSet, resolveRangeSet, solverActive, solverActions } from './solverCharts';

describe('solverCharts — range projection', () => {
  it('includes a hand only when non-fold frequency ≥ minPlay', () => {
    const chart = {
      AA: [{ a: 'open' as const, f: 1 }],
      AJo: [{ a: 'open' as const, f: 0.6 }, { a: 'fold' as const, f: 0.4 }], // 0.6 ≥ 0.5 → in
      K2o: [{ a: 'open' as const, f: 0.3 }, { a: 'fold' as const, f: 0.7 }], // 0.3 < 0.5 → out
      '72o': [{ a: 'fold' as const, f: 1 }], // pure fold → out
    };
    const set = projectRangeSet(chart);
    expect(set.has('AA')).toBe(true);
    expect(set.has('AJo')).toBe(true);
    expect(set.has('K2o')).toBe(false);
    expect(set.has('72o')).toBe(false);
  });

  it('respects a custom minPlay threshold', () => {
    const chart = { K2o: [{ a: 'open' as const, f: 0.3 }, { a: 'fold' as const, f: 0.7 }] };
    expect(projectRangeSet(chart, 0.25).has('K2o')).toBe(true);
    expect(projectRangeSet(chart, 0.5).has('K2o')).toBe(false);
  });
});

describe('solverCharts — empty file is a no-op', () => {
  it('ships inactive (empty charts) so the app uses heuristics', () => {
    expect(solverActive()).toBe(false);
  });

  it('resolveRangeSet returns the fallback verbatim when no chart exists', () => {
    const fallback = new Set(['AA', 'KK']);
    expect(resolveRangeSet('rfi-UTG', fallback)).toBe(fallback);
  });

  it('solverActions returns null when no chart exists (caller falls back)', () => {
    expect(solverActions('rfi-UTG', 'AA')).toBeNull();
  });
});
