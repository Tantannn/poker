// Bridges the range-vs-range river solver (riverSolver.ts) into the live engine:
// expands both players' weighted ranges to concrete combos (subsampled for speed),
// runs the CFR solve, and maps the result onto the NodeStrategy shape the HUD and
// grader already consume. Pure — imports nothing from strategy/index.ts, so no
// import cycle. Applies to a hero-FIRST heads-up river node only (v1 tree).

import type { Card } from '../../engine/cards';
import { sameCard, SUIT_SYMBOLS } from '../../engine/cards';
import type { WeightedRange } from '../../engine/range';
import { codeToCombos } from '../../engine/range';
import type { NodeStrategy, ActionId, ActionOption } from '../types';
import { solveRiver, solveRiverVsBet, type Combo } from './riverSolver';
import { solveTurn } from './turnSolver';
import { requiredEquityForBet } from '../../engine/potOdds';

// Live size set — chosen to map onto the existing ActionIds (no overbet id yet).
const RIVER_SIZES = [0.33, 0.5, 0.75, 1.0];
const SIZE_ID: ActionId[] = ['bet33', 'bet50', 'bet75', 'betpot'];
const SIZE_LABEL = ['Bet 33%', 'Bet 50%', 'Bet 75%', 'Bet pot'];
const HERO_CAP = 48;
const VILLAIN_CAP = 80;
// Turn caps are smaller: the equity matrix costs O(hero × villain × ~44 rivers).
const TURN_HERO_CAP = 36;
const TURN_VILLAIN_CAP = 48;

const round2 = (x: number) => Math.round(x * 100) / 100;
const dead = (c: Card, cards: Card[]) => cards.some((x) => sameCard(x, c));

const FRAC_LABEL = ['⅓ pot', '½ pot', '¾ pot', 'pot'];

/** Plain-English reasons for a hero-FIRST river CFR node, built from the solved
 *  numbers (hero's showdown equity, recovered from the check EV = pot × equity; and
 *  villain's solved call frequency per size) PLUS the concrete blocker read from
 *  hero's cards vs the board. Faithful to what the solve knows — river polarization,
 *  fold equity per size, value:bluff balance, showdown value, blockers — not spot
 *  narrative ("villain is capped") it can't assert. Wording is tailored to the
 *  SOLVED best line: for a low-equity hand where the solver still checks (showdown
 *  value + weak blockers make bluffing not worth it), it must NOT read "you must
 *  bet". The per-hand model (postflopModel.ts) writes its own `why`; this fills the
 *  gap for the CFR path, which otherwise returns bare bars with nothing to tap. */
