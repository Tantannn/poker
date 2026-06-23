// Weighted hand ranges (the 169-hand model) + concrete-combo expansion and
// blocker-aware sampling. Used by the equity-vs-range engine and the strategy model.

import type { Card } from './cards';
import { sameCard } from './cards';
import { buildRange } from '../ai/preflop';

/** A range maps a 169-code (e.g. "AKs", "QQ", "T9o") to a weight 0..1. */
export type WeightedRange = Map<string, number>;

const RANK_FROM_CHAR: Record<string, number> = {
  A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
};

/** All concrete 2-card combos for a 169-code. */
export function codeToCombos(code: string): [Card, Card][] {
  const out: [Card, Card][] = [];
  if (code.length === 2) {
    // pair
    const r = RANK_FROM_CHAR[code[0]];
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = s1 + 1; s2 < 4; s2++) out.push([{ rank: r, suit: s1 }, { rank: r, suit: s2 }]);
    return out;
  }
  const r1 = RANK_FROM_CHAR[code[0]];
  const r2 = RANK_FROM_CHAR[code[1]];
  const suited = code[2] === 's';
  if (suited) {
    for (let s = 0; s < 4; s++) out.push([{ rank: r1, suit: s }, { rank: r2, suit: s }]);
  } else {
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([{ rank: r1, suit: s1 }, { rank: r2, suit: s2 }]);
  }
  return out;
}

export function rangeFromSet(set: Set<string>, weight = 1): WeightedRange {
  const m: WeightedRange = new Map();
  set.forEach((c) => m.set(c, weight));
  return m;
}

export function rangeFromTokens(tokens: string[], weight = 1): WeightedRange {
  return rangeFromSet(buildRange(tokens), weight);
}

export function rangeCombos(range: WeightedRange): number {
  let n = 0;
  range.forEach((w, code) => (n += w * (code.length === 2 ? 6 : code.endsWith('s') ? 4 : 12)));
  return n;
}

/** Flattened, blocker-filtered list of concrete combos with cumulative weights for sampling. */
export interface SampleTable {
  combos: [Card, Card][];
  cum: number[];
  total: number;
}

/** Optional per-CONCRETE-combo multiplier (0..n) applied on top of the 169-code
 *  weight. This is how board+action conditioning enters: e.g. on a 3-flush board a
 *  villain who bets is far more likely to hold the two cards that MAKE the flush
 *  than the same code's non-flush suits — a distinction the per-code weight can't
 *  express, but this can. */
export type ComboWeight = (a: Card, b: Card) => number;

export function buildSampleTable(range: WeightedRange, dead: Card[], comboWeight?: ComboWeight): SampleTable {
  const combos: [Card, Card][] = [];
  const cum: number[] = [];
  let total = 0;
  range.forEach((w, code) => {
    if (w <= 0) return;
    for (const combo of codeToCombos(code)) {
      if (dead.some((d) => sameCard(d, combo[0]) || sameCard(d, combo[1]))) continue;
      const wq = comboWeight ? w * comboWeight(combo[0], combo[1]) : w;
      if (wq <= 0) continue;
      total += wq;
      combos.push(combo);
      cum.push(total);
    }
  });
  return { combos, cum, total };
}

export function sampleCombo(table: SampleTable, rng: () => number = Math.random): [Card, Card] | null {
  if (table.total <= 0) return null;
  const x = rng() * table.total;
  // binary search
  let lo = 0;
  let hi = table.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.cum[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return table.combos[lo];
}
