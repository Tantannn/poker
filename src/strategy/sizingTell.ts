// Sizing-tell reader. What a villain's BET SIZE means — the read most players
// never train, and the one that beats physical tells at live low/mid stakes.
// Rule-based (like checklist sizing bands + bettingStory shapes) so the "truth"
// is deterministic and testable: size × street × texture → what the size polarises
// toward. Pure — the drill and its notes both call this.

import type { Card } from '../engine/cards';
import { boardWetness } from '../engine/board';

export type SizingMeaning = 'merged' | 'value' | 'polar' | 'capped';
export type Street = 'flop' | 'turn' | 'river';

export interface SizingOption {
  id: SizingMeaning;
  label: string;
}
export const SIZING_OPTIONS: SizingOption[] = [
  { id: 'merged', label: 'Range / merged bet — whole range, low info' },
  { id: 'value', label: 'Value / protection — value-weighted' },
  { id: 'polar', label: 'Polarized — nuts or bluff' },
  { id: 'capped', label: 'Capped / weak — thin, blocker or giving up' },
];

type Band = 'small' | 'half' | 'big' | 'pot' | 'over';
function band(frac: number): Band {
  if (frac >= 1.25) return 'over';
  if (frac >= 0.85) return 'pot';
  if (frac >= 0.6) return 'big';
  if (frac >= 0.42) return 'half';
  return 'small';
}

export interface SizingVerdict {
  meaning: SizingMeaning;
  why: string;
}

/** Read what a bet SIZE polarises toward, given the street and board texture. */
export function readSizing(frac: number, street: Street, board: Card[]): SizingVerdict {
  const b = band(frac);
  const wet = boardWetness(board);
  const pct = Math.round(frac * 100);
  switch (b) {
    case 'over':
      return {
        meaning: 'polar',
        why: `An overbet (${pct}%) is maximally polar — the nuts or a bluff, nothing between. Only a very strong or very weak hand wants this size. Continue only with strong bluff-catchers + blockers; don't call medium hands "to see it".`,
      };
    case 'pot':
      return {
        meaning: 'polar',
        why: `A pot-size bet (${pct}%) is polar / value-heavy — big value plus the bluffs that balance it. Weight it toward value: you need a real hand or a blocker-heavy catcher, not hope.`,
      };
    case 'big':
      return {
        meaning: 'value',
        why: `A big bet (${pct}%) is value / protection — charging draws on a wetter board and betting made hands for value. Respect it: continue with strong made hands, fold marginal without a draw.`,
      };
    case 'half':
      return {
        meaning: 'value',
        why: `A half-pot bet (${pct}%) is standard, value-leaning — balanced but tilted to made hands. Defend by the pot odds; don't over-fold, don't hero-call trash.`,
      };
    default: {
      // small: a range bet early on a dry board, otherwise a capped/weak signal.
      if (street === 'flop' && wet !== 'wet') {
        return {
          meaning: 'merged',
          why: `A small bet (${pct}%) on a dry flop is a RANGE bet — the aggressor bets their whole range cheaply. It says almost nothing about strength; don't over-fold, float in position and take it away on a later street.`,
        };
      }
      const where = street === 'flop' ? 'on a WET board' : `on the ${street}`;
      return {
        meaning: 'capped',
        why: `A small bet (${pct}%) ${where} is capped / weak — value wants a bigger size here, so this is a blocker, thin value, or a cheap give-up. Rarely the nuts: you can raise as a bluff, or call light and let them barrel into a hand.`,
      };
    }
  }
}

/** How the villain TYPE bends the size read (reuse the observed-read ids). */
export function sizingTypeNote(readId: string | undefined): string {
  switch (readId) {
    case 'overcall':
      return 'Station: they bet small even with value (no sizing sense), so a small bet still hides value — read it more merged than weak, and value bet THEM bigger.';
    case 'spew':
      return 'Maniac/LAG: sizes are noise and bluff-heavy — discount a big/polar size, and a small bet is often just a cheap stab. Call wider.';
    case 'overfold':
      return 'Nit/TAG: sizes mean what they say — a small bet from a value-sizer is genuinely weak/capped; a pot/overbet is the goods, believe it.';
    default:
      return '';
  }
}