function riverReasons(
  checkEvChips: number,
  villainCallFreq: number[],
  pot: number,
  bb: number,
  heroCards: Card[],
  board: Card[],
  bestIsCheck: boolean,
): { notes: string[]; why: Record<string, string>; sizeNote: Record<string, string> } {
  const eq = Math.max(0, Math.min(1, pot > 0 ? checkEvChips / pot : 0));
  const eqPct = Math.round(eq * 100);
  const potBB = pot / bb;
  const value = eq >= 0.6;
  const bluff = eq <= 0.34;
  const foldOf = (s: number) => Math.round((1 - Math.max(0, Math.min(1, villainCallFreq[s] ?? 0))) * 100);
  const callOf = (s: number) => Math.round(Math.max(0, Math.min(1, villainCallFreq[s] ?? 0)) * 100);
  const why: Record<string, string> = {};
  const sizeNote: Record<string, string> = {};

  // Blocker read: on a 3+ flush board, does hero hold a card of that suit? A bluff
  // that holds one makes villain's made flushes less likely (good); holding none
  // unblocks them and runs a "rep the flush" bet into more calls (weak bluff).
  const suitCounts = [0, 0, 0, 0];
  for (const c of board) suitCounts[c.suit]++;
  const flushSuit = suitCounts.findIndex((n) => n >= 3);
  const holdsFlushCard = flushSuit >= 0 && heroCards.some((c) => c.suit === flushSuit);
  const flushSym = flushSuit >= 0 ? SUIT_SYMBOLS[flushSuit] : '';

  why.check = value
    ? `Checks down your ~${eqPct}% for showdown — with a hand this strong that leaves money behind, since worse hands would have called a bet.`
    : bluff
      ? bestIsCheck
        ? `Realises your ~${eqPct}% — modest, but it still beats villain's busted hands, and with weak blockers that showdown value is worth more than a bluff. You're never forced to bluff, so checking wins here.`
        : `Shows down your ~${eqPct}% — near the bottom of your range. The check just banks that small equity; the solver prefers betting only because fold equity here is high.`
      : `Realises your ~${eqPct}% at showdown for free — a bluff-catcher plays check/call, not bet (betting folds out the worse hands you beat and is called only by better).`;

  RIVER_SIZES.forEach((frac, s) => {
    const id = SIZE_ID[s];
    const be = Math.round((frac / (1 + frac)) * 100); // breakeven fold% for a bluff this size
    const betBB = (frac * pot) / bb;
    const bluffFrac = requiredEquityForBet(frac);
    const ratio = (1 - bluffFrac) / Math.max(0.001, bluffFrac);
    sizeNote[id] = `⚖ ~${Math.round(bluffFrac * 100)}% bluffs · ${ratio.toFixed(1)}:1 value:bluff`;
    why[id] = value
      ? `Value bet (${FRAC_LABEL[s]}): you're ~${eqPct}% ahead and villain still calls ~${callOf(s)}%, paying you off. A bigger size earns more from a polar range but folds out the thinnest calls — size to the worst hand that still calls.`
      : bluff
        ? `Bluff (${FRAC_LABEL[s]}): risk ${betBB.toFixed(1)}bb to win ${potBB.toFixed(1)}bb, so villain must fold >${be}% for it to profit; here he folds ~${foldOf(s)}%.${
            flushSuit >= 0 && !holdsFlushCard
              ? ` But you hold no ${flushSym}, so you block none of his flushes — a weaker bluff than a hand that does.`
              : ''
          }`
        : `Betting a bluff-catcher turns a hand that beats only worse hands (which fold) into one called only by better — no value, and nothing to bluff. Prefer check/call.`;
  });

  const eqNote = value
    ? `Your ~${eqPct}% is near the top of your range — bet for value and size up.`
    : bluff
      ? `Your ~${eqPct}% is near the bottom — a bluff-or-give-up hand. It keeps a little showdown value (beats his busted hands), so a check is a real option, not just a bet.`
      : `Your ~${eqPct}% is a bluff-catcher — beats his bluffs, loses to his value, so check and call only at the right price.`;
  const potBluff = Math.round(requiredEquityForBet(1.0) * 100);
  const potRatio = ((1 - requiredEquityForBet(1.0)) / Math.max(0.001, requiredEquityForBet(1.0))).toFixed(1);

  // Blocker teaching line — only meaningful on a flush board for a bluff-tier hand.
  const blockerNote =
    bluff && flushSuit >= 0
      ? holdsFlushCard
        ? `Blockers: you hold a ${flushSym}, which blocks some of villain's made flushes — a good card to bluff with, since it folds more of his continues out.`
        : `Blockers: you hold no ${flushSym}, so you don't make his flushes any less likely — a weak card to rep the flush with. The best bluffs here hold a ${flushSym}; a hand with equity and no blocker prefers to check.`
      : '';

  const notes = [
    `River, range vs range — no more cards, so bets are polarized (strong value + bluffs, little between) and every hand is a value bet or a bluff-catcher.`,
    eqNote,
    blockerNote,
    bluff && bestIsCheck
      ? `Here a check is best: a hand with some showdown value and weak blockers gives up more by bluffing than it gains — and bluffing is never forced.`
      : `Bigger sizes fold out more: villain folds ~${foldOf(3)}% vs a pot bet vs ~${foldOf(0)}% vs ⅓. A pot bet needs him to fold >50% to profit — the solver leans on the big size because a polar range makes the nuts credible.`,
    `Balance: at pot the mix wants ~${potBluff}% bluffs (≈ ${potRatio}:1 value:bluff) so villain can't profitably fold everything or call everything.`,
  ].filter(Boolean);
  return { notes, why, sizeNote };
}

/** Expand a WeightedRange to concrete combos, drop board/dead conflicts, apply an
 *  optional per-combo weight, subsample down to `cap` combos, and (optionally)
 *  force-include a specific combo (hero's actual hand).
 *
 *  Subsampling is a REPRESENTATIVE systematic (stride) sample, NOT the top-`cap` by
 *  weight. Keeping the highest-weight combos silently gutted the range whenever the
 *  per-combo weight (`cw`) down-weighted the strong hands: on a wet board the "capped"
 *  weighting shades villain's straights/flushes to ~0.85, so a top-by-weight cut
 *  evicted EVERY flush and straight (verified: a 427-combo BTN range → 0 flushes /
 *  0 straights after an 80-cap), leaving a too-weak range that inflated hero equity and
 *  drove massive over-bluffing (A9-high "bet pot 60%" on 48857T with 3 diamonds — the
 *  bug this fixes). Systematic sampling preserves the weighted mix across hand strengths
 *  (the down-weight is still carried in `w` into the solve), so flushes/straights appear
 *  in proportion. No hand evaluation, so it works for both the turn and river caps. */
