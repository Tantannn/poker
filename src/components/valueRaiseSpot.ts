// Spot generation for the Value-Raise drill, kept out of the component file so the
// generator (and its types) can be unit-tested without tripping react-refresh. Deals a
// facing-a-bet node biased toward a made hand and grades the best line with the real engine.

import type { Card } from '../engine/cards';
import { makeDeck, shuffle } from '../engine/cards';
import { evaluateBest, describeHand } from '../engine/evaluator';
import { rangeFromSet } from '../engine/range';
import { BB_DEFEND_RANGE } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import type { ActionId } from '../strategy/types';

export type Cat = 'raise' | 'call' | 'fold';

const BB = 2;
const VILL_RANGE = rangeFromSet(BB_DEFEND_RANGE); // a wide caller/leader — lots of worse hands + draws to raise against
const SIZES = [0.5, 0.66, 0.75, 1]; // villain bet as a fraction of the pot
const POTS_BB = [12, 16, 20, 26, 32, 44]; // pot before hero acts, in bb
// Facing a bet, solvePostflop expresses a RAISE via the bet-fraction ids (bet33…betpot =
// raise-TO sizes) — anything that isn't call/fold/check is aggression.
const isAgg = (id: ActionId) => id !== 'call' && id !== 'fold' && id !== 'check';
const pick = <T,>(a: T[], rng: () => number): T => a[Math.floor(rng() * a.length)];

export interface Spot {
  board: Card[];
  hole: Card[];
  handName: string;
  street: 'flop' | 'turn';
  position: 'ip' | 'oop';
  potBB: number;
  betBB: number;
  best: Cat;
  bestEv: number;
  raiseEv: number;
  callEv: number;
  raiseLabel: string; // e.g. "raise to 34bb"
  why: string; // the best raise option's reasoning, for the reveal
}

export function genSpot(rng: () => number = Math.random): Spot {
  const street = rng() < 0.5 ? 'flop' : 'turn';
  const nBoard = street === 'flop' ? 3 : 4;
  // Bias toward a genuine made hand: mostly two-pair+ (where a raise is usually right — the
  // spot this drill exists for), sometimes one pair (so calling is a real option and the drill
  // isn't "always raise"). Reject air — a made-hand raise is the lesson.
  const wantStrong = rng() < 0.62;
  let board: Card[] = [];
  let hole: Card[] = [];
  for (let i = 0; i < 500; i++) {
    const d = shuffle(makeDeck(), rng);
    const b = d.slice(0, nBoard);
    const h = d.slice(nBoard, nBoard + 2);
    const rank = evaluateBest(h, b).categoryRank; // 0 high · 1 pair · 2 two pair · 3 trips …
    if (wantStrong ? rank >= 2 : rank >= 1) { board = b; hole = h; break; }
  }
  if (!board.length) { const d = shuffle(makeDeck(), rng); board = d.slice(0, nBoard); hole = d.slice(nBoard, nBoard + 2); }

  const position: 'ip' | 'oop' = rng() < 0.5 ? 'ip' : 'oop';
  const potBB = pick(POTS_BB, rng);
  const betBB = Math.max(1, Math.round(potBB * pick(SIZES, rng)));
  const pot = potBB * BB;
  const bet = betBB * BB;
  const behind = 200; // ~100bb effective, deep enough that a raise is always legal
  const strat = solvePostflop({
    hero: hole, board, oppRange: VILL_RANGE,
    pot: pot + bet, // chips in the middle INCLUDING the villain bet hero faces
    toCall: bet, heroCommitted: 0, currentBet: bet,
    minRaiseTo: bet + Math.max(BB, bet), maxRaiseTo: behind,
    canCheck: false, canRaise: true, bigBlind: BB, iterations: 2200, position,
  });
  const aggro = strat.options.filter((o) => isAgg(o.id)).sort((a, b2) => b2.ev - a.ev);
  const raiseEv = aggro.length ? aggro[0].ev : -Infinity;
  const callEv = strat.options.find((o) => o.id === 'call')?.ev ?? -Infinity;
  // Grade on the engine's own best line (EV-anchored, per CLAUDE.md), mapped to a category.
  const best: Cat = isAgg(strat.bestId) ? 'raise' : strat.bestId === 'call' ? 'call' : 'fold';
  const bestRaise = aggro[0];
  return {
    board, hole, handName: describeHand(evaluateBest(hole, board)), street, position, potBB, betBB,
    best, bestEv: strat.bestEv, raiseEv, callEv,
    raiseLabel: bestRaise?.amount != null ? `raise to ${Math.round(bestRaise.amount / BB)}bb` : 'raise',
    why: bestRaise?.why ?? '',
  };
}
