import { describe, it, expect } from 'vitest';
import type { ObservedStats } from '../analysis/observed';
import {
  BALANCED,
  balancedModel,
  bluffFreqFromBetFreq,
  callStationFromFoldToBet,
  foldToBetFromCallStation,
  isExploitable,
  resolveVillainModel,
} from './villainModel';

const obs = (o: Partial<ObservedStats>): ObservedStats => ({
  hands: 50,
  vpip: 0.25,
  pfr: 0.18,
  af: 2,
  foldToBet: null,
  betFreq: null,
  facedBetSample: 0,
  betChanceSample: 0,
  riverBetFreq: null,
  riverBetChanceSample: 0,
  turnBetFreq: null,
  barrelThrough: null,
  ledFlopSample: 0,
  ...o,
});

describe('villainModel — parameter mapping', () => {
  it('maps fold-to-bet inversely to stickiness', () => {
    expect(callStationFromFoldToBet(0.75)).toBeLessThan(callStationFromFoldToBet(0.45));
    expect(callStationFromFoldToBet(0.15)).toBeGreaterThan(callStationFromFoldToBet(0.45));
  });

  it('a balanced fold-to-bet reproduces the balanced stickiness exactly', () => {
    expect(callStationFromFoldToBet(0.45)).toBeCloseTo(BALANCED.callStation, 6);
  });

  it('a balanced bet frequency reproduces the balanced bluff frequency exactly', () => {
    expect(bluffFreqFromBetFreq(0.55)).toBeCloseTo(BALANCED.bluffFreq, 6);
  });

  it('maps bet frequency proportionally to how much of the bet range is air', () => {
    expect(bluffFreqFromBetFreq(0.85)).toBeGreaterThan(bluffFreqFromBetFreq(0.55));
    expect(bluffFreqFromBetFreq(0.2)).toBeLessThan(bluffFreqFromBetFreq(0.55));
  });

  it('clamps to a sane range at the extremes', () => {
    expect(callStationFromFoldToBet(1)).toBeGreaterThanOrEqual(0.05);
    expect(callStationFromFoldToBet(0)).toBeLessThanOrEqual(0.95);
    expect(bluffFreqFromBetFreq(1)).toBeLessThanOrEqual(0.9);
    expect(bluffFreqFromBetFreq(0)).toBeGreaterThanOrEqual(0.05);
  });
});

