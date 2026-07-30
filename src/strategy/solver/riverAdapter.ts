// Bridges the range-vs-range river solver (riverSolver.ts) into the live engine:
// expands both players' weighted ranges to concrete combos (subsampled for speed),
// runs the CFR solve, and maps the result onto the NodeStrategy shape the HUD and
// grader already consume. Pure — imports nothing from strategy/index.ts, so no
// import cycle. Applies to a hero-FIRST heads-up river node only (v1 tree).

import type { Card } from '../../engine/cards';
import { sameCard, SUIT_SYMBOLS } from '../../engine/cards';
import type { WeightedRange } from '../../engine/range';
import { codeToCombos } from '../../engine/range';
import type { NodeStrategy, ActionOption } from '../types';
import { solveRiver, solveRiverVsBet, type Combo } from './riverSolver';
import { solveTurn, solveTurnVsBet } from './turnSolver';
import { solveFlop, solveFlopVsBet } from './flopSolver';
import { solveRiver3way, solveTurn3way } from './multiwaySolver';
import type { VsBetResult } from './vsBet';
import { betSizeGrid, raiseSizeGrid, type BetSizeGrid, type RaiseSizeGrid } from './betSizeGrid';
import { requiredEquityForBet } from '../../engine/potOdds';

// Size grids are built per node (betSizeGrid) — the sizes on offer depend on the stack.
// The polar overbet slot is offered on the hero-first TURN and RIVER only: it pays off a
// polar range, which is a turn/river property, and the flop and 3-way solves each nest
// another chance layer, so a 5th size costs more there than it teaches.
const HERO_CAP = 48;
const VILLAIN_CAP = 80;
// Turn caps are smaller: the equity matrix costs O(hero × villain × ~44 rivers).
const TURN_HERO_CAP = 36;
const TURN_VILLAIN_CAP = 48;
// Flop caps are smaller still: the equity matrix enumerates BOTH streets — O(hero ×
// villain × ~990 turn+river runouts) — and the check line nests a turn solve per bucket.
const FLOP_HERO_CAP = 20;
const FLOP_VILLAIN_CAP = 28;
// 3-way caps. The third player is aggregated into scalars, so per-iteration cost stays
// O(hero × villain); the river solve is exact (score-based) so it can carry near-HU caps.
const MW_RIVER_HERO_CAP = 40;
const MW_RIVER_VILLAIN_CAP = 48;
const MW_RIVER_THIRD_CAP = 48;
// The turn 3-way enumerates three river-equity matrices AND nests a river 3-way per bucket,
// so it takes the tightest caps of all.
const MW_TURN_HERO_CAP = 22;
const MW_TURN_VILLAIN_CAP = 28;
const MW_TURN_THIRD_CAP = 28;

