// Teaching-grade "hand class" classifier for the gameplan / feedback panels.
// Turns hero hole cards + board into a labelled category ("Top Pair, Top
// Kicker", "Open-Ended Straight Draw", "Combo Draw", …) plus a one-line read of
// how the hand should usually be played. Not a solver — a transparent heuristic
// that mirrors the made-hand + draw vocabulary trainers use.

import type { Card } from '../engine/cards';
import { rankToChar } from '../engine/cards';
import { evaluate7 } from '../engine/evaluator';

export interface HandClass {
  /** short label, e.g. "Top Pair, Top Kicker". */
  label: string;
  /** one-sentence read of how the class usually plays on this street. */
  blurb: string;
  /** rough strength bucket for coloring (0 air … 5 monster). */
  strength: number;
}

const RC = (r: number) => rankToChar(r);

/** Detect a flush draw: 4 to a suit with at least one hero card in it. */
function flushDraw(hero: Card[], board: Card[]): { draw: boolean; nut: boolean } {
  for (let s = 0; s < 4; s++) {
    const all = [...hero, ...board].filter((c) => c.suit === s);
    const heroIn = hero.some((c) => c.suit === s);
    if (all.length === 4 && heroIn) {
      // nut draw if hero holds the highest missing card of that suit (≈ Ace)
      const haveAce = hero.some((c) => c.suit === s && c.rank === 14);
      return { draw: true, nut: haveAce };
    }
  }
  return { draw: false, nut: false };
}

/** Open-ended / double-gutshot vs gutshot vs none, from the full rank set. */
function straightDraw(ranks: number[]): 'oesd' | 'gutshot' | 'none' {
  const present = new Array(16).fill(false);
  for (const r of ranks) {
    present[r] = true;
    if (r === 14) present[1] = true; // ace plays low
  }
  const isMade = (p: boolean[]): boolean => {
    let run = 0;
    for (let r = 1; r <= 14; r++) {
      if (p[r]) {
        run++;
        if (run >= 5) return true;
      } else run = 0;
    }
    return false;
  };
  if (isMade(present)) return 'none'; // already a straight — handled as a made hand
  const completers = new Set<number>();
  for (let c = 1; c <= 14; c++) {
    if (present[c]) continue;
    const p2 = present.slice();
    p2[c] = true;
    if (c === 1) p2[14] = true;
    if (isMade(p2)) completers.add(c === 1 ? 14 : c);
  }
  if (completers.size >= 2) return 'oesd'; // two+ ranks complete it ≈ 8 outs
  if (completers.size === 1) return 'gutshot';
  return 'none';
}

