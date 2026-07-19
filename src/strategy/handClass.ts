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

/** For a MADE flush, does hero hold the nut? True if hero has the highest rank
 *  of the flush suit that isn't already on the board (Ace, or next-best if the
 *  Ace is a shared board card). */
function nutFlush(hero: Card[], board: Card[]): boolean {
  for (let s = 0; s < 4; s++) {
    const suited = [...hero, ...board].filter((c) => c.suit === s);
    if (suited.length < 5) continue;
    const onBoard = new Set(board.filter((c) => c.suit === s).map((c) => c.rank));
    let nutRank = 0;
    for (let r = 14; r >= 2; r--) if (!onBoard.has(r)) { nutRank = r; break; }
    return hero.some((c) => c.suit === s && c.rank === nutRank);
  }
  return false;
}

// present[] rank-set (1..14), ace also low at index 1.
function rankSet(ranks: number[]): boolean[] {
  const p = new Array(16).fill(false);
  for (const r of ranks) {
    p[r] = true;
    if (r === 14) p[1] = true; // ace plays low
  }
  return p;
}
// highest top-card of a made 5-straight in a rank-set, else 0.
function bestStraightTop(p: boolean[]): number {
  for (let top = 14; top >= 5; top--) {
    let ok = true;
    for (let k = 0; k < 5; k++) if (!p[top - k]) { ok = false; break; }
    if (ok) return top;
  }
  return 0;
}

/** Open-ended / gutshot / none. BOARD-AWARE: a completing rank that only makes a
 *  straight lying entirely on the board is a CHOP (everyone plays it), not a real
 *  out, so it's excluded. E.g. K5 on 9-6-7-T: an 8 makes 6-7-8-9-T on the board,
 *  a chop — hero has no straight draw, only a flush draw. Counts a completer only
 *  when hero's resulting straight tops the board's. */
function straightDraw(hero: Card[], board: Card[]): 'oesd' | 'gutshot' | 'none' {
  const heroRanks = [...hero, ...board].map((c) => c.rank);
  const boardRanks = board.map((c) => c.rank);
  if (bestStraightTop(rankSet(heroRanks)) > 0) return 'none'; // already a straight
  const completers = new Set<number>();
  for (let c = 2; c <= 14; c++) {
    if (heroRanks.includes(c)) continue;
    const heroTop = bestStraightTop(rankSet([...heroRanks, c]));
    if (heroTop === 0) continue; // c doesn't complete hero's straight
    if (heroTop <= bestStraightTop(rankSet([...boardRanks, c]))) continue; // board straight = chop
    completers.add(c);
  }
  if (completers.size >= 2) return 'oesd'; // two+ ranks complete it ≈ 8 outs
  if (completers.size === 1) return 'gutshot';
  return 'none';
}

/** Draw components, board-aware — shared with the equity drill so its out-count
 *  matches this label (flush 9 · OESD 8 · gutshot 4 · flush+OESD 15 · flush+gutshot
 *  12). Flop/turn only; no draws pre-flop or on the river. */
export function drawProfile(hero: Card[], board: Card[]): { flush: boolean; straight: 'oesd' | 'gutshot' | 'none' } {
  if (board.length < 3 || board.length >= 5) return { flush: false, straight: 'none' };
  return { flush: flushDraw(hero, board).draw, straight: straightDraw(hero, board) };
}

/** Honest teaching out-count, board-aware. `countOuts` over-counts a draw: it also
 *  credits pairing your own under/overcards and board-shared straights, so a flush +
 *  open-ender (really 15 outs) reads as ~21. The memorized ladder keyed to the ACTUAL
 *  draw is the number a player learns and the number the trainer must show:
 *    flush 9 · OESD 8 · gutshot 4 · flush+OESD 15 · flush+gutshot 12 · two overcards 6.
 *  Falls back to `counted` for made hands / anything off the ladder. Single source
 *  shared by the solver model and the 🎯 equity drill / anchor sheet so they can't
 *  disagree on the same spot. Flop/turn only (an "out" needs a card to come). */
