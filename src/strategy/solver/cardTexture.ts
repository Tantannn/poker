// Next-street card bucketing shared by the flop solver (buckets turn cards) and the 3-way
// turn solver (buckets river cards). Enumerating a nested subgame per legal card is too slow
// live, so cards that play alike are grouped and one representative per bucket is solved,
// weighted by the bucket's size. This is the disclosed texture abstraction (design doc §5).

import type { Card } from '../../engine/cards';

const id = (c: Card) => c.rank * 4 + c.suit;

/** Max number of the given ranks that fall inside any 5-consecutive-rank window (Ace counts
 *  as both 14 and 1 for the wheel). A proxy for straight texture: 3 in a window = a
 *  coordinated/open board, 4+ = a straight is possible. */
function straightWindowMax(ranks: number[]): number {
  const present = new Set<number>();
  for (const r of ranks) {
    present.add(r);
    if (r === 14) present.add(1);
  }
  let best = 0;
  for (let lo = 1; lo <= 10; lo++) {
    let c = 0;
    for (let r = lo; r < lo + 5; r++) if (present.has(r)) c++;
    if (c > best) best = c;
  }
  return best;
}

/** Group the available next-street cards by strategic texture, one representative per bucket
 *  weighted by count. Strategy on the next card pivots on: which board card (if any) it PAIRS
 *  — top vs bottom pair carry different range/nut impact; whether it brings a flush DRAW,
 *  COMPLETES a flush, or neither; its rank TIER vs the board (over/mid/under moves the range
 *  advantage); and how much it COORDINATES the board toward a straight. Cards sharing a key
 *  play alike, so solving one and weighting by count approximates enumerating every card at a
 *  fraction of the cost. Representative = the first card seen in the bucket.
 *
 *  Finer than the earlier pairsBoard|flushComplete|tier key: it separates flush-DRAW cards
 *  from blanks, top- from bottom-pairing cards, and straightening from dry runouts — runouts
 *  the coarse scheme lumped together but that barrel and defend very differently. */
export function textureBuckets(board: Card[]): { card: Card; weight: number }[] {
  const used = new Set<number>(board.map(id));
  const suitCount = [0, 0, 0, 0];
  for (const c of board) suitCount[c.suit]++;
  const ranksDesc = board.map((c) => c.rank).sort((a, b) => b - a);
  const maxRank = ranksDesc[0];
  const minRank = ranksDesc[ranksDesc.length - 1];
  const groups = new Map<string, { card: Card; weight: number }>();
  for (let rank = 2; rank <= 14; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      if (used.has(rank * 4 + suit)) continue;
      const paired = ranksDesc.indexOf(rank); // -1 none, else position among sorted board ranks
      const pairPos =
        paired < 0 ? 'x' : paired === 0 ? 't' : paired === ranksDesc.length - 1 ? 'b' : 'm';
      const suited = suitCount[suit] + 1;
      const flushState = suited >= 3 ? 2 : suited === 2 ? 1 : 0; // 0 blank · 1 new draw · 2 complete
      const tier = rank > maxRank ? 'over' : rank < minRank ? 'under' : 'mid';
      const sw = straightWindowMax([...ranksDesc, rank]);
      const straightTier = sw >= 4 ? 2 : sw === 3 ? 1 : 0; // 0 dry · 1 coordinated · 2 straight-on
      const key = `${pairPos}|${flushState}|${tier}|${straightTier}`;
      const g = groups.get(key);
      if (g) g.weight++;
      else groups.set(key, { card: { rank, suit }, weight: 1 });
    }
  }
  return [...groups.values()];
}
