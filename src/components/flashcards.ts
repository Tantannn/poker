// Equity flashcard data + draw helpers, shared by the Equity Drill and the Review
// (spaced-repetition) tab. Kept out of any component file so React Fast Refresh
// stays happy (a component module must export only components).

import { ruleOf2and4 } from '../engine/equity';
import { weightOf, weightedIndex, type SrsMap } from '../store/srs';

export type Cat = 'Preflop' | 'Draws' | 'Made hands';

export interface Flash {
  spot: string;
  detail: string;
  equity: number; // hero's equity %, the number to remember
  hook: string; // how to remember it without a solver
  recognize: string; // how to spot this pattern at the table
  cat: Cat;
}

// All equities are the well-known textbook figures (heads-up, all-in). Draw rows
// derive straight from the Rule of 2 & 4 so the hook and the number always agree.
export const CARDS: Flash[] = [
  // ---- Preflop matchup ladder ----
  { spot: 'Pair vs two overcards', detail: 'e.g. 88 vs AK — the classic "race"', equity: 52, hook: 'Coinflip. Pair is a hair ahead (~52). "Race" = roughly 50/50.', recognize: 'You hold a pocket pair; BOTH of villain\'s cards rank above your pair (e.g. 88 vs A-K). Neither hand is paired-on-paired — it\'s your made pair vs two live overcards.', cat: 'Preflop' },
  { spot: 'Pair vs two undercards', detail: 'e.g. 88 vs 56', equity: 83, hook: 'Pair over both = ~80/20. The undercards need to pair or run a draw.', recognize: 'Your pocket pair outranks BOTH of villain\'s cards (e.g. 88 vs 5-6). They must pair up or make a straight/flush to beat you.', cat: 'Preflop' },
  { spot: 'Higher pair vs lower pair', detail: 'e.g. QQ vs 77', equity: 81, hook: '80/20. Lower pair needs its set (~18%) or a runner straight/flush.', recognize: 'BOTH players hold a pocket pair, yours the bigger one (e.g. QQ vs 77). Their main out is flopping a set (~12% per street).', cat: 'Preflop' },
  { spot: 'Dominated unpaired hand', detail: 'e.g. AK vs AQ (shared ace)', equity: 73, hook: 'Domination ≈ 70/30. Loser only lives via kicker / board.', recognize: 'Both hands share their TOP card; your kicker outranks theirs (A-K vs A-Q). "Domination" = same high card, you win the kicker.', cat: 'Preflop' },
  { spot: 'Two overcards vs a pair', detail: 'e.g. AK vs QQ', equity: 43, hook: 'Overcards are the dog (~43). Still close — two live cards.', recognize: 'You hold two unpaired high cards; villain has a pair that sits below them (A-K vs QQ). The same race, but from the overcard side — you\'re the slight dog.', cat: 'Preflop' },
  { spot: 'AA vs KK', detail: 'best vs 2nd-best pair', equity: 82, hook: '80/20, "cowboys cracked". KK only wins ~18% (set or runner).', recognize: 'The top two pocket pairs collide — your aces vs kings. KK is drawing almost dead unless a king lands.', cat: 'Preflop' },
  { spot: 'Pair vs two higher overcards, suited+connected', detail: 'e.g. 22 vs AKs', equity: 50, hook: 'A true coinflip — the suited+connected overs claw back to ~50.', recognize: 'Same as pair-vs-overcards, but the overcards are BOTH suited and connected (22 vs A-K suited). Those extra straight/flush outs drag it back to a true flip.', cat: 'Preflop' },
  { spot: 'Suited connector vs overpair', detail: 'e.g. JTs vs AA', equity: 22, hook: 'Big dog (~22), but the suited connector has the most outs of any underdog.', recognize: 'Your suited, connected cards are both BELOW villain\'s pocket pair (J-T suited vs AA). Way behind, but the most live underdog there is — straights AND flushes.', cat: 'Preflop' },

  // ---- Draws (Rule of 2 & 4) ----
  { spot: 'Flush draw on the flop', detail: '9 outs · 2 cards to come', equity: ruleOf2and4(9, 2), hook: 'Outs × 4 = 36 (round to ~35). The headline draw number.', recognize: 'Four cards of one suit after the flop (two in hand + two on board, or one + three). 13 − 4 = 9 cards of that suit left = 9 outs.', cat: 'Draws' },
  { spot: 'Open-ended straight draw, flop', detail: '8 outs · 2 cards to come', equity: ruleOf2and4(8, 2), hook: 'Outs × 4 = 32. OESD ≈ a third of the time.', recognize: 'Four cards in a row with room to extend BOTH ends (e.g. 9-8-7-6 wanting a T or a 5). Two ranks complete it × 4 suits = 8 outs.', cat: 'Draws' },
  { spot: 'Gutshot straight draw, flop', detail: '4 outs · 2 cards to come', equity: ruleOf2and4(4, 2), hook: 'Outs × 4 = 16. Gutshot ≈ 1-in-6 by the river.', recognize: 'One missing rank in the MIDDLE fills your straight (e.g. 9-8-6-5 needing a 7). One rank × 4 suits = 4 outs.', cat: 'Draws' },
  { spot: 'Flush + gutshot, flop', detail: '12 outs · 2 cards to come', equity: ruleOf2and4(12, 2), hook: 'Outs × 4 ≈ 48 (minus a touch). Near coinflip vs one pair.', recognize: 'A flush draw (9) AND an inside straight draw (4) at once — subtract the 1 card that does both. 9 + 4 − 1 = 12 outs.', cat: 'Draws' },
  { spot: 'Flush + OESD (monster draw), flop', detail: '15 outs · 2 cards to come', equity: ruleOf2and4(15, 2), hook: 'Outs × 4 ≈ 54 — you are the FAVOURITE vs top pair.', recognize: 'Flush draw (9) AND an open-ended straight draw (8) together — remove the 2 cards counted twice. 9 + 8 − 2 = 15 outs, the biggest standard draw.', cat: 'Draws' },
  { spot: 'Two overcards, flop', detail: '6 outs · 2 cards to come', equity: ruleOf2and4(6, 2), hook: 'Outs × 4 = 24. Six outs to a (maybe-good) pair.', recognize: 'You missed the flop but BOTH your cards beat the board (e.g. A-K on 8-5-2). Pairing either = 2 ranks × 3 remaining suits = 6 outs.', cat: 'Draws' },
  { spot: 'Flush draw on the turn', detail: '9 outs · 1 card to come', equity: ruleOf2and4(9, 1), hook: 'Outs × 2 = 18. One card halves your flop odds.', recognize: 'Same 9-out flush draw, but you\'re now on the turn with only the river left — so use × 2, not × 4.', cat: 'Draws' },
  { spot: 'OESD on the turn', detail: '8 outs · 1 card to come', equity: ruleOf2and4(8, 1), hook: 'Outs × 2 = 16. Need ~2:1 pot odds or implied odds.', recognize: 'Open-ended straight draw (8 outs) with one card to come. River-only, so × 2.', cat: 'Draws' },
  { spot: 'Gutshot on the turn', detail: '4 outs · 1 card to come', equity: ruleOf2and4(4, 1), hook: 'Outs × 2 = 8. Almost never a pure call — implied odds only.', recognize: 'Inside straight draw (4 outs) with only the river to come. × 2 = barely worth a call without implied odds.', cat: 'Draws' },

  // ---- Common postflop clashes ----
  { spot: 'Set vs overpair, on the flop', detail: 'e.g. 99 on 9♣4♦2♠ vs AA', equity: 90, hook: '~90/10. Set is a monster; overpair needs runner-runner or its 2-out set.', recognize: 'You hold a pocket pair that MATCHED the board (three of a kind) vs a bigger pocket pair that didn\'t improve (99 hits a 9; villain has AA). Set crushes overpair.', cat: 'Made hands' },
  { spot: 'Top pair vs flush draw, flop', detail: 'made hand vs 9-out draw', equity: 65, hook: '~65/35 — top pair is ahead but it is a real fight. Charge the draw.', recognize: 'You\'ve made top pair; villain has nothing yet but four to a flush (9 outs). Made hand ahead of a big draw — bet to deny the free card.', cat: 'Made hands' },
  { spot: 'Two pair vs flush draw, flop', detail: 'made hand vs 9-out draw', equity: 70, hook: '~70/30. Two pair also fears the board pairing, so still bet.', recognize: 'You hold two pair vs a flush draw (9 outs). Stronger made hand than top pair, so a bit further ahead — but the board can still pair you out.', cat: 'Made hands' },
  { spot: 'Overpair vs underpair, flop', detail: 'e.g. AA vs KK on a low board', equity: 90, hook: '~90/10 — same as preflop; the underpair is drawing to its set.', recognize: 'BOTH pocket pairs are bigger than every board card, yours the higher (AA vs KK on a 7-4-2 board). Same shape as the preflop pair-over-pair — they need a set.', cat: 'Made hands' },
];

export function buildOptions(card: Flash): number[] {
  // 3 distractors from other cards, each ≥6 pts from the answer and from each other
  const pool = CARDS.map((c) => c.equity).filter((e) => Math.abs(e - card.equity) >= 6);
  const picks: number[] = [card.equity];
  // shuffle pool
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (const e of pool) {
    if (picks.length >= 4) break;
    if (picks.every((p) => Math.abs(p - e) >= 6)) picks.push(e);
  }
  // shuffle the 4 options so the answer isn't always first
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  return picks;
}

// Spaced-repetition card selection. Math.random lives here (callers invoke from
// event handlers / module scope, never render). The draw is WEIGHTED by each
// card's SRS weight (missed cards surface more); `avoidIdx` skips an immediate repeat.
export function rollCard(pool: Flash[], srs: SrsMap, avoidIdx?: number): { idx: number; options: number[] } {
  const weights = pool.map((c) => weightOf(srs, c.spot));
  const i = weightedIndex(weights, Math.random, avoidIdx);
  return { idx: i, options: buildOptions(pool[i]) };
}
