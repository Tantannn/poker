// The bet-size grid a hero-first CFR node is solved over, built per node because the
// offered sizes depend on the stack. Two rules the callers depend on: every size is a
// DISTINCT positive chip amount (two sizes that round to the same chips would split one
// decision across two identical actions and halve its frequency), and no size exceeds
// the effective stack (anything that would is the jam, offered once).
//
// An overbet needs its own slot because it cannot be reached by scaling: it is only
// profitable for a POLAR range (nuts + bluffs), which is exactly what a river/turn CFR
// discovers and a per-hand EV model cannot. Without the slot the solver's biggest size
// is pot, so hero is never taught the line villains under-defend most.

import type { ActionId } from '../types';

export interface BetSizeGrid {
  /** fractions of pot, ascending — feed straight to a solver's `betSizes` */
  fracs: number[];
  /** ActionId per size, parallel to `fracs` */
  ids: ActionId[];
  labels: string[];
  /** short size word for prose ("¾ pot") */
  fracLabels: string[];
}

interface Row {
  frac: number;
  id: ActionId;
  label: string;
  fracLabel: string;
}

const BASE: Row[] = [
  { frac: 0.33, id: 'bet33', label: 'Bet 33%', fracLabel: '⅓ pot' },
  { frac: 0.5, id: 'bet50', label: 'Bet 50%', fracLabel: '½ pot' },
  { frac: 0.75, id: 'bet75', label: 'Bet 75%', fracLabel: '¾ pot' },
  { frac: 1.0, id: 'betpot', label: 'Bet pot', fracLabel: 'pot' },
];

/** Single overbet slot, matched to the band the bots themselves overbet in
 *  (`DifficultyParams.overbet`, 1.3–1.75× pot) so hero trains against the size he faces. */
export const OVERBET_FRAC = 1.5;

const OVERBET: Row = { frac: OVERBET_FRAC, id: 'bet150', label: 'Overbet 150%', fracLabel: '1½× pot' };

export interface RaiseSizeGrid {
  /** hero's raise-TO totals in chips (ascending, all legal) */
  raiseTo: number[];
  /** villain's re-raise total per raise size; ≤ the raise itself means he cannot re-raise
   *  (hero already jammed, or the re-raise would exceed what hero can call) */
  threeBetTo: number[];
  ids: ActionId[];
  labels: string[];
}

/** Hero's raise, sized as a fraction of the pot he'd be playing after just calling (Q + 2b).
 *  Two sizes with distinct jobs — a cheap price on a bluff-raise vs charging a caller — plus
 *  the jam. They match the ½-pot / pot / all-in buttons `Controls.tsx` already offers facing
 *  a bet (same `bet + f × (pot + callAmount)` arithmetic), so the recommended raise is
 *  always one tap rather than a number to dial in on the slider. */
const RAISE_FRACS = [0.5, 1.0];
const RAISE_IDS: ActionId[] = ['raise', 'raisebig'];

/** Villain's re-raise, as a multiple of hero's raise. One size: at the SPRs these nodes
 *  reach, a re-raise is either a jam or close enough that a second size adds tree width
 *  without changing hero's decision. Capped by hero's own all-in — a re-raise past what
 *  hero can call is unreachable, so it is not a distinct branch. */
const THREE_BET_MULT = 2.2;

export function raiseSizeGrid(potBeforeBet: number, bet: number, minRaiseTo: number, maxRaiseTo: number): RaiseSizeGrid {
  const grid: RaiseSizeGrid = { raiseTo: [], threeBetTo: [], ids: [], labels: [] };
  if (maxRaiseTo <= bet) return grid;
  const potAfterCall = potBeforeBet + 2 * bet;

  const add = (chips: number, id: ActionId, label: string) => {
    if (chips <= bet || grid.raiseTo.includes(chips)) return;
    grid.raiseTo.push(chips);
    grid.threeBetTo.push(Math.min(maxRaiseTo, Math.round(THREE_BET_MULT * chips)));
    grid.ids.push(id);
    grid.labels.push(label);
  };

  RAISE_FRACS.forEach((f, k) => {
    const chips = Math.min(maxRaiseTo, Math.max(minRaiseTo, Math.round(bet + f * potAfterCall)));
    // At or past the stack the size IS the jam — added once below, never labelled a raise.
    if (chips < maxRaiseTo) add(chips, RAISE_IDS[k], `Raise to ${chips}`);
  });
  add(maxRaiseTo, 'allin', 'All in');
  return grid;
}

export function betSizeGrid(pot: number, effStack: number, overbet = false): BetSizeGrid {
  const grid: BetSizeGrid = { fracs: [], ids: [], labels: [], fracLabels: [] };
  if (pot <= 0 || effStack < 1) return grid;

  let jammed = false;
  for (const r of overbet ? [...BASE, OVERBET] : BASE) {
    const chips = Math.round(r.frac * pot);
    if (chips < 1) continue;
    // At or past the stack the size IS a jam: collapse every such row into one all-in
    // slot rather than labelling a stack-capped bet "pot".
    if (chips >= effStack) {
      if (jammed) continue;
      jammed = true;
      push(grid, effStack / pot, 'allin', 'All in', 'all in');
      continue;
    }
    push(grid, r.frac, r.id, r.label, r.fracLabel);
  }
  return grid;
}

function push(g: BetSizeGrid, frac: number, id: ActionId, label: string, fracLabel: string) {
  g.fracs.push(frac);
  g.ids.push(id);
  g.labels.push(label);
  g.fracLabels.push(fracLabel);
}
