// Recognising an ANONYMOUS seat. The archetype dials in ai/profiles.ts are not VPIP/PFR/AF,
// so nothing here predicts a stat value — it ranks archetypes by SIMILARITY on the three
// axes the profiling guide actually teaches, normalising both sides into their own span
// first. Everything is derived from PROFILE_LIST, so retuning a dial retunes the guide.
//
// Never reads the seat's hidden profileId: the ranking is built from observed stats and the
// public dial table only, which is what keeps anonymous mode honest.

import type { AIProfile } from '../ai/profiles';
import { PROFILE_LIST } from '../ai/profiles';
import type { ObservedStats } from './observed';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Two archetypes whose normalised dials sit this close are indistinguishable from static
 *  play — the honest verdict for TAG vs reg, which differ only by `adapt`. */
export const STATIC_TIE = 0.12;

/** One comparable axis: the countable observation, the stat that measures it, and the dial
 *  that drives it. `band` is the plausible LIVE span of the stat — an authored normalisation
 *  range (the dial span beside it is derived), and the UI labels it as one. */
export interface SignatureAxis {
  id: 'looseness' | 'aggression' | 'stickiness';
  label: string;
  watch: string;
  band: [number, number];
  /** sample at which this axis carries full weight */
  firmAt: number;
  statOf: (o: ObservedStats) => number | null;
  sampleOf: (o: ObservedStats) => number;
  dialOf: (p: AIProfile) => number;
  loLabel: string;
  hiLabel: string;
}

export const SIGNATURE_AXES: SignatureAxis[] = [
  {
    id: 'looseness',
    label: 'How many hands he plays',
    watch: 'Count the pots he voluntarily puts money into over one orbit (VPIP). Half his hands = loose; one an orbit = nit.',
    band: [0.12, 0.65],
    firmAt: 12,
    statOf: (o) => (o.hands > 0 ? o.vpip : null),
    sampleOf: (o) => o.hands,
    dialOf: (p) => p.openLooseness,
    loLabel: 'tight',
    hiLabel: 'loose',
  },
  {
    id: 'aggression',
    label: 'Does he raise or call',
    watch: 'Count his bets and raises against his calls (AF). Limping and flat-calling = passive; raising and 3-betting = aggressive.',
    band: [0.3, 3.5],
    firmAt: 10,
    statOf: (o) => o.af,
    sampleOf: (o) => o.hands,
    dialOf: (p) => (p.aggression + p.cbetFreq + p.bluffFreq) / 3,
    loLabel: 'passive',
    hiLabel: 'aggressive',
  },
  {
    id: 'stickiness',
    label: 'Does he fold to a bet',
    watch: 'Of the bets he faced, how many did he fold to? "I have to see it" with any pair = a station.',
    band: [0.15, 0.7],
    firmAt: 6,
    // A station is defined by NOT folding, so the axis is inverted fold-to-bet — that keeps
    // it pointing the same way as `callStation` and lets one distance formula serve all three.
    statOf: (o) => (o.foldToBet == null ? null : 1 - o.foldToBet),
    sampleOf: (o) => o.facedBetSample,
    dialOf: (p) => p.callStation,
    loLabel: 'folds correctly',
    hiLabel: 'calls too much',
  },
];

function dialSpan(axis: SignatureAxis, profiles: AIProfile[]): [number, number] {
  const vals = profiles.map(axis.dialOf);
  return [Math.min(...vals), Math.max(...vals)];
}

/** A dial as its position within the FIELD's own span — "loose for this table", which is how
 *  the guide teaches it and the only comparison that survives retuning the dials. */
export function normDial(axis: SignatureAxis, p: AIProfile, profiles: AIProfile[] = PROFILE_LIST): number {
  const [lo, hi] = dialSpan(axis, profiles);
  return hi === lo ? 0.5 : clamp01((axis.dialOf(p) - lo) / (hi - lo));
}

export function normStat(axis: SignatureAxis, v: number): number {
  const [lo, hi] = axis.band;
  return clamp01((v - lo) / (hi - lo));
}

export interface ArchetypeMatch {
  id: string;
  tag: string;
  name: string;
  /** 0 = his dials sit exactly where you've observed, 1 = the opposite corner */
  distance: number;
  /** how much sample backs the axes that were usable, 0..1 */
  confidence: number;
  usedAxes: SignatureAxis['id'][];
}

/** Rank the archetypes by how close their dials sit to what you have actually observed.
 *  An axis with no sample drops out entirely rather than defaulting — four hands in, the
 *  rank is honestly one-dimensional instead of confidently wrong on three. */
