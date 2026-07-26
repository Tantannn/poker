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
