// CROSS-MODULE CONSISTENCY SWEEP.
//
// `handClass.ts` (the made-hand classifier) and `postflopModel.ts` (the EV
// recommender) reason about the SAME hand independently. When they disagree —
// the classifier calling 88 on 9-7-7 a "bluff-catcher, keep the pot small" while
// the model bet it 100% as a "semi-bluff" — that contradiction IS the bug
// signature. This suite turns that into an automated net: for a battery of spots
// it asserts the recommender never CLEARLY contradicts the category the
// classifier assigns.
//
// Scope note — what counts as a contradiction here. We assert only UNAMBIGUOUS
// leaks (a monster shoved-as-a-bluff, air value-bet, a bluff-catcher taking a
// LARGE bet or a shove as its top line multiway). We deliberately do NOT fail on
// close, defensible frequency calls: heads-up a "bluff-catcher" that is actually a
// 60%+ favourite (88 on 9-7-7 vs a wide range) is a fine thin-value bet, and a
// multiway two-pair that's ahead of the field (TT on A-A-5, ~46% three-way) taking
// a small bet is a judgement call, not a blunder. Those live in the `it.todo`
// below as a documented residual — the model still under-checks them, which needs
// equity-vs-the-continuing-range to price exactly (see postflopModel computeAggro).
//
// Monte-Carlo equity is not seeded through solvePostflop, so every asserted spot
// is chosen far from the equity thresholds and the bounds are wide — noise cannot
// flip a verdict.

import { describe, it, expect } from 'vitest';
import { solvePostflop, type PostflopInput } from './postflopModel';
import { classifyHandClass, type HandClass } from './handClass';
import { parseCard } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import { BB_DEFEND_RANGE } from '../ai/preflop';

const cards = (s: string) => s.split(' ').map(parseCard);
const range = rangeFromSet(BB_DEFEND_RANGE);
const BET_IDS = new Set(['bet33', 'bet50', 'bet75', 'betpot', 'allin']);
const BIG_BET_IDS = new Set(['bet75', 'betpot', 'allin']); // over half pot, or a shove

interface Probe {
  hc: HandClass;
  bestId: string;
  bestKind: string | undefined;
  betFreq: number; // summed frequency of every betting/raising line
  bigBetFreq: number; // summed frequency of >½-pot bets + shoves
  label: string;
}

/** A hero-first (checked-to) node: hero can check or bet, `nOpp` opponents live. */
function probe(hero: string, board: string, nOpp: number, iterations = 3000): Probe {
  const h = cards(hero);
  const b = cards(board);
  const inp: PostflopInput = {
    hero: h,
    board: b,
    oppRange: range,
    oppRanges: Array.from({ length: nOpp }, () => range),
    pot: 24,
    toCall: 0,
    heroCommitted: 0,
    currentBet: 0,
    minRaiseTo: 2,
    maxRaiseTo: 200,
    canCheck: true,
    canRaise: true,
    bigBlind: 2,
    iterations,
    effStack: 200,
  };
  const strat = solvePostflop(inp);
  const best = strat.options.find((o) => o.id === strat.bestId);
  const betFreq = strat.options.filter((o) => BET_IDS.has(o.id)).reduce((a, o) => a + o.freq, 0);
  const bigBetFreq = strat.options.filter((o) => BIG_BET_IDS.has(o.id)).reduce((a, o) => a + o.freq, 0);
  return {
    hc: classifyHandClass(h, b),
    bestId: strat.bestId,
    bestKind: best?.kind,
    betFreq,
    bigBetFreq,
    label: `${hero} on ${board} (${nOpp + 1}-way)`,
  };
}

const isBluffCatcher = (hc: HandClass) => /Board Pair/.test(hc.label) || /bluff-catcher/i.test(hc.blurb);
const isMonster = (hc: HandClass) => hc.strength >= 5;
const isAir = (hc: HandClass) => hc.label === 'Air';

