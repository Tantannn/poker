import { describe, it, expect } from 'vitest';
import { projectRangeSet, resolveRangeSet, solverActive, solverActions, hasSolverChart } from './solverCharts';

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

// The shipped file used to be EMPTY and this suite asserted that. It now ships the
// hand-authored charts from scripts/authored-preflop.mjs, so the invariant worth
// pinning moved: the FALLBACK path must still work untouched for every scenario the
// charts don't cover (21 of 33 as of writing), because that is what keeps a partial
// chart set safe.
describe('solverCharts — fallback for uncovered scenarios', () => {
  it('is active (charts are shipped)', () => {
    expect(solverActive()).toBe(true);
  });

  // iso-btn / cold-vs-3bet / *-vs-4bet are the still-uncovered examples here. If a batch
  // authors one, repoint these to another scenario that stays on the heuristic.
  it('reports no chart for a scenario that is not covered', () => {
    expect(hasSolverChart('iso-btn')).toBe(false);
    expect(hasSolverChart('utg-vs-4bet')).toBe(false);
  });

  it('resolveRangeSet returns the fallback verbatim for an uncovered scenario', () => {
    const fallback = new Set(['AA', 'KK']);
    expect(resolveRangeSet('iso-btn', fallback)).toBe(fallback);
  });

  it('solverActions returns null for an uncovered scenario (caller falls back)', () => {
    expect(solverActions('iso-btn', 'AA')).toBeNull();
    expect(solverActions('cold-vs-3bet', 'AA')).toBeNull();
  });

  it('returns null for an unknown scenario id rather than throwing', () => {
    expect(solverActions('not-a-scenario', 'AA')).toBeNull();
    expect(hasSolverChart('not-a-scenario')).toBe(false);
  });
});

// Guards the shipped data itself, so a bad regeneration fails CI instead of quietly
// mis-grading hands. `authored-preflop.mjs` emits all 169 codes per chart on
// purpose: an ABSENT hand falls back to the heuristic, which would mix two engines
// inside one scenario.
describe('solverCharts — shipped chart integrity', () => {
  const COVERED = [
    'rfi-UTG', 'rfi-MP', 'rfi-CO', 'rfi-BTN', 'rfi-SB',
    'bb-vs-utg', 'bb-vs-mp', 'bb-vs-co', 'bb-vs-btn', 'bb-vs-sb',
    'sb-vs-btn',
    'btn-vs-co', 'btn-vs-mp', 'btn-vs-utg', 'co-vs-mp', 'co-vs-utg',
    'btn-vs-3bet', 'co-vs-3bet', 'utg-vs-3bet', 'sq-btn', 'sq-bb',
  ];

  // The OPPONENT-RANGE ids must stay on the heuristic. They are projected to a binary
  // set and used as the range a player holds POSTFLOP, so overriding them with a
  // defend/3-bet chart makes every villain read too wide and too weak — it tipped the
  // multiway bluff-catcher sweep in crossCheck.test.ts into value-betting an underpair
  // on a paired board. authored-preflop.mjs prunes them; this is the guard.
  it.each(['bb-defend', 'threebet'])('%s is NOT overridden', (id) => {
    expect(hasSolverChart(id)).toBe(false);
  });

  it.each(COVERED)('%s is present', (id) => {
    expect(hasSolverChart(id)).toBe(true);
  });

  it.each(COVERED)('%s covers all 169 codes with frequencies summing to 1', (id) => {
    const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
    const codes: string[] = [];
    for (let i = 0; i < 13; i++) codes.push(RANKS[i] + RANKS[i]);
    for (let i = 0; i < 13; i++)
      for (let j = i + 1; j < 13; j++) codes.push(RANKS[i] + RANKS[j] + 's', RANKS[i] + RANKS[j] + 'o');

    for (const code of codes) {
      const acts = solverActions(id, code);
      expect(acts, `${id} is missing ${code}`).not.toBeNull();
      const sum = (acts ?? []).reduce((a, x) => a + x.freq, 0);
      expect(sum, `${id} ${code} sums to ${sum}`).toBeCloseTo(1, 2);
    }
  });

  it('RFI charts widen monotonically UTG → BTN', () => {
    const width = (id: string) => projectWidth(id);
    expect(width('rfi-UTG')).toBeLessThan(width('rfi-MP'));
    expect(width('rfi-MP')).toBeLessThan(width('rfi-CO'));
    expect(width('rfi-CO')).toBeLessThan(width('rfi-BTN'));
  });

  it('BB defends wider vs a late open than vs an early one', () => {
    expect(projectWidth('bb-vs-utg')).toBeLessThan(projectWidth('bb-vs-mp'));
    expect(projectWidth('bb-vs-mp')).toBeLessThan(projectWidth('bb-vs-co'));
    expect(projectWidth('bb-vs-co')).toBeLessThan(projectWidth('bb-vs-btn'));
    expect(projectWidth('bb-vs-btn')).toBeLessThan(projectWidth('bb-vs-sb'));
  });

  it('IP vs-open defence widens vs a later opener, and the CO defends tighter than the BTN', () => {
    expect(projectWidth('btn-vs-utg')).toBeLessThan(projectWidth('btn-vs-mp'));
    expect(projectWidth('btn-vs-mp')).toBeLessThan(projectWidth('btn-vs-co'));
    expect(projectWidth('co-vs-utg')).toBeLessThan(projectWidth('co-vs-mp'));
    expect(projectWidth('co-vs-mp')).toBeLessThan(projectWidth('btn-vs-mp'));
    expect(projectWidth('co-vs-utg')).toBeLessThan(projectWidth('btn-vs-utg'));
  });

  it('premiums are never folded and trash is never opened', () => {
    for (const id of COVERED) {
      const aa = solverActions(id, 'AA') ?? [];
      const foldAA = aa.filter((x) => x.id === 'fold').reduce((a, x) => a + x.freq, 0);
      expect(foldAA, `${id} folds AA`).toBeLessThan(0.01);
    }
    for (const id of ['rfi-UTG', 'rfi-MP', 'rfi-CO']) {
      const junk = solverActions(id, '72o') ?? [];
      const played = junk.filter((x) => x.id !== 'fold').reduce((a, x) => a + x.freq, 0);
      expect(played, `${id} opens 72o`).toBeLessThan(0.01);
    }
  });
});

/** Combo-weighted width (0..1) of a chart's projected binary range. */
function projectWidth(id: string): number {
  const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  const codes: string[] = [];
  for (let i = 0; i < 13; i++) codes.push(RANKS[i] + RANKS[i]);
  for (let i = 0; i < 13; i++)
    for (let j = i + 1; j < 13; j++) codes.push(RANKS[i] + RANKS[j] + 's', RANKS[i] + RANKS[j] + 'o');
  let combos = 0;
  for (const code of codes) {
    const acts = solverActions(id, code) ?? [];
    const played = acts.filter((x) => x.id !== 'fold').reduce((a, x) => a + x.freq, 0);
    combos += played * (code.length === 2 ? 6 : code.endsWith('s') ? 4 : 12);
  }
  return combos / 1326;
}
