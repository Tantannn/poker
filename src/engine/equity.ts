// Equity (Monte Carlo) + outs estimation for the training HUD.

import type { Card } from './cards';
import { makeDeck, sameCard } from './cards';
import { evaluate7 } from './evaluator';
import type { WeightedRange } from './range';
import { buildSampleTable, sampleCombo } from './range';

export interface EquityResult {
  win: number; // fraction
  tie: number; // fraction
  equity: number; // win + tie/ (split) — pot share fraction
  iterations: number;
}

function remainingDeck(used: Card[]): Card[] {
  const deck = makeDeck();
  return deck.filter((d) => !used.some((u) => sameCard(u, d)));
}

/**
 * Monte Carlo equity for hero hole cards vs N random opponents,
 * given the current community board (0..5 cards).
 */
export function monteCarloEquity(
  hero: Card[],
  board: Card[],
  opponents: number,
  iterations = 3000,
): EquityResult {
  if (hero.length < 2) return { win: 0, tie: 0, equity: 0, iterations: 0 };

  const used = [...hero, ...board];
  const baseDeck = remainingDeck(used);
  const needBoard = 5 - board.length;
  let win = 0;
  let tie = 0;

  for (let it = 0; it < iterations; it++) {
    // Partial Fisher–Yates: draw what we need from a fresh shuffle each iter.
    const deck = baseDeck.slice();
    let top = deck.length;
    const draw = (): Card => {
      const j = Math.floor(Math.random() * top);
      const c = deck[j];
      deck[j] = deck[top - 1];
      top--;
      return c;
    };

    const oppHands: Card[][] = [];
    for (let o = 0; o < opponents; o++) oppHands.push([draw(), draw()]);
    const fullBoard = board.slice();
    for (let b = 0; b < needBoard; b++) fullBoard.push(draw());

    const heroScore = evaluate7([...hero, ...fullBoard]).score;
    let best = heroScore;
    let tiedWith = 0;
    let heroBeaten = false;
    for (const oh of oppHands) {
      const s = evaluate7([...oh, ...fullBoard]).score;
      if (s > best) {
        best = s;
        heroBeaten = true;
        tiedWith = 0;
      } else if (s === heroScore && s === best) {
        tiedWith++;
      }
    }
    if (!heroBeaten) {
      if (tiedWith > 0) tie += 1 / (tiedWith + 1);
      else win += 1;
    }
  }

  const w = win / iterations;
  const t = tie / iterations;
  return { win: w, tie: t, equity: w + t, iterations };
}

/**
 * Equity of hero's exact hand vs an opponent's *range* (the realistic set of
 * hands they could hold), given the board. Samples opponent holdings from the
 * weighted range with blockers removed. This is the "equity vs range" number.
 */
export function equityVsRange(
  hero: Card[],
  board: Card[],
  oppRange: WeightedRange,
  iterations = 1500,
): EquityResult {
  if (hero.length < 2) return { win: 0, tie: 0, equity: 0, iterations: 0 };
  const dead = [...hero, ...board];
  const table = buildSampleTable(oppRange, dead);
  if (table.total <= 0) {
    // range fully blocked — fall back to vs one random hand
    return monteCarloEquity(hero, board, 1, iterations);
  }
  const needBoard = 5 - board.length;
  let win = 0;
  let tie = 0;
  let valid = 0;

  for (let it = 0; it < iterations; it++) {
    const opp = sampleCombo(table);
    if (!opp) continue;
    // build a fresh deck excluding hero, board, opp
    const used = [...hero, ...board, opp[0], opp[1]];
    const deck = makeDeck().filter((d) => !used.some((u) => sameCard(u, d)));
    // partial shuffle to fill board
    const fullBoard = board.slice();
    let top = deck.length;
    for (let b = 0; b < needBoard; b++) {
      const j = Math.floor(Math.random() * top);
      fullBoard.push(deck[j]);
      deck[j] = deck[top - 1];
      top--;
    }
    const hs = evaluate7([...hero, ...fullBoard]).score;
    const os = evaluate7([opp[0], opp[1], ...fullBoard]).score;
    valid++;
    if (hs > os) win++;
    else if (hs === os) tie++;
  }
  if (valid === 0) return { win: 0, tie: 0, equity: 0, iterations: 0 };
  const w = win / valid;
  const t = tie / valid;
  return { win: w, tie: t, equity: w + t / 2, iterations: valid };
}

/**
 * MULTIWAY equity: hero vs a FIELD of opponents, each drawn from their own
 * range. Hero must beat EVERY opponent to win the pot — so this is materially
 * lower than heads-up equity-vs-range in 3+ way pots. Cards are kept distinct
 * across hero, board and every opponent.
 */
