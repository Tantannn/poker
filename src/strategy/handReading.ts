// Hand-reading / range-narrowing engine. Powers the drill where the player takes a
// villain's preflop range and PRUNES it street-by-street to the hands consistent with
// the betting story — the core "put them on a range" skill. The "correct" narrowed
// range is DERIVED, not scripted: it reuses the exact same `betConditionedWeight` the
// solver uses to condition a range on a bet, so the drill can't teach a read the game
// then contradicts. Pure functions only (no React) so it's unit-testable.

import type { Card } from '../engine/cards';
import { makeDeck, sameCard, shuffle } from '../engine/cards';
import { codeToCombos } from '../engine/range';
import { evaluate7 } from '../engine/evaluator';
import { betConditionedWeight } from './index';
import { drawProfile } from './handClass';
import { RFI_RANGES, THREEBET_RANGE, BB_DEFEND_RANGE } from '../ai/preflop';

// Ranks high→low so index 0 = A; the grid rows/cols use this order.
export const HR_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

// A combo must want to bet with at least this likelihood (per betConditionedWeight)
// to belong in a betting line; below it, the combo is "capped" and belongs in a
// checking range. One threshold drives both directions so bet/check narrow symmetrically.
const BET_FLOOR = 0.35;
// Fallback pot fraction used to probe a hand's betting desire on a checked street.
const PROBE_FRAC = 0.66;

/** The 169-code for a grid cell (row i, col j), high→low ranks. Upper-right = suited,
 *  lower-left = offsuit, diagonal = pairs. Matches `codeToCombos`' expected format. */
export function gridCode(i: number, j: number): string {
  const hi = HR_RANKS[Math.min(i, j)];
  const lo = HR_RANKS[Math.max(i, j)];
  if (i === j) return `${hi}${hi}`;
  return i < j ? `${hi}${lo}s` : `${hi}${lo}o`;
}

export interface VillainProfile {
  label: string;
  note: string;
  codes: string[];
  /** archetype bluff scaling passed through to betConditionedWeight (value-heavy < 1). */
  bluffMult: number;
}

const RANGES: VillainProfile[] = [
  { label: 'UTG open', note: 'First in from early position — a tight, value-leaning opening range.', codes: [...RFI_RANGES.UTG], bluffMult: 0.7 },
  { label: 'CO open', note: 'Cutoff steal-ish open — medium width, balanced barrels.', codes: [...RFI_RANGES.CO], bluffMult: 1 },
  { label: 'BTN open', note: 'Button open — wide and positional, plenty of air to barrel.', codes: [...RFI_RANGES.BTN], bluffMult: 1.15 },
  { label: '3-bettor', note: 'Re-raised preflop — polarised, value-heavy premiums + a few bluffs.', codes: [...THREEBET_RANGE], bluffMult: 0.8 },
  { label: 'BB defend', note: 'Big blind flat-defend — wide and capped (few premiums, lots of speculative hands).', codes: [...BB_DEFEND_RANGE], bluffMult: 1 },
];

export type Action = { kind: 'bet' | 'check'; frac: number };

export interface StreetInfo {
  name: 'Flop' | 'Turn' | 'River';
  board: Card[]; // cumulative board visible this street
  action: Action;
}

export interface HRScenario {
  profile: VillainProfile;
  villainHand: [Card, Card];
  streets: StreetInfo[]; // always [Flop, Turn, River]
  board: Card[]; // full 5-card runout
}

function collides(cb: [Card, Card], board: Card[]): boolean {
  return board.some((b) => sameCard(b, cb[0]) || sameCard(b, cb[1]));
}

function probe(hand: [Card, Card], board: Card[], frac: number, bluffMult: number): number {
  return betConditionedWeight(hand[0], hand[1], board, true, frac, bluffMult);
}

function genOnce(rng: () => number): HRScenario {
  const profile = RANGES[Math.floor(rng() * RANGES.length)];
  const deck = shuffle(makeDeck(), rng);
  const board = deck.slice(0, 5);
  const combos = profile.codes.flatMap(codeToCombos).filter((cb) => !collides(cb, board));
  const villainHand = (combos.length ? combos[Math.floor(rng() * combos.length)] : [deck[5], deck[6]]) as [Card, Card];
  const names = ['Flop', 'Turn', 'River'] as const;
  const streets: StreetInfo[] = [3, 4, 5].map((n, idx) => {
    const b = board.slice(0, n);
    const w = probe(villainHand, b, PROBE_FRAC, profile.bluffMult);
    const kind: 'bet' | 'check' = w >= BET_FLOOR ? 'bet' : 'check';
    const frac = kind === 'bet' ? (w >= 1 ? 0.75 : 0.5) : PROBE_FRAC;
    return { name: names[idx], board: b, action: { kind, frac } };
  });
  return { profile, villainHand, streets, board };
}

