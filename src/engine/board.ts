// Flop texture classification + texture-matched flop generation for drills.

import type { Card } from './cards';
import { makeDeck, rankToChar, sameCard, shuffle } from './cards';

export type TextureFilter =
  | 'any'
  | 'monotone'
  | 'twotone'
  | 'rainbow'
  | 'paired'
  | 'connected'
  | 'disconnected'
  | 'acehigh'
  | 'broadway'
  | 'low';

export const TEXTURE_LABELS: Record<TextureFilter, string> = {
  any: 'Any flop',
  monotone: 'Monotone (3 suit)',
  twotone: 'Two-tone (flush draw)',
  rainbow: 'Rainbow',
  paired: 'Paired',
  connected: 'Connected',
  disconnected: 'Disconnected dry',
  acehigh: 'Ace-high',
  broadway: 'Broadway-heavy',
  low: 'Low (≤9)',
};

export interface TextureInfo {
  suitPattern: 'monotone' | 'twotone' | 'rainbow';
  paired: boolean;
  connected: boolean; // any two within 2 ranks / straighty
  highCard: number;
  tags: string[];
}

export function classifyFlop(board: Card[]): TextureInfo {
  // Reads the WHOLE board, not just the flop — a turn/river card that pairs the
  // board (or completes a 3-flush) changes the texture, and slicing to the first
  // three cards made AAQT read as an unpaired "connected" board.
  const cards = board;
  // suit pattern by the LARGEST single-suit count, so it means the same thing on
  // every street: 3+ of a suit → flushes live ("monotone"), exactly 2 → a flush
  // draw is out there ("twotone"), all distinct → none yet. Identical to the old
  // set-size logic on a 3-card flop.
  const suitCounts = [0, 0, 0, 0];
  for (const c of cards) suitCounts[c.suit]++;
  const maxSuit = Math.max(...suitCounts);
  const suitPattern = maxSuit >= 3 ? 'monotone' : maxSuit === 2 ? 'twotone' : 'rainbow';
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const paired = ranks.some((r, i) => i > 0 && ranks[i - 1] === r);
  // connectedness over UNIQUE ranks (dupes fake closeness): any touching pair, or
  // any 3 ranks within a 4-spread window. Matches the old flop rule exactly.
  const uniq = [...new Set(ranks)];
  const gapOne = uniq.some((r, i) => i > 0 && uniq[i - 1] - r === 1);
  let windowed = false;
  for (let i = 0; i + 2 < uniq.length; i++) if (uniq[i] - uniq[i + 2] <= 4) windowed = true;
  const connected = !paired && (gapOne || windowed);
  const highCard = ranks[0];

  const tags: string[] = [];
  tags.push(suitPattern);
  if (paired) tags.push('paired');
  if (connected) tags.push('connected');
  else if (!paired) tags.push('disconnected');
  if (highCard === 14) tags.push('ace-high');
  if (ranks.every((r) => r >= 10)) tags.push('broadway');
  if (highCard <= 9) tags.push('low');
  return { suitPattern, paired, connected, highCard, tags };
}

export interface TextureDescription {
  /** short headline, e.g. "Low Cards", "Ace-High & Two-Tone". */
  label: string;
  /** one-sentence plain-English read of the board. */
  sentence: string;
  /** who the texture tends to favour, in NL 6-max single-raised-pot terms. */
  favours: string;
}

/**
 * Human-readable read of a board's texture for the gameplan/feedback panels.
 * Classifies the FULL current board, so a pairing turn/river updates the read.
 */
