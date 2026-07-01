// The "Postflop Gameplan" — a simplified, memorizable betting system (the
// PokerCoaching / SplitSuit-style matrix). You look up a BETTING RANGE by two
// inputs only: the BOARD TEXTURE (row) and the total BETS IN POT so far (column).
// The cell is a named tier (Tight+ / Tight / Loose / Loose+); each tier is a
// CUMULATIVE set of hand classes — a looser tier contains everything the tighter
// ones do, plus more. This models "first to act / facing a check" decisions.
//
// This is a transparent lookup table, NOT the EV solver in postflopModel — it's a
// beginner gameplan you can hold in your head. Kept as data so both the Reference
// table and the drill read the identical source of truth.

import type { Card } from '../engine/cards';
import { classifyHandClass } from './handClass';

// tightest → loosest. NB: "Tight+" is TIGHTER than "Tight" (the + means "more
// polar / nuttier"); "Loose+" is the widest.
export type Tier = 'Tight+' | 'Tight' | 'Loose' | 'Loose+';
export const TIER_ORDER: Tier[] = ['Tight+', 'Tight', 'Loose', 'Loose+'];
export const tierIndex = (t: Tier) => TIER_ORDER.indexOf(t);

export type GTexture = '4flush' | '4straight' | '3paired' | '3flush' | 'high' | 'low';
export type BetBucket = 0 | 1 | 2;

export const TEXTURE_ROWS: { id: GTexture; label: string; desc: string }[] = [
  { id: '3paired', label: '3 Paired Cards', desc: 'The board is paired — full houses & trips exist, so ranges tighten.' },
  { id: '4flush', label: '4 Flush Cards', desc: 'Four to a flush on board — flushes are live, bet only strong made hands + nut flushes.' },
  { id: '4straight', label: '4 Straight Cards', desc: 'Four to a straight on board — straights are live and many hands chop; bet polar.' },
  { id: '3flush', label: '3 Flush Cards', desc: 'Three of a suit / monotone — a flush is possible; stay disciplined across all sizes.' },
  { id: 'low', label: 'Low Cards', desc: 'Low, disconnected board — it hits few hands, so you can bet wide when bets are small.' },
  { id: 'high', label: 'High Card', desc: 'A broadway / high card on board — range-advantage board, bet widest first-in.' },
];
export const TEXTURE_LABEL: Record<GTexture, string> = Object.fromEntries(
  TEXTURE_ROWS.map((r) => [r.id, r.label]),
) as Record<GTexture, string>;

export const BET_COLS: { id: BetBucket; label: string }[] = [
  { id: 0, label: '0' },
  { id: 1, label: '0.5–1.5' },
  { id: 2, label: '2+' },
];

// texture → [bucket0, bucket1, bucket2] tier.
export const GRID: Record<GTexture, [Tier, Tier, Tier]> = {
  '3paired': ['Tight', 'Tight', 'Tight+'],
  '4flush': ['Tight', 'Tight+', 'Tight+'],
  '4straight': ['Tight', 'Tight+', 'Tight+'],
  '3flush': ['Tight', 'Tight', 'Tight'],
  low: ['Loose', 'Loose', 'Tight'],
  high: ['Loose+', 'Loose', 'Tight'],
};

// ---- cumulative hand-class content of each tier ----
// Tight+ = the nuttiest value + Air (a polar bet). On flushy/straighty boards a
// couple of texture-specific monsters get added to the Tight+ core.
const TIGHT_PLUS_BASE = ['Straight Flush', 'Four of a Kind', 'Strong Full House', 'Air'];
const TIGHT_PLUS_EXTRA: Partial<Record<GTexture, string[]>> = {
  '4flush': ['Weak Full House', 'Nut Flush'],
  '4straight': ['Flush (Not Nut)', 'Strong Straight'],
};
const TIGHT_ADD = [
  'Set', 'Trips – Good Kicker', 'Trips – Weak Kicker', 'Top Two Pair', 'Non-Top Two Pair',
  'Overpair', 'Top Pair – Top Kicker', 'Flush Draw to the Nuts', 'Combo Draw',
];
const LOOSE_ADD = ['Top Pair – Second Kicker', 'Top Pair – Third Kicker', 'Gutshot Draw'];
const LOOSE_PLUS_ADD = ['Second Pair', 'Premium Overcards', 'Backdoor Flush Draw to the Nuts'];

