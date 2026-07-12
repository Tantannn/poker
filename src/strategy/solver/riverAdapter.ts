// Bridges the range-vs-range river solver (riverSolver.ts) into the live engine:
// expands both players' weighted ranges to concrete combos (subsampled for speed),
// runs the CFR solve, and maps the result onto the NodeStrategy shape the HUD and
// grader already consume. Pure — imports nothing from strategy/index.ts, so no
// import cycle. Applies to a hero-FIRST heads-up river node only (v1 tree).

import type { Card } from '../../engine/cards';
import { sameCard } from '../../engine/cards';
import type { WeightedRange } from '../../engine/range';
import { codeToCombos } from '../../engine/range';
import type { NodeStrategy, ActionId, ActionOption } from '../types';
import { solveRiver, solveRiverVsBet, type Combo } from './riverSolver';
import { solveTurn } from './turnSolver';

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

/** Expand a WeightedRange to concrete combos, drop board/dead conflicts, apply an
 *  optional per-combo weight, keep the `cap` highest-weight combos, and (optionally)
 *  force-include a specific combo (hero's actual hand). */
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
  combos.sort((x, y) => y.w - x.w);
  const kept = combos.slice(0, cap);
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
    p.pot,
    p.bigBlind,
    `River solver — range-vs-range equilibrium (CFR over both ranges, not the ` +
      `per-hand estimate). Frequencies are the solved mix.` +
      (p.rangeNote ? ` Villain: ${p.rangeNote}` : ''),
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
  res: { heroStrategy: { action: string; freq: number }[][]; heroActionEv: number[][] },
  heroCombos: Combo[],
  heroActual: [Card, Card],
  pot: number,
  bigBlind: number,
  noteText: string,
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

  return {
    options: options.sort((a, b) => b.freq - a.freq || b.ev - a.ev),
    bestEv: round2(best.ev),
    bestId: best.id,
    source: 'postflop-model',
    note: noteText,
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
    // 4000, not the old 600: at low iteration counts the averaged villain hasn't
    // learned to defend yet, so hero's BET EVs are overstated vs a CHECK (which is
    // modelled as an immediate turn showdown). That made a marginal check — e.g.
    // giving up with air — look like a ~1.5bb blunder when at equilibrium checking
    // and betting are near-EV-indifferent. By ~4000 iters the bet EVs converge down
    // to the check EV, so the grade stops flagging a legitimate give-up. The equity
    // matrix is the fixed cost; the extra iterations add ~0.4s (worst-case caps, in
    // the HUD worker) — see the header note on why the caps stay small.
    iterations: 4000,
  });

  return heroFirstNodeStrategy(
    result,
    heroCombos,
    heroActual,
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
