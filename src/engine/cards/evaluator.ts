// 7-card hand evaluator.
// Produces a single comparable integer score so any two hands can be compared
// with plain >, <, ===. Higher is better.
//
// Score layout (base-16 digits, high -> low significance):
//   category (4 bits) | tb1 | tb2 | tb3 | tb4 | tb5   (each tiebreaker a rank 0..14)
// We pack into a Number using powers of 16 (15 fits in 4 bits; ranks max 14).

import type { Card } from './cards';
import { rankToChar } from './cards';

export const HAND_CATEGORIES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
] as const;

export type HandCategory = (typeof HAND_CATEGORIES)[number];

export interface HandResult {
  score: number;
  category: HandCategory;
  categoryRank: number; // 0..8
  tiebreakers: number[];
  cards: Card[]; // the 7 evaluated cards (not the chosen 5)
}

const CAT_HIGH = 0;
const CAT_PAIR = 1;
const CAT_TWO_PAIR = 2;
const CAT_TRIPS = 3;
const CAT_STRAIGHT = 4;
const CAT_FLUSH = 5;
const CAT_FULL = 6;
const CAT_QUADS = 7;
const CAT_SF = 8;

function pack(cat: number, tb: number[]): number {
  // 5 tiebreaker slots, base 16
  let s = cat;
  for (let i = 0; i < 5; i++) {
    s = s * 16 + (tb[i] ?? 0);
  }
  return s;
}

/** Find highest straight high-card from a set of present ranks. Returns 0 if none. */
function straightHigh(present: boolean[]): number {
  // present indexed by rank 2..14. Treat Ace (14) also as 1 for the wheel.
  let run = 0;
  // check from Ace down to 5-high straight; include wheel via rank 14 acting as low
  for (let r = 14; r >= 2; r--) {
    if (present[r]) {
      run++;
      if (run >= 5) return r + 4; // r is the lowest of the run; high = r+4
    } else {
      run = 0;
    }
  }
  // wheel: A-2-3-4-5
  if (present[14] && present[2] && present[3] && present[4] && present[5]) return 5;
  return 0;
}

export function evaluate7(cards: Card[]): HandResult {
  const rankCount = new Array(15).fill(0);
  const suitCount = [0, 0, 0, 0];
  const suitRanks: number[][] = [[], [], [], []];
  const present: boolean[] = new Array(15).fill(false);

  for (const c of cards) {
    rankCount[c.rank]++;
    suitCount[c.suit]++;
    suitRanks[c.suit].push(c.rank);
    present[c.rank] = true;
  }

  // ---- Flush / straight flush ----
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) flushSuit = s;

  if (flushSuit >= 0) {
    const fp: boolean[] = new Array(15).fill(false);
    for (const r of suitRanks[flushSuit]) fp[r] = true;
    const sfHigh = straightHigh(fp);
    if (sfHigh > 0) {
      return result(CAT_SF, [sfHigh], cards);
    }
  }

  // ---- Quads ----
  for (let r = 14; r >= 2; r--) {
    if (rankCount[r] === 4) {
      const kicker = highestExcept(rankCount, [r], 1)[0];
      return result(CAT_QUADS, [r, kicker], cards);
    }
  }

  // ---- Full house ----
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (rankCount[r] === 3) trips.push(r);
    else if (rankCount[r] === 2) pairs.push(r);
  }
  if (trips.length >= 2) {
    return result(CAT_FULL, [trips[0], trips[1]], cards);
  }
  if (trips.length === 1 && pairs.length >= 1) {
    return result(CAT_FULL, [trips[0], pairs[0]], cards);
  }

  // ---- Flush ----
  if (flushSuit >= 0) {
    const top5 = suitRanks[flushSuit].slice().sort((a, b) => b - a).slice(0, 5);
    return result(CAT_FLUSH, top5, cards);
  }

  // ---- Straight ----
  const sHigh = straightHigh(present);
  if (sHigh > 0) {
    return result(CAT_STRAIGHT, [sHigh], cards);
  }

  // ---- Trips ----
  if (trips.length === 1) {
    const kickers = highestExcept(rankCount, [trips[0]], 2);
    return result(CAT_TRIPS, [trips[0], ...kickers], cards);
  }

  // ---- Two pair ----
  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    const kicker = highestExcept(rankCount, [p1, p2], 1)[0];
    return result(CAT_TWO_PAIR, [p1, p2, kicker], cards);
  }

  // ---- One pair ----
  if (pairs.length === 1) {
    const kickers = highestExcept(rankCount, [pairs[0]], 3);
    return result(CAT_PAIR, [pairs[0], ...kickers], cards);
  }

  // ---- High card ----
  const highs = highestExcept(rankCount, [], 5);
  return result(CAT_HIGH, highs, cards);
}

function highestExcept(rankCount: number[], exclude: number[], n: number): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) {
    if (rankCount[r] > 0 && !exclude.includes(r)) out.push(r);
  }
  return out;
}

function result(cat: number, tb: number[], cards: Card[]): HandResult {
  return {
    score: pack(cat, tb),
    category: HAND_CATEGORIES[cat],
    categoryRank: cat,
    tiebreakers: tb,
    cards,
  };
}

/** Convenience: evaluate any 5..7 cards (hole + board). */
export function evaluateBest(hole: Card[], board: Card[]): HandResult {
  return evaluate7([...hole, ...board]);
}

/** Human-readable description, e.g. "Two Pair, Kings and Sevens". */
export function describeHand(h: HandResult): string {
  const tb = h.tiebreakers;
  const r = (x: number) => rankToChar(x);
  const plural = (x: number) => PLURALS[x] ?? r(x) + 's';
  switch (h.categoryRank) {
    case CAT_SF:
      return tb[0] === 14 ? 'Royal Flush' : `Straight Flush, ${r(tb[0])}-high`;
    case CAT_QUADS:
      return `Four of a Kind, ${plural(tb[0])}`;
    case CAT_FULL:
      return `Full House, ${plural(tb[0])} full of ${plural(tb[1])}`;
    case CAT_FLUSH:
      return `Flush, ${r(tb[0])}-high`;
    case CAT_STRAIGHT:
      return `Straight, ${r(tb[0])}-high`;
    case CAT_TRIPS:
      return `Three of a Kind, ${plural(tb[0])}`;
    case CAT_TWO_PAIR:
      return `Two Pair, ${plural(tb[0])} and ${plural(tb[1])}`;
    case CAT_PAIR:
      return `Pair of ${plural(tb[0])}`;
    default:
      return `${r(tb[0])}-high`;
  }
}

const PLURALS: Record<number, string> = {
  14: 'Aces',
  13: 'Kings',
  12: 'Queens',
  11: 'Jacks',
  10: 'Tens',
  9: 'Nines',
  8: 'Eights',
  7: 'Sevens',
  6: 'Sixes',
  5: 'Fives',
  4: 'Fours',
  3: 'Threes',
  2: 'Twos',
};
