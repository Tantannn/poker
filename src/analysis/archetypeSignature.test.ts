import { describe, it, expect } from 'vitest';
import type { AIProfile } from '../ai/profiles';
import { PROFILE_LIST, getProfile } from '../ai/profiles';
import type { ObservedStats } from './observed';
import { SIGNATURE_AXES, STATIC_TIE, discriminator, nearestArchetype, rankArchetypes, signatureFor } from './archetypeSignature';

/** Only the fields the axes read; the rest of ObservedStats is irrelevant here. */
function obs(p: Partial<ObservedStats>): ObservedStats {
  return { hands: 0, vpip: 0, pfr: 0, af: null, foldToBet: null, facedBetSample: 0, ...p } as ObservedStats;
}

describe('archetype recognition: ranked from observed stats, derived from the dial table', () => {
  it('loose + passive + never folds ranks the calling station first', () => {
    const r = rankArchetypes(obs({ hands: 30, vpip: 0.6, af: 0.5, foldToBet: 0.18, facedBetSample: 12 }));
    expect(r[0].tag).toBe('LP');
  });

  it('loose + hyper-aggressive ranks the maniac first, and the nit last', () => {
    const r = rankArchetypes(obs({ hands: 30, vpip: 0.62, af: 3.4, foldToBet: 0.45, facedBetSample: 12 }));
    expect(r[0].tag).toBe('MANIAC');
    expect(r[r.length - 1].tag).toBe('NIT');
  });

  it('very tight ranks the nit first', () => {
    const r = rankArchetypes(obs({ hands: 30, vpip: 0.13, af: 1.4, foldToBet: 0.68, facedBetSample: 12 }));
    expect(r[0].tag).toBe('NIT');
  });

  it('an axis with no sample drops out instead of defaulting', () => {
    const vpipOnly = rankArchetypes(obs({ hands: 20, vpip: 0.6 }));
    expect(vpipOnly[0].usedAxes).toEqual(['looseness']);
    expect(vpipOnly[0].confidence).toBeLessThan(0.5);
    const all = rankArchetypes(obs({ hands: 30, vpip: 0.6, af: 0.5, foldToBet: 0.18, facedBetSample: 12 }));
    expect(all[0].usedAxes).toHaveLength(SIGNATURE_AXES.length);
    expect(all[0].confidence).toBeGreaterThan(vpipOnly[0].confidence);
  });

  it('no observation at all leaves every archetype tied', () => {
    const r = rankArchetypes(null);
    expect(new Set(r.map((m) => m.distance)).size).toBe(1);
    expect(r[0].usedAxes).toEqual([]);
    expect(r[0].confidence).toBe(0);
  });

  it('a thin sample weights the axis down rather than trusting it', () => {
    const thin = rankArchetypes(obs({ hands: 3, vpip: 0.6 }));
    expect(thin[0].confidence).toBeLessThan(0.2);
  });
});

describe('discriminator: what separates two archetypes', () => {
  it('station vs maniac is separated by a countable axis', () => {
    const d = discriminator(getProfile('lp'), getProfile('maniac'));
    expect(d.axis).not.toBeNull();
    expect(d.gap).toBeGreaterThan(STATIC_TIE);
  });

  it('TAG vs reg is statically indistinguishable and points at the adapt read instead', () => {
    const d = discriminator(getProfile('tag'), getProfile('reg'));
    expect(d.axis).toBeNull();
    expect(d.watch).toMatch(/COUNTER-ADJUSTS/);
  });

  it('is symmetric', () => {
    const a = discriminator(getProfile('nit'), getProfile('lag'));
    const b = discriminator(getProfile('lag'), getProfile('nit'));
    expect(a.axis?.id).toBe(b.axis?.id);
    expect(a.watch).toBe(b.watch);
  });
});

describe('signatures are derived, not authored', () => {
  it('every archetype gets a quadrant, a nearest neighbour and three dials', () => {
    for (const p of PROFILE_LIST) {
      const s = signatureFor(p);
      expect(s.quadrant).toMatch(/^(Loose|Tight)-(aggressive|passive)$/);
      expect(s.nearest.id).not.toBe(p.id);
      expect(s.dials).toHaveLength(SIGNATURE_AXES.length);
      for (const d of s.dials) expect(d.v).toBeGreaterThanOrEqual(0);
    }
  });

  it('retuning a dial retunes the signature — nothing is hard-coded per archetype', () => {
    const field: AIProfile[] = PROFILE_LIST.map((p) =>
      p.id === 'nit' ? { ...p, openLooseness: 1, aggression: 1, cbetFreq: 1, bluffFreq: 1 } : p,
    );
    const nit = field.find((p) => p.id === 'nit')!;
    expect(signatureFor(nit, field).quadrant).toBe('Loose-aggressive');
  });

  // The near-balanced trio is a closed clique: each one's nearest is another of the three,
  // which is why the panel has to fall back to the adapt read to separate them at all.
  it('tag / gto / reg are only ever confusable with each other', () => {
    const balanced = ['tag', 'gto', 'reg'];
    for (const id of balanced) expect(balanced).toContain(nearestArchetype(getProfile(id)).id);
  });
});
