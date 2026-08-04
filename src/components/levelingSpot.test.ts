// The generator's contract is that it never authors an answer — every one comes from
// readShifts. These tests pin that: the drill's correct answer must equal what the live coach
// would say about the same numbers, and the unactionable spots must really be unactionable.

import { describe, it, expect } from 'vitest';
import { counterFor, genSpot, COUNTERS, type Spot } from './levelingSpot';
import { emptyObs, readShifts, toStats } from '../analysis/observed';

// deterministic LCG so a failure is reproducible
function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const spots = (n: number): Spot[] => {
  const rng = rngFrom(7);
  return Array.from({ length: n }, () => genSpot(rng));
};

describe('counterFor', () => {
  it('maps each shift direction to the counter that beats it', () => {
    const mk = (stat: 'foldToBet' | 'betFreq', fromPct: number, toPct: number) => ({
      stat, fromPct, toPct, headline: '', advice: '', leveling: false,
    });
    expect(counterFor(mk('foldToBet', 55, 25))).toBe('stop-bluff');
    expect(counterFor(mk('foldToBet', 30, 65))).toBe('barrel-more');
    expect(counterFor(mk('betFreq', 40, 75))).toBe('bluffcatch');
    expect(counterFor(mk('betFreq', 70, 30))).toBe('take-lead');
  });

  it('no alert means no adjustment', () => {
    expect(counterFor(null)).toBe('keep-watching');
  });
});

describe('genSpot', () => {
  const all = spots(120);

  it('every answer is a real counter id', () => {
    for (const s of all) {
      expect(COUNTERS[s.first.answer]).toBeTruthy();
      if (s.second) expect(COUNTERS[s.second.answer]).toBeTruthy();
    }
  });

  it('an unactionable round-1 answers keep-watching and has no re-level', () => {
    const quiet = all.filter((s) => s.first.alert == null);
    expect(quiet.length).toBeGreaterThan(0);
    for (const s of quiet) {
      expect(s.first.answer).toBe('keep-watching');
      expect(s.second).toBeNull();
    }
  });

  it('an actionable round-1 never answers keep-watching', () => {
    const live = all.filter((s) => s.first.alert != null);
    expect(live.length).toBeGreaterThan(0);
    for (const s of live) expect(s.first.answer).not.toBe('keep-watching');
  });

  it('thin samples are never actionable — the sample gate is the pipeline\'s, not the drill\'s', () => {
    for (const s of all) if (s.first.sample < 8) expect(s.first.alert).toBeNull();
  });

  it('the re-level reverses the first move, so it needs the opposite counter', () => {
    for (const s of all) {
      if (!s.second) continue;
      const firstRose = s.first.toPct > s.first.fromPct;
      const secondRose = s.second.toPct > s.second.fromPct;
      expect(secondRose).toBe(!firstRose);
      expect(s.second.answer).not.toBe(s.first.answer);
    }
  });

  it('agrees with readShifts run independently on the displayed numbers', () => {
    for (const s of all) {
      if (!s.first.alert) continue;
      const a = s.first.alert;
      expect(counterFor(a)).toBe(s.first.answer);
      // the alert really is the one for this spot's stat
      expect(a.stat).toBe(s.stat);
    }
  });

  it('flags leveling only when the hero has been the aggressor', () => {
    for (const s of all) {
      if (s.first.alert?.leveling) expect(s.heroAggroPct).toBeGreaterThanOrEqual(55);
    }
  });

  it('produces both stats and both directions across a run', () => {
    expect(new Set(all.map((s) => s.stat)).size).toBe(2);
    const dirs = new Set(all.map((s) => s.first.toPct > s.first.fromPct));
    expect(dirs.size).toBe(2);
  });

  it('readShifts is the single source of truth (a leveling advice line is carried, not rewritten)', () => {
    const s = all.find((x) => x.first.alert?.leveling);
    expect(s).toBeTruthy();
    expect(s!.first.alert!.advice).toMatch(/adapting to YOU|answering your aggression/);
    // sanity: the SAME numbers are not "leveling" when the hero hasn't been the aggressor
    const stats = toStats({ ...emptyObs(), hands: 30, facedBet: 20, foldedToBet: 11, foldToBetRecent: 0.2 });
    expect(readShifts(stats, { heroAggro: 0.1 })[0].leveling).toBe(false);
    expect(readShifts(stats, { heroAggro: 0.8 })[0].leveling).toBe(true);
  });
});
