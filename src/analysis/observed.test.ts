import { describe, it, expect } from 'vitest';
import type { ActionRecord } from '../engine/table';
import { accumulateHand, emptyObs, toStats } from './observed';

// Minimal log builder — only the fields accumulateHand reads.
function rec(playerId: number, type: ActionRecord['type'], street: ActionRecord['street']): ActionRecord {
  return {
    handNumber: 1,
    playerId,
    playerName: `p${playerId}`,
    position: 'BTN',
    type,
    amount: 0,
    street,
    potAfter: 0,
  } as ActionRecord;
}

describe('observed — preflop counters', () => {
  it('counts a VPIP hand once even when the player calls then re-raises', () => {
    const log = [rec(1, 'call', 'preflop'), rec(1, 'raise', 'preflop')];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.hands).toBe(1);
    expect(c.vpipHands).toBe(1);
    expect(c.pfrHands).toBe(1);
  });

  it('does not count a blind post as VPIP', () => {
    const log = [rec(1, 'post', 'preflop'), rec(1, 'fold', 'preflop')];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.vpipHands).toBe(0);
    expect(c.pfrHands).toBe(0);
  });

  it('ignores entries from other hands', () => {
    const log = [rec(1, 'raise', 'preflop'), { ...rec(1, 'raise', 'preflop'), handNumber: 2 }];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.pfrHands).toBe(1);
  });
});

describe('observed — preflop exploit reads', () => {
  const at = (playerId: number, type: ActionRecord['type'], position: string) =>
    ({ ...rec(playerId, type, 'preflop'), position }) as ActionRecord;

  it('counts an unopened pot as an RFI chance, taken or declined', () => {
    const c = accumulateHand({}, [at(1, 'raise', 'UTG'), at(2, 'fold', 'CO')], 1);
    expect(c[1].pfOpenChances).toBe(1);
    expect(c[1].pfOpenTaken).toBe(1);
    // p2 acted AFTER the raise, so it was a 3-bet spot for him, not an open chance
    expect(c[2].pfOpenChances).toBe(0);
    expect(c[2].pfThreeBetChances).toBe(1);
    expect(c[2].pfThreeBetTaken).toBe(0);
  });

  it('excludes the blinds from RFI chances — they have no unopened pot to open into', () => {
    const c = accumulateHand({}, [at(1, 'post', 'SB'), at(2, 'post', 'BB'), at(1, 'fold', 'SB'), at(2, 'check', 'BB')], 1);
    expect(c[1].pfOpenChances).toBe(0);
    expect(c[2].pfOpenChances).toBe(0);
  });

  it('counts a re-raise over an open as a 3-bet, and the opener as facing one', () => {
    const c = accumulateHand({}, [at(1, 'raise', 'CO'), at(2, 'raise', 'BTN'), at(1, 'fold', 'CO')], 1);
    expect(c[2].pfThreeBetChances).toBe(1);
    expect(c[2].pfThreeBetTaken).toBe(1);
    expect(c[1].pfFacedThreeBet).toBe(1);
    expect(c[1].pfFoldedToThreeBet).toBe(1);
    expect(toStats(c[1]).foldToThreeBet).toBe(1);
    expect(toStats(c[2]).threeBetFreq).toBe(1);
  });

  it('a 4-bet spot is neither a 3-bet chance nor a second open chance', () => {
    // p1 opens, p2 3-bets, p1 4-bets, p2 folds → p2's fold is FACING a 4-bet, not a
    // fresh 3-bet chance; counting it would halve his measured 3-bet frequency.
    const c = accumulateHand({}, [at(1, 'raise', 'CO'), at(2, 'raise', 'BTN'), at(1, 'raise', 'CO'), at(2, 'fold', 'BTN')], 1);
    expect(c[2].pfThreeBetChances).toBe(1);
    expect(c[2].pfFacedThreeBet).toBe(1); // his 3-bet got re-raised
    expect(c[1].pfOpenChances).toBe(1);
    expect(c[1].pfFacedThreeBet).toBe(1); // and he chose to 4-bet rather than fold
    expect(c[1].pfFoldedToThreeBet).toBe(0);
  });

  it('accumulates preflop rates across hands', () => {
    let m = accumulateHand({}, [at(1, 'raise', 'CO'), at(2, 'fold', 'BTN')], 1);
    m = accumulateHand(m, [
      { ...at(1, 'fold', 'CO'), handNumber: 2 },
      { ...at(2, 'raise', 'BTN'), handNumber: 2 },
    ], 2);
    expect(toStats(m[1]).openFreq).toBeCloseTo(0.5, 5);
    expect(toStats(m[1]).openSample).toBe(2);
    expect(toStats(m[2]).threeBetFreq).toBe(0); // hand 1 only; hand 2 was his own open
    expect(toStats(m[2]).openSample).toBe(1);
  });

  it('reports null, not zero, for a read with no spots yet', () => {
    const s = toStats(emptyObs());
    expect(s.openFreq).toBeNull();
    expect(s.threeBetFreq).toBeNull();
    expect(s.foldToThreeBet).toBeNull();
  });
});

