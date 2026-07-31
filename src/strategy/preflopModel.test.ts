import { describe, it, expect } from 'vitest';
import type { ObservedStats } from '../analysis/observed';
import {
  PF_BALANCED,
  applyPreflopRead,
  balancedPreflopRead,
  isPreflopExploitable,
  preflopAdjust,
  rangeMultForRole,
  resizeRangeByStrength,
  resolvePreflopRead,
} from './preflopModel';
import { preflopStrength } from '../ai/preflop';
import type { ActionOption } from './types';

const obs = (o: Partial<ObservedStats>): ObservedStats =>
  ({
    hands: 60, vpip: 0.25, pfr: 0.18, af: 2,
    foldToBet: null, betFreq: null, facedBetSample: 0, betChanceSample: 0,
    riverBetFreq: null, riverBetChanceSample: 0, turnBetFreq: null,
    barrelThrough: null, ledFlopSample: 0,
    openFreq: null, openSample: 0, threeBetFreq: null, threeBetSample: 0,
    foldToThreeBet: null, foldToThreeBetSample: 0,
    ...o,
  }) as ObservedStats;

describe('resolvePreflopRead — shrinkage', () => {
  it('no observation and no lock is balanced, and moves nothing', () => {
    const r = resolvePreflopRead(null, null);
    expect(r).toEqual(balancedPreflopRead());
    expect(isPreflopExploitable(r)).toBe(false);
    expect(preflopAdjust(2, '87s', r)).toEqual({ valueMult: 1, bluffMult: 1, callMult: 1, why: null });
  });

  it('one 3-bet spot barely moves the read; a hundred nearly reaches it', () => {
    const thin = resolvePreflopRead(obs({ threeBetFreq: 0.4, threeBetSample: 1 }));
    const solid = resolvePreflopRead(obs({ threeBetFreq: 0.4, threeBetSample: 200 }));
    expect(thin.threeBetFreq).toBeLessThan(0.1);
    expect(solid.threeBetFreq).toBeGreaterThan(0.35);
    expect(thin.confidence).toBeLessThan(solid.confidence);
  });

  it('each read shrinks on ITS OWN sample, not a pooled hand count', () => {
    // 200 open chances but only 2 faced-3-bet spots: the open read converges while
    // the fold read stays near the prior. A shared denominator would trust both.
    const r = resolvePreflopRead(obs({ openFreq: 0.5, openSample: 200, foldToThreeBet: 1, foldToThreeBetSample: 2 }));
    expect(r.openFreq).toBeGreaterThan(0.44);
    expect(r.foldToThreeBet).toBeLessThan(0.72);
  });

  it('a lock is an assertion — full weight, no shrinkage', () => {
    const r = resolvePreflopRead(obs({ threeBetFreq: 0.05, threeBetSample: 300 }), { threeBetFreq: 0.25 }, true);
    expect(r.threeBetFreq).toBe(0.25);
    expect(r.source).toBe('locked');
    expect(r.confidence).toBe(1);
  });

  it('a disabled lock is ignored', () => {
    const r = resolvePreflopRead(null, { threeBetFreq: 0.25 }, false);
    expect(r.threeBetFreq).toBe(PF_BALANCED.threeBetFreq);
  });
});

