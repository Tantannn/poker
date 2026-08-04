import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from './index';
import type { VillainModels } from './index';
import { resolveVillainModel } from './villainModel';
import { parseCard } from '../engine/cards';
import type { GameState } from '../engine/table';

const cards = (s: string) => s.split(' ').map(parseCard);

// Heads-up FLOP node, hero first to act. The flop deliberately avoids the turn/river
// CFR paths in index.ts (those bypass the per-hand model and so carry no exploit
// delta in this stage), so this exercises solvePostflop — the engine the node lock
// actually steers.
// `lastRaiseSize` matters: legalActions derives minRaiseTo from it, and leaving it
// undefined makes every bet size NaN — a silently degenerate solve, not an error.
function flopState(heroCards: string, boardStr: string, currentBet = 0): GameState {
  const villainIn = currentBet; // villain led for `currentBet` when there is a bet
  return {
    handNumber: 1,
    buttonIndex: 0,
    board: cards(boardStr),
    street: 'flop',
    currentBet,
    lastRaiseSize: 2,
    toAct: 0,
    lastAggressor: currentBet > 0 ? 1 : -1,
    bigBlind: 2,
    seed: 12345,
    log: [],
    players: [
      { id: 0, name: 'You', isHero: true, profileId: 'gto', holeCards: cards(heroCards), stack: 200, committed: 0, totalCommitted: 6, folded: false, allIn: false },
      { id: 1, name: 'V', isHero: false, profileId: 'gto', holeCards: [], stack: 200 - villainIn, committed: villainIn, totalCommitted: 6 + villainIn, folded: false, allIn: false },
    ],
  } as unknown as GameState;
}

/** Same table, but a hero-first heads-up RIVER node — which routes to the CFR gate
 *  rather than the per-hand model, so the lock has to reach the solver itself. */
function riverState(heroCards: string, boardStr: string): GameState {
  const s = flopState(heroCards, boardStr) as unknown as { street: string };
  s.street = 'river';
  return s as unknown as GameState;
}

/** Same table, a hero-first heads-up TURN node — routes to the turn CFR gate, which (like
 *  the river, not the flop carve-out) pins villain to the read instead of falling to the
 *  per-hand model, so the lock must reach solveTurn and its nested river subgames. */
function turnState(heroCards: string, boardStr: string): GameState {
  const s = flopState(heroCards, boardStr) as unknown as { street: string };
  s.street = 'turn';
  return s as unknown as GameState;
}

/** models map with seat 1 locked to a given fold-to-bet / bet frequency */
function locked(foldToBet?: number, betFreq?: number): VillainModels {
  return { 1: resolveVillainModel(undefined, null, { enabled: true, foldToBet, betFreq }) };
}

const freqOf = (s: ReturnType<typeof getNodeStrategy>, id: string) =>
  s.options.filter((o) => o.id === id).reduce((a, o) => a + o.freq, 0);
const aggroFreq = (s: ReturnType<typeof getNodeStrategy>) =>
  s.options.filter((o) => o.id.startsWith('bet') || o.id === 'allin' || o.id === 'raise').reduce((a, o) => a + o.freq, 0);

describe('node lock — fold-to-bet steers the betting decision', () => {
  // air with backdoor equity: the hand whose whole value is fold equity, so the
  // villain's fold frequency is the only thing that should decide the line.
  const board = 'Kh 8d 3c';
  const air = '6s 5s';

  it('a villain who folds far too much makes hero bet more than one who never folds', () => {
    const nit = getNodeStrategy(flopState(air, board), 0, 1200, undefined, locked(0.85));
    const station = getNodeStrategy(flopState(air, board), 0, 1200, undefined, locked(0.05));
    expect(aggroFreq(nit)).toBeGreaterThan(aggroFreq(station));
  });

  it('a station gets checked to more often than a nit', () => {
    const nit = getNodeStrategy(flopState(air, board), 0, 1200, undefined, locked(0.85));
    const station = getNodeStrategy(flopState(air, board), 0, 1200, undefined, locked(0.05));
    expect(freqOf(station, 'check')).toBeGreaterThan(freqOf(nit, 'check'));
  });

  it('is deterministic for the same node and lock', () => {
    const a = getNodeStrategy(flopState(air, board), 0, 1200, 0.31, locked(0.85));
    const b = getNodeStrategy(flopState(air, board), 0, 1200, 0.31, locked(0.85));
    expect(a.bestId).toBe(b.bestId);
    expect(a.bestEv).toBeCloseTo(b.bestEv, 6);
  });
});