describe('cross-check: classifier vs recommender never contradict', () => {
  // ---- MONSTERS: a set / boat / quads is never a bluff and is never folded. ----
  it('a monster (set/boat/quads) is never recommended as a bluff or a fold', () => {
    const spots = [
      probe('8s 8d', '8c 7d 2h', 1), // set of 8s
      probe('As Ad', 'Ah Kc 5d', 1), // top set
      probe('Ks Kd', 'Kh Qc Qd', 2), // kings full
      probe('9s 9d', '9c 9h 4d', 3), // quads, 4-way
    ];
    for (const p of spots) {
      expect(isMonster(p.hc), `${p.label}: classifier=${p.hc.label} (strength ${p.hc.strength})`).toBe(true);
      expect(p.bestKind, `${p.label}: monster's top line kind`).not.toBe('bluff');
      expect(p.bestId, `${p.label}: monster's top line`).not.toBe('fold');
    }
  });

  // ---- AIR: no made hand + no draw can never be a VALUE bet. ----
  it('air (no pair, no draw) is never recommended as a value bet', () => {
    const spots = [
      probe('Qs 3d', 'Kh 8c 2d', 1), // Q-high, no draw
      probe('7s 4d', 'Ah Kc 9d', 1), // 7-high, no draw
      probe('6h 2d', 'Ks Qc 9d', 2), // 6-high, no draw, 3-way
    ];
    for (const p of spots) {
      expect(isAir(p.hc), `${p.label}: classifier=${p.hc.label}`).toBe(true);
      expect(p.bestKind, `${p.label}: air's top line kind`).not.toBe('value');
    }
  });

  // ---- BLUFF-CATCHERS, MULTIWAY: the 88-on-977 family. A hand the classifier
  // calls a bluff-catcher must never take a LARGE bet (>½ pot) or a shove as its
  // top line multiway, and must not put real weight on big bets — betting big folds
  // out worse and is called only by better. (Small thin bets are allowed: they can
  // be defensible when the hand is ahead of the field — see the todo below.) ----
  it('a bluff-catcher never over-bets or shoves multiway (the reported-bug class)', () => {
    const spots = [
      probe('8s 8d', '9c 7d 7h', 3), // the reported bug, 4-way
      probe('9s 9d', 'As Ah 5c', 2), // pair of 9s + board aces, 3-way
      probe('6s 6d', 'Kc Kh 3d', 3), // pair of 6s + board kings, 4-way
      probe('Ts Td', 'Ac Ah 5s', 2), // pair of tens + board aces, 3-way
    ];
    for (const p of spots) {
      expect(isBluffCatcher(p.hc), `${p.label}: classifier=${p.hc.label}`).toBe(true);
      expect(BIG_BET_IDS.has(p.bestId), `${p.label}: top line is an over-bet/shove (bestId=${p.bestId})`).toBe(false);
      expect(p.bestId, `${p.label}: bluff-catcher shoving`).not.toBe('allin');
      // >½-pot bets + shoves must not be a real PREFERENCE. The threshold sits well
      // above the softmax mix-spill (~10-16% leaks onto near-EV big bets via the
      // mixing temperature) and well below a genuine over-bet (~100%), so MC noise
      // near the boundary can't flip the verdict.
      expect(p.bigBetFreq, `${p.label}: weight on >½-pot bets + shoves`).toBeLessThanOrEqual(0.35);
    }
  });

  // ---- GENERATED SWEEP: every underpair on a higher paired board is a
  // "Pair + Board Pair" bluff-catcher. Sweep the whole family, 3- and 4-way, and
  // assert none of them OVER-bets (big bet / shove top line, or heavy big-bet
  // weight). This is the automated hunt for more spots like the reported one. ----
  it('sweep: no underpair-on-paired-board bluff-catcher over-bets or shoves multiway', () => {
    const heroRanks = ['2', '3', '4', '6', '7', '8', '9', 'T']; // skip 5 (board kicker)
    const offenders: string[] = [];
    for (const r of heroRanks) {
      for (const nOpp of [2, 3]) {
        const p = probe(`${r}s ${r}d`, 'Ac Ah 5s', nOpp, 2500);
        if (!isBluffCatcher(p.hc)) continue;
        if (BIG_BET_IDS.has(p.bestId) || p.bigBetFreq > 0.35) {
          offenders.push(`${p.label}: ${p.hc.label} → bestId=${p.bestId} kind=${p.bestKind} bigBetFreq=${(p.bigBetFreq * 100).toFixed(0)}%`);
        }
      }
    }
    expect(offenders, `bluff-catchers the model over-bets:\n${offenders.join('\n')}`).toEqual([]);
  });

  // ---- DOCUMENTED RESIDUAL (not a failing test). The model still UNDER-CHECKS a
  // subset of multiway bluff-catchers that are ahead of the field but behind their
  // CALLING range (e.g. TT / 99 on A-A-5 three-way take a small bet ~100% instead
  // of mixing in checks for pot control). Pricing this exactly needs hero's equity
  // vs the actual tightened continuing range rather than the scalar order-statistic
  // + field-share bound now used in computeAggro. Tracked here so it isn't lost. ----
  it.todo('bluff-catchers ahead-of-field-but-behind-callers should mix in more checks multiway (needs equity-vs-continuing-range)');
});