describe('preflopAdjust — direction', () => {
  const wide3bettor = resolvePreflopRead(obs({ threeBetFreq: 0.22, threeBetSample: 300 }));
  const nit3bettor = resolvePreflopRead(obs({ threeBetFreq: 0.02, threeBetSample: 300 }));

  it('a premium is read-proof — AA opens and 4-bets against everyone', () => {
    for (const r of [wide3bettor, nit3bettor]) {
      expect(preflopAdjust(2, 'AA', r)).toEqual({ valueMult: 1, bluffMult: 1, callMult: 1, why: null });
    }
  });

  it('vs a wide 3-bettor the marginal continues and value 4-bets widen', () => {
    const a = preflopAdjust(2, 'A5s', wide3bettor);
    expect(a.valueMult).toBeGreaterThan(1);
    expect(a.callMult).toBeGreaterThan(1);
    expect(a.why).toMatch(/wider than the chart/);
  });

  it("vs a nit's 3-bet the bluff re-raises die first and hardest", () => {
    const a = preflopAdjust(2, 'A5s', nit3bettor);
    expect(a.bluffMult).toBeLessThan(1);
    expect(a.callMult).toBeLessThan(1);
    // the bluff is cut further than the value continue — a 4-bet bluff into a range
    // that never folds is the worst of the two, not merely the same mistake
    expect(a.bluffMult).toBeLessThan(a.valueMult);
  });

  it('facing a 4-bet the same signal is damped — a 4-bet is tighter for everyone', () => {
    const three = preflopAdjust(2, 'A5s', wide3bettor);
    const four = preflopAdjust(3, 'A5s', wide3bettor);
    expect(four.valueMult).toBeGreaterThan(1);
    expect(four.valueMult).toBeLessThan(three.valueMult);
  });

  it('vs an opener who folds to 3-bets, the bluff 3-bet gains most', () => {
    const folder = resolvePreflopRead(obs({ foldToThreeBet: 0.85, foldToThreeBetSample: 60 }));
    const a = preflopAdjust(1, 'K8s', folder);
    expect(a.bluffMult).toBeGreaterThan(1.15);
    expect(a.why).toMatch(/light 3-bets print/);
  });

  it('vs an opener who never folds, bluff 3-bets are cut and flatting takes over', () => {
    const sticky = resolvePreflopRead(obs({ foldToThreeBet: 0.15, foldToThreeBetSample: 60 }));
    const a = preflopAdjust(1, 'K8s', sticky);
    expect(a.bluffMult).toBeLessThan(1);
    expect(a.callMult).toBeGreaterThan(a.bluffMult);
  });

  it('a wide opener is defended wider; a tight opener tighter', () => {
    const loose = preflopAdjust(1, 'K8s', resolvePreflopRead(obs({ openFreq: 0.5, openSample: 200 })));
    const tight = preflopAdjust(1, 'K8s', resolvePreflopRead(obs({ openFreq: 0.1, openSample: 200 })));
    expect(loose.callMult).toBeGreaterThan(1);
    expect(tight.callMult).toBeLessThan(1);
  });

  it('a 3-bettor behind taxes the steal tail; a passive field lets it run', () => {
    const taxed = preflopAdjust(0, '96s', wide3bettor);
    const free = preflopAdjust(0, '96s', nit3bettor);
    expect(taxed.valueMult).toBeLessThan(1);
    expect(free.valueMult).toBeGreaterThan(1);
    expect(taxed.why).toMatch(/open tighter/);
  });
});

describe('applyPreflopRead', () => {
  const cell = (): ActionOption[] => [
    { id: 'raise', label: '3-Bet (bluff)', freq: 0.3, ev: 0, kind: 'bluff' },
    { id: 'call', label: 'Call', freq: 0.3, ev: 0, kind: 'call' },
    { id: 'fold', label: 'Fold', freq: 0.4, ev: 0, kind: 'fold' },
  ];
  const total = (o: ActionOption[]) => o.reduce((a, x) => a + x.freq, 0);

  it('stays a probability distribution in both directions', () => {
    for (const adj of [
      { valueMult: 1, bluffMult: 2.2, callMult: 1.6, why: 'x' },
      { valueMult: 1, bluffMult: 0.2, callMult: 0.5, why: 'x' },
    ]) {
      expect(total(applyPreflopRead(cell(), adj, 'A5s'))).toBeCloseTo(1, 9);
    }
  });

  it('fold absorbs the change — bluffing more means folding less', () => {
    const out = applyPreflopRead(cell(), { valueMult: 1, bluffMult: 2, callMult: 1, why: 'x' }, 'A5s');
    expect(out.find((o) => o.id === 'raise')!.freq).toBeCloseTo(0.6, 9);
    expect(out.find((o) => o.id === 'fold')!.freq).toBeCloseTo(0.1, 9);
  });

  it('overshooting 100% renormalises instead of producing a negative fold', () => {
    const out = applyPreflopRead(cell(), { valueMult: 1, bluffMult: 2.2, callMult: 1.6, why: 'x' }, 'A5s');
    expect(out.find((o) => o.id === 'fold')!.freq).toBe(0);
    expect(total(out)).toBeCloseTo(1, 9);
    for (const o of out) expect(o.freq).toBeGreaterThanOrEqual(0);
  });

  it('a cell the chart always plays can start folding — a read is not a nudge', () => {
    const noFold: ActionOption[] = [{ id: 'call', label: 'Call', freq: 1, ev: 0, kind: 'call' }];
    const out = applyPreflopRead(noFold, { valueMult: 1, bluffMult: 1, callMult: 0.8, why: 'x' }, 'AQo');
    expect(out.find((o) => o.id === 'call')!.freq).toBeCloseTo(0.8, 9);
    expect(out.find((o) => o.id === 'fold')!.freq).toBeCloseTo(0.2, 9);
  });

  it('is identity when the read moves nothing', () => {
    const c = cell();
    expect(applyPreflopRead(c, { valueMult: 1, bluffMult: 1, callMult: 1, why: null }, 'A5s')).toBe(c);
  });
});

