// 7- to 9-handed tables add seats the preflop charts were never authored for. The
// whole design rests on one claim: every added seat has 5+ players behind, the same
// as 6-max UTG, so it borrows UTG's chart. These pin that the two mappings which
// encode it agree, that the engine deals the bigger ring, and that hero's blind
// frequency actually drops — the reason full ring exists.

import { describe, it, expect } from 'vitest';
import { getNodeStrategy, roleBaseRange } from './index';
import { cardId } from '../engine/cards';
import { RFI_RANGES, handCode } from '../ai/preflop';
import { decideAction } from '../ai/decide';
import {
  applyAction,
  biasHoleCards,
  chartPosition,
  createGame,
  positionLabel,
  sixMaxRfiEquivalent,
  startHand,
  tablePositions,
  type GameState,
  type Position,
} from '../engine/table';

const BB = 2;
const bots = (n: number) => Array.from({ length: n - 1 }, () => 'tag');

function dealt(n: number, depthBB = 100): GameState {
  return startHand(createGame(n, depthBB, BB, bots(n)));
}

/** A 9-handed hand dealt so hero (seat 0) sits at `pos` holding `code`. startHand
 *  advances the button by one, so the pre-hand index is set one BEHIND the target —
 *  setting it afterwards would relabel the seats without moving the posted blinds. */
function heroAt(pos: Position, code: string): GameState {
  const n = 9;
  const button = (n - tablePositions(n).indexOf(pos)) % n;
  const g = createGame(n, 100, BB, bots(n));
  g.buttonIndex = (button - 1 + n) % n;
  const s = startHand(g);
  biasHoleCards(s, 0, code);
  return s;
}

/** Fold every seat ahead of hero so hero (seat 0) is first-in and unopened. */
function foldedToHero(s: GameState): GameState {
  for (let guard = 0; guard < 12 && s.toAct !== 0 && s.street === 'preflop'; guard++) {
    s = applyAction(s, { type: 'fold' });
  }
  return s;
}

describe('full-ring seat tables', () => {
  it('deals 7, 8 and 9 distinct seats with the blinds left of the button', () => {
    for (const n of [7, 8, 9]) {
      const seats = tablePositions(n);
      expect(seats).toHaveLength(n);
      expect(new Set(seats).size).toBe(n);
      expect(seats[0]).toBe('BTN');
      expect(seats[1]).toBe('SB');
      expect(seats[2]).toBe('BB');
    }
  });

  it('grows the table in the middle — the late seats keep their labels', () => {
    // Position is "how many act behind you", so a bigger table must not shift the
    // CO or the button; it inserts early seats between the BB and the hijack.
    for (const n of [7, 8, 9]) {
      const seats = tablePositions(n);
      expect(seats[seats.length - 1]).toBe('CO');
      expect(seats[seats.length - 2]).toBe('MP');
    }
  });

  it('chartPosition equals the seats-behind ladder at every full-ring size', () => {
    // The two mappings are used by different call sites (name-keyed lookups vs the
    // RFI ladder). If they ever disagree, one seat gets graded on a chart the bots
    // are not playing — the sync requirement in CLAUDE.md.
    for (const n of [7, 8, 9]) {
      for (const pos of tablePositions(n)) {
        const ladder = sixMaxRfiEquivalent(pos, n);
        if (ladder === null) {
          expect(pos).toBe('BB'); // only the BB never opens first-in
          continue;
        }
        expect(ladder).toBe(chartPosition(pos));
      }
    }
  });

  it('every added seat reads UTG, and only the hijack and CO widen', () => {
    const nine = tablePositions(9).map((p) => [p, chartPosition(p)] as const);
    expect(Object.fromEntries(nine)).toEqual({
      BTN: 'BTN', SB: 'SB', BB: 'BB',
      UTG: 'UTG', UTG1: 'UTG', UTG2: 'UTG', LJ: 'UTG',
      MP: 'MP', CO: 'CO',
    });
  });
});

