// Preflop read layer — the analogue of villainModel.ts for the street the node
// lock never reached.
//
// The preflop node is a static chart (preflopChart.ts + solverPreflop.json), so
// before this module the recommended 5-bet-bluff / flat / fold mix facing a
// maniac's 4-bet was IDENTICAL to the mix facing a nit's. Against the players this
// app targets that is the single biggest missing exploit: a low-stakes regular's
// preflop frequencies deviate far further from balanced than his postflop ones,
// and they leak into every hand, not just the ones that see a flop.
//
// Three observed rates drive it, each shrunk toward a balanced prior by ITS OWN
// decision count (analysis/observed.ts), with a manual lock overriding outright —
// the same shape villainModel.ts uses, for the same reason: a read is only worth
// acting on in proportion to how much of it you have actually seen.
//
// Two consumers:
//   1. the chart frequencies at hero's node (preflopAdjust → applyPreflopRead)
//   2. the projected preflop range the POSTFLOP engines inherit
//      (resizeRangeByStrength, via index.ts: roleBaseRange) — a player who 3-bets
//      20% modelled on the chart's 8% range reads too tight and too strong on
//      later streets, which is the direction that costs hero money against him.

import type { ObservedStats } from '../analysis/observed';
import { preflopStrength } from '../ai/preflop';
import { ALL_169 } from './preflopChart';
import type { ActionId, ActionOption, ReadStat } from './types';

/** Balanced ~100bb 6-max baselines — what the charts themselves assume, so a read
 *  equal to these leaves every frequency untouched.
 *  openFreq's denominator is UNOPENED pots with the blinds excluded, which averages
 *  across seats (UTG ~15%, BTN ~45%); it is not any one seat's RFI. */
export const PF_BALANCED = { openFreq: 0.26, threeBetFreq: 0.08, foldToThreeBet: 0.55 } as const;

/** Sample sizes at which an observed rate gets half its weight (n/(n+K)), keyed on
 *  that read's own decision count. Faced-3-bet spots are far rarer than open
 *  chances, so a shared constant would pin the fold read to the prior for a whole
 *  session while the open read had long since converged. */
const PF_HALF_WEIGHT = { open: 25, threeBet: 20, foldToThreeBet: 6 } as const;

/** Manual preflop assertions. Absent fields keep the observed/prior value, so you
 *  can lock "he 3-bets 20%" and leave the rest alone. Carried on VillainLock. */
export interface PreflopLock {
  /** 0..1 — assume he opens this often from an unopened pot */
  openFreq?: number;
  /** 0..1 — assume he 3-bets this often facing an open */
  threeBetFreq?: number;
  /** 0..1 — assume he folds his open this often facing a 3-bet */
  foldToThreeBet?: number;
}

