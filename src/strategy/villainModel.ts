// Node-lock villain model: the ONE place that decides which opponent parameters
// the postflop engine solves against.
//
// The engine has exactly two knobs that change the recommended line, and both were
// previously read straight off the bot's hidden archetype (`getProfile(profileId)`
// in index.ts):
//
//   bluffFreq   → bluffMult in betConditionedWeight — how much of villain's BETTING
//                 range is air, i.e. what your bluff-catcher is actually beating.
//   callStation → contBias in postflopModel.computeAggro — how wide villain
//                 continues vs a bet, i.e. your fold equity and how thin you can
//                 value bet.
//
// Reading the true profile is wrong for two reasons. It leaks the archetype the
// "anonymous villains" mode deliberately hides, and against a REAL opponent there
// is no profile at all — only what you have observed. This module replaces the
// source without touching the math: observed reads, shrunk toward a prior by sample
// size, with an optional manual lock that overrides everything.
//
// Manual locks are the node-lock tool proper: "assume he folds to 70% of turn
// barrels and see what the line becomes". That is the exploit workflow — find the
// leak, lock it, play the counter-strategy — and it is what beats a low-stakes
// regular, who is not balanced but is also not the archetype the bots ship with.

import type { ObservedStats } from '../analysis/observed';

/** Balanced-opponent baselines. These are the numbers index.ts already treated as
 *  "GTO / unknown", so a model with no read and no lock reproduces the old
 *  balanced behaviour exactly. */
export const BALANCED = { bluffFreq: 0.33, callStation: 0.3 } as const;

/** What a balanced player does, used to convert an observed rate into a parameter.
 *  betFreq: how often a balanced player bets when checked to postflop.
 *  foldToBet: how often a balanced player folds facing a bet (MDF-adjacent). */
const REF = { betFreq: 0.55, foldToBet: 0.45 } as const;

/** Sample sizes at which an observed rate gets half its weight (n/(n+K)). Keyed on
 *  the DECISION count for that specific read, not hands played — a villain can be
 *  40 hands deep and never once have faced a bet. */
const HALF_WEIGHT = { facedBet: 12, betChance: 15 } as const;

/** A user-set lock. Absent fields keep the observed/prior value, so you can lock
 *  fold-to-bet alone and leave the bluff read alone. */
export interface VillainLock {
  enabled: boolean;
  /** 0..1 — assume villain folds this often facing a bet */
  foldToBet?: number;
  /** 0..1 — assume villain bets this often when checked to */
  betFreq?: number;
}

export interface VillainModel {
  /** → bluffMult (vs the 0.33 baseline) in betConditionedWeight */
  bluffFreq: number;
  /** → contBias (vs the 0.30 baseline) in postflopModel */
  callStation: number;
  source: 'balanced' | 'prior' | 'observed' | 'locked';
  /** 0..1 — how much of the read was trusted after shrinkage. 0 = pure prior. */
  confidence: number;
  /** one-line read for the Explain panel, or null when nothing is notable */
  label: string | null;
}

export const balancedModel = (): VillainModel => ({
  bluffFreq: BALANCED.bluffFreq,
  callStation: BALANCED.callStation,
  source: 'balanced',
  confidence: 0,
  label: null,
});

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Observed bet-when-checked-to rate → what share of his betting range is air.
 *  Proportional to the balanced reference: a villain who bets 80% of the time he
 *  can is firing far more than his made hands, so the extra is bluffs. */
export function bluffFreqFromBetFreq(betFreq: number): number {
  return clamp(BALANCED.bluffFreq * (betFreq / REF.betFreq), 0.05, 0.9);
}

/** Observed fold-to-bet → stickiness. Inverted: the more he folds, the less he is a
 *  station. The 1.2 slope puts a 70%-folder near 0 (pure nit — bluffs print) and a
 *  15%-folder near 0.66 (station — value bet big, never bluff). */