export interface TierGroup { tier: Tier; classes: string[] }

/** The tier groups for a texture, tightest → loosest, each carrying only the
 *  hand classes IT adds (cumulative — read top-down and keep everything above). */
export function tierGroups(texture: GTexture): TierGroup[] {
  return [
    { tier: 'Tight+', classes: [...TIGHT_PLUS_BASE, ...(TIGHT_PLUS_EXTRA[texture] ?? [])] },
    { tier: 'Tight', classes: TIGHT_ADD },
    { tier: 'Loose', classes: LOOSE_ADD },
    { tier: 'Loose+', classes: LOOSE_PLUS_ADD },
  ];
}

/** All hand classes a texture+tier bets = every group up to and including `tier`. */
export function tierClasses(texture: GTexture, tier: Tier): string[] {
  const cut = tierIndex(tier);
  return tierGroups(texture)
    .filter((g) => tierIndex(g.tier) <= cut)
    .flatMap((g) => g.classes);
}

/** Total postflop bets → column bucket. Small=0.5, Medium=1, Big=1.5, V.Large=2;
 *  bets across streets are summed. 0 → col0, 0.5–1.5 → col1, 2+ → col2. */
export function betBucket(totalBets: number): BetBucket {
  if (totalBets <= 0) return 0;
  if (totalBets >= 2) return 2;
  return 1;
}

/** The recommended tier for a texture + total bets in pot. */
export function gameplanTier(texture: GTexture, totalBets: number): Tier {
  return GRID[texture][betBucket(totalBets)];
}

// ---- board → texture row (priority-ordered; a board matches exactly one row) ----
function maxSuitCount(board: Card[]): number {
  const s = [0, 0, 0, 0];
  for (const c of board) s[c.suit]++;
  return Math.max(0, ...s);
}
function isPaired(board: Card[]): boolean {
  const seen = new Set<number>();
  for (const c of board) {
    if (seen.has(c.rank)) return true;
    seen.add(c.rank);
  }
  return false;
}
/** Max board cards falling inside any 5-rank straight window (ace plays both ends). */
function maxStraightWindow(board: Card[]): number {
  const present = new Set<number>();
  for (const c of board) {
    present.add(c.rank);
    if (c.rank === 14) present.add(1);
  }
  let best = 0;
  for (let lo = 1; lo <= 10; lo++) {
    let n = 0;
    for (let r = lo; r < lo + 5; r++) if (present.has(r)) n++;
    best = Math.max(best, n);
  }
  return best;
}

/** Classify a board into a gameplan texture row. Priority: flush > straight >
 *  paired > 3-flush > high/low, so the most range-defining feature wins. */
export function classifyGameplanTexture(board: Card[]): GTexture {
  if (board.length < 3) return 'high';
  const suited = maxSuitCount(board);
  if (suited >= 4) return '4flush';
  if (maxStraightWindow(board) >= 4) return '4straight';
  if (isPaired(board)) return '3paired';
  if (suited >= 3) return '3flush';
  const top = Math.max(...board.map((c) => c.rank));
  return top >= 10 ? 'high' : 'low'; // a Ten+ on board = a "high card" board
}

export const SPECIAL_RULES: { title: string; body: string }[] = [
  {
    title: 'OOP → check to the previous-street aggressor',
    body: 'Out of position, usually check to whoever was aggressor on the last street. They hold the stronger, more polar range and you act first — so lead rarely and defend by checking.',
  },
  {
    title: 'OOP → check sets on the flop',
    body: 'Out of position, usually check your sets on the flop to protect your checking range. It lets you show up with the nuts after checking, so villain can’t bet freely into your checks.',
  },
];

