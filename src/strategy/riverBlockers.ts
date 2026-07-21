// River blocker read — what the hero's EXACT hole cards remove from villain's
// range, and what that means for bluffing (aggressive gate) vs bluff-catching
// (call gate). Deterministic from hole+board, but the "right" read depends on
// villain's actual range — which at a live table you never truly see — so the
// checklist keeps the blocker QUESTION ungraded (a live read, like the
// villain-type read) and uses this only to build the reveal note. River-only:
// with cards still to come, "blockers" are really equity, not removal.

import type { Card } from '../engine/cards';
import { SUIT_SYMBOLS, rankToChar } from '../engine/cards';

export type BlockerRead = 'blockValue' | 'blockBluffs' | 'neutral';

export interface BlockerVerdict {
  /** which category the hero's cards mostly interact with on this board. */
  read: BlockerRead;
  /** truth + one-line coaching for the reveal (mode-specific). */
  why: string;
}

export const BLOCKER_READ_LABEL: Record<BlockerRead, string> = {
  blockValue: 'blocking his value (removing his nut combos)',
  blockBluffs: "blocking his bluffs (you hold cards he'd bluff with)",
  neutral: "neutral removal — your cards don't shift his range",
};

/** The dominant blocker interaction the hero's hand has with THIS river board,
 *  with mode-specific coaching. Falls back to 'neutral' when there's no clear
 *  removal signal — honest for a live read rather than forcing a verdict. */
export function readRiverBlockers(
  hero: Card[],
  board: Card[],
  mode: 'aggressive' | 'call',
): BlockerVerdict {
  if (board.length < 5 || hero.length < 2) return { read: 'neutral', why: '' };
  const agg = mode === 'aggressive';

  const boardRanks = board.map((c) => c.rank);
  const topBoard = Math.max(...boardRanks);
  const suitCounts = [0, 0, 0, 0];
  for (const c of board) suitCounts[c.suit]++;
  const flushSuit = suitCounts.findIndex((n) => n >= 3);
  const paired = new Set(boardRanks).size < boardRanks.length;

  // ── flush board: the flush is the nut-relevant category ──────────────────
  if (flushSuit >= 0) {
    const sym = SUIT_SYMBOLS[flushSuit];
    const mine = hero.filter((c) => c.suit === flushSuit).sort((a, b) => b.rank - a.rank);
    if (mine.some((c) => c.rank === 14)) {
      return {
        read: 'blockValue',
        why: agg
          ? `You hold the A${sym} — the nut-flush blocker. Villain can't have the nut flush and you remove his strongest ${sym} combos, so a bluff repping the flush folds out more of his range: prime card to fire.`
          : `You hold the A${sym} — the nut-flush blocker. He can't hold the nut flush, so fewer of his bets are the top of his range. Helps, but a made second-nut flush still beats you — this thins his value, it isn't a call on its own.`,
      };
    }
    if (mine.length > 0) {
      const high = mine[0].rank >= 11;
      return {
        read: 'blockValue',
        why: agg
          ? `You hold the ${rankToChar(mine[0].rank)}${sym}, removing some of villain's made ${sym} flushes${high ? ' including high ones' : ''} — a decent card to bluff-rep the flush; you block a slice of his continues.`
          : `You hold the ${rankToChar(mine[0].rank)}${sym}, so you block a few of his flushes and his bets skew a touch more toward bluffs — a marginal plus for calling, not a green light.`,
      };
    }
    // no card of the flush suit — you remove none of his flushes
    return {
      read: agg ? 'neutral' : 'blockBluffs',
      why: agg
        ? `You hold no ${sym}, so you remove none of villain's flushes — a weak card to rep it. The best bluffs here hold a ${sym}; without one your bluff folds out little.`
        : `You hold no ${sym}, so you don't thin his flushes. If your busted hand is exactly the missed draw he'd be bluffing, you also hold his bluffs — lean fold unless you clearly unblock them.`,
    };
  }

  // ── paired board: trips / full houses are the nut region ─────────────────
  if (paired) {
    const match = hero.find((c) => boardRanks.includes(c.rank));
    if (match) {
      return {
        read: 'blockValue',
        why: agg
          ? `You hold a ${rankToChar(match.rank)}, matching a paired board card — you block some of his trips and full houses, so repping the boat is more credible.`
          : `You hold a ${rankToChar(match.rank)}, matching a paired board card — you block some of his trips/boats, so his value is thinner and his bets lean a touch more bluff.`,
      };
    }
    return {
      read: 'neutral',
      why: `Paired board — trips and full houses are live and your cards match none of it, so you get no removal help. ${
        agg ? 'Rep it only if your line sells the boat; you have no blocker edge.' : 'You do not thin his value — decide on his line and the price, not removal.'
      }`,
    };
  }

  // ── unpaired, no flush: top pair / two pair / straights are the value ─────
  const topCard = hero.find((c) => c.rank === topBoard);
  if (topCard) {
    return {
      read: 'blockValue',
      why: agg
        ? `You hold a ${rankToChar(topBoard)}, matching the top board card — you block some of his top-pair / two-pair value and can credibly rep it.`
        : `You hold a ${rankToChar(topBoard)}, matching the top board card — his top-pair value is a touch thinner, a small plus for a bluff-catch.`,
    };
  }
  // big offsuit overcards are the classic bluff candidates — holding them removes
  // some of villain's bluffs (bad for a catch, irrelevant for our own bluff).
  const bigOver = hero.some((c) => c.rank >= 13 && !boardRanks.includes(c.rank));
  if (bigOver && !agg) {
    return {
      read: 'blockBluffs',
      why: `Your high card(s) are exactly what villain would be bluffing with, so you hold some of his bluff combos and he has fewer left — blocking his bluffs is bad for a bluff-catch. Lean fold.`,
    };
  }
  return {
    read: 'neutral',
    why: agg
      ? `Your cards don't clearly block his value on this board — no removal help for a bluff, so lean on your story and fold equity.`
      : `Your cards don't clearly block his value or his bluffs — a neutral-removal hand. Decide on his line and the price, not removal.`,
  };
}