export function callStationFromFoldToBet(foldToBet: number): number {
  return clamp(BALANCED.callStation + (REF.foldToBet - foldToBet) * 1.2, 0.05, 0.95);
}

function shrink(observed: number, prior: number, n: number, halfWeight: number): { value: number; weight: number } {
  const w = n / (n + halfWeight);
  return { value: prior + (observed - prior) * w, weight: w };
}

function describe(m: { bluffFreq: number; callStation: number }, locked: boolean, conf: number): string | null {
  const parts: string[] = [];
  if (m.callStation >= 0.5) parts.push('sticky — pays off too much, rarely folds');
  else if (m.callStation <= 0.14) parts.push('folds too much — bluffs and bigger sizes print');
  if (m.bluffFreq >= 0.45) parts.push('barrels a lot — his bet range is air-heavy');
  else if (m.bluffFreq <= 0.18) parts.push('barely bluffs — a bet is value');
  if (!parts.length) return null;
  const strength = locked ? 'locked' : conf >= 0.6 ? 'solid read' : conf >= 0.3 ? 'developing read' : 'thin read';
  return `${parts.join('; ')} (${strength})`;
}

/**
 * Resolve the model the strategy engine should solve against.
 *
 * @param prior     fallback parameters when there is no read — pass the bot's
 *                  profile params when the archetype is VISIBLE to the player
 *                  (that information is legitimately theirs), or `BALANCED` in
 *                  anonymous mode so the engine can't use what the UI hides.
 * @param obs       observed stats for this seat, or null.
 * @param lock      manual override; ignored unless `enabled`.
 */
export function resolveVillainModel(
  prior: { bluffFreq: number; callStation: number } = BALANCED,
  obs?: ObservedStats | null,
  lock?: VillainLock | null,
): VillainModel {
  // A lock is an assertion by the user, not an estimate — no shrinkage, full weight.
  if (lock?.enabled && (lock.foldToBet != null || lock.betFreq != null)) {
    const bluffFreq = lock.betFreq != null ? bluffFreqFromBetFreq(lock.betFreq) : prior.bluffFreq;
    const callStation = lock.foldToBet != null ? callStationFromFoldToBet(lock.foldToBet) : prior.callStation;
    const m = { bluffFreq, callStation };
    return { ...m, source: 'locked', confidence: 1, label: describe(m, true, 1) };
  }

  const hasFold = obs?.foldToBet != null && obs.facedBetSample > 0;
  const hasBet = obs?.betFreq != null && obs.betChanceSample > 0;
  if (!obs || (!hasFold && !hasBet)) {
    const label = describe(prior, false, 0);
    return { ...prior, source: 'prior', confidence: 0, label };
  }

  const cs = hasFold
    ? shrink(callStationFromFoldToBet(obs.foldToBet as number), prior.callStation, obs.facedBetSample, HALF_WEIGHT.facedBet)
    : { value: prior.callStation, weight: 0 };
  const bf = hasBet
    ? shrink(bluffFreqFromBetFreq(obs.betFreq as number), prior.bluffFreq, obs.betChanceSample, HALF_WEIGHT.betChance)
    : { value: prior.bluffFreq, weight: 0 };

  const confidence = Math.max(cs.weight, bf.weight);
  const m = { bluffFreq: bf.value, callStation: cs.value };
  return {
    ...m,
    source: confidence > 0.05 ? 'observed' : 'prior',
    confidence,
    label: describe(m, false, confidence),
  };
}

/** Does this model differ from balanced enough to be worth a second (baseline)
 *  solve for the exploit-delta display? Below these thresholds the two lines come
 *  out identical and the extra solve is wasted. */
export function isExploitable(m: VillainModel): boolean {
  return Math.abs(m.bluffFreq - BALANCED.bluffFreq) > 0.05 || Math.abs(m.callStation - BALANCED.callStation) > 0.03;
}