describe('villainModel — shrinkage', () => {
  it('with no read at all, returns the prior untouched', () => {
    const prior = { bluffFreq: 0.5, callStation: 0.7 };
    const m = resolveVillainModel(prior, null, null);
    expect(m.bluffFreq).toBe(0.5);
    expect(m.callStation).toBe(0.7);
    expect(m.source).toBe('prior');
    expect(m.confidence).toBe(0);
  });

  it('a tiny sample barely moves off the prior', () => {
    const prior = BALANCED;
    // 1 spot, folded every time — the raw read says "total nit"
    const m = resolveVillainModel(prior, obs({ foldToBet: 1, facedBetSample: 1 }), null);
    const raw = callStationFromFoldToBet(1);
    expect(m.confidence).toBeLessThan(0.1);
    // stays much nearer the prior than the raw read
    expect(Math.abs(m.callStation - prior.callStation)).toBeLessThan(Math.abs(raw - prior.callStation) / 2);
  });

  it('a large sample converges toward the raw read', () => {
    const m = resolveVillainModel(BALANCED, obs({ foldToBet: 0.8, facedBetSample: 200 }), null);
    expect(m.confidence).toBeGreaterThan(0.9);
    expect(m.callStation).toBeCloseTo(callStationFromFoldToBet(0.8), 1);
    expect(m.source).toBe('observed');
  });

  it('is monotone in sample size — more evidence means more movement', () => {
    // Assert on foldToBet, the PRIMITIVE the shrinkage runs in. callStation is a
    // clamped affine image of it, so at an extreme read (85% folds maps below the 0.05
    // floor) it saturates and equal values there are correct, not a monotonicity break.
    const foldAt = (n: number) =>
      resolveVillainModel(BALANCED, obs({ foldToBet: 0.85, facedBetSample: n }), null).foldToBet;
    expect(foldAt(30)).toBeGreaterThan(foldAt(10));
    expect(foldAt(100)).toBeGreaterThan(foldAt(30));
    expect(foldAt(1000)).toBeLessThanOrEqual(0.85); // never overshoots the observation

    // And the derived stickiness is monotone too, away from the clamp.
    const stickAt = (n: number) =>
      resolveVillainModel(BALANCED, obs({ foldToBet: 0.6, facedBetSample: n }), null).callStation;
    expect(stickAt(30)).toBeLessThan(stickAt(10));
    expect(stickAt(100)).toBeLessThan(stickAt(30));
  });

  it('carries foldToBet as the primitive, consistent with the derived callStation', () => {
    const m = resolveVillainModel(BALANCED, obs({ foldToBet: 0.6, facedBetSample: 200 }), null);
    expect(m.foldToBet).toBeCloseTo(0.6, 1);
    expect(m.callStation).toBeCloseTo(callStationFromFoldToBet(m.foldToBet), 6);
  });

  it('a locked foldToBet reaches the solver verbatim — no lossy round-trip', () => {
    // The CFR node lock builds villain's continue policy from this number, so it must
    // be exactly what the slider set, not a value recovered through a clamped map.
    for (const f of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      const m = resolveVillainModel(BALANCED, null, { enabled: true, foldToBet: f });
      expect(m.foldToBet).toBe(f);
    }
  });

  it('round-trips a prior expressed only as stickiness', () => {
    const m = resolveVillainModel({ bluffFreq: 0.33, callStation: 0.5 }, null, null);
    expect(foldToBetFromCallStation(0.5)).toBeCloseTo(m.foldToBet, 6);
    expect(callStationFromFoldToBet(m.foldToBet)).toBeCloseTo(0.5, 6);
  });

  it('shrinks each read on its own sample — a fold read does not borrow the bet read\'s evidence', () => {
    const m = resolveVillainModel(
      BALANCED,
      obs({ foldToBet: 0.8, facedBetSample: 200, betFreq: 0.9, betChanceSample: 1 }),
      null,
    );
    expect(m.callStation).toBeCloseTo(callStationFromFoldToBet(0.8), 1); // heavily weighted
    expect(m.bluffFreq).toBeCloseTo(BALANCED.bluffFreq, 1); // barely moved
  });

  it('prefers the RIVER bet read over the pooled one, which flop c-bets dominate', () => {
    // Pooled says he fires 90% of the time; the river says he fires at the balanced
    // rate. The river number wins, so the bluff read stays balanced.
    const m = resolveVillainModel(
      BALANCED,
      obs({ betFreq: 0.9, betChanceSample: 200, riverBetFreq: 0.42, riverBetChanceSample: 200 }),
      null,
    );
    expect(m.bluffFreq).toBeCloseTo(BALANCED.bluffFreq, 5);
    expect(bluffFreqFromBetFreq(0.9)).toBeGreaterThan(0.5); // what pooled WOULD have said
  });

  it('scores a river rate against the river reference, not the pooled one', () => {
    // 45% is under the pooled 0.55 (would read as under-bluffing) but over the river
    // 0.42 — so it must come out ABOVE balanced, not below.
    const m = resolveVillainModel(
      BALANCED,
      obs({ riverBetFreq: 0.45, riverBetChanceSample: 400 }),
      null,
    );
    expect(m.bluffFreq).toBeGreaterThan(BALANCED.bluffFreq);
    expect(bluffFreqFromBetFreq(0.45)).toBeLessThan(BALANCED.bluffFreq); // the inverted read we avoided
  });

  it('reads a heavy river barreller as air-heavy', () => {
    const m = resolveVillainModel(BALANCED, obs({ riverBetFreq: 0.8, riverBetChanceSample: 200 }), null);
    expect(m.bluffFreq).toBeGreaterThan(0.5);
    expect(m.label).toContain('barrels a lot');
  });

  it('falls back to the pooled read until a river spot exists', () => {
    const m = resolveVillainModel(BALANCED, obs({ betFreq: 0.9, betChanceSample: 200 }), null);
    expect(m.bluffFreq).toBeGreaterThan(0.5);
  });
});

