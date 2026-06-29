// Shared postflop action vocabulary: the per-action "💡 rule" hook and the
// kind→color map. Both the Postflop Lab and the Bet-Sizing Drill render these,
// so they live here once instead of drifting apart as duplicated copies.

import type { Card } from '../engine/cards';
import { boardWetness } from '../engine/board';
import type { ActionId } from './types';

/** Action kind → swatch color, shared by every postflop frequency bar. */
export const KIND_COLOR: Record<string, string> = {
  value: '#2ec27e',
  bluff: '#e0843a',
  passive: '#3aa0e0',
  aggressive: '#2ec27e',
  call: '#3aa0e0',
  fold: '#2a3a31',
};

/**
 * One-line memorable rule for why the solver picked an action — no equation,
 * the kind of thing you can recall mid-hand. The bet sizes read the BOARD: a
 * big bet "charges draws" on a wet board but "builds the pot for value" on a
 * dry one; a small bet is a range bet when dry, a merge/cheap-deny bet when
 * wet — so those two branch on texture, not just on the size that was chosen.
 * Returns '' when there is no rule for the id (callers gate on truthiness).
 */
export function actionRule(id: ActionId, board: Card[]): string {
  const wet = boardWetness(board) !== 'dry';
  switch (id) {
    case 'bet33':
      return wet
        ? 'Range/merge bet — too connected to deny much, so bet your whole range cheaply and keep worse hands in. 💡 Bet small to bet often.'
        : 'Dry, static board / range advantage — bet small, bet often. 💡 Dry board → small.';
    case 'bet75':
      return wet
        ? 'Wet, dynamic board — charge their draws and build the pot. 💡 Wet board → big.'
        : 'Dry board, but a strong hand — bet big for value and build the pot. Size follows your HAND here, not the texture. 💡 Strong hand → big for value.';
    case 'betpot':
      return 'You hold the nut edge / a polar range — bet pot for max value and max fold equity. 💡 Nut edge → pot.';
    case 'check':
      return 'No value bet and no fold-equity case — check, control the pot, take a free card and realize equity. 💡 No edge → check.';
    case 'fold':
      return 'Not enough equity for the price — folding risks nothing more. 💡 Bad price + weak hand → fold.';
    case 'call':
      return "Right price with outs or showdown value — call, don't bloat with a marginal hand. 💡 Price good, hand thin → call.";
    case 'allin':
      return 'Low SPR or a clear nut edge — just get it in. 💡 Low SPR → commit.';
    case 'raise':
      return "Strong enough to raise villain's bet for value/protection. 💡 Ahead of their bet → raise.";
    default:
      return '';
  }
}