/** Build a scenario, biased toward an interesting multi-barrel line (≥2 bets) so the
 *  player actually has a range to narrow. Deterministic when given a seeded rng. */
export function makeScenario(rng: () => number = Math.random): HRScenario {
  let last = genOnce(rng);
  for (let i = 0; i < 60; i++) {
    if (last.streets.filter((s) => s.action.kind === 'bet').length >= 2) return last;
    last = genOnce(rng);
  }
  return last;
}

/** Does one concrete combo survive a single street's action? A bet keeps combos that
 *  WANT to bet (weight ≥ floor); a check keeps the capped combos that would NOT bet. */
function survivesStreet(cb: [Card, Card], st: StreetInfo, bluffMult: number): boolean {
  const w = betConditionedWeight(cb[0], cb[1], st.board, true, st.action.frac, bluffMult);
  return st.action.kind === 'bet' ? w >= BET_FLOOR : w < BET_FLOOR;
}

/** For a 169-code, how many of its board-valid combos survive ALL revealed streets.
 *  `revealed` is the number of streets currently shown (1=flop … 3=river). */
export function codeConsistency(
  code: string,
  scenario: HRScenario,
  revealed: number,
  bluffMult: number,
): { valid: number; surviving: number } {
  const streets = scenario.streets.slice(0, revealed);
  const deepBoard = streets[streets.length - 1].board;
  const combos = codeToCombos(code).filter((cb) => !collides(cb, deepBoard));
  let surviving = 0;
  for (const cb of combos) if (streets.every((st) => survivesStreet(cb, st, bluffMult))) surviving++;
  return { valid: combos.length, surviving };
}

/** The engine's "correct" narrowed range at the current depth: codes where the
 *  majority of board-valid combos are consistent with the whole line so far. */
export function targetKeep(scenario: HRScenario, revealed: number): Set<string> {
  const keep = new Set<string>();
  for (const code of scenario.profile.codes) {
    const { valid, surviving } = codeConsistency(code, scenario, revealed, scenario.profile.bluffMult);
    if (valid > 0 && surviving / valid >= 0.5) keep.add(code);
  }
  return keep;
}

export interface HRScore {
  total: number; // codes graded (start-range codes with ≥1 valid combo)
  correct: number;
  accuracy: number; // 0..1
  keptWrong: string[]; // hero kept, engine says cut
  cutWrong: string[]; // hero cut, engine says keep
  target: Set<string>;
}

/** Grade the hero's kept set against the engine's narrowed range at this depth. */
export function scoreRead(scenario: HRScenario, revealed: number, heroKeep: Set<string>): HRScore {
  const target = targetKeep(scenario, revealed);
  const deepBoard = scenario.streets[revealed - 1].board;
  let total = 0;
  let correct = 0;
  const keptWrong: string[] = [];
  const cutWrong: string[] = [];
  for (const code of scenario.profile.codes) {
    const valid = codeToCombos(code).filter((cb) => !collides(cb, deepBoard)).length;
    if (valid === 0) continue; // fully blocked by the board — not gradable
    total++;
    const heroIn = heroKeep.has(code);
    const targetIn = target.has(code);
    if (heroIn === targetIn) correct++;
    else if (heroIn) keptWrong.push(code);
    else cutWrong.push(code);
  }
  return { total, correct, accuracy: total ? correct / total : 0, keptWrong, cutWrong, target };
}

export type ComboClass = 'value' | 'draw' | 'air';

/** Classify a concrete combo on a board: made hand (beats the bare board) = value;
 *  else a real flush/straight draw (not merely "could pair up") = draw; else air.
 *  Uses drawProfile so "draw" means an actual drawing hand, the way a reader thinks. */
export function classifyCombo(cb: [Card, Card], board: Card[]): ComboClass {
  const lift = evaluate7([...cb, ...board]).categoryRank - evaluate7(board).categoryRank;
  if (lift > 0) return 'value';
  const dp = drawProfile([cb[0], cb[1]], board);
  if (dp.flush || dp.straight !== 'none') return 'draw';
  return 'air';
}

export interface RangeMakeup {
  value: number;
  draw: number;
  air: number;
  combos: number;
}

/** Value/draw/air combo breakdown of a set of codes on the deepest revealed board —
 *  used to reveal what the correctly-narrowed range actually is. */
export function rangeMakeup(codes: Iterable<string>, scenario: HRScenario, revealed: number): RangeMakeup {
  const board = scenario.streets[revealed - 1].board;
  const m: RangeMakeup = { value: 0, draw: 0, air: 0, combos: 0 };
  for (const code of codes) {
    for (const cb of codeToCombos(code)) {
      if (collides(cb, board)) continue;
      m.combos++;
      m[classifyCombo(cb, board)]++;
    }
  }
  return m;
}
