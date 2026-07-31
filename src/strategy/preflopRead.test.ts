// Live wiring for the preflop read layer: getNodeStrategy must actually move its
// preflop answer with the opponent model, and must move it the RIGHT way.
//
// Before this layer the mix facing a maniac's 3-bet was byte-identical to the mix
// facing a nit's — the reads never reached the chart path at all.

import { describe, it, expect } from 'vitest';
import { getNodeStrategy, buildVillainRange } from './index';
import type { VillainModels } from './index';
import { resolveVillainModel } from './villainModel';
import { parseCard } from '../engine/cards';
import type { ActionRecord, GameState } from '../engine/table';
import type { NodeStrategy } from './types';

const bb = 2;
const cards = (s: string) => s.split(' ').map(parseCard);

/** 6-max table, hero in seat 0 with the button on seat 2 → hero is CO.
 *  `raisers` are the seats that have already raised preflop, in order. */
function preflopState(heroCards: string, raisers: number[] = [], stackBB = 100): GameState {
  const stack = stackBB * bb;
  const log: ActionRecord[] = raisers.map((id, i) => ({
    handNumber: 1,
    playerId: id,
    playerName: `V${id}`,
    position: 'BTN',
    type: 'raise',
    amount: bb * (3 + i * 6),
    street: 'preflop',
    potAfter: 0,
  }) as ActionRecord);
  const currentBet = raisers.length ? bb * (3 + (raisers.length - 1) * 6) : bb;
  return {
    handNumber: 1,
    buttonIndex: 2,
    board: [],
    street: 'preflop',
    currentBet,
    lastRaiseSize: currentBet,
    toAct: 0,
    lastAggressor: raisers.length ? raisers[raisers.length - 1] : -1,
    bigBlind: bb,
    smallBlind: bb / 2,
    seed: 3,
    log,
    players: Array.from({ length: 6 }, (_, i) => ({
      id: i,
      name: i === 0 ? 'You' : `V${i}`,
      isHero: i === 0,
      profileId: 'gto',
      holeCards: i === 0 ? cards(heroCards) : [],
      stack,
      committed: raisers.includes(i) ? currentBet : i === 4 ? bb / 2 : i === 5 ? bb : 0,
      totalCommitted: raisers.includes(i) ? currentBet : i === 4 ? bb / 2 : i === 5 ? bb : 0,
      folded: false,
      allIn: false,
      hasActed: raisers.includes(i),
    })),
  } as unknown as GameState;
}

/** models map with one seat locked to a preflop profile */
function pf(seat: number, lock: { openFreq?: number; threeBetFreq?: number; foldToThreeBet?: number }): VillainModels {
  return { [seat]: resolveVillainModel(undefined, null, { enabled: true, ...lock }) };
}

const freqOf = (s: NodeStrategy, id: string) => s.options.filter((o) => o.id === id).reduce((a, o) => a + o.freq, 0);
const playFreq = (s: NodeStrategy) => s.options.filter((o) => o.id !== 'fold').reduce((a, o) => a + o.freq, 0);

describe('preflop read — facing a 3-bet', () => {
  // seat 1 opened, seat 3 3-bet; hero (seat 0) is the one facing it. The lock is on
  // the LAST raiser, which is the player whose range hero is actually up against.
  const node = (hero: string) => preflopState(hero, [0, 3]);

  it('a maniac 3-bettor and a nit 3-bettor no longer get the same answer', () => {
    const maniac = getNodeStrategy(node('Ah Qd'), 0, undefined, undefined, pf(3, { threeBetFreq: 0.24 }));
    const nit = getNodeStrategy(node('Ah Qd'), 0, undefined, undefined, pf(3, { threeBetFreq: 0.02 }));
    expect(playFreq(maniac)).toBeGreaterThan(playFreq(nit));
  });

  it("a nit's 3-bet folds out hero's marginal continues", () => {
    const balanced = getNodeStrategy(node('Ah Qd'), 0);
    const nit = getNodeStrategy(node('Ah Qd'), 0, undefined, undefined, pf(3, { threeBetFreq: 0.02 }));
    expect(playFreq(nit)).toBeLessThan(playFreq(balanced));
    expect(nit.note).toMatch(/top of his range/);
  });

  it('leaves the premiums alone — AA never folds to a read', () => {
    const nit = getNodeStrategy(node('Ah Ad'), 0, undefined, undefined, pf(3, { threeBetFreq: 0.02 }));
    expect(freqOf(nit, 'fold')).toBe(0);
  });

  it('a balanced villain reproduces the un-modelled chart answer exactly', () => {
    const bare = getNodeStrategy(node('Ah Qd'), 0);
    const balanced = getNodeStrategy(node('Ah Qd'), 0, undefined, undefined, {});
    expect(balanced.options).toEqual(bare.options);
    expect(balanced.exploit).toBeUndefined();
  });
});