export interface PreflopRead {
  openFreq: number;
  threeBetFreq: number;
  foldToThreeBet: number;
  source: 'balanced' | 'observed' | 'locked';
  /** 0..1 — how much of the read survived shrinkage. 0 = pure prior. */
  confidence: number;
  /** one-line read for the Explain panel, or null when nothing is notable */
  label: string | null;
  /** decisions behind each rate, for the explain panel. `confidence` is the maximum
   *  of the three weights, so it cannot say WHICH number is thin — and a firm 3-bet
   *  read sitting next to a one-spot fold read is the case the player must see. */
  samples?: { open: number; threeBet: number; foldToThreeBet: number };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export const balancedPreflopRead = (): PreflopRead => ({
  ...PF_BALANCED,
  source: 'balanced',
  confidence: 0,
  label: null,
  samples: { open: 0, threeBet: 0, foldToThreeBet: 0 },
});

function shrink(observed: number, prior: number, n: number, halfWeight: number) {
  const w = n / (n + halfWeight);
  return { value: prior + (observed - prior) * w, weight: w };
}

function describe(r: { openFreq: number; threeBetFreq: number; foldToThreeBet: number }, locked: boolean, conf: number) {
  const parts: string[] = [];
  if (r.threeBetFreq >= 0.13) parts.push('3-bets far too wide — his re-raise is not a premium');
  else if (r.threeBetFreq <= 0.045) parts.push('almost never 3-bets — a 3-bet from him is the top of his range');
  if (r.foldToThreeBet >= 0.7) parts.push('folds his opens to 3-bets — light 3-bets print');
  else if (r.foldToThreeBet <= 0.35) parts.push('never folds his open — 3-bet him for value only');
  if (r.openFreq >= 0.38) parts.push('opens far too many pots — defend wider');
  else if (r.openFreq <= 0.15) parts.push('opens tight — his raise is a real range');
  if (!parts.length) return null;
  const strength = locked ? 'locked' : conf >= 0.6 ? 'solid read' : conf >= 0.3 ? 'developing read' : 'thin read';
  return `${parts.join('; ')} (${strength})`;
}

/**
 * Resolve the preflop read the chart layer should adjust against.
 *
 * Unlike the postflop model there is no archetype prior on offer: the bot profiles
 * carry no preflop-frequency fields, and reading them would leak what anonymous
 * mode hides. The prior is always balanced.
 */
export function resolvePreflopRead(obs?: ObservedStats | null, lock?: PreflopLock | null, lockEnabled = false): PreflopRead {
  if (lockEnabled && lock && (lock.openFreq != null || lock.threeBetFreq != null || lock.foldToThreeBet != null)) {
    const r = {
      openFreq: lock.openFreq ?? PF_BALANCED.openFreq,
      threeBetFreq: lock.threeBetFreq ?? PF_BALANCED.threeBetFreq,
      foldToThreeBet: lock.foldToThreeBet ?? PF_BALANCED.foldToThreeBet,
    };
    return {
      ...r,
      source: 'locked',
      confidence: 1,
      label: describe(r, true, 1),
      samples: { open: 0, threeBet: 0, foldToThreeBet: 0 },
    };
  }

  const hasOpen = obs?.openFreq != null && obs.openSample > 0;
  const has3 = obs?.threeBetFreq != null && obs.threeBetSample > 0;
  const hasF3 = obs?.foldToThreeBet != null && obs.foldToThreeBetSample > 0;
  if (!obs || (!hasOpen && !has3 && !hasF3)) return balancedPreflopRead();

  const open = hasOpen
    ? shrink(obs.openFreq as number, PF_BALANCED.openFreq, obs.openSample, PF_HALF_WEIGHT.open)
    : { value: PF_BALANCED.openFreq, weight: 0 };
  const three = has3
    ? shrink(obs.threeBetFreq as number, PF_BALANCED.threeBetFreq, obs.threeBetSample, PF_HALF_WEIGHT.threeBet)
    : { value: PF_BALANCED.threeBetFreq, weight: 0 };
  const foldTo3 = hasF3
    ? shrink(obs.foldToThreeBet as number, PF_BALANCED.foldToThreeBet, obs.foldToThreeBetSample, PF_HALF_WEIGHT.foldToThreeBet)
    : { value: PF_BALANCED.foldToThreeBet, weight: 0 };

  const confidence = Math.max(open.weight, three.weight, foldTo3.weight);
  const r = { openFreq: open.value, threeBetFreq: three.value, foldToThreeBet: foldTo3.value };
  return {
    ...r,
    source: confidence > 0.05 ? 'observed' : 'balanced',
    confidence,
    label: describe(r, false, confidence),
    samples: {
      open: hasOpen ? obs.openSample : 0,
      threeBet: has3 ? obs.threeBetSample : 0,
      foldToThreeBet: hasF3 ? obs.foldToThreeBetSample : 0,
    },
  };
}

/** Is this read far enough off balanced to be worth a second (baseline) chart pass
 *  for the exploit-delta display? Below these the two lines come out identical. */
export function isPreflopExploitable(r: PreflopRead): boolean {
  return (
    Math.abs(r.threeBetFreq - PF_BALANCED.threeBetFreq) > 0.015 ||
    Math.abs(r.foldToThreeBet - PF_BALANCED.foldToThreeBet) > 0.06 ||
    Math.abs(r.openFreq - PF_BALANCED.openFreq) > 0.05
  );
}

// ---------------- chart adjustment ----------------

/** Raise level at hero's node: 0 = unopened (RFI), 1 = facing one open,
 *  2 = facing a 3-bet, 3 = facing a 4-bet. Mirrors pickPreflopScenario's `level`. */
export type PreflopLevel = 0 | 1 | 2 | 3;

export interface PreflopAdjust {
  valueMult: number;
  bluffMult: number;
  callMult: number;
  why: string | null;
}

export const NO_PREFLOP_ADJUST: PreflopAdjust = { valueMult: 1, bluffMult: 1, callMult: 1, why: null };

/** How far a chart cell may move for a read. Premiums are read-proof — AA opens and
 *  4-bets against everyone — so the adjustment tapers to nothing above ~0.82 strength
 *  and reaches full force only on the genuinely marginal tail, which is where every
 *  preflop exploit actually lives. */
export function marginality(code: string): number {
  return clamp((0.82 - preflopStrength(code)) / 0.3, 0, 1);
}

const taper = (mult: number, m: number) => 1 + (mult - 1) * m;

/**
 * Read → per-kind frequency multipliers at hero's node.
 *
 * The read belongs to the opponent the decision is ABOUT: the opener when hero
 * faces an open, the 3-bettor when hero faces a 3-bet, and — at an unopened pot —
 * the seat behind most likely to punish the open.
 */
export function preflopAdjust(level: PreflopLevel, code: string, read: PreflopRead): PreflopAdjust {
  const m = marginality(code);
  if (m <= 0 || read.source === 'balanced') return NO_PREFLOP_ADJUST;
  const sq = read.threeBetFreq / PF_BALANCED.threeBetFreq;
  const wide = read.openFreq / PF_BALANCED.openFreq;
  const folds = read.foldToThreeBet / PF_BALANCED.foldToThreeBet;

  if (level === 0) {
    // A 3-bet-happy seat behind taxes the steal tail: hero's weakest opens win the
    // blinds least often and get blown off the pot most often, so they go first.
    const open = clamp(1 - 0.45 * (sq - 1), 0.65, 1.3);
    const why =
      Math.abs(open - 1) < 0.04
        ? null
        : open < 1
          ? `Someone behind 3-bets ~${(read.threeBetFreq * 100).toFixed(0)}% (balanced is ~${(PF_BALANCED.threeBetFreq * 100).toFixed(0)}%) — the marginal opens get re-raised off the pot, so open tighter here.`
          : `Nobody behind is 3-betting (~${(read.threeBetFreq * 100).toFixed(0)}%) — the steal tail runs unpunished, so open wider.`;
    return { valueMult: taper(open, m), bluffMult: taper(open, m), callMult: taper(open, m), why };
  }

  if (level === 1) {
    // Two independent channels: how WIDE he opens prices hero's flat (his range is
    // weak), how often he FOLDS to a 3-bet prices hero's bluff-raise (fold equity).
    // They pull the call/raise split apart — a wide opener who never folds is a
    // flatting target, a tight opener who folds is a 3-bet-bluff target.
    const bluffMult = clamp(1 + 0.8 * (folds - 1) + 0.5 * (wide - 1), 0.2, 2.2);
    const callMult = clamp(1 + 0.45 * (wide - 1) - 0.3 * (folds - 1), 0.5, 1.6);
    const valueMult = clamp(1 + 0.2 * (wide - 1), 0.85, 1.2);
    const bits: string[] = [];
    if (Math.abs(wide - 1) >= 0.15)
      bits.push(
        wide > 1
          ? `he opens ~${(read.openFreq * 100).toFixed(0)}% of unopened pots, so his range is weak — defend wider`
          : `he opens only ~${(read.openFreq * 100).toFixed(0)}%, so his raise is a real range — defend tighter`,
      );
    if (Math.abs(folds - 1) >= 0.15)
      bits.push(
        folds > 1
          ? `he folds ~${(read.foldToThreeBet * 100).toFixed(0)}% of his opens to a 3-bet — light 3-bets print`
          : `he folds only ~${(read.foldToThreeBet * 100).toFixed(0)}% to a 3-bet — 3-bet him for value, not as a bluff`,
      );
    return { valueMult: taper(valueMult, m), bluffMult: taper(bluffMult, m), callMult: taper(callMult, m), why: bits.join('; ') || null };
  }

  // Facing a 3-bet or a 4-bet: how often he 3-bets IS the composition of the range
  // hero is now up against. A 20% 3-bettor is re-raising hands the chart has him
  // folding, so hero's 4-bet gets value and his continues widen; a 4% 3-bettor is
  // showing the nuts, and a 4-bet bluff against that is lighting money on fire.
  // Level 3 damps the same signal — a 4-bet is tighter than a 3-bet for everyone,
  // and there is no observed 4-bet rate to key on.
  const damp = level === 3 ? 0.72 : 1;
  const valueMult = clamp(1 + 0.35 * damp * (sq - 1), 0.7, 1.5);
  const callMult = clamp(1 + 0.3 * damp * (sq - 1), 0.6, 1.5);
  const bluffMult = clamp(1 + 0.55 * damp * (sq - 1), 0.1, 1.8);
  const word = level === 3 ? '4-bet' : '3-bet';
  const why =
    Math.abs(sq - 1) < 0.15
      ? null
      : sq > 1
        ? `He 3-bets ~${(read.threeBetFreq * 100).toFixed(0)}% (balanced ~${(PF_BALANCED.threeBetFreq * 100).toFixed(0)}%), so this ${word} is far wider than the chart assumes — continue more and re-raise more for value.`
        : `He 3-bets only ~${(read.threeBetFreq * 100).toFixed(0)}%, so this ${word} is the top of his range — fold the marginal continues and drop the bluff re-raises.`;
  return { valueMult: taper(valueMult, m), bluffMult: taper(bluffMult, m), callMult: taper(callMult, m), why };
}

// ---------------- explaining the adjustment ----------------
//
// The chart layer moves frequencies silently, which teaches nothing: the player sees a
// different mix and has no way to tell a read from a chart. These three build the
// "why" — the numbers, what each one prices HERE, and what to watch for at a live
// table to collect it yourself. `spot` is deliberately phrased as a countable
// observation (raise-first-ins per orbit), not a HUD stat, because live is where the
// app's target player actually has to build the read.

const PF_STAT_SPOT = {
  open: 'Count his raise-first-ins over one orbit. 2+ in a 6-handed orbit is wide; a full orbit with none means his raise is a real range.',
  threeBet: 'Every time someone opens and he re-raises, that is one. Balanced is ~once every other orbit — twice in one orbit is already wide.',
  foldToThreeBet: 'Only visible when HE opened and got 3-bet. Two folds is a usable read; one call tells you almost nothing.',
} as const;

export function preflopReadStats(level: PreflopLevel, read: PreflopRead): ReadStat[] {
  const s = read.samples ?? { open: 0, threeBet: 0, foldToThreeBet: 0 };
  const raise = level === 3 ? '5-bet' : level === 2 ? '4-bet' : '3-bet';
  return [
    {
      label: 'Opens unopened pots (RFI)',
      value: read.openFreq,
      baseline: PF_BALANCED.openFreq,
      sample: s.open,
      active: level === 1,
      effect:
        level === 1
          ? 'Prices your FLAT: the wider he opens the weaker his range, so more hands are worth continuing against it.'
          : 'Context only here — it prices your defence once he is the one who opened.',
      spot: PF_STAT_SPOT.open,
    },
    {
      label: '3-bets facing an open',
      value: read.threeBetFreq,
      baseline: PF_BALANCED.threeBetFreq,
      sample: s.threeBet,
      active: level === 0 || level >= 2,
      effect:
        level === 0
          ? 'Taxes your STEAL: the marginal opens are the ones his re-raise blows off the pot, so they go first.'
          : level >= 2
            ? `IS the composition of the range you now face — a wide 3-bettor is re-raising hands the chart has him folding, so your ${raise} gets value and your continues widen.`
            : 'Context only here — it prices your open, and the pot is already open.',
      spot: PF_STAT_SPOT.threeBet,
    },
    {
      label: 'Folds his open to a 3-bet',
      value: read.foldToThreeBet,
      baseline: PF_BALANCED.foldToThreeBet,
      sample: s.foldToThreeBet,
      active: level === 1,
      effect:
        level === 1
          ? 'Prices your 3-BET BLUFF: this is the fold equity. High → light 3-bets print; low → 3-bet him for value only.'
          : 'Context only here — it prices bluff-raising his opens.',
      spot: PF_STAT_SPOT.foldToThreeBet,
    },
  ];
}

/** A read is only worth acting on in proportion to how much you have seen. Locked
 *  reads carry no sample, so their caveat is about the assertion, not the evidence. */
export function preflopReadCaution(read: PreflopRead): string {
  if (read.source === 'locked')
    return 'You locked this by hand — the engine takes it as fact and does not shrink it. Clear the lock if the table stops matching it.';
  if (read.confidence < 0.3)
    return 'Thin sample — most of this is still the balanced prior, so the mix has barely moved. Keep counting before you deviate hard.';
  if (read.confidence < 0.6) return 'Developing read — real but not firm. Deviate on the marginal hands, not the coolers.';
  return 'Solid sample. Watch for him CHANGING: a lifetime average cannot see a player who has started adjusting to you.';
}

/** Which of the three rates moved a given action's frequency, in one line. */
export function preflopMoveWhy(level: PreflopLevel, kind: ActionOption['kind'], up: boolean): string {
  const dir = up ? 'more' : 'less';
  if (level === 0) return `His 3-bet frequency behind you re-prices every open, so you steal ${dir} here.`;
  if (level === 1) {
    if (kind === 'call') return `How wide he opens sets how much of your range is live, so you flat ${dir}.`;
    if (kind === 'bluff') return `Your 3-bet bluff is priced by how often he folds his open — ${up ? 'more' : 'less'} fold equity, ${dir} bluffs.`;
    return `His opening range is ${up ? 'weaker' : 'stronger'} than the chart assumes, so value re-raises are worth ${dir}.`;
  }
  return `His ${level === 3 ? '4-bet' : '3-bet'} is ${up ? 'wider' : 'tighter'} than the chart assumes, so this line is worth ${dir}.`;
}

/** Hand strength below which a chart-folded hand is never promoted into a raise, no
 *  matter how badly the opponent over-folds. Junk stays folded: the exploit is
 *  3-betting his over-folds with the hands just below the threshold, not with 32o. */
const PROMOTE_FLOOR = 0.55;
const PROMOTE_MAX = 0.3;

/**
 * Apply the multipliers to a chart cell, fold absorbing the change — same shape as
 * depth.ts: shadeForDepth, so the two compose without either being able to push the
 * mix off a probability distribution.
 *
 * It differs from depth shading in two places, both because a read is a categorical
 * claim about the opponent while depth is a nudge about the stack:
 *   • a cell the chart plays 100% (no fold listed) can START folding;
 *   • a cell the chart folds 100% can start raising — `aggr` opts into that.
 * Without either, the two most valuable preflop exploits ("fold this to a nit's
 * 3-bet", "3-bet the hands he folds to") are unreachable no matter how firm the read.
 */
export function applyPreflopRead(
  opts: ActionOption[],
  adj: PreflopAdjust,
  code: string,
  aggr?: { id: ActionId; label: string },
): ActionOption[] {
  if (!opts.length || (adj.valueMult === 1 && adj.bluffMult === 1 && adj.callMult === 1)) return opts;
  const multFor = (o: ActionOption) =>
    o.kind === 'bluff' ? adj.bluffMult : o.kind === 'call' ? adj.callMult : o.kind === 'value' ? adj.valueMult : 1;
  const out = opts.map((o) => (o.id === 'fold' ? { ...o } : { ...o, freq: o.freq * multFor(o) }));
  let played = out.reduce((a, o) => a + (o.id === 'fold' ? 0 : o.freq), 0);

  // Only the AGGRESSIVE action is ever invented: fold equity is the mechanism that
  // makes the hand playable at all, and flatting a chart-fold hand out of position
  // is a different — and worse — idea than raising it.
  if (aggr && adj.bluffMult > 1.1 && played < 1 && preflopStrength(code) >= PROMOTE_FLOOR && !out.some((o) => o.id === aggr.id)) {
    const add = clamp((adj.bluffMult - 1) * 0.6, 0, PROMOTE_MAX) * (1 - played);
    if (add > 0.01) {
      out.push({ id: aggr.id, label: aggr.label, freq: add, ev: 0, kind: 'bluff' });
      played += add;
    }
  }

  // Widening overshot 100% — renormalise the played actions and fold drops to zero.
  if (played > 1) return out.map((o) => (o.id === 'fold' ? { ...o, freq: 0 } : { ...o, freq: o.freq / played }));
  const fold = out.find((o) => o.id === 'fold');
  if (fold) fold.freq = Math.max(0, 1 - played);
  else if (played < 1 - 1e-9) out.push({ id: 'fold', label: 'Fold', freq: 1 - played, ev: 0, kind: 'fold' });
  return out;
}

// ---------------- projected range ----------------

const BY_STRENGTH = [...ALL_169].sort((a, b) => preflopStrength(b) - preflopStrength(a));

/**
 * Resize a projected preflop range by a read multiplier, keeping it strength-ordered:
 * widening admits the strongest codes not already in it, tightening drops its weakest.
 *
 * Combos are ignored in favour of code count — the sets these operate on
 * (RFI_RANGES, THREEBET_RANGE, …) are authored as code sets, and a combo-exact
 * resize would still be an approximation of a range nobody has solved. The clamp is
 * what matters: a thin read must not be able to invent a range twice the chart's.
 */
export function resizeRangeByStrength(baseSet: Set<string>, mult: number): Set<string> {
  const m = clamp(mult, 0.6, 1.8);
  if (Math.abs(m - 1) < 0.06 || baseSet.size === 0) return baseSet;
  const target = clamp(Math.round(baseSet.size * m), 6, ALL_169.length);
  if (target === baseSet.size) return baseSet;
  if (target < baseSet.size) {
    const keep = BY_STRENGTH.filter((c) => baseSet.has(c)).slice(0, target);
    return new Set(keep);
  }
  const out = new Set(baseSet);
  for (const c of BY_STRENGTH) {
    if (out.size >= target) break;
    out.add(c);
  }
  return out;
}

/** Read → how much wider (or narrower) than the chart this villain's range is for
 *  the role he took. Roles other than opener/3-bettor lean on the open read at half
 *  weight: a player who opens everything also defends and calls too much, but the
 *  connection is looser than his own opening frequency, so the signal is damped. */
export function rangeMultForRole(role: 'open' | 'threebet' | 'continue' | 'limp', read: PreflopRead): number {
  if (read.source === 'balanced') return 1;
  // observed.ts counts a limp as an open CHANCE that was declined, so a habitual limper's
  // RFI% is low by construction. Feeding it in would tighten the one range that is wide by
  // definition, so with no limp-frequency stat the limp range takes the read unresized.
  if (role === 'limp') return 1;
  if (role === 'threebet') return read.threeBetFreq / PF_BALANCED.threeBetFreq;
  const wide = read.openFreq / PF_BALANCED.openFreq;
  return role === 'open' ? wide : 1 + 0.5 * (wide - 1);
}