describe('applyPreflopRead — promoting a hand the chart folds', () => {
  const pureFold = (): ActionOption[] => [{ id: 'fold', label: 'Fold', freq: 1, ev: 0, kind: 'fold' }];
  const aggr = { id: 'raise' as const, label: '3-Bet (read)' };
  const big = { valueMult: 1, bluffMult: 1.5, callMult: 1, why: 'x' };

  it('gives a decent folded hand a bluff-raise when the opponent over-folds', () => {
    const out = applyPreflopRead(pureFold(), big, 'K9s', aggr);
    const raise = out.find((o) => o.id === 'raise');
    expect(raise?.freq).toBeGreaterThan(0);
    expect(raise?.kind).toBe('bluff');
    expect(out.reduce((a, o) => a + o.freq, 0)).toBeCloseTo(1, 9);
  });

  it('never promotes junk, however badly he folds', () => {
    for (const code of ['32o', '72o', 'A2s'])
      expect(applyPreflopRead(pureFold(), { ...big, bluffMult: 2.2 }, code, aggr).some((o) => o.id === 'raise')).toBe(false);
  });

  it('needs an opt-in — multiway callers withhold it because bluffs have no fold equity', () => {
    expect(applyPreflopRead(pureFold(), big, 'K9s').some((o) => o.id === 'raise')).toBe(false);
  });

  it('does not promote when the read points the other way', () => {
    expect(applyPreflopRead(pureFold(), { ...big, bluffMult: 0.5 }, 'K9s', aggr).some((o) => o.id === 'raise')).toBe(false);
  });

  it('caps how much of a folded hand the read can turn into a raise', () => {
    const out = applyPreflopRead(pureFold(), { ...big, bluffMult: 5 }, 'KQs', aggr);
    expect(out.find((o) => o.id === 'raise')!.freq).toBeLessThanOrEqual(0.3);
  });
});

describe('resizeRangeByStrength — the range the postflop engine inherits', () => {
  const base = new Set(['AA', 'KK', 'QQ', 'AKs', 'AQs', 'AJs', 'KQs', 'ATs', 'KJs', 'QJs']);

  it('widening keeps every original hand and admits the strongest outsiders', () => {
    const wider = resizeRangeByStrength(base, 1.6);
    expect(wider.size).toBeGreaterThan(base.size);
    for (const c of base) expect(wider.has(c)).toBe(true);
    const added = [...wider].filter((c) => !base.has(c));
    const weakestKept = Math.min(...added.map(preflopStrength));
    // nothing junk crept in ahead of a hand it is plainly worse than
    expect(weakestKept).toBeGreaterThan(preflopStrength('32o'));
  });

  it('tightening drops the weakest, never the top of the range', () => {
    const tighter = resizeRangeByStrength(base, 0.6);
    expect(tighter.size).toBeLessThan(base.size);
    expect(tighter.has('AA')).toBe(true);
    for (const c of tighter) expect(base.has(c)).toBe(true);
  });

  it('clamps — a thin read cannot invent a range twice the chart', () => {
    expect(resizeRangeByStrength(base, 9).size).toBeLessThanOrEqual(Math.round(base.size * 1.8));
    expect(resizeRangeByStrength(base, 0.01).size).toBeGreaterThanOrEqual(Math.round(base.size * 0.6));
  });

  it('a balanced read moves nothing, for any role', () => {
    const bal = balancedPreflopRead();
    for (const role of ['open', 'threebet', 'continue'] as const) {
      expect(rangeMultForRole(role, bal)).toBe(1);
      expect(resizeRangeByStrength(base, rangeMultForRole(role, bal))).toBe(base);
    }
  });

  it('a 20% 3-bettor is projected with a wider 3-bet range than the chart', () => {
    const r = resolvePreflopRead(obs({ threeBetFreq: 0.2, threeBetSample: 300 }));
    expect(rangeMultForRole('threebet', r)).toBeGreaterThan(1.5);
    expect(resizeRangeByStrength(base, rangeMultForRole('threebet', r)).size).toBeGreaterThan(base.size);
  });

  it('the continue role damps the open read rather than mirroring it', () => {
    const r = resolvePreflopRead(obs({ openFreq: 0.52, openSample: 300 }));
    expect(rangeMultForRole('continue', r)).toBeGreaterThan(1);
    expect(rangeMultForRole('continue', r)).toBeLessThan(rangeMultForRole('open', r));
  });
});