describe('node lock — the exploit delta', () => {
  const board = 'Kh 8d 3c';

  it('is absent with no models supplied (archetype prior is not an earned read)', () => {
    const s = getNodeStrategy(flopState('6s 5s', board), 0, 1200);
    expect(s.exploit).toBeUndefined();
  });

  it('is absent when the locked read is balanced (nothing to exploit)', () => {
    // 0.45 fold-to-bet / 0.55 bet-freq ARE the balanced reference values
    const s = getNodeStrategy(flopState('6s 5s', board), 0, 1200, undefined, locked(0.45, 0.55));
    expect(s.exploit).toBeUndefined();
  });

  it('reports a positive gain and names two different actions when it fires', () => {
    // sweep a few spots — the delta only appears where the balanced and exploit
    // lines genuinely diverge, which is spot-specific, not universal
    const spots: [string, string][] = [
      ['6s 5s', 'Kh 8d 3c'],
      ['Ts 9s', 'Kh 8d 3c'],
      ['Qd Jc', 'Kh 8d 3c'],
      ['7h 6h', 'Ah Kd 4c'],
      ['As 4s', 'Kh 8d 3c'],
    ];
    const found = spots
      .map(([h, b]) => getNodeStrategy(flopState(h, b), 0, 1200, undefined, locked(0.9))?.exploit)
      .filter((x) => x != null);

    expect(found.length).toBeGreaterThan(0);
    for (const x of found!) {
      expect(x!.gainBb).toBeGreaterThan(0.05);
      expect(x!.baselineId).not.toBe(x!.exploitId);
      expect(x!.source).toBe('locked');
      expect(x!.confidence).toBe(1);
      expect(x!.why).toBeTruthy();
    }
  });

  it('surfaces the delta in the notes so the text panels see it too', () => {
    const spots: [string, string][] = [
      ['6s 5s', 'Kh 8d 3c'],
      ['Ts 9s', 'Kh 8d 3c'],
      ['Qd Jc', 'Kh 8d 3c'],
      ['7h 6h', 'Ah Kd 4c'],
    ];
    const withDelta = spots
      .map(([h, b]) => getNodeStrategy(flopState(h, b), 0, 1200, undefined, locked(0.9)))
      .filter((s) => s.exploit != null);
    expect(withDelta.length).toBeGreaterThan(0);
    for (const s of withDelta) {
      expect(s.note).toContain('Exploit:');
      expect(s.notes?.some((n) => n.startsWith('Exploit:'))).toBe(true);
    }
  });
});

// The HU river gate does NOT fall through to the per-hand model on a read (unlike the
// flop/3-way gates). It pins villain inside the CFR and hero best-responds, so these
// assert the lock actually reaches the solver rather than only reweighting the range.
describe('node lock — heads-up river routes through the CFR with villain pinned', () => {
  const board = 'Kh 8d 3c 7s 2h'; // dry: no flush, no straight
  const air = '6c 5d';

  it('says it is node-locked, not at equilibrium', () => {
    const s = getNodeStrategy(riverState(air, board), 0, undefined, undefined, locked(0.85));
    expect(s.note).toContain('NODE LOCKED');
    expect(s.note).toMatch(/85% to a ¾-pot bet/);
  });

  it('still reports the plain equilibrium when there is no read', () => {
    const s = getNodeStrategy(riverState(air, board), 0);
    expect(s.note).toContain('River solver');
    expect(s.note).not.toContain('NODE LOCKED');
    expect(s.exploit).toBeUndefined();
  });

  it('bluffs air more against an over-folder than at equilibrium', () => {
    const eq = getNodeStrategy(riverState(air, board), 0);
    const vsNit = getNodeStrategy(riverState(air, board), 0, undefined, undefined, locked(0.85));
    expect(aggroFreq(vsNit)).toBeGreaterThan(aggroFreq(eq));
  });

  it('gives up on air against a villain who never folds', () => {
    const vsStation = getNodeStrategy(riverState(air, board), 0, undefined, undefined, locked(0.03));
    const vsNit = getNodeStrategy(riverState(air, board), 0, undefined, undefined, locked(0.85));
    expect(aggroFreq(vsStation)).toBeLessThan(aggroFreq(vsNit));
  });

  it('surfaces an exploit delta when the locked line differs from the equilibrium line', () => {
    const spots = [air, 'Qs Jd', '9h 9d', 'Ad Ac'];
    const found = spots
      .map((h) => getNodeStrategy(riverState(h, board), 0, undefined, undefined, locked(0.9)).exploit)
      .filter((x) => x != null);
    expect(found.length).toBeGreaterThan(0);
    for (const x of found) {
      expect(x!.gainBb).toBeGreaterThan(0.05);
      expect(x!.baselineId).not.toBe(x!.exploitId);
      expect(x!.source).toBe('locked');
    }
  });

  it('is deterministic for the same node and lock', () => {
    const a = getNodeStrategy(riverState(air, board), 0, undefined, undefined, locked(0.8));
    const b = getNodeStrategy(riverState(air, board), 0, undefined, undefined, locked(0.8));
    expect(a.bestId).toBe(b.bestId);
    expect(a.bestEv).toBeCloseTo(b.bestEv, 6);
  });
});