describe('full-ring positional frequency', () => {
  it('drops hero into the blinds 2 hands in 9 instead of 2 in 6', () => {
    // The point of the feature: 6-max puts hero in a blind a third of the time and
    // over-trains blind defence. Counting whole orbits keeps this exact.
    const blindShare = (n: number) => {
      let blinds = 0;
      for (let button = 0; button < n; button++) {
        const pos = positionLabel(0, button, n);
        if (pos === 'SB' || pos === 'BB') blinds++;
      }
      return blinds / n;
    };
    expect(blindShare(6)).toBeCloseTo(2 / 6, 10);
    expect(blindShare(9)).toBeCloseTo(2 / 9, 10);
    expect(blindShare(9)).toBeLessThan(blindShare(6));
  });
});

describe('full-ring reaches the strategy engine', () => {
  it('plays a 9-handed hand to completion through the real engine', () => {
    let s = dealt(9);
    expect(s.players).toHaveLength(9);
    expect(s.players.every((p) => p.holeCards.length === 2)).toBe(true);
    // 18 hole cards + 5 board must still come off one 52-card deck without collision
    const ids = s.players.flatMap((p) => p.holeCards).map(cardId);
    expect(new Set(ids).size).toBe(18);
    for (let guard = 0; guard < 40 && s.street !== 'complete'; guard++) {
      s = applyAction(s, { type: 'fold' });
    }
    expect(s.street).toBe('complete');
  });

  it.each(['UTG1', 'UTG2', 'LJ'] as const)('grades a 9-max %s on UTG’s chart, not the button’s', (pos) => {
    // Before the chart mapping existed, an unmatched label matched no branch and fell
    // through to BTN — the widest range in the file — handed to the tightest seats.
    // KJo is a button open (K7o+) and an UTG fold (AJo+/KQo), so it separates them.
    const s = foldedToHero(heroAt(pos, 'KJo'));
    expect(positionLabel(0, s.buttonIndex, 9)).toBe(pos);
    expect(s.toAct).toBe(0); // hero really is first-in; the assertion below is not vacuous
    const strat = getNodeStrategy(s, 0);
    const freq = (id: string) => strat.options.find((o) => o.id === id)?.freq ?? 0;
    expect(freq('fold')).toBeGreaterThan(freq('raise') + freq('allin'));
  });

  it.each(['UTG1', 'UTG2', 'LJ'] as const)('projects a 9-max %s opener as UTG, not as the button', (pos) => {
    // roleBaseRange keyed RFI_RANGES on the raw label with `?? RFI_RANGES.BTN`. An
    // added seat missed and every postflop engine inherited the WIDEST range in the
    // file for the tightest seat — reads too wide and too weak on every street.
    let s = heroAt(pos, 'AhKs');
    while (s.toAct !== 0) s = applyAction(s, { type: 'fold' });
    s = applyAction(s, { type: 'raise', amount: 5 * BB });
    const opener = roleBaseRange(s, 0);
    expect(opener.note).toMatch(/opening range/);
    expect(opener.baseSet).toEqual(RFI_RANGES.UTG);
    expect(opener.baseSet.size).toBeLessThan(RFI_RANGES.BTN.size);
  });
});

describe('full-ring bots', () => {
  it.each(['UTG1', 'UTG2', 'LJ'] as const)('lets a bot in the added %s seat open', (pos) => {
    // decideAction read RFI_RANGES[pos] directly: an added seat had no chart, so
    // `?? false` folded it 100% of the time and the early third of the table sat out.
    // Counted only over hands the seat's chart actually opens: off-chart hands get a
    // thin steal band either way, so a raw open count can't tell a charted seat from
    // a chartless one. In-chart hands open ~always (blueprint.ts: rfiOpenFreq).
    // createGame leaves the button at n-1 and startHand advances it to 0, so a seat
    // index IS its offset from the button and positionLabel(seat, 0, 9) is its label.
    const seat = tablePositions(9).indexOf(pos);
    let charted = 0;
    let opened = 0;
    for (let hand = 0; hand < 200; hand++) {
      let s = dealt(9);
      expect(positionLabel(seat, s.buttonIndex, 9)).toBe(pos);
      while (s.toAct !== seat && s.street === 'preflop') s = applyAction(s, { type: 'fold' });
      if (s.toAct !== seat) continue;
      if (!RFI_RANGES.UTG.has(handCode(s.players[seat].holeCards))) continue;
      charted++;
      if (decideAction(s).type === 'raise') opened++; // decideAction acts for state.toAct
    }
    expect(charted).toBeGreaterThan(15);
    expect(opened / charted).toBeGreaterThan(0.5);
  });
});