function buildCombos(
  range: WeightedRange,
  board: Card[],
  block: Card[],
  cap: number,
  cw?: (a: Card, b: Card) => number,
  force?: [Card, Card],
): Combo[] {
  const combos: Combo[] = [];
  for (const [code, w] of range) {
    if (w <= 0) continue;
    for (const [a, b] of codeToCombos(code)) {
      if (dead(a, board) || dead(b, board) || dead(a, block) || dead(b, block)) continue;
      const weight = w * (cw ? cw(a, b) : 1);
      if (weight > 0) combos.push({ cards: [a, b], w: weight });
    }
  }
  let kept: Combo[];
  if (combos.length <= cap) kept = combos;
  else {
    // even stride across the range preserves the code-by-code distribution the Map
    // was built in (each 169-code's combos sit together), so every hand class is
    // sampled in proportion instead of the strongest being cut for their low weight.
    kept = [];
    const stride = combos.length / cap;
    for (let k = 0; k < cap; k++) kept.push(combos[Math.floor(k * stride)]);
  }
  if (force && !dead(force[0], board) && !dead(force[1], board)) {
    const has = kept.some((c) => sameCard(c.cards[0], force[0]) && sameCard(c.cards[1], force[1]));
    if (!has) kept.push({ cards: force, w: kept.length ? kept[kept.length >> 1].w : 1 });
  }
  return kept;
}

export interface RiverSolveParams {
  heroCards: Card[];
  board: Card[]; // 5
  pot: number;
  effStack: number;
  heroRange: WeightedRange;
  villainRange: WeightedRange;
  villainComboWeight?: (a: Card, b: Card) => number;
  bigBlind: number;
  rangeNote?: string;
}

/** Solve a hero-first heads-up river node range-vs-range and adapt to NodeStrategy.
 *  Returns null when it can't apply (bad board, hero hand missing, empty range). */
export function solveRiverNode(p: RiverSolveParams): NodeStrategy | null {
  if (p.board.length !== 5 || p.heroCards.length !== 2) return null;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, VILLAIN_CAP, p.villainComboWeight);
  const heroCombos = buildCombos(p.heroRange, p.board, [], HERO_CAP, undefined, heroActual);
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const result = solveRiver({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    pot: p.pot,
    effStack: p.effStack,
    betSizes: RIVER_SIZES,
    iterations: 700,
  });

  return heroFirstNodeStrategy(
    result,
    heroCombos,
    heroActual,
    p.board,
    p.pot,
    p.bigBlind,
    `River solver — range-vs-range equilibrium (CFR over both ranges, not the ` +
      `per-hand estimate). Frequencies are the solved mix.` +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
    true,
  );
}

/** Shared mapping: a hero-first solver result (river or turn) → NodeStrategy for
 *  hero's specific hand. "Best" = the highest-EV line (tie-break: frequency), so it
 *  matches the "highest-EV line" the grader/UI reports and EV-loss is a true regret.
 *  In a fully converged equilibrium the played actions are ~EV-indifferent, so this
 *  is also the primary line; but the finite solve can leave an EV gap between mixed
 *  actions, and when it does the genuinely most-profitable line must win — otherwise
 *  we'd crown a lower-EV line "best" and mis-grade the deviation. */
function heroFirstNodeStrategy(
  res: { heroStrategy: { action: string; freq: number }[][]; heroActionEv: number[][]; villainCallFreq?: number[] },
  heroCombos: Combo[],
  heroActual: [Card, Card],
  board: Card[],
  pot: number,
  bigBlind: number,
  noteText: string,
  river = false,
): NodeStrategy | null {
  const idx = heroCombos.findIndex(
    (c) => sameCard(c.cards[0], heroActual[0]) && sameCard(c.cards[1], heroActual[1]),
  );
  if (idx < 0) return null;
  const row = res.heroStrategy[idx];
  const evRow = res.heroActionEv[idx];
  const freqOf = (action: string) => row.find((a) => a.action === action)?.freq ?? 0;

  const options: ActionOption[] = [
    { id: 'check', label: 'Check', freq: freqOf('check'), ev: round2(evRow[0] / bigBlind), kind: 'passive' },
  ];
  RIVER_SIZES.forEach((f, s) => {
    options.push({
      id: SIZE_ID[s],
      label: SIZE_LABEL[s],
      freq: freqOf(`bet:${s}`),
      ev: round2(evRow[1 + s] / bigBlind),
      amount: Math.round(f * pot),
      sizePct: Math.round(f * 100),
      kind: 'aggressive',
    });
  });

  let best = options[0];
  for (const o of options) if (o.ev > best.ev || (o.ev === best.ev && o.freq > best.freq)) best = o;

  // River-only: attach solve-grounded per-line reasons + a bulleted overview so the
  // Explain panel has something to show (the CFR path sets no `why`/`notes` itself).
  // evRow[0] is the check EV in chips = pot × hero's showdown equity, so it recovers
  // the equity the reasons key off without a second Monte-Carlo. Skipped on the turn
  // (river=false): turn reasons would need protection/runout wording this doesn't have.
  let notes: string[] | undefined;
  if (river && res.villainCallFreq) {
    const r = riverReasons(evRow[0], res.villainCallFreq, pot, bigBlind, heroActual, board, best.id === 'check');
    for (const o of options) {
      if (r.why[o.id]) o.why = r.why[o.id];
      if (r.sizeNote[o.id]) o.sizeNote = r.sizeNote[o.id];
    }
    notes = [...r.notes, noteText];
  }

  return {
    options: options.sort((a, b) => b.freq - a.freq || b.ev - a.ev),
    bestEv: round2(best.ev),
    bestId: best.id,
    source: 'postflop-model',
    note: noteText,
    notes,
  };
}