describe('villainModel — locks', () => {
  it('a lock takes full weight with no shrinkage', () => {
    const m = resolveVillainModel(BALANCED, obs({ foldToBet: 0.45, facedBetSample: 500 }), {
      enabled: true,
      foldToBet: 0.8,
    });
    expect(m.source).toBe('locked');
    expect(m.confidence).toBe(1);
    expect(m.callStation).toBeCloseTo(callStationFromFoldToBet(0.8), 6);
  });

  it('a partial lock leaves the unlocked parameter on the prior', () => {
    const prior = { bluffFreq: 0.6, callStation: 0.2 };
    const m = resolveVillainModel(prior, null, { enabled: true, foldToBet: 0.7 });
    expect(m.bluffFreq).toBe(0.6);
    expect(m.callStation).toBeCloseTo(callStationFromFoldToBet(0.7), 6);
  });

  it('a disabled lock is ignored', () => {
    const m = resolveVillainModel(BALANCED, null, { enabled: false, foldToBet: 0.9 });
    expect(m.source).toBe('prior');
    expect(m.callStation).toBe(BALANCED.callStation);
  });

  it('an enabled lock with no values set falls through to the read', () => {
    const m = resolveVillainModel(BALANCED, obs({ foldToBet: 0.8, facedBetSample: 100 }), { enabled: true });
    expect(m.source).toBe('observed');
  });
});

describe('villainModel — exploitability gate', () => {
  it('a balanced model is not exploitable', () => {
    expect(isExploitable(balancedModel())).toBe(false);
  });

  it('a station and a nit both register as exploitable', () => {
    const station = resolveVillainModel(BALANCED, obs({ foldToBet: 0.1, facedBetSample: 100 }), null);
    const nit = resolveVillainModel(BALANCED, obs({ foldToBet: 0.85, facedBetSample: 100 }), null);
    expect(isExploitable(station)).toBe(true);
    expect(isExploitable(nit)).toBe(true);
    expect(station.callStation).toBeGreaterThan(nit.callStation);
  });

  it('labels a station and a nit differently, and says nothing about a balanced player', () => {
    const station = resolveVillainModel(BALANCED, obs({ foldToBet: 0.05, facedBetSample: 100 }), null);
    const nit = resolveVillainModel(BALANCED, obs({ foldToBet: 0.9, facedBetSample: 100 }), null);
    expect(station.label).toMatch(/sticky/i);
    expect(nit.label).toMatch(/folds too much/i);
    expect(balancedModel().label).toBeNull();
  });

  it('a read whose sample is too thin to move anything reports as prior', () => {
    const m = resolveVillainModel(BALANCED, obs({ foldToBet: 0.9, facedBetSample: 0 }), null);
    expect(m.source).toBe('prior');
  });
});

// Anonymous mode hides the bot's tag, so explain text must not name it. The flag
// defaults to hidden: a caller that forgets to pass it leaks nothing.
describe('villainModel — archetype visibility', () => {
  const thin = obs({ foldToBet: 0.9, facedBetSample: 0 });
  const solid = obs({ foldToBet: 0.85, facedBetSample: 100 });
  const lock = { enabled: true, foldToBet: 0.7 };

  it('defaults to hidden on every branch', () => {
    expect(balancedModel().archetypeVisible).toBe(false);
    expect(resolveVillainModel(BALANCED, thin, null).archetypeVisible).toBe(false);
    expect(resolveVillainModel(BALANCED, solid, null).archetypeVisible).toBe(false);
    expect(resolveVillainModel(BALANCED, null, lock).archetypeVisible).toBe(false);
  });

  it('rides through every branch when the tag is visible', () => {
    expect(resolveVillainModel(BALANCED, thin, null, true).archetypeVisible).toBe(true);
    expect(resolveVillainModel(BALANCED, solid, null, true).archetypeVisible).toBe(true);
    expect(resolveVillainModel(BALANCED, null, lock, true).archetypeVisible).toBe(true);
  });
});