describe('observed — fold-to-bet read', () => {
  it('counts a fold facing a bet, not a fold with no bet in front', () => {
    // p2 bets the flop, p1 folds → one faced-bet decision, one fold
    const log = [rec(2, 'bet', 'flop'), rec(1, 'fold', 'flop')];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.facedBet).toBe(1);
    expect(c.foldedToBet).toBe(1);
    expect(c.betChances).toBe(0);
  });

  it('a check with no bet ahead is a bet CHANCE, not a faced bet', () => {
    const log = [rec(1, 'check', 'flop'), rec(2, 'check', 'flop')];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.betChances).toBe(1);
    expect(c.betTaken).toBe(0);
    expect(c.facedBet).toBe(0);
  });

  it('scores both decisions when a player checks and then faces a bet in the same street', () => {
    // p1 checks, p2 bets, p1 calls → one bet-chance (declined) + one faced bet (called)
    const log = [rec(1, 'check', 'flop'), rec(2, 'bet', 'flop'), rec(1, 'call', 'flop')];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.betChances).toBe(1);
    expect(c.betTaken).toBe(0);
    expect(c.facedBet).toBe(1);
    expect(c.foldedToBet).toBe(0);
  });

  it('resets the "bet ahead" flag at a street boundary', () => {
    // flop: p2 bets, p1 calls. turn: p1 acts FIRST with nothing in front of them.
    const log = [
      rec(2, 'bet', 'flop'),
      rec(1, 'call', 'flop'),
      rec(1, 'check', 'turn'),
    ];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.facedBet).toBe(1); // the flop call only
    expect(c.betChances).toBe(1); // the turn check
  });

  it('never counts preflop decisions — the posted blind would read as a permanent bet', () => {
    const log = [rec(2, 'raise', 'preflop'), rec(1, 'fold', 'preflop')];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.facedBet).toBe(0);
    expect(c.betChances).toBe(0);
  });

  it('counts a raise with no bet ahead as taking the lead', () => {
    const log = [rec(1, 'bet', 'flop')];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.betChances).toBe(1);
    expect(c.betTaken).toBe(1);
  });

  it('accumulates across hands', () => {
    let m = accumulateHand({}, [rec(2, 'bet', 'flop'), rec(1, 'fold', 'flop')], 1);
    const hand2 = [
      { ...rec(2, 'bet', 'flop'), handNumber: 2 },
      { ...rec(1, 'call', 'flop'), handNumber: 2 },
    ];
    m = accumulateHand(m, hand2, 2);
    expect(m[1].facedBet).toBe(2);
    expect(m[1].foldedToBet).toBe(1);
    expect(toStats(m[1]).foldToBet).toBeCloseTo(0.5, 5);
  });
});

describe('observed — per-street split and barrel-through', () => {
  // villain = 1, hero = 2. Villain leads a street only when no bet is ahead of him.
  const barrel = (streets: ActionRecord['street'][], handNumber = 1) =>
    streets.flatMap((s) => [
      { ...rec(1, 'bet', s), handNumber },
      { ...rec(2, 'call', s), handNumber },
    ]);

  it('splits lead chances by street so a flop c-bet does not inflate the river read', () => {
    const c = accumulateHand({}, [...barrel(['flop', 'turn']), ...[rec(1, 'check', 'river'), rec(2, 'check', 'river')]], 1)[1];
    expect(c.betChances).toBe(3); // pooled: flop + turn + river
    expect(c.betTaken).toBe(2);
    expect(c.riverBetChances).toBe(1);
    expect(c.riverBetTaken).toBe(0);
    expect(toStats(c).betFreq).toBeCloseTo(2 / 3, 5); // pooled says 67% — flop-driven
    expect(toStats(c).riverBetFreq).toBe(0); // the river truth: he gave up
  });

  it('counts a flop→river barrel-through', () => {
    const c = accumulateHand({}, barrel(['flop', 'turn', 'river']), 1)[1];
    expect(c.ledFlop).toBe(1);
    expect(c.ledFlopThroughRiver).toBe(1);
    expect(toStats(c).barrelThrough).toBe(1);
  });

  it('excludes a flop lead that never got a river lead chance from the denominator', () => {
    // hero folds the flop — the hand teaches nothing about villain's river tendency
    const c = accumulateHand({}, [rec(1, 'bet', 'flop'), rec(2, 'fold', 'flop')], 1)[1];
    expect(c.ledFlop).toBe(0);
    expect(toStats(c).barrelThrough).toBeNull();
  });

  it('excludes a river the HERO led — villain never had the chance to barrel', () => {
    const log = [
      ...barrel(['flop']),
      rec(2, 'bet', 'river'), // hero leads the river
      rec(1, 'call', 'river'),
    ];
    const c = accumulateHand({}, log, 1)[1];
    expect(c.riverBetChances).toBe(0);
    expect(c.ledFlop).toBe(0);
  });

  it('gives up on one hand and barrels the next → 50%', () => {
    let m = accumulateHand({}, [...barrel(['flop']), rec(1, 'check', 'river'), rec(2, 'check', 'river')], 1);
    m = accumulateHand(m, barrel(['flop', 'river'], 2), 2);
    expect(m[1].ledFlop).toBe(2);
    expect(toStats(m[1]).barrelThrough).toBeCloseTo(0.5, 5);
    expect(toStats(m[1]).ledFlopSample).toBe(2);
  });
});

describe('observed — toStats', () => {
  it('returns nulls for the rate reads with no sample', () => {
    const s = toStats(emptyObs());
    expect(s.foldToBet).toBeNull();
    expect(s.betFreq).toBeNull();
    expect(s.facedBetSample).toBe(0);
  });

  it('reports the per-read sample sizes, which differ from hands played', () => {
    const c = { ...emptyObs(), hands: 40, facedBet: 3, foldedToBet: 3, betChances: 0 };
    const s = toStats(c);
    expect(s.hands).toBe(40);
    expect(s.foldToBet).toBe(1);
    expect(s.facedBetSample).toBe(3); // 40 hands, but only 3 spots behind this read
    expect(s.betFreq).toBeNull();
  });
});
