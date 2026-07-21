// Short-stack FIRST-IN JAM charts (Nash-approximation) for the tournament drill.
// When you're short (≤ ~25bb) and folded to, the only preflop plan is shove-or-fold
// — a min-raise pot-commits you anyway. These are teaching baselines (wider in late
// position, wider the shorter you are), NOT an exact solver: they get a live-
// tournament beginner making the single highest-frequency short-stack decision
// correctly, which is where most of the field bleeds chips.
//
// Ranges use the app's standard token notation (see ai/preflop.buildRange) and are
// tested for monotonicity + valid codes in pushFold.charts.test.ts.

import type { Card } from '../engine/cards';
import { handCode, buildRange } from '../ai/preflop';

/** Seats we chart. Blinds fold-to-you cases collapse to SB (you're first in). */
export type PfPos = 'UTG' | 'MP' | 'CO' | 'BTN' | 'SB';
export const PF_POSITIONS: PfPos[] = ['UTG', 'MP', 'CO', 'BTN', 'SB'];
export const PF_POS_LABEL: Record<PfPos, string> = {
  UTG: 'UTG (early)',
  MP: 'MP (middle)',
  CO: 'CO (cutoff)',
  BTN: 'Button',
  SB: 'Small blind',
};

/** Effective-stack buckets, in big blinds. Shorter → jam wider (less fold equity
 *  needed, and folding bleeds you out). */
export type PfBucket = 'short' | 'mid' | 'deep';
export const PF_BUCKET_LABEL: Record<PfBucket, string> = {
  short: '≤ 10bb',
  mid: '11–16bb',
  deep: '17–25bb',
};

export function bucketFor(bb: number): PfBucket {
  if (bb <= 10) return 'short';
  if (bb <= 16) return 'mid';
  return 'deep';
}

// First-in jam tokens per bucket × position. Monotonic by design: for a fixed
// stack, later position is a superset of earlier; for a fixed seat, shorter stacks
// are a superset of deeper. (Asserted in the chart test.)
const SHOVE_TOKENS: Record<PfBucket, Record<PfPos, string[]>> = {
  short: {
    UTG: ['44+', 'A9s+', 'A5s-A4s', 'ATo+', 'KTs+', 'KQo', 'QJs'],
    MP: ['33+', 'A7s+', 'A5s-A4s', 'A9o+', 'K9s+', 'KJo+', 'QTs+', 'JTs'],
    CO: ['22+', 'A2s+', 'A7o+', 'K9s+', 'KTo+', 'Q9s+', 'QJo', 'J9s+', 'T9s', '98s'],
    BTN: ['22+', 'A2s+', 'A2o+', 'K5s+', 'K9o+', 'Q8s+', 'QTo+', 'J8s+', 'JTo', 'T8s+', '97s+', '87s', '76s'],
    SB: ['22+', 'A2s+', 'A2o+', 'K4s+', 'K8o+', 'Q7s+', 'Q9o+', 'J7s+', 'JTo', 'T7s+', '97s+', '86s+', '76s', '65s'],
  },
  mid: {
    UTG: ['66+', 'ATs+', 'AJo+', 'KQs'],
    MP: ['55+', 'A9s+', 'ATo+', 'KJs+', 'KQo', 'QJs'],
    CO: ['33+', 'A5s+', 'ATo+', 'K9s+', 'KJo+', 'QTs+', 'JTs'],
    BTN: ['22+', 'A2s+', 'A8o+', 'K7s+', 'KTo+', 'Q9s+', 'QJo', 'J9s+', 'T9s', '98s'],
    SB: ['22+', 'A2s+', 'A5o+', 'K5s+', 'K9o+', 'Q8s+', 'QTo+', 'J8s+', 'JTo', 'T8s+', '97s+'],
  },
  deep: {
    UTG: ['88+', 'AQs+', 'AKo'],
    MP: ['77+', 'AJs+', 'AQo+', 'KQs'],
    CO: ['55+', 'ATs+', 'AJo+', 'KJs+', 'KQo'],
    BTN: ['33+', 'A8s+', 'ATo+', 'K9s+', 'KJo+', 'QTs+', 'JTs'],
    SB: ['22+', 'A5s+', 'A9o+', 'K8s+', 'KTo+', 'Q9s+', 'QJo', 'JTs'],
  },
};

/** Expanded 169-code sets, built once. */
export const SHOVE_SETS: Record<PfBucket, Record<PfPos, Set<string>>> = (() => {
  const out = {} as Record<PfBucket, Record<PfPos, Set<string>>>;
  for (const b of Object.keys(SHOVE_TOKENS) as PfBucket[]) {
    out[b] = {} as Record<PfPos, Set<string>>;
    for (const p of PF_POSITIONS) out[b][p] = buildRange(SHOVE_TOKENS[b][p]);
  }
  return out;
})();

export function shoveTokens(bb: number, pos: PfPos): string[] {
  return SHOVE_TOKENS[bucketFor(bb)][pos];
}

/** Should hero JAM this hand first-in at this stack + seat? (Nash-approx.) */
export function shouldJam(hand: Card[], bb: number, pos: PfPos): boolean {
  return SHOVE_SETS[bucketFor(bb)][pos].has(handCode(hand));
}

/** % of all 1326 combos in the jam range — the headline "how wide" number. */
export function jamPct(bb: number, pos: PfPos): number {
  let combos = 0;
  SHOVE_SETS[bucketFor(bb)][pos].forEach((code) => {
    combos += code.length === 2 ? 6 : code.endsWith('s') ? 4 : 12;
  });
  return (100 * combos) / 1326;
}