export function describeTexture(board: Card[]): TextureDescription {
  if (board.length < 3) {
    return { label: 'Preflop', sentence: 'No flop yet — this is a preflop decision.', favours: '' };
  }
  const t = classifyFlop(board);
  const hc = t.highCard;

  // primary "height" label
  let height: string;
  let heightSentence: string;
  if (hc === 14) {
    height = 'Ace-High';
    heightSentence = 'There is an ace on board, anchoring the high end of the range.';
  } else if (board.every((c) => c.rank >= 10)) {
    height = 'Broadway';
    heightSentence = 'The board is all broadway cards (T or higher) — it hits high, raise-heavy ranges hard.';
  } else if (hc <= 9) {
    height = 'Low Cards';
    heightSentence = 'The board consists only of low cards (9 or lower).';
  } else {
    height = 'Mixed Heights';
    heightSentence = `A ${rankToChar(hc)}-high board with a spread of ranks.`;
  }

  // suit + connectedness extras
  const extras: string[] = [];
  if (t.suitPattern === 'monotone') extras.push('Monotone');
  else if (t.suitPattern === 'twotone') extras.push('Two-Tone');
  if (t.paired) extras.push('Paired');
  else if (t.connected) extras.push('Connected');

  // on the river there are no more draws — say what IS possible, not what's brewing
  const river = board.length === 5;
  const suitSentence =
    t.suitPattern === 'monotone'
      ? river
        ? ' Three or more cards share a suit, so made flushes are live.'
        : ' Three or more cards share a suit, so flushes and flush draws dominate.'
      : t.suitPattern === 'twotone'
        ? river
          ? ' Only two cards share a suit, so no flush is possible.'
          : ' Two cards share a suit, putting a flush draw out there.'
        : river
          ? ' No two cards share a suit, so no flush is possible.'
          : ' No two cards share a suit — no flush draws yet.';
  // Straight-draw axis, consistent with boardWetScore: any two ranks within 2
  // (e.g. 9-7) put gutshots/one-gappers out there — the board isn't bone dry even
  // when classifyFlop's stricter `connected` test (gap 1 / 4-window) says so.
  const uniqAsc = [...new Set(board.map((c) => c.rank))].sort((a, b) => a - b);
  let straighty = false;
  for (let i = 0; i + 1 < uniqAsc.length; i++) if (uniqAsc[i + 1] - uniqAsc[i] <= 2) straighty = true;
  const connSentence = t.paired
    ? ' The board is paired, which adds trips/full-house combos and removes some straights.'
    : t.connected
      ? river
        ? ' The cards are connected, so straights are live.'
        : ' The cards are connected, so straights and straight draws are live.'
      : straighty
        ? river
          ? ' A two-gap sits on board, so some straights are possible.'
          : ' A two-gap sits on board (like 9-7), so gutshot/one-gapper straight draws are live — not bone dry.'
        : ' The cards are disconnected, so straights are unlikely.';

  // who it favours (single-raised-pot heuristic)
  const favours =
    hc >= 13
      ? 'High boards favour the preflop raiser, who holds more big cards and overpairs.'
      : hc <= 9
        ? 'Low boards favour the preflop caller, who has more low and connected cards in range.'
        : 'A middling board is closer to neutral — neither range is hugely advantaged.';

  const label = [height, ...extras].join(' & ');
  return { label, sentence: heightSentence + suitSentence + connSentence, favours };
}

function matches(board: Card[], filter: TextureFilter): boolean {
  if (filter === 'any') return true;
  const t = classifyFlop(board);
  const ranks = board.slice(0, 3).map((c) => c.rank).sort((a, b) => b - a);
  switch (filter) {
    case 'monotone':
      return t.suitPattern === 'monotone';
    case 'twotone':
      return t.suitPattern === 'twotone';
    case 'rainbow':
      return t.suitPattern === 'rainbow';
    case 'paired':
      return t.paired;
    case 'connected':
      return t.connected;
    case 'disconnected':
      return !t.connected && !t.paired;
    case 'acehigh':
      return t.highCard === 14;
    case 'broadway':
      return ranks.every((r) => r >= 10);
    case 'low':
      return t.highCard <= 9;
  }
}

/** Draw a random 3-card flop matching a filter, avoiding dead cards. */
export function randomFlop(filter: TextureFilter, dead: Card[]): Card[] {
  for (let attempt = 0; attempt < 400; attempt++) {
    const deck = shuffle(makeDeck().filter((d) => !dead.some((u) => sameCard(u, d))));
    const flop = deck.slice(0, 3);
    if (matches(flop, filter)) return flop;
  }
  // fallback: any
  const deck = shuffle(makeDeck().filter((d) => !dead.some((u) => sameCard(u, d))));
  return deck.slice(0, 3);
}

/** Draw a single random card avoiding dead cards. */
export function randomCard(dead: Card[]): Card {
  const deck = shuffle(makeDeck().filter((d) => !dead.some((u) => sameCard(u, d))));
  return deck[0];
}

/**
 * Draw-heaviness score over the FULL available board (flop/turn/river, so later
 * flush/straight completers count, not just the flop):
 *   +2 a flush is possible (3+ of one suit), +1 a flush draw is live (exactly 2),
 *   +1 connected / straight-draw heavy. 0 = bone dry … 3+ = very wet.
 * Single source of truth for "is this board dynamic?" — shared by the AI's
 * sizing multiplier and the drill explanations so they can't disagree.
 */
export function boardWetScore(board: Card[]): number {
  if (board.length < 3) return 0;
  const suitCounts = new Map<number, number>();
  for (const c of board) suitCounts.set(c.suit, (suitCounts.get(c.suit) ?? 0) + 1);
  const maxSuit = Math.max(...suitCounts.values());
  const ranks = [...new Set(board.map((c) => c.rank))].sort((a, b) => a - b);
  let straighty = false;
  for (let i = 0; i + 1 < ranks.length; i++) if (ranks[i + 1] - ranks[i] <= 2) straighty = true;
  const span = ranks[ranks.length - 1] - ranks[0];
  let wet = 0;
  if (maxSuit >= 3) wet += 2; // flush out there
  else if (maxSuit === 2) wet += 1; // flush draw live
  if (straighty || span <= 4) wet += 1; // connected / straight-draw heavy
  return wet;
}

/** Coarse wet/dry label for sizing-rule copy. wet = draw-heavy/dynamic (charge
 *  draws), dry = rainbow & disconnected (range/value bets), semi = one draw axis. */
export function boardWetness(board: Card[]): 'dry' | 'semi' | 'wet' {
  const w = boardWetScore(board);
  return w >= 2 ? 'wet' : w === 1 ? 'semi' : 'dry';
}