export function classifyHandClass(hero: Card[], board: Card[]): HandClass {
  if (hero.length < 2) return { label: 'Unknown', blurb: '', strength: 0 };

  // ---- preflop ----
  if (board.length < 3) {
    const [a, b] = [...hero].sort((x, y) => y.rank - x.rank);
    const suited = a.suit === b.suit;
    const gap = a.rank - b.rank;
    if (a.rank === b.rank)
      return { label: `Pocket Pair (${RC(a.rank)}${RC(a.rank)})`, blurb: 'A made pair preflop — set-mine cheaply or play it as a strong holding when high.', strength: a.rank >= 10 ? 3 : 2 };
    if (a.rank >= 13 && b.rank >= 13)
      return { label: 'Premium Big Cards', blurb: 'Two big cards that flop strong top pairs — raise and apply pressure.', strength: 3 };
    if (suited && gap <= 3 && b.rank >= 5)
      return { label: 'Suited Connector', blurb: 'High implied odds via straights/flushes — great for set-and-go and barreling.', strength: 2 };
    if (a.rank >= 12)
      return { label: 'Big Card', blurb: 'One big card — playable, but watch domination and weak kickers.', strength: 1 };
    return { label: 'Speculative / Marginal', blurb: 'A thin holding — play tight and position-dependent.', strength: 1 };
  }

  // ---- postflop ----
  const made = evaluate7([...hero, ...board]);
  const boardRanks = board.map((c) => c.rank).sort((x, y) => y - x);
  const topBoard = boardRanks[0];
  const secondBoard = boardRanks[1];
  const pocket = hero[0].rank === hero[1].rank;
  const allRanks = [...hero, ...board].map((c) => c.rank);

  const fd = flushDraw(hero, board);
  const sd = board.length < 5 ? straightDraw(allRanks) : 'none';
  const drawTag = (base: string) => {
    if (fd.draw && (sd === 'oesd' || sd === 'gutshot')) return `${base} + Combo Draw`;
    if (fd.draw) return `${base} + Flush Draw`;
    if (sd === 'oesd') return `${base} + Open-Ender`;
    if (sd === 'gutshot') return `${base} + Gutshot`;
    return base;
  };

  switch (made.categoryRank) {
    case 8:
      return { label: 'Straight Flush', blurb: 'The effective nuts — get all the money in.', strength: 5 };
    case 7:
      return { label: 'Four of a Kind', blurb: 'A monster — slow-play or build the pot, you are crushing.', strength: 5 };
    case 6:
      return { label: 'Full House', blurb: 'A near-nut hand — bet for value, rarely fold.', strength: 5 };
    case 5:
      return { label: fd.nut ? 'Nut Flush' : 'Flush', blurb: 'A very strong made hand — value bet, but respect the paired/higher-flush warning cards.', strength: 4 };
    case 4:
      return { label: 'Straight', blurb: 'A strong made hand — bet for value and protect against flush/board-pair redraws.', strength: 4 };
    case 3: {
      // set (pocket pair hits) vs trips (one hole card + paired board)
      const tripRank = made.tiebreakers[0];
      const isSet = pocket && hero[0].rank === tripRank;
      return isSet
        ? { label: 'Set', blurb: 'A disguised monster — bet/raise for value, you are almost always ahead.', strength: 5 }
        : { label: 'Trips', blurb: 'Very strong but face-up on a paired board — value bet, mind kicker on big bets.', strength: 4 };
    }
    case 2:
      return { label: 'Two Pair', blurb: 'A strong made hand — bet for value and charge draws; beware paired boards.', strength: 4 };
    case 1: {
      const pr = made.tiebreakers[0];
      // overpair / pocket pair vs board
      if (pocket && hero[0].rank === pr) {
        if (pr > topBoard)
          return { label: drawTag('Overpair'), blurb: 'A pocket pair above the board — bet for value and protection against overcards/draws.', strength: 4 };
        return { label: drawTag(`Pocket Pair below top (${RC(pr)}${RC(pr)})`), blurb: 'A medium pair that misses top pair — pot-control and look to get cheap showdowns.', strength: 2 };
      }
      // pair using a hole card matching the board
      const kicker = hero.find((c) => c.rank !== pr)?.rank ?? 0;
      if (pr === topBoard) {
        const kq = kicker === 14 ? 'Top Kicker' : kicker >= 11 ? 'Good Kicker' : 'Weak Kicker';
        return {
          label: drawTag(`Top Pair, ${kq}`),
          blurb:
            kicker >= 11
              ? 'A strong top pair — bet for value and protection; usually good for two to three streets.'
              : 'Top pair but the kicker is vulnerable — value bet thinly and avoid bloating the pot.',
          strength: kicker >= 11 ? 4 : 3,
        };
      }
      if (pr === secondBoard)
        return { label: drawTag('Middle Pair'), blurb: 'A marginal made hand — usually a check/call, realize equity cheaply.', strength: 2 };
      return { label: drawTag('Bottom Pair'), blurb: 'Weak made hand — mostly a bluff-catcher/showdown hand; keep the pot small.', strength: 2 };
    }
    default: {
      // high card — is it a draw or air?
      if (fd.draw && (sd === 'oesd' || sd === 'gutshot'))
        return { label: 'Combo Draw', blurb: 'A flush draw plus a straight draw — huge equity; semi-bluff aggressively.', strength: 3 };
      if (fd.draw)
        return { label: fd.nut ? 'Nut Flush Draw' : 'Flush Draw', blurb: '~9 outs to a flush — a strong semi-bluff that can bet or check-call.', strength: 3 };
      if (sd === 'oesd')
        return { label: 'Open-Ended Straight Draw', blurb: 'You need one of two cards to complete your straight. Usually check to see a cheap card and realize equity, or semi-bluff.', strength: 3 };
      if (sd === 'gutshot')
        return { label: 'Gutshot Straight Draw', blurb: '~4 outs to a straight — a thin draw; mostly give up unless you have extra equity or fold equity.', strength: 1 };
      const overcards = hero.filter((c) => c.rank > topBoard).length;
      if (overcards === 2)
        return { label: 'Two Overcards', blurb: 'No pair yet but ~6 outs to top pair — a light semi-bluff or give-up.', strength: 1 };
      return { label: 'Air', blurb: 'No made hand and no real draw — check/fold, or bluff only with a clear plan and fold equity.', strength: 0 };
    }
  }
}