export function rankArchetypes(o: ObservedStats | null, profiles: AIProfile[] = PROFILE_LIST): ArchetypeMatch[] {
  const usable = (o ? SIGNATURE_AXES : [])
    .map((a) => {
      const v = a.statOf(o!);
      const w = Math.min(1, a.sampleOf(o!) / a.firmAt);
      return v == null || w <= 0 ? null : { a, target: normStat(a, v), w };
    })
    .filter((x): x is { a: SignatureAxis; target: number; w: number } => x !== null);
  const wTotal = usable.reduce((s, u) => s + u.w, 0);
  return profiles
    .map((p) => ({
      id: p.id,
      tag: p.tag,
      name: p.name,
      distance:
        wTotal === 0
          ? 0.5
          : usable.reduce((s, u) => s + u.w * Math.abs(u.target - normDial(u.a, p, profiles)), 0) / wTotal,
      confidence: wTotal === 0 ? 0 : wTotal / SIGNATURE_AXES.length,
      usedAxes: usable.map((u) => u.a.id),
    }))
    .sort((x, y) => x.distance - y.distance);
}

export interface Discriminator {
  /** null when static play cannot separate them */
  axis: SignatureAxis | null;
  gap: number;
  watch: string;
}

/** What separates two archetypes and what to watch to tell them apart. Returns a null axis
 *  when their dials are statically indistinguishable, which is the true answer for TAG vs
 *  reg: the difference is `adapt`, and adapting only shows once you have pressured him. */
export function discriminator(a: AIProfile, b: AIProfile, profiles: AIProfile[] = PROFILE_LIST): Discriminator {
  const top = SIGNATURE_AXES.map((ax) => ({
    ax,
    gap: Math.abs(normDial(ax, a, profiles) - normDial(ax, b, profiles)),
  })).sort((x, y) => y.gap - x.gap)[0];
  if (top.gap >= STATIC_TIE) {
    const hi = normDial(top.ax, a, profiles) > normDial(top.ax, b, profiles) ? a : b;
    return {
      axis: top.ax,
      gap: top.gap,
      watch: `${top.ax.label}: ${hi.tag} is the ${top.ax.hiLabel} one. ${top.ax.watch}`,
    };
  }
  const adaptGap = Math.abs((a.adapt ?? 0) - (b.adapt ?? 0));
  return {
    axis: null,
    gap: adaptGap,
    watch:
      adaptGap > 0.1
        ? `Static play cannot separate them — one COUNTER-ADJUSTS to you and the other doesn't. Bet at him for an orbit and watch whether his fold-to-bet drops (the ⚠ shift alert). A read that moves is the adapting one.`
        : `Nothing you can count separates them. Play them as the same opponent.`,
  };
}

export function nearestArchetype(p: AIProfile, profiles: AIProfile[] = PROFILE_LIST): AIProfile {
  const others = profiles.filter((q) => q.id !== p.id);
  return others
    .map((q) => ({
      q,
      d: SIGNATURE_AXES.reduce((s, ax) => s + Math.abs(normDial(ax, p, profiles) - normDial(ax, q, profiles)), 0),
    }))
    .sort((x, y) => x.d - y.d)[0].q;
}

export interface ArchetypeSignature {
  profile: AIProfile;
  quadrant: string;
  /** the axis this archetype is most extreme on — the thing that gives him away first */
  giveaway: { axis: SignatureAxis; high: boolean } | null;
  nearest: AIProfile;
  tellApart: Discriminator;
  /** normalised dial per axis, for rendering bars on the same scale as the match list */
  dials: { axis: SignatureAxis; v: number }[];
}

/** The loose/tight × aggressive/passive quadrant the first-orbit guide teaches, taken off the
 *  field's own median so it stays a relative judgement rather than an authored cut-off. */
function quadrantOf(p: AIProfile, profiles: AIProfile[]): string {
  const median = (ax: SignatureAxis) => {
    const vs = profiles.map((q) => normDial(ax, q, profiles)).sort((a, b) => a - b);
    return vs[Math.floor(vs.length / 2)];
  };
  const loose = SIGNATURE_AXES[0];
  const aggro = SIGNATURE_AXES[1];
  const l = normDial(loose, p, profiles) >= median(loose) ? 'Loose' : 'Tight';
  const a = normDial(aggro, p, profiles) >= median(aggro) ? 'aggressive' : 'passive';
  return `${l}-${a}`;
}

export function signatureFor(p: AIProfile, profiles: AIProfile[] = PROFILE_LIST): ArchetypeSignature {
  const median = (ax: SignatureAxis) => {
    const vs = profiles.map((q) => normDial(ax, q, profiles)).sort((a, b) => a - b);
    return vs[Math.floor(vs.length / 2)];
  };
  const spread = SIGNATURE_AXES.map((axis) => ({ axis, off: normDial(axis, p, profiles) - median(axis) })).sort(
    (x, y) => Math.abs(y.off) - Math.abs(x.off),
  )[0];
  const nearest = nearestArchetype(p, profiles);
  return {
    profile: p,
    quadrant: quadrantOf(p, profiles),
    giveaway: Math.abs(spread.off) < STATIC_TIE ? null : { axis: spread.axis, high: spread.off > 0 },
    nearest,
    tellApart: discriminator(p, nearest, profiles),
    dials: SIGNATURE_AXES.map((axis) => ({ axis, v: normDial(axis, p, profiles) })),
  };
}
