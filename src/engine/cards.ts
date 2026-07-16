// Core card types and deck utilities.
// Ranks are 2..14 (J=11, Q=12, K=13, A=14). Suits are 0..3.

export const SUITS = ['c', 'd', 'h', 's'] as const;
export type Suit = (typeof SUITS)[number];

export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export type RankChar = (typeof RANK_CHARS)[number];

export interface Card {
  rank: number; // 2..14
  suit: number; // 0..3 -> c d h s
}

export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'];
export const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'];

export function rankToChar(rank: number): string {
  return RANK_CHARS[rank - 2] ?? '?';
}

export function charToRank(ch: string): number {
  const i = RANK_CHARS.indexOf(ch.toUpperCase() as RankChar);
  return i < 0 ? 0 : i + 2;
}

export function cardToString(c: Card): string {
  return rankToChar(c.rank) + SUITS[c.suit];
}

/** Parse "As", "Td", "9h" -> Card */
export function parseCard(s: string): Card {
  return { rank: charToRank(s[0]), suit: SUITS.indexOf(s[1] as Suit) };
}

export function isRed(c: Card): boolean {
  return c.suit === 1 || c.suit === 2; // diamonds or hearts
}

/** 4-color deck CSS class: c=green, d=blue, h=red, s=black. Makes ♣/♠ distinct. */
export function suitClass(suit: number): string {
  return 'su-' + (SUITS[suit] ?? 's');
}

/** Build an ordered 52-card deck. */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ rank: r, suit: s });
    }
  }
  return deck;
}

/** Mulberry32 — small deterministic PRNG so sessions/scenarios are reproducible if needed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle (in place). Uses Math.random by default. */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function cardId(c: Card): number {
  return c.suit * 13 + (c.rank - 2);
}

export function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}