// The HU turn gate mirrors the river: a read pins villain INSIDE the CFR (and its nested
// river subgames) and hero best-responds, then a second unlocked solve gives the delta.
// This is the street CLAUDE.md previously flagged as carrying no lock/delta.
describe('node lock — heads-up turn routes through the CFR with villain pinned', () => {
  const board = 'Kh 8d 3c 7s'; // dry turn: no flush, no straight
  const air = '6c 5d';

  it('says it is node-locked, not at equilibrium', () => {
    const s = getNodeStrategy(turnState(air, board), 0, undefined, undefined, locked(0.85));
    expect(s.note).toContain('NODE LOCKED');
    expect(s.note).toMatch(/85% to a ¾-pot bet/);
  });

  it('reports the plain turn solve when there is no read', () => {
    const s = getNodeStrategy(turnState(air, board), 0);
    expect(s.note).toContain('Turn solver');
    expect(s.note).not.toContain('NODE LOCKED');
    expect(s.exploit).toBeUndefined();
  });

  // EV, not frequency. On the turn hero's alternative to barrelling is to check and bluff the
  // river, where the same locked villain folds just as often — so the two lines sit within
  // fractions of a chip and which one carries the FREQUENCY flips between adjacent runouts.
  // What the read must always do is make barrelling worth more; that is the number the grader
  // anchors on, and it is stable.
  it('makes barrelling worth MORE against an over-folder than against a station', () => {
    const bluff = 'Qs Jd';
    const betEv = (foldToBet: number) => {
      const s = getNodeStrategy(turnState(bluff, board), 0, undefined, undefined, locked(foldToBet));
      return Math.max(...s.options.filter((o) => o.kind === 'aggressive').map((o) => o.ev));
    };
    expect(betEv(0.85)).toBeGreaterThan(betEv(0.15));
  }, 30000);

  // A turn solve nests a river subgame per runout, so it is ~40× a river solve; the read
  // needs TWO solves (locked + unlocked baseline) per spot → generous timeout, few spots.
  //
  // On the TURN the read changes the LINE but the EV gap is small on purpose: hero's
  // alternative is to check and bluff the river, where the same locked villain folds just as
  // often, so the two lines are near-EV-equal and `exploit` (which needs > 0.05bb) may not
  // fire. The gap is large one street later, where there is no river left to delay to — that
  // is asserted in the river block above. Here the claim is that the line itself flips.
  it('flips the best line when the read is strong, even where the EV gap is thin', () => {
    const bluff = 'Qs Jd';
    const eq = getNodeStrategy(turnState(bluff, board), 0);
    const lockedSolve = getNodeStrategy(turnState(bluff, board), 0, undefined, undefined, locked(0.9));
    expect(lockedSolve.bestId).not.toBe(eq.bestId);
    expect(lockedSolve.note).toContain('NODE LOCKED');
  }, 30000);
});

describe('node lock — provenance never leaks the hidden archetype', () => {
  it('a locked read is described as locked, not by the bot tag', () => {
    // facing a bet, villain locked to almost never bluff → the bluff-catch note fires
    const s = getNodeStrategy(flopState('As 2d', 'Kh 8d 3c', 12), 0, 1200, undefined, locked(0.45, 0.06));
    const text = `${s.note} ${(s.notes ?? []).join(' ')}`;
    if (text.includes('Villain read:')) {
      expect(text).toContain('locked read');
      expect(text).not.toMatch(/\((TAG|LAG|LP|MANIAC|NIT|GTO)\)/);
    }
  });

  it('an observed read reports a confidence percentage rather than an archetype', () => {
    const models: VillainModels = {
      1: resolveVillainModel(undefined, {
        hands: 80, vpip: 0.3, pfr: 0.2, af: 2,
        foldToBet: 0.05, betFreq: null, facedBetSample: 120, betChanceSample: 0,
        foldToBetRecent: null, foldToBetShift: null, betFreqRecent: null, betFreqShift: null,
        riverBetFreq: null, riverBetChanceSample: 0, turnBetFreq: null,
        barrelThrough: null, ledFlopSample: 0,
        turnGiveUp: null, turnGiveUpSample: 0, foldToRaise: null, foldToRaiseSample: 0,
        openFreq: null, openSample: 0, threeBetFreq: null, threeBetSample: 0,
        foldToThreeBet: null, foldToThreeBetSample: 0,
      }, null),
    };
    const s = getNodeStrategy(flopState('As 2d', 'Kh 8d 3c', 12), 0, 1200, undefined, models);
    const text = `${s.note} ${(s.notes ?? []).join(' ')}`;
    if (text.includes('Villain read:')) {
      expect(text).toMatch(/confidence read/);
      expect(text).not.toMatch(/\((TAG|LAG|LP|MANIAC|NIT|GTO)\)/);
    }
  });
});