/** Solve a hero-first heads-up TURN node range-vs-range (river runouts enumerated
 *  for the showdown equity) and adapt to NodeStrategy. Smaller caps than the river
 *  because the equity matrix costs O(hero × villain × 44 rivers). */
export function solveTurnNode(p: RiverSolveParams): NodeStrategy | null {
  if (p.board.length !== 4 || p.heroCards.length !== 2) return null;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, TURN_VILLAIN_CAP, p.villainComboWeight);
  const heroCombos = buildCombos(p.heroRange, p.board, [], TURN_HERO_CAP, undefined, heroActual);
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const result = solveTurn({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    pot: p.pot,
    effStack: p.effStack,
    betSizes: RIVER_SIZES,
    // 2000: the old 4000 was compensating for the CHECK being scored as an instant
    // turn showdown — at low iters the bet EVs were overstated vs that too-low check,
    // so a legitimate give-up looked like a ~1.5bb blunder and needed many iters to
    // converge the bets back down. solveTurn now values a check as a real river
    // subgame (nestRiverForCheck), so the check baseline is correct and the mix
    // reaches near-indifference far sooner. 2000 is plenty; the nested per-river
    // solves are the dominant cost now, so this also claws back the time they add.
    iterations: 2000,
    riverNestIterations: 140,
  });

  return heroFirstNodeStrategy(
    result,
    heroCombos,
    heroActual,
    p.board,
    p.pot,
    p.bigBlind,
    `Turn solver — range-vs-range with the river runouts enumerated for showdown ` +
      `equity. Frequencies are the solved mix.` +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}

export interface RiverVsBetNodeParams {
  heroCards: Card[];
  board: Card[];
  potBeforeBet: number; // Q
  bet: number; // b
  raiseTo: number; // r (total chips), must be > bet
  heroRange: WeightedRange;
  villainRange: WeightedRange;
  villainComboWeight?: (a: Card, b: Card) => number;
  bigBlind: number;
  rangeNote?: string;
}

/** Solve a hero-facing-a-bet heads-up river node (fold / call / raise) range-vs-range
 *  and adapt to NodeStrategy. Returns null when it can't apply. */
export function solveRiverVsBetNode(p: RiverVsBetNodeParams): NodeStrategy | null {
  if (p.board.length !== 5 || p.heroCards.length !== 2 || p.raiseTo <= p.bet) return null;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, VILLAIN_CAP, p.villainComboWeight);
  const heroCombos = buildCombos(p.heroRange, p.board, [], HERO_CAP, undefined, heroActual);
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const res = solveRiverVsBet({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    potBeforeBet: p.potBeforeBet,
    bet: p.bet,
    raiseTo: p.raiseTo,
    iterations: 900,
  });

  const idx = heroCombos.findIndex(
    (c) => sameCard(c.cards[0], heroActual[0]) && sameCard(c.cards[1], heroActual[1]),
  );
  if (idx < 0) return null;
  const s = res.heroStrategy[idx];
  const ev = res.heroEv[idx];
  const potNow = p.potBeforeBet + p.bet;

  const options: ActionOption[] = [
    { id: 'fold', label: 'Fold', freq: s.fold, ev: 0, kind: 'fold' },
    { id: 'call', label: `Call ${p.bet}`, freq: s.call, ev: round2(ev.call / p.bigBlind), kind: 'call' },
    {
      id: 'betpot',
      label: `Raise to ${p.raiseTo}`,
      freq: s.raise,
      ev: round2(ev.raise / p.bigBlind),
      amount: p.raiseTo,
      sizePct: Math.round((100 * p.raiseTo) / potNow),
      kind: 'aggressive',
    },
  ];

  let best = options[0];
  for (const o of options) if (o.ev > best.ev || (o.ev === best.ev && o.freq > best.freq)) best = o;

  return {
    options: options.sort((a, b) => b.freq - a.freq || b.ev - a.ev),
    bestEv: round2(best.ev),
    bestId: best.id,
    source: 'postflop-model',
    note:
      `River solver — range-vs-range (facing a bet: fold / call / raise, CFR over ` +
      `both ranges).` + (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  };
}