const round2 = (x: number) => Math.round(x * 100) / 100;
const dead = (c: Card, cards: Card[]) => cards.some((x) => sameCard(x, c));

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
  grid: BetSizeGrid,
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

  grid.fracs.forEach((frac, s) => {
    const id = grid.ids[s];
    const be = Math.round((frac / (1 + frac)) * 100); // breakeven fold% for a bluff this size
    const betBB = (frac * pot) / bb;
    const bluffFrac = requiredEquityForBet(frac);
    const ratio = (1 - bluffFrac) / Math.max(0.001, bluffFrac);
    sizeNote[id] = `⚖ ~${Math.round(bluffFrac * 100)}% bluffs · ${ratio.toFixed(1)}:1 value:bluff`;
    why[id] = value
      ? `Value bet (${grid.fracLabels[s]}): you're ~${eqPct}% ahead and villain still calls ~${callOf(s)}%, paying you off.${
          frac > 1
            ? ` An overbet only works because your range here is POLAR — the nuts plus bluffs, nothing between; villain can't call wide against it, so the size prints with your best hands.`
            : ` A bigger size earns more from a polar range but folds out the thinnest calls — size to the worst hand that still calls.`
        }`
      : bluff
        ? `Bluff (${grid.fracLabels[s]}): risk ${betBB.toFixed(1)}bb to win ${potBB.toFixed(1)}bb, so villain must fold >${be}% for it to profit; here he folds ~${foldOf(s)}%.${
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
  // Balance is quoted at the BIGGEST size on offer — the one that needs the most bluffs,
  // and the number the player has to hold to if he takes the polar line.
  const top = Math.max(0, grid.fracs.length - 1);
  const topFrac = grid.fracs[top] ?? 1;
  const topBluffFrac = requiredEquityForBet(topFrac);
  const potBluff = Math.round(topBluffFrac * 100);
  const potRatio = ((1 - topBluffFrac) / Math.max(0.001, topBluffFrac)).toFixed(1);

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
      : `Bigger sizes fold out more: villain folds ~${foldOf(top)}% vs ${grid.fracLabels[top]} vs ~${foldOf(0)}% vs ${grid.fracLabels[0]}. ${
          grid.fracLabels[top]
        } needs him to fold >${Math.round((topFrac / (1 + topFrac)) * 100)}% to profit — the solver leans on the big size because a polar range makes the nuts credible.`,
    `Balance: at ${grid.fracLabels[top]} the mix wants ~${potBluff}% bluffs (≈ ${potRatio}:1 value:bluff) so villain can't profitably fold everything or call everything.`,
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
  /** NODE LOCK: villain's fold-to-bet read (0..1). When set, villain's strategy is
   *  PINNED to it and hero best-responds instead of both sides reaching equilibrium.
   *  Omit for the GTO baseline — an equilibrium villain can't be exploited, so a
   *  fold-frequency read only changes the answer once his strategy stops solving. */
  villainFoldToBet?: number;
}

/** Solve a hero-first heads-up river node range-vs-range and adapt to NodeStrategy.
 *  Returns null when it can't apply (bad board, hero hand missing, empty range). */
export function solveRiverNode(p: RiverSolveParams): NodeStrategy | null {
  if (p.board.length !== 5 || p.heroCards.length !== 2) return null;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, VILLAIN_CAP, p.villainComboWeight);
  const heroCombos = buildCombos(p.heroRange, p.board, [], HERO_CAP, undefined, heroActual);
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const locked = p.villainFoldToBet != null;
  const grid = betSizeGrid(p.pot, p.effStack, true);
  const result = solveRiver({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    pot: p.pot,
    effStack: p.effStack,
    betSizes: grid.fracs,
    iterations: 700,
    villainLock: locked ? { foldToBet: p.villainFoldToBet as number } : undefined,
  });

  return heroFirstNodeStrategy(
    result,
    grid,
    heroCombos,
    heroActual,
    p.board,
    p.pot,
    p.bigBlind,
    (locked
      ? `River solver — NODE LOCKED to your read: villain folds ~${Math.round(
          (p.villainFoldToBet as number) * 100,
        )}% to a ¾-pot bet (scaled by pot odds across sizes) and your line is the BEST RESPONSE to that, ` +
        `not an equilibrium. An equilibrium villain can't be exploited, which is why the lock has to pin him.`
      : `River solver — range-vs-range equilibrium (CFR over both ranges, not the ` +
        `per-hand estimate). Frequencies are the solved mix.`) +
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
  grid: BetSizeGrid,
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
  // `bet:${s}` indices are the grid's own order: betSizeGrid guarantees every size is a
  // distinct positive amount inside the stack, so no solver filtering shifts them.
  grid.fracs.forEach((f, s) => {
    options.push({
      id: grid.ids[s],
      label: grid.labels[s],
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
    const r = riverReasons(grid, evRow[0], res.villainCallFreq, pot, bigBlind, heroActual, board, best.id === 'check');
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

  const locked = p.villainFoldToBet != null;
  const grid = betSizeGrid(p.pot, p.effStack, true);
  const result = solveTurn({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    pot: p.pot,
    effStack: p.effStack,
    betSizes: grid.fracs,
    // The nested river subgames on the check line keep the base grid: after checking the
    // turn hero's range is capped, which is the one range an overbet cannot represent —
    // and the nest is the turn solve's dominant cost.
    checkLineBetSizes: betSizeGrid(p.pot, p.effStack).fracs,
    // 2000: the old 4000 was compensating for the CHECK being scored as an instant
    // turn showdown — at low iters the bet EVs were overstated vs that too-low check,
    // so a legitimate give-up looked like a ~1.5bb blunder and needed many iters to
    // converge the bets back down. solveTurn now values a check as a real river
    // subgame (nestRiverForCheck), so the check baseline is correct and the mix
    // reaches near-indifference far sooner. 2000 is plenty; the nested per-river
    // solves are the dominant cost now, so this also claws back the time they add.
    iterations: 2000,
    riverNestIterations: 140,
    villainLock: locked ? { foldToBet: p.villainFoldToBet as number } : undefined,
  });

  return heroFirstNodeStrategy(
    result,
    grid,
    heroCombos,
    heroActual,
    p.board,
    p.pot,
    p.bigBlind,
    (locked
      ? `Turn solver — NODE LOCKED to your read: villain folds ~${Math.round(
          (p.villainFoldToBet as number) * 100,
        )}% to a ¾-pot bet (scaled by pot odds across sizes), and your line — bet AND check ` +
        `(the nested river subgames best-respond too) — is the BEST RESPONSE to that read, not an equilibrium.`
      : `Turn solver — range-vs-range with the river runouts enumerated for showdown ` +
        `equity. Frequencies are the solved mix.`) +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}

/** Solve a hero-first heads-up FLOP node range-vs-range (turn+river runouts enumerated
 *  for showdown equity, the CHECK line nesting a real turn subgame per texture bucket) and
 *  adapt to NodeStrategy. Smallest caps of the three streets — the equity matrix costs
 *  O(hero × villain × ~990 runouts) and the check line nests a turn solve per bucket. */
export function solveFlopNode(p: RiverSolveParams): NodeStrategy | null {
  if (p.board.length !== 3 || p.heroCards.length !== 2) return null;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, FLOP_VILLAIN_CAP, p.villainComboWeight);
  const heroCombos = buildCombos(p.heroRange, p.board, [], FLOP_HERO_CAP, undefined, heroActual);
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const grid = betSizeGrid(p.pot, p.effStack);
  const result = solveFlop({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    pot: p.pot,
    effStack: p.effStack,
    betSizes: grid.fracs,
    iterations: 700,
    turnNestIterations: 220,
  });

  return heroFirstNodeStrategy(
    result,
    grid,
    heroCombos,
    heroActual,
    p.board,
    p.pot,
    p.bigBlind,
    `Flop solver — range-vs-range with turn+river runouts enumerated for showdown equity; ` +
      `the check line nests a turn subgame. Turn cards are bucketed by texture (a disclosed ` +
      `abstraction, not a solver-exact flop solve). Frequencies are the solved mix.` +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}

export interface Multiway3NodeParams extends RiverSolveParams {
  /** the FIXED-policy opponents: 1 = 3-way, 2 = 4-way, 3 = 5-way */
  fieldRanges: WeightedRange[];
  fieldComboWeight?: (a: Card, b: Card) => number;
  /** Reads on the FIXED opponents (0..1 fold-to-¾-pot), parallel to `fieldRanges`. Each
   *  re-anchors that player's MDF policy; omit for the parameter-free default.
   *  `villainFoldToBet` (inherited) is unused on the multiway paths — the SOLVED villain's
   *  read routes through the per-hand model. */
  fieldFoldToBet?: (number | undefined)[];
}

/** Combo caps shrink as the field grows: each extra fixed player adds an O(range × field)
 *  precompute and doubles the caller sets the inner loop walks. */
const fieldCapScale = (nField: number) => (nField <= 1 ? 1 : nField === 2 ? 0.75 : 0.6);
const scaleCap = (cap: number, nField: number) => Math.max(12, Math.round(cap * fieldCapScale(nField)));

/** Solve a hero-first 3-WAY river node (hero + primary villain by CFR, the second opponent
 *  on a fixed MDF policy) and adapt to NodeStrategy. HU-framed per-line reasons are skipped
 *  (river=false) — they assume one opponent; the note explains the multiway solve. */
export function solveRiver3wayNode(p: Multiway3NodeParams): NodeStrategy | null {
  if (p.board.length !== 5 || p.heroCards.length !== 2 || p.fieldRanges.length === 0) return null;
  const nF = p.fieldRanges.length;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, scaleCap(MW_RIVER_VILLAIN_CAP, nF), p.villainComboWeight);
  const fieldCombos = p.fieldRanges.map((r) =>
    buildCombos(r, p.board, p.heroCards, scaleCap(MW_RIVER_THIRD_CAP, nF), p.fieldComboWeight),
  );
  const heroCombos = buildCombos(p.heroRange, p.board, [], scaleCap(MW_RIVER_HERO_CAP, nF), undefined, heroActual);
  if (villainCombos.length === 0 || fieldCombos.some((c) => c.length === 0) || heroCombos.length === 0) return null;

  const grid = betSizeGrid(p.pot, p.effStack);
  const result = solveRiver3way({
    heroRange: heroCombos,
    villainRange: villainCombos,
    fieldRanges: fieldCombos,
    board: p.board,
    pot: p.pot,
    effStack: p.effStack,
    betSizes: grid.fracs,
    iterations: 1000,
    fieldFoldToBet: p.fieldFoldToBet,
  });

  return heroFirstNodeStrategy(
    result,
    grid,
    heroCombos,
    heroActual,
    p.board,
    p.pot,
    p.bigBlind,
    `${nF + 2}-way river solver — hero + one villain solved range-vs-range (CFR); the other ` +
      `${nF === 1 ? 'opponent follows' : `${nF} opponents each follow`} a fixed MDF policy ` +
      `(defends the top of its range, folds the rest). Bluffs earn less than heads-up because ` +
      `a bet must get through ${nF + 1} players.` +
      fieldReadNote(p.fieldFoldToBet) +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}

function fieldReadNote(reads: (number | undefined)[] | undefined): string {
  const named = (reads ?? []).filter((r): r is number => r != null);
  if (!named.length) return '';
  const pcts = named.map((r) => `~${Math.round(r * 100)}%`).join(', ');
  return named.length === 1
    ? ` The fixed opponent's fold read (${pcts} to a ¾-pot bet) is applied to its policy.`
    : ` The fixed opponents' fold reads (${pcts} to a ¾-pot bet) are applied to their policies.`;
}

/** Solve a hero-first 3-WAY turn node (hero + villain CFR with river runouts enumerated for
 *  equity; the second opponent on a fixed MDF policy; the check line nests a 3-way river
 *  subgame per river-texture bucket). Adapt to NodeStrategy. Tightest caps of all paths. */
export function solveTurn3wayNode(p: Multiway3NodeParams): NodeStrategy | null {
  if (p.board.length !== 4 || p.heroCards.length !== 2 || p.fieldRanges.length === 0) return null;
  const nF = p.fieldRanges.length;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, scaleCap(MW_TURN_VILLAIN_CAP, nF), p.villainComboWeight);
  const fieldCombos = p.fieldRanges.map((r) =>
    buildCombos(r, p.board, p.heroCards, scaleCap(MW_TURN_THIRD_CAP, nF), p.fieldComboWeight),
  );
  const heroCombos = buildCombos(p.heroRange, p.board, [], scaleCap(MW_TURN_HERO_CAP, nF), undefined, heroActual);
  if (villainCombos.length === 0 || fieldCombos.some((c) => c.length === 0) || heroCombos.length === 0) return null;

  const grid = betSizeGrid(p.pot, p.effStack);
  const result = solveTurn3way({
    heroRange: heroCombos,
    villainRange: villainCombos,
    fieldRanges: fieldCombos,
    board: p.board,
    pot: p.pot,
    effStack: p.effStack,
    betSizes: grid.fracs,
    iterations: 900,
    riverNestIterations: 110,
    fieldFoldToBet: p.fieldFoldToBet,
  });

  return heroFirstNodeStrategy(
    result,
    grid,
    heroCombos,
    heroActual,
    p.board,
    p.pot,
    p.bigBlind,
    `${nF + 2}-way turn solver — hero + one villain range-vs-range (CFR, river runouts ` +
      `enumerated); the other ${nF === 1 ? 'opponent follows' : `${nF} opponents each follow`} a ` +
      `fixed MDF policy and the check line nests a multiway river subgame (bucketed by texture). ` +
      `A disclosed approximation, not full multiway CFR.` +
      fieldReadNote(p.fieldFoldToBet) +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}

export interface RiverVsBetNodeParams {
  heroCards: Card[];
  board: Card[];
  potBeforeBet: number; // Q
  bet: number; // b
  /** legal raise bounds from the engine — the offered raise sizes are built inside these */
  minRaiseTo: number;
  maxRaiseTo: number;
  heroRange: WeightedRange;
  villainRange: WeightedRange;
  villainComboWeight?: (a: Card, b: Card) => number;
  bigBlind: number;
  rangeNote?: string;
  /** NODE LOCK: villain's fold-to-bet read (0..1, quoted at ¾ pot). Villain has already bet,
   *  so this pins the one decision he has left — fold or call hero's RAISE — and hero
   *  best-responds. His BETTING range composition already carries the read separately
   *  (`villainComboWeight`); that prices hero's call, this prices hero's raise. */
  villainFoldToBet?: number;
}

/** Disclosed shape of the facing-a-bet tree: hero picks a raise size and villain can
 *  RE-RAISE it, which is what keeps a bluff-raise honestly priced. */
const VS_BET_TREE_NOTE =
  ` Hero chooses between two raise sizes and a jam, and villain can re-raise any of them ` +
  `(one re-raise size, capped by your stack) — so a raise is priced against being played back at.`;

/** How the note describes a locked vs an equilibrium facing-a-bet solve. */
function vsBetLockNote(foldToBet: number | undefined): string {
  return foldToBet == null
    ? ` Both sides solve, so the result is an equilibrium.`
    : ` NODE LOCKED to your read: villain continues vs your raise at the rate a ~${Math.round(
        foldToBet * 100,
      )}% fold-to-¾-pot player would (re-priced for the raise), and your line is the BEST RESPONSE to that — which is what makes a bluff-raise show up against a player who gives up when raised. ` +
      `His continuing hands still re-raise the top of that range, so the read can't make raising free.`;
}

/** Shared mapping: a facing-a-bet solver result (river/turn/flop) → NodeStrategy for hero's
 *  specific hand (fold / call / raise). Identical across streets — only the equity source
 *  behind `res` and the `note` differ. */
function vsBetNodeStrategy(
  res: VsBetResult,
  grid: RaiseSizeGrid,
  heroCombos: Combo[],
  heroActual: [Card, Card],
  bet: number,
  potBeforeBet: number,
  bigBlind: number,
  note: string,
): NodeStrategy | null {
  const idx = heroCombos.findIndex(
    (c) => sameCard(c.cards[0], heroActual[0]) && sameCard(c.cards[1], heroActual[1]),
  );
  if (idx < 0) return null;
  const s = res.heroStrategy[idx];
  const ev = res.heroEv[idx];
  const potNow = potBeforeBet + bet;

  const options: ActionOption[] = [
    { id: 'fold', label: 'Fold', freq: s.fold, ev: 0, kind: 'fold' },
    { id: 'call', label: `Call ${bet}`, freq: s.call, ev: round2(ev.call / bigBlind), kind: 'call' },
  ];
  grid.raiseTo.forEach((chips, k) => {
    options.push({
      id: grid.ids[k],
      label: grid.labels[k],
      freq: s.raises[k] ?? 0,
      ev: round2((ev.raises[k] ?? 0) / bigBlind),
      amount: chips,
      sizePct: Math.round((100 * chips) / potNow),
      kind: 'aggressive',
      sizeNote:
        res.villain3BetFreq[k] > 0.005
          ? `⚖ villain calls ~${Math.round(res.villainCallRaiseFreq[k] * 100)}% · re-raises ~${Math.round(
              res.villain3BetFreq[k] * 100,
            )}%`
          : undefined,
    });
  });

  let best = options[0];
  for (const o of options) if (o.ev > best.ev || (o.ev === best.ev && o.freq > best.freq)) best = o;

  return {
    options: options.sort((a, b) => b.freq - a.freq || b.ev - a.ev),
    bestEv: round2(best.ev),
    bestId: best.id,
    source: 'postflop-model',
    note,
  };
}

/** Solve a hero-facing-a-bet heads-up river node (fold / call / raise) range-vs-range
 *  and adapt to NodeStrategy. Returns null when it can't apply. */
export function solveRiverVsBetNode(p: RiverVsBetNodeParams): NodeStrategy | null {
  if (p.board.length !== 5 || p.heroCards.length !== 2) return null;
  const grid = raiseSizeGrid(p.potBeforeBet, p.bet, p.minRaiseTo, p.maxRaiseTo);
  if (grid.raiseTo.length === 0) return null;
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
    raiseSizes: grid.raiseTo,
    threeBetTo: grid.threeBetTo,
    iterations: 900,
    villainLock: p.villainFoldToBet != null ? { foldToBet: p.villainFoldToBet } : undefined,
  });

  return vsBetNodeStrategy(
    res,
    grid,
    heroCombos,
    heroActual,
    p.bet,
    p.potBeforeBet,
    p.bigBlind,
    `River solver — range-vs-range (facing a bet: fold / call / raise, CFR over ` +
      `both ranges).` +
      VS_BET_TREE_NOTE +
      vsBetLockNote(p.villainFoldToBet) +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}

/** Solve a hero-facing-a-bet heads-up TURN node (fold / call / raise) range-vs-range, the
 *  call/raise terminals scored on hero's equity over every river runout. */
export function solveTurnVsBetNode(p: RiverVsBetNodeParams): NodeStrategy | null {
  if (p.board.length !== 4 || p.heroCards.length !== 2) return null;
  const grid = raiseSizeGrid(p.potBeforeBet, p.bet, p.minRaiseTo, p.maxRaiseTo);
  if (grid.raiseTo.length === 0) return null;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, TURN_VILLAIN_CAP, p.villainComboWeight);
  const heroCombos = buildCombos(p.heroRange, p.board, [], TURN_HERO_CAP, undefined, heroActual);
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const res = solveTurnVsBet({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    potBeforeBet: p.potBeforeBet,
    bet: p.bet,
    raiseSizes: grid.raiseTo,
    threeBetTo: grid.threeBetTo,
    iterations: 900,
    villainFoldToBet: p.villainFoldToBet,
  });

  return vsBetNodeStrategy(
    res,
    grid,
    heroCombos,
    heroActual,
    p.bet,
    p.potBeforeBet,
    p.bigBlind,
    `Turn solver — range-vs-range facing a bet (fold / call / raise); the call and raise ` +
      `lines are scored on hero's equity over every river runout.` +
      VS_BET_TREE_NOTE +
      vsBetLockNote(p.villainFoldToBet) +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}

/** Solve a hero-facing-a-bet heads-up FLOP node (fold / call / raise) range-vs-range, the
 *  call/raise terminals scored on hero's equity over every turn+river runout. */
export function solveFlopVsBetNode(p: RiverVsBetNodeParams): NodeStrategy | null {
  if (p.board.length !== 3 || p.heroCards.length !== 2) return null;
  const grid = raiseSizeGrid(p.potBeforeBet, p.bet, p.minRaiseTo, p.maxRaiseTo);
  if (grid.raiseTo.length === 0) return null;
  const heroActual: [Card, Card] = [p.heroCards[0], p.heroCards[1]];
  const villainCombos = buildCombos(p.villainRange, p.board, p.heroCards, FLOP_VILLAIN_CAP, p.villainComboWeight);
  const heroCombos = buildCombos(p.heroRange, p.board, [], FLOP_HERO_CAP, undefined, heroActual);
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const res = solveFlopVsBet({
    heroRange: heroCombos,
    villainRange: villainCombos,
    board: p.board,
    potBeforeBet: p.potBeforeBet,
    bet: p.bet,
    raiseSizes: grid.raiseTo,
    threeBetTo: grid.threeBetTo,
    iterations: 900,
    villainFoldToBet: p.villainFoldToBet,
  });

  return vsBetNodeStrategy(
    res,
    grid,
    heroCombos,
    heroActual,
    p.bet,
    p.potBeforeBet,
    p.bigBlind,
    `Flop solver — range-vs-range facing a bet (fold / call / raise); the call and raise ` +
      `lines are scored on hero's equity over every turn+river runout (a static two-street ` +
      `showdown, no future betting on the call line).` +
      VS_BET_TREE_NOTE +
      vsBetLockNote(p.villainFoldToBet) +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
  );
}