// ---- grading layer (for the drill): hero hand → chart class → its entry tier ----
// The TIGHTEST tier a hand class belongs to (it's then bet in that tier and every
// looser one). Built to match tierGroups; the texture-specific Tight+ monsters are
// treated as Tight+ everywhere (betting a made flush/straight for value is always
// fine), and two grading-only draws are added (a bare non-nut flush draw is NOT bet
// by this system → it maps to null / check). null = not in any tier → check.
export const HAND_TIER: Record<string, Tier> = {
  'Straight Flush': 'Tight+', 'Four of a Kind': 'Tight+', 'Strong Full House': 'Tight+',
  'Weak Full House': 'Tight+', 'Nut Flush': 'Tight+', 'Flush (Not Nut)': 'Tight+',
  'Strong Straight': 'Tight+', Air: 'Tight+',
  Set: 'Tight', 'Trips – Good Kicker': 'Tight', 'Trips – Weak Kicker': 'Tight',
  'Top Two Pair': 'Tight', 'Non-Top Two Pair': 'Tight', Overpair: 'Tight',
  'Top Pair – Top Kicker': 'Tight', 'Flush Draw to the Nuts': 'Tight', 'Combo Draw': 'Tight',
  'Top Pair – Second Kicker': 'Loose', 'Top Pair – Third Kicker': 'Loose', 'Gutshot Draw': 'Loose',
  'Open-Ended Straight Draw': 'Loose',
  'Second Pair': 'Loose+', 'Premium Overcards': 'Loose+', 'Backdoor Flush Draw to the Nuts': 'Loose+',
};

/** Map the fine-grained classifier label to the gameplan's chart-class vocabulary.
 *  Returns null when the hand is outside the whole system (e.g. bottom pair, a bare
 *  non-nut flush draw) — i.e. a check. */
export function handChartClass(hero: Card[], board: Card[]): string | null {
  const base = classifyHandClass(hero, board).label.split(' + ')[0]; // strip draw tag
  if (base.startsWith('Straight Flush')) return 'Straight Flush';
  if (base.startsWith('Four of a Kind')) return 'Four of a Kind';
  if (base.startsWith('Full House')) return 'Strong Full House';
  if (base === 'Nut Flush Draw') return 'Flush Draw to the Nuts';
  if (base === 'Flush Draw') return null; // bare non-nut flush draw is not bet by the chart
  if (base === 'Nut Flush') return 'Nut Flush';
  if (base === 'Flush') return 'Flush (Not Nut)';
  if (base === 'Straight') return 'Strong Straight';
  if (base === 'Set') return 'Set';
  if (base === 'Trips') return 'Trips – Good Kicker';
  if (base === 'Two Pair') return 'Top Two Pair';
  if (base === 'Overpair') return 'Overpair';
  if (base === 'Top Pair, Top Kicker') return 'Top Pair – Top Kicker';
  if (base === 'Top Pair, Good Kicker') return 'Top Pair – Second Kicker';
  if (base === 'Top Pair, Weak Kicker') return 'Top Pair – Third Kicker';
  if (base === 'Middle Pair' || base.startsWith('Pocket Pair below top')) return 'Second Pair';
  if (base === 'Bottom Pair') return null;
  if (base === 'Combo Draw') return 'Combo Draw';
  if (base === 'Open-Ended Straight Draw') return 'Open-Ended Straight Draw';
  if (base === 'Gutshot Straight Draw') return 'Gutshot Draw';
  if (base === 'Two Overcards') return 'Premium Overcards';
  if (base === 'Air') return 'Air';
  return null;
}

export interface BetVerdict {
  bet: boolean; // does the gameplan bet this hand here?
  tier: Tier; // the recommended tier for this texture + bets
  chartClass: string | null; // hero's mapped chart class
  entryTier: Tier | null; // the tightest tier hero's class belongs to (null = never)
}

/** The gameplan verdict for a concrete spot: bet or check, and why. */
export function shouldBet(hero: Card[], board: Card[], texture: GTexture, totalBets: number): BetVerdict {
  const tier = gameplanTier(texture, totalBets);
  const chartClass = handChartClass(hero, board);
  const entryTier = chartClass ? HAND_TIER[chartClass] ?? null : null;
  const bet = entryTier != null && tierIndex(entryTier) <= tierIndex(tier);
  return { bet, tier, chartClass, entryTier };
}

export const BETS_NOTE = 'Postflop bets are added together across streets. Small = 0.5, Medium = 1, Big = 1.5, Very Large = 2 (as a fraction of pot). Sum them, then read the column.';
export const FRAMING_NOTE = 'This gameplan is for when you are FIRST TO ACT or FACING A CHECK. Pick the row for the board texture, the column for the total bets already in the pot, and bet the hand classes in that tier (and every tighter tier above it).';