describe('preflop read — facing an open', () => {
  const node = (hero: string) => preflopState(hero, [3]);

  it('an opener who folds to 3-bets gets 3-bet more than one who never folds', () => {
    const folder = getNodeStrategy(node('Kh 9h'), 0, undefined, undefined, pf(3, { foldToThreeBet: 0.85 }));
    const sticky = getNodeStrategy(node('Kh 9h'), 0, undefined, undefined, pf(3, { foldToThreeBet: 0.15 }));
    expect(freqOf(folder, 'raise')).toBeGreaterThanOrEqual(freqOf(sticky, 'raise'));
    expect(freqOf(folder, 'raise') + freqOf(folder, 'call')).toBeGreaterThan(0);
  });

  it('a 45%-opener is defended wider than a 10%-opener', () => {
    const loose = getNodeStrategy(node('Kh 9h'), 0, undefined, undefined, pf(3, { openFreq: 0.45 }));
    const tight = getNodeStrategy(node('Kh 9h'), 0, undefined, undefined, pf(3, { openFreq: 0.1 }));
    expect(playFreq(loose)).toBeGreaterThan(playFreq(tight));
    expect(loose.note).toMatch(/his range is weak/);
  });
});

describe('preflop read — opening into the field', () => {
  it('a 3-bet-happy seat behind taxes the steal tail', () => {
    // hero opens with nobody in yet; seat 3 (behind, yet to act) is the threat
    const taxed = getNodeStrategy(preflopState('9h 6h'), 0, undefined, undefined, pf(3, { threeBetFreq: 0.26 }));
    const free = getNodeStrategy(preflopState('9h 6h'), 0, undefined, undefined, pf(3, { threeBetFreq: 0.02 }));
    expect(playFreq(taxed)).toBeLessThanOrEqual(playFreq(free));
    expect(taxed.note).toMatch(/open tighter|3-bets/);
  });
});

describe('preflop read — every mix stays a valid distribution', () => {
  it('across hands, nodes and read extremes', () => {
    const reads = [
      { threeBetFreq: 0.3 }, { threeBetFreq: 0.01 },
      { foldToThreeBet: 0.95 }, { foldToThreeBet: 0.05 },
      { openFreq: 0.6 }, { openFreq: 0.05 },
    ];
    for (const hero of ['Ah Ad', 'Ah Qd', 'Kh 9h', '7h 6h', '3h 2d']) {
      for (const raisers of [[], [3], [1, 3], [1, 3, 1]]) {
        for (const r of reads) {
          const s = getNodeStrategy(preflopState(hero, raisers), 0, undefined, undefined, pf(3, r));
          const total = s.options.reduce((a, o) => a + o.freq, 0);
          expect(total).toBeGreaterThan(0.98);
          expect(total).toBeLessThan(1.02);
          for (const o of s.options) expect(o.freq).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('preflop read — the postflop range inherits it', () => {
  // A flop node where seat 3 was the preflop 3-bettor. His projected range is what
  // every postflop equity number is measured against, so a 3-bet% read has to reach it.
  function flopAfter3Bet(): GameState {
    const s = preflopState('Ah Qd', [1, 3]) as unknown as {
      street: string; board: unknown[]; players: { folded: boolean }[]; currentBet: number;
    };
    s.street = 'flop';
    s.board = cards('Kh 8d 3c');
    s.currentBet = 0;
    for (const [i, p] of s.players.entries()) if (i !== 0 && i !== 3) p.folded = true;
    return s as unknown as GameState;
  }

  const sizeOf = (models?: VillainModels) => buildVillainRange(flopAfter3Bet(), 0, models).range.size;

  it('a 24% 3-bettor is modelled with a wider range than the chart assumes', () => {
    expect(sizeOf(pf(3, { threeBetFreq: 0.24 }))).toBeGreaterThan(sizeOf());
  });

  it('a 2% 3-bettor is modelled tighter', () => {
    expect(sizeOf(pf(3, { threeBetFreq: 0.02 }))).toBeLessThan(sizeOf());
  });

  it('says so in the range note rather than silently changing the read', () => {
    const { note } = buildVillainRange(flopAfter3Bet(), 0, pf(3, { threeBetFreq: 0.24 }));
    expect(note).toMatch(/widened to his observed preflop frequencies/);
  });
});
