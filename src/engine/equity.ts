// Equity (Monte Carlo) + outs estimation for the training HUD.

import type { Card } from './cards';
import { makeDeck, sameCard, rankToChar } from './cards';
import { evaluate7, HAND_CATEGORIES } from './evaluator';
import type { HandCategory } from './evaluator';
import type { WeightedRange, ComboWeight } from './range';
import { buildSampleTable, sampleCombo } from './range';

export interface EquityResult {
  win: number; // fraction
  tie: number; // fraction
  equity: number; // win + tie/ (split) — pot share fraction
  iterations: number;
  // raw simulation tally (integer event counts) so the HUD can show exactly
  // where win%/tie% came from: wins + ties + losses === trials.
  trials: number;
  wins: number;
  ties: number;
  losses: number;
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
  rng: () => number = Math.random,
): EquityResult {
  if (hero.length < 2) return { win: 0, tie: 0, equity: 0, iterations: 0, trials: 0, wins: 0, ties: 0, losses: 0 };

  const used = [...hero, ...board];
  const baseDeck = remainingDeck(used);
  const needBoard = 5 - board.length;
  let win = 0;
  let tie = 0;
  let wins = 0;
  let ties = 0;

  for (let it = 0; it < iterations; it++) {
    // Partial Fisher–Yates: draw what we need from a fresh shuffle each iter.
    const deck = baseDeck.slice();
    let top = deck.length;
    const draw = (): Card => {
      const j = Math.floor(rng() * top);
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
      if (tiedWith > 0) { tie += 1 / (tiedWith + 1); ties++; }
      else { win += 1; wins++; }
    }
  }

  const w = win / iterations;
  const t = tie / iterations;
  return {
    win: w, tie: t, equity: w + t, iterations,
    trials: iterations, wins, ties, losses: iterations - wins - ties,
  };
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
  rng: () => number = Math.random,
  comboWeight?: ComboWeight,
): EquityResult {
  if (hero.length < 2) return { win: 0, tie: 0, equity: 0, iterations: 0, trials: 0, wins: 0, ties: 0, losses: 0 };
  const dead = [...hero, ...board];
  const table = buildSampleTable(oppRange, dead, comboWeight);
  if (table.total <= 0) {
    // range fully blocked — fall back to vs one random hand
    return monteCarloEquity(hero, board, 1, iterations, rng);
  }
  const needBoard = 5 - board.length;
  let win = 0;
  let tie = 0;
  let valid = 0;

  for (let it = 0; it < iterations; it++) {
    const opp = sampleCombo(table, rng);
    if (!opp) continue;
    // build a fresh deck excluding hero, board, opp
    const used = [...hero, ...board, opp[0], opp[1]];
    const deck = makeDeck().filter((d) => !used.some((u) => sameCard(u, d)));
    // partial shuffle to fill board
    const fullBoard = board.slice();
    let top = deck.length;
    for (let b = 0; b < needBoard; b++) {
      const j = Math.floor(rng() * top);
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
  if (valid === 0) return { win: 0, tie: 0, equity: 0, iterations: 0, trials: 0, wins: 0, ties: 0, losses: 0 };
  const w = win / valid;
  const t = tie / valid;
  return {
    win: w, tie: t, equity: w + t / 2, iterations: valid,
    trials: valid, wins: win, ties: tie, losses: valid - win - tie,
  };
}

/**
 * Range DECOMPOSITION — the honest "measure your own equity" tool. Instead of a
 * lossy bucket-minus-cut heuristic, this reads the villain's ACTUAL range and
 * splits it into the three piles a player eyeballs at the table:
 *   • AHEAD  — combos hero crushes (hero ≥ 70% vs that exact hand)
 *   • BEHIND — combos that crush hero (hero ≤ 30%)
 *   • FLIP   — everything between: coinflips and live draws
 * plus the overall equity (weighted average of per-combo equity, ≈ the MC number).
 * Each concrete combo's equity is computed vs the real runout (exhaustive on the
 * turn, sampled on the flop), so the split is accurate — never 15% off — and it
 * teaches exactly what to estimate live: how much of his range you beat.
 */
export interface RangeBreakdown {
  ahead: number; // weighted fraction of the range
  flip: number;
  behind: number;
  equity: number; // overall pot-share fraction (win + tie/2)
  combos: number; // distinct concrete combos considered
  // a few representative combos per pile, heaviest first, deduped by hand-type — so
  // the drill can show the tick worked on real example hands ("beat 55, A5 · lose AQ").
  examples: { ahead: [Card, Card][]; behind: [Card, Card][]; flip: [Card, Card][] };
}

/** 169-style code for a concrete combo (AKs / AKo / 77) — to dedupe example hands. */
function comboCode(a: Card, b: Card): string {
  const hi = a.rank >= b.rank ? a : b;
  const lo = a.rank >= b.rank ? b : a;
  const base = rankToChar(hi.rank) + rankToChar(lo.rank);
  return hi.rank === lo.rank ? base : base + (a.suit === b.suit ? 's' : 'o');
}

/** Heaviest-weight, distinct-type example combos from a bucket (up to `n`). */
function pickExamples(arr: { c: [Card, Card]; w: number }[], n: number): [Card, Card][] {
  arr.sort((x, y) => y.w - x.w);
  const seen = new Set<string>();
  const out: [Card, Card][] = [];
  for (const { c } of arr) {
    const code = comboCode(c[0], c[1]);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

/** Hero's exact equity vs ONE opponent combo over the remaining board. */
function comboEquity(hero: Card[], board: Card[], opp: [Card, Card], needBoard: number, rng: () => number): number {
  if (needBoard <= 0) {
    const hs = evaluate7([...hero, ...board]).score;
    const os = evaluate7([opp[0], opp[1], ...board]).score;
    return hs > os ? 1 : hs === os ? 0.5 : 0;
  }
  const used = [...hero, ...board, opp[0], opp[1]];
  const deck = makeDeck().filter((d) => !used.some((u) => sameCard(u, d)));
  let win = 0;
  let tie = 0;
  let n = 0;
  if (needBoard === 1) {
    for (const c of deck) {
      const fb = [...board, c];
      const hs = evaluate7([...hero, ...fb]).score;
      const os = evaluate7([opp[0], opp[1], ...fb]).score;
      if (hs > os) win++;
      else if (hs === os) tie++;
      n++;
    }
  } else {
    const K = 120; // flop: two cards to come — sample runouts
    for (let k = 0; k < K; k++) {
      const i = Math.floor(rng() * deck.length);
      let j = Math.floor(rng() * deck.length);
      while (j === i) j = Math.floor(rng() * deck.length);
      const fb = [...board, deck[i], deck[j]];
      const hs = evaluate7([...hero, ...fb]).score;
      const os = evaluate7([opp[0], opp[1], ...fb]).score;
      if (hs > os) win++;
      else if (hs === os) tie++;
      n++;
    }
  }
  return n ? (win + tie * 0.5) / n : 0;
}

export function rangeBreakdown(
  hero: Card[],
  board: Card[],
  oppRange: WeightedRange,
  comboWeight?: ComboWeight,
  rng: () => number = Math.random,
): RangeBreakdown {
  const empty: RangeBreakdown = { ahead: 0, flip: 0, behind: 0, equity: 0, combos: 0, examples: { ahead: [], behind: [], flip: [] } };
  if (hero.length < 2) return empty;
  const dead = [...hero, ...board];
  const table = buildSampleTable(oppRange, dead, comboWeight);
  const n = table.combos.length;
  if (table.total <= 0 || n === 0) return empty;
  const needBoard = 5 - board.length;
  let aheadW = 0;
  let flipW = 0;
  let behindW = 0;
  let eqW = 0;
  let prev = 0;
  const rawAhead: { c: [Card, Card]; w: number }[] = [];
  const rawBehind: { c: [Card, Card]; w: number }[] = [];
  const rawFlip: { c: [Card, Card]; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    const w = table.cum[i] - prev; // per-combo weight from the cumulative array
    prev = table.cum[i];
    const combo = table.combos[i];
    const e = comboEquity(hero, board, combo, needBoard, rng);
    eqW += e * w;
    if (e >= 0.7) { aheadW += w; rawAhead.push({ c: combo, w }); }
    else if (e <= 0.3) { behindW += w; rawBehind.push({ c: combo, w }); }
    else { flipW += w; rawFlip.push({ c: combo, w }); }
  }
  const T = table.total;
  return {
    ahead: aheadW / T, flip: flipW / T, behind: behindW / T, equity: eqW / T, combos: n,
    examples: { ahead: pickExamples(rawAhead, 3), behind: pickExamples(rawBehind, 3), flip: pickExamples(rawFlip, 3) },
  };
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
  rng: () => number = Math.random,
  comboWeight?: ComboWeight,
  // Optional PER-opponent conditioning, aligned to oppRanges by index. When
  // given, entry i is used for opponent i (undefined = that opponent's range is
  // NOT bet-conditioned). Lets a multiway pot model only the actual bettor with
  // a value-heavy range while the players who merely called keep a wider one —
  // applying the bettor's strong range to everyone crushes made hands' equity.
  comboWeights?: (ComboWeight | undefined)[],
): EquityResult {
  if (hero.length < 2 || oppRanges.length === 0) return { win: 0, tie: 0, equity: 0, iterations: 0, trials: 0, wins: 0, ties: 0, losses: 0 };
  if (oppRanges.length === 1) return equityVsRange(hero, board, oppRanges[0], iterations, rng, comboWeights ? comboWeights[0] : comboWeight);

  const dead0 = [...hero, ...board];
  const tables = oppRanges.map((r, i) => buildSampleTable(r, dead0, comboWeights ? comboWeights[i] : comboWeight));
  const needBoard = 5 - board.length;
  let win = 0;
  let tie = 0;
  let valid = 0;
  let wins = 0;
  let ties = 0;

  const collides = (c: Card, used: Card[]) => used.some((u) => sameCard(u, c));

  for (let it = 0; it < iterations; it++) {
    const used = dead0.slice();
    const oppHands: Card[][] = [];
    let ok = true;

    for (const table of tables) {
      let combo: Card[] | null = null;
      // sample from this opponent's range, rejecting cards already dealt
      for (let t = 0; t < 12 && table.total > 0; t++) {
        const c = sampleCombo(table, rng);
        if (c && !collides(c[0], used) && !collides(c[1], used)) { combo = c; break; }
      }
      if (!combo) {
        // range blocked out — fall back to two random live cards
        const deck = makeDeck().filter((d) => !collides(d, used));
        if (deck.length < 2) { ok = false; break; }
        const a = deck[Math.floor(rng() * deck.length)];
        let b = a;
        while (sameCard(a, b)) b = deck[Math.floor(rng() * deck.length)];
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
      const j = Math.floor(rng() * top);
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
      if (tiedWith > 0) { tie += 1 / (tiedWith + 1); ties++; }
      else { win++; wins++; }
    }
  }

  if (valid === 0) return { win: 0, tie: 0, equity: 0, iterations: 0, trials: 0, wins: 0, ties: 0, losses: 0 };
  const w = win / valid;
  const t = tie / valid;
  return {
    win: w, tie: t, equity: w + t, iterations: valid,
    trials: valid, wins, ties, losses: valid - wins - ties,
  };
}

/**
 * Count "outs" — unseen cards that improve the hero's hand to a strictly
 * better category on the next street. This is the classic teaching estimate
 * (flush draw ~9, OESD ~8, gutshot ~4, etc.). Only meaningful on flop/turn.
 */
export interface OutsInfo {
  outs: number;
  cards: Card[];
  /** outs grouped by the hand they make, strongest category first */
  byCategory: { category: HandCategory; cards: Card[] }[];
}

export function countOuts(hero: Card[], board: Card[]): OutsInfo {
  if (board.length < 3 || board.length >= 5) return { outs: 0, cards: [], byCategory: [] };
  const used = [...hero, ...board];
  const deck = remainingDeck(used);
  const current = evaluate7([...hero, ...board]).categoryRank;
  // the bare community hand right now — used to reject "shared" improvements
  const boardNow = evaluate7(board).categoryRank;

  const outCards: Card[] = [];
  const groups = new Map<HandCategory, Card[]>();
  for (const c of deck) {
    const next = evaluate7([...hero, ...board, c]);
    // must improve hero to a strictly higher category that's at least a pair
    if (next.categoryRank <= current || next.categoryRank < 1) continue;
    // Reject shared outs: if the card lifts the BOARD's own category at least as
    // much as it lifts hero's, the gain is board-driven (it pairs/trips the
    // board) and every player gets the same boost — hero's edge over the field
    // didn't grow. A real out comes from hero's hole cards, so it must out-gain
    // the bare board. This is the "don't count cards everyone gets" discount.
    const boardNext = evaluate7([...board, c]).categoryRank;
    const heroGain = next.categoryRank - current;
    const boardGain = boardNext - boardNow;
    if (boardGain >= heroGain) continue;
    // Reject board-driven boats/quads: the card pairs a BOARD rank hero doesn't
    // hold, so hero's "improvement" is board trips propping up his existing pair
    // (99 on AAQT: an ace makes aces-full-of-NINES — every pocket pair boats the
    // same way and every Qx/Tx boats BIGGER). Counting these let a 2-out
    // bluff-catcher qualify as a real draw and collect implied odds. A card that
    // pairs the board can still be an out when it completes a flush (category
    // stays below full house) or trips hero's own rank (hero holds the rank).
    const pairsBoardOnly = board.some((b) => b.rank === c.rank) && !hero.some((h) => h.rank === c.rank);
    if (pairsBoardOnly && next.categoryRank >= 6) continue;
    outCards.push(c);
    const arr = groups.get(next.category) ?? [];
    arr.push(c);
    groups.set(next.category, arr);
  }
  // strongest hand first (Flush before Straight before Pair, etc.)
  const byCategory = [...groups.entries()]
    .map(([category, cards]) => ({ category, cards }))
    .sort((a, b) => HAND_CATEGORIES.indexOf(b.category) - HAND_CATEGORIES.indexOf(a.category));
  return { outs: outCards.length, cards: outCards, byCategory };
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

/**
 * The EXACT probability of hitting at least one of `outs` by the river — the true
 * number the Rule of 2 & 4 only approximates. Pure hypergeometric, no shortcut.
 * Standard unseen-card counts from the hero's seat: 47 on the flop (turn AND river
 * still to come), 46 on the turn (river only). Returns a percentage 0..100.
 *
 *   flop (2 cards): 1 − P(miss both) = 1 − (47−o)/47 · (46−o)/46
 *   turn (1 card):  o / 46
 *
 * e.g. 9-out flush draw on the flop → 34.97% (Rule of 4 says ~36%).
 */
export function exactOutsEquity(outs: number, cardsToCome: number): number {
  if (cardsToCome >= 2) {
    const o = Math.max(0, Math.min(outs, 47));
    const missBoth = ((47 - o) / 47) * ((46 - o) / 46);
    return (1 - missBoth) * 100;
  }
  if (cardsToCome === 1) {
    const o = Math.max(0, Math.min(outs, 46));
    return (o / 46) * 100;
  }
  return 0;
}
