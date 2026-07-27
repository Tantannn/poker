import { describe, it, expect } from 'vitest';
import type { ObservedStats } from '../analysis/observed';
import {
  BALANCED,
  balancedModel,
  bluffFreqFromBetFreq,
  callStationFromFoldToBet,
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
    const at = (n: number) =>
      resolveVillainModel(BALANCED, obs({ foldToBet: 0.85, facedBetSample: n }), null).callStation;
    // folding 85% makes them a nit, so callStation should DROP further as n grows
    expect(at(30)).toBeLessThan(at(10));
    expect(at(100)).toBeLessThan(at(30));
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