export function equityVsField(
  hero: Card[],
  board: Card[],
  oppRanges: WeightedRange[],
  iterations = 1500,
): EquityResult {
  if (hero.length < 2 || oppRanges.length === 0) return { win: 0, tie: 0, equity: 0, iterations: 0 };
  if (oppRanges.length === 1) return equityVsRange(hero, board, oppRanges[0], iterations);

  const dead0 = [...hero, ...board];
  const tables = oppRanges.map((r) => buildSampleTable(r, dead0));
  const needBoard = 5 - board.length;
  let win = 0;
  let tie = 0;
  let valid = 0;

  const collides = (c: Card, used: Card[]) => used.some((u) => sameCard(u, c));

  for (let it = 0; it < iterations; it++) {
    const used = dead0.slice();
    const oppHands: Card[][] = [];
    let ok = true;

    for (const table of tables) {
      let combo: Card[] | null = null;
      // sample from this opponent's range, rejecting cards already dealt
      for (let t = 0; t < 12 && table.total > 0; t++) {
        const c = sampleCombo(table);
        if (c && !collides(c[0], used) && !collides(c[1], used)) { combo = c; break; }
      }
      if (!combo) {
        // range blocked out — fall back to two random live cards
        const deck = makeDeck().filter((d) => !collides(d, used));
        if (deck.length < 2) { ok = false; break; }
        const a = deck[Math.floor(Math.random() * deck.length)];
        let b = a;
        while (sameCard(a, b)) b = deck[Math.floor(Math.random() * deck.length)];
        combo = [a, b];
      }
      oppHands.push(combo);
      used.push(combo[0], combo[1]);
    }
    if (!ok) continue;

    const deck = makeDeck().filter((d) => !collides(d, used));
    const fullBoard = board.slice();
    let top = deck.length;
    for (let b = 0; b < needBoard; b++) {
      const j = Math.floor(Math.random() * top);
      fullBoard.push(deck[j]);
      deck[j] = deck[top - 1];
      top--;
    }

    const hs = evaluate7([...hero, ...fullBoard]).score;
    let beaten = false;
    let tiedWith = 0;
    for (const oh of oppHands) {
      const os = evaluate7([oh[0], oh[1], ...fullBoard]).score;
      if (os > hs) { beaten = true; break; }
      if (os === hs) tiedWith++;
    }
    valid++;
    if (!beaten) {
      if (tiedWith > 0) tie += 1 / (tiedWith + 1);
      else win++;
    }
  }

  if (valid === 0) return { win: 0, tie: 0, equity: 0, iterations: 0 };
  const w = win / valid;
  const t = tie / valid;
  return { win: w, tie: t, equity: w + t, iterations: valid };
}

/**
 * Count "outs" — unseen cards that improve the hero's hand to a strictly
 * better category on the next street. This is the classic teaching estimate
 * (flush draw ~9, OESD ~8, gutshot ~4, etc.). Only meaningful on flop/turn.
 */
export function countOuts(hero: Card[], board: Card[]): { outs: number; cards: Card[] } {
  if (board.length < 3 || board.length >= 5) return { outs: 0, cards: [] };
  const used = [...hero, ...board];
  const deck = remainingDeck(used);
  const current = evaluate7([...hero, ...board]).categoryRank;

  const outCards: Card[] = [];
  for (const c of deck) {
    const next = evaluate7([...hero, ...board, c]);
    // Out = improves to a strictly higher category that is at least a pair.
    if (next.categoryRank > current && next.categoryRank >= 1) {
      outCards.push(c);
    }
  }
  return { outs: outCards.length, cards: outCards };
}

/**
 * Rules of thumb for memorizing equity without a solver. Preflop matchups sit on
 * a fixed ladder; draws use the Rule of 2 and 4 (outs × 4 with two cards to come,
 * outs × 2 with one). Used by the equity-explain panel as a learning aid.
 */
export const EQUITY_RULES_OF_THUMB: { spot: string; equity: string; hook: string }[] = [
  { spot: 'Pair vs 2 overcards', equity: '52 / 48', hook: 'coinflip / race' },
  { spot: 'Pair vs 2 undercards', equity: '85 / 15', hook: '5-to-1' },
  { spot: 'Higher pair vs lower pair', equity: '80 / 20', hook: '80-20' },
  { spot: 'Dominated (AK vs AQ)', equity: '70 / 30', hook: 'domination = 70' },
  { spot: 'Flush draw (9 outs)', equity: '~36%', hook: 'outs × 4' },
  { spot: 'Open-ender (8 outs)', equity: '~32%', hook: 'outs × 4' },
  { spot: 'Gutshot (4 outs)', equity: '~17%', hook: 'outs × 2 per street' },
];

/** Rule of 2 and 4 estimate from outs. */
export function ruleOf2and4(outs: number, cardsToCome: number): number {
  let pct = cardsToCome >= 2 ? outs * 4 : outs * 2;
  if (cardsToCome >= 2 && outs >= 9) pct -= outs - 8; // small correction
  return Math.max(0, Math.min(100, pct));
}