export function canonicalOuts(hero: Card[], board: Card[], counted: number): number {
  const { flush, straight } = drawProfile(hero, board);
  if (flush && straight === 'oesd') return 15;
  if (flush && straight === 'gutshot') return 12;
  if (flush) return 9;
  if (straight === 'oesd') return 8;
  if (straight === 'gutshot') return 4;
  // Two overcards (no made pair, both hole cards above every board card) → ~6 outs to
  // top pair. Same case as the "Two Overcards" hand class, derived from the cards so no
  // label is needed; only reachable here once flush/straight draws are ruled out above.
  if (board.length >= 3 && board.length < 5 && hero.length >= 2 && hero[0].rank !== hero[1].rank) {
    const topBoard = Math.max(...board.map((c) => c.rank));
    if (hero.every((h) => h.rank > topBoard)) return 6;
  }
  return counted;
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
      return { label: 'Suited Connector', blurb: 'High implied odds via straights/flushes — play it cheap and in position, and barrel good runouts.', strength: 2 };
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

  const fd = board.length < 5 ? flushDraw(hero, board) : { draw: false, nut: false };
  const sd = board.length < 5 ? straightDraw(hero, board) : 'none';
  const drawTag = (base: string) => {
    if (fd.draw && (sd === 'oesd' || sd === 'gutshot')) return `${base} + Combo Draw`;
    if (fd.draw) return `${base} + Flush Draw`;
    if (sd === 'oesd') return `${base} + Open-Ender`;
    if (sd === 'gutshot') return `${base} + Gutshot`;
    return base;
  };

  // A real draw riding along with a made hand: flush draw or OESD ≈ 8–9+ outs is
  // "strong" (upgrades the hand to a semi-bluff); a gutshot is thin backup equity.
  const hasStrongDraw = fd.draw || sd === 'oesd';
  const hasAnyDraw = hasStrongDraw || sd === 'gutshot';
  const drawPhrase =
    fd.draw && sd !== 'none'
      ? `a ${fd.nut ? 'nut ' : ''}flush draw plus a straight draw`
      : fd.draw
      ? `a ${fd.nut ? 'nut ' : ''}flush draw (~9 outs)`
      : sd === 'oesd'
      ? 'an open-ended straight draw (~8 outs)'
      : 'a gutshot (~4 outs)';

  // A MADE hand that ALSO holds a draw is a semi-bluff, not a "keep the pot
  // small" hand — the mistake behind "why bet, I only have bottom pair?". The
  // draw, not the weak pair, drives the bet: you win two ways (fold equity now +
  // big equity when called), build the pot for when you hit, and deny a free
  // card. The pair is a backup + showdown bonus. Upgrades weak/medium made hands
  // to semi-bluff strength (3) so the downstream "usual play" / fold-equity reads
  // stop advising a check.
  const withDraw = (base: HandClass): HandClass => {
    if (!hasAnyDraw) return base;
    if (base.strength >= 4)
      return {
        ...base,
        blurb: `${base.blurb} You ALSO hold ${drawPhrase} — value-strong AND drawing, so bet big for value + protection and keep barrelling the cards that complete your draw.`,
      };
    if (hasStrongDraw)
      return {
        label: base.label,
        blurb:
          `More than a made hand — you also hold ${drawPhrase}. Play it as a strong SEMI-BLUFF, not a pot-control spot:` +
          ` • Wins two ways — fold equity now (worse hands and air give up), plus big equity when called (the draw + your pair outs, so you're rarely drawing dead).` +
          ` • Builds the pot for when you hit.` +
          ` • Denies a free card to his overcards and draws.` +
          ` • The made pair is a backup + showdown bonus, not the reason to bet.`,
        strength: 3,
      };
    // pair + gutshot: extra outs, but still thin
    return {
      ...base,
      blurb: `${base.blurb} You also have ${drawPhrase} for backup outs — enough to bet with fold equity or peel a cheap card, but it stays a thin holding.`,
    };
  };

  // No pair of hero's OWN — either true high card, or the evaluator credited the
  // BOARD's own pair/trips, which every player shares. Classify by draws/overcards
  // instead; `shared` names the board-made hand so the blurb can explain it away.
  const classifyDrawOrAir = (shared?: string): HandClass => {
    const note = shared ? ` Don't count the ${shared} — that's the board's, shared by every player, so your own cards make no pair.` : '';
    if (fd.draw && (sd === 'oesd' || sd === 'gutshot'))
      return { label: 'Combo Draw', blurb: `A flush draw plus a straight draw — huge equity; semi-bluff aggressively.${note}`, strength: 3 };
    if (fd.draw)
      return { label: fd.nut ? 'Nut Flush Draw' : 'Flush Draw', blurb: `~9 outs to a flush — a strong semi-bluff that can bet or check-call.${note}`, strength: 3 };
    if (sd === 'oesd')
      return { label: 'Open-Ended Straight Draw', blurb: `~8 outs — two different ranks complete your straight. Usually check to see a cheap card and realize equity, or semi-bluff.${note}`, strength: 3 };
    if (sd === 'gutshot')
      return { label: 'Gutshot Straight Draw', blurb: `~4 outs to a straight — a thin draw; mostly give up unless you have extra equity or fold equity.${note}`, strength: 1 };
    // overcards only matter with cards to come — on the river there is no "out"
    const overcards = board.length < 5 ? hero.filter((c) => c.rank > topBoard).length : 0;
    if (overcards === 2)
      return { label: 'Two Overcards', blurb: `No pair yet but ~6 outs to top pair — a light semi-bluff or give-up.${note}`, strength: 1 };
    return { label: 'Air', blurb: `No made hand and no real draw — check/fold, or bluff only with a clear plan and fold equity.${note}`, strength: 0 };
  };

  // River "playing the board": hero's best five cards ARE the five community
  // cards, so every player has at least this hand. A chop is the ceiling —
  // labelling it "Straight"/"Flush"/"Full House" and advising value bets misleads.
  if (board.length === 5) {
    const boardMade = evaluate7(board);
    if (
      boardMade.categoryRank === made.categoryRank &&
      boardMade.tiebreakers.length === made.tiebreakers.length &&
      boardMade.tiebreakers.every((t, i) => t === made.tiebreakers[i])
    )
      return {
        label: 'Playing the Board',
        blurb: 'Your best five cards are all on the board — every player has at least this hand, so a chop is your ceiling. Fold to serious bets when the board can be beaten; if nothing beats the board, never fold — the worst you can do is split.',
        strength: 1,
      };
  }

  switch (made.categoryRank) {
    case 8:
      return { label: 'Straight Flush', blurb: 'The effective nuts — get all the money in.', strength: 5 };
    case 7:
      return { label: 'Four of a Kind', blurb: 'A monster — slow-play or build the pot, you are crushing.', strength: 5 };
    case 6:
      return { label: 'Full House', blurb: 'A near-nut hand — bet for value, rarely fold.', strength: 5 };
    case 5:
      return { label: nutFlush(hero, board) ? 'Nut Flush' : 'Flush', blurb: 'A very strong made hand — value bet, but respect the paired/higher-flush warning cards.', strength: 4 };
    case 4:
      return { label: 'Straight', blurb: 'A strong made hand — bet for value and protect against flush/board-pair redraws.', strength: 4 };
    case 3: {
      // set (pocket pair hits) vs trips (one hole card + paired board). If hero
      // holds NO card of the trip rank, the trips are entirely ON the board
      // (e.g. J9 on T888) — shared by everyone, so hero really has a draw/air.
      const tripRank = made.tiebreakers[0];
      if (!hero.some((c) => c.rank === tripRank)) return classifyDrawOrAir(`trip ${RC(tripRank)}s`);
      const isSet = pocket && hero[0].rank === tripRank;
      return isSet
        ? { label: 'Set', blurb: 'A disguised monster — bet/raise for value, you are almost always ahead.', strength: 5 }
        : { label: 'Trips', blurb: 'Very strong but face-up on a paired board — value bet, mind kicker on big bets.', strength: 4 };
    }
    case 2: {
      // "Two pair" where one of the pairs is the BOARD's own pair is really ONE
      // pair plus a pair everyone shares (99 on AAQT = aces-and-nines, but every
      // hand has the aces). It plays like a bluff-catcher, not a value hand — and
      // higher board cards can counterfeit it. Real two pair uses both hole cards.
      const boardPairRank = boardRanks.find((r, i) => i > 0 && boardRanks[i - 1] === r);
      const pairRanks = made.tiebreakers.slice(0, 2);
      if (boardPairRank != null && pairRanks.includes(boardPairRank) && !hero.some((c) => c.rank === boardPairRank)) {
        const own = pairRanks.find((r) => r !== boardPairRank && hero.some((c) => c.rank === r));
        // hero holds NEITHER pair rank → both pairs are the board's (double-paired
        // board) and hero is really unpaired: classify the draw/air instead.
        if (own == null) return classifyDrawOrAir(`two pair (${RC(pairRanks[0])}s and ${RC(pairRanks[1])}s)`);
        // The board pair is shared by everyone, so hero's REAL edge is only his own
        // pair. If that pair is the TOP unpaired board card (a 7 on 766, a T on T88)
        // hero has TOP PAIR on a paired board — he beats all air and every WORSE pair,
        // so it is a genuine value hand; only overpairs, trips and better kickers get
        // there. A pair BELOW a higher board card (a 6 on 776, 99 on AAQT) has that
        // overcard AND the shared pair against it — the real bluff-catcher.
        if (own >= topBoard) {
          return {
            label: `Top Pair + Board Pair`,
            blurb:
              'Top pair on a paired board — you beat all air and every worse pair, so this is a value hand, not a pure bluff-catcher. But the shared board pair counterfeits your kicker and any overpair or trips still has you: bet thinly, keep the pot medium, and don\'t stack off.',
            strength: 3,
          };
        }
        return {
          label: `Pair of ${RC(own)}s + Board Pair`,
          blurb:
            'A pair below a higher board card, plus the board\'s own pair that everyone shares — it plays like ONE weak pair: a bluff-catcher. Keep the pot small, don\'t stack off, and beware higher cards counterfeiting your pair.',
          strength: 2,
        };
      }
      return { label: 'Two Pair', blurb: 'A strong made hand — bet for value and charge draws; beware paired boards.', strength: 4 };
    }
    case 1: {
      const pr = made.tiebreakers[0];
      // The "pair" may be the BOARD's own pair with hero holding no card of that
      // rank (e.g. J9 on T88) — it belongs to every player, so hero is really
      // unpaired: classify the draw, don't call a shared pair "Middle Pair".
      if (!hero.some((c) => c.rank === pr)) return classifyDrawOrAir(`pair of ${RC(pr)}s`);
      // overpair / pocket pair vs board
      if (pocket && hero[0].rank === pr) {
        if (pr > topBoard)
          return withDraw({ label: drawTag('Overpair'), blurb: 'A pocket pair above the board — bet for value and protection against overcards/draws.', strength: 4 });
        return withDraw({ label: drawTag(`Pocket Pair below top (${RC(pr)}${RC(pr)})`), blurb: 'A medium pair that misses top pair — pot-control and look to get cheap showdowns.', strength: 2 });
      }
      // pair using a hole card matching the board
      const kicker = hero.find((c) => c.rank !== pr)?.rank ?? 0;
      if (pr === topBoard) {
        const kq = kicker === 14 ? 'Top Kicker' : kicker >= 11 ? 'Good Kicker' : 'Weak Kicker';
        return withDraw({
          label: drawTag(`Top Pair, ${kq}`),
          blurb:
            kicker >= 11
              ? 'A strong top pair — bet for value and protection; usually good for two to three streets.'
              : 'Top pair but the kicker is vulnerable — value bet thinly and avoid bloating the pot.',
          strength: kicker >= 11 ? 4 : 3,
        });
      }
      if (pr === secondBoard)
        return withDraw({ label: drawTag('Middle Pair'), blurb: 'A marginal made hand — usually a check/call, realize equity cheaply.', strength: 2 });
      return withDraw({ label: drawTag('Bottom Pair'), blurb: 'Weak made hand — mostly a bluff-catcher/showdown hand; keep the pot small.', strength: 2 });
    }
    default:
      // high card — is it a draw or air?
      return classifyDrawOrAir();
  }
}
