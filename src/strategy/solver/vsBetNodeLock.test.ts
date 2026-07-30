import { describe, it, expect } from 'vitest';
import { solveRiverVsBet, lockedContinueVsRaise, type Combo } from './riverSolver';
import { solveTurnVsBet } from './turnSolver';
import { getNodeStrategy } from '../index';
import type { VillainModels } from '../index';
import { resolveVillainModel } from '../villainModel';
import { parseCard, type Card } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);

// Hero faces a bet holding air. Villain's betting range is mostly busted bluffs plus a few
// value hands, so hero has a bluff-RAISE available. Whether it's profitable depends entirely
// on how often villain gives up when raised — the one thing an equilibrium solve refuses to
// let hero exploit, and the reason the lock exists.
const heroRange: Combo[] = [
  { cards: C('7c 6d'), w: 1 }, // air — the bluff-raise candidate
  { cards: C('Ac Kc'), w: 1 }, // two pair: beats everything villain continues with
];
const villainRange: Combo[] = [
  { cards: C('Jc Tc'), w: 3 }, // busted — the part of his range a raise attacks
  { cards: C('9d 7d'), w: 3 }, // busted
  { cards: C('Ad Qd'), w: 1 }, // top pair — the top of his range by strength
];
const b5 = board('Ah Kd 8c 3s 2h');
const Q = 60;
const bet = 20;
const raiseTo = 100;

const raiseFreq = (r: { heroStrategy: { raise: number }[] }, i: number) => r.heroStrategy[i].raise;

describe('lockedContinueVsRaise', () => {
  it('re-prices the ¾-pot read for the raise the hero is actually making', () => {
    // Villain adds raiseTo − bet to win Q + bet + raiseTo, a better price than the ¾-pot
    // reference — so the curve must fold him LESS than his raw fold-to-bet number.
    const read = 0.7;
    const cont = lockedContinueVsRaise(read, Q, bet, raiseTo);
    expect(cont).toBeGreaterThan(1 - read);
    expect(cont).toBeLessThanOrEqual(1);
  });

  it('a bigger raise folds a locked villain out more often', () => {
    const small = lockedContinueVsRaise(0.6, Q, bet, 60);
    const big = lockedContinueVsRaise(0.6, Q, bet, 200);
    expect(big).toBeLessThan(small);
  });

  it('a station continues more than a nit at the same node', () => {
    expect(lockedContinueVsRaise(0.15, Q, bet, raiseTo)).toBeGreaterThan(
      lockedContinueVsRaise(0.75, Q, bet, raiseTo),
    );
  });
});

describe('river facing-a-bet node lock', () => {
  const solve = (villainFoldToBet?: number) =>
    solveRiverVsBet({
      heroRange,
      villainRange,
      board: b5,
      potBeforeBet: Q,
      bet,
      raiseSizes: [raiseTo],
      iterations: 2500,
      villainLock: villainFoldToBet != null ? { foldToBet: villainFoldToBet } : undefined,
    });

  it('an over-folder makes hero raise AIR more than the equilibrium does', () => {
    const eq = solve();
    const overfolder = solve(0.8);
    console.log(`air raise: equilibrium=${(raiseFreq(eq, 0) * 100).toFixed(0)}%  vs over-folder=${(raiseFreq(overfolder, 0) * 100).toFixed(0)}%`);
    expect(raiseFreq(overfolder, 0)).toBeGreaterThan(raiseFreq(eq, 0));
  });

  it('the raise EV with air is strictly higher vs the over-folder', () => {
    expect(solve(0.8).heroEv[0].raise).toBeGreaterThan(solve().heroEv[0].raise);
  });

  it('a station kills the bluff-raise but not the value raise', () => {
    const station = solve(0.05);
    expect(raiseFreq(station, 0)).toBeLessThan(raiseFreq(solve(0.8), 0));
    // two pair beats his whole continuing range, so a station is the one player it most
    // wants to raise — the read must not suppress value along with the bluff.
    expect(raiseFreq(station, 1)).toBeGreaterThan(0.2);
  });

  it('the locked villain call frequency reports the pinned policy, not a coin flip', () => {
    const station = solve(0.05);
    const nit = solve(0.85);
    expect(station.villainCallRaiseFreq[0]).toBeGreaterThan(nit.villainCallRaiseFreq[0]);
    expect(nit.villainCallRaiseFreq[0]).toBeLessThan(0.5);
  });

  it('no lock leaves the equilibrium untouched (determinism guard)', () => {
    const a = solve();
    const c = solve();
    expect(a.heroStrategy[0].raise).toBeCloseTo(c.heroStrategy[0].raise, 10);
    expect(a.villainCallRaiseFreq[0]).toBeCloseTo(c.villainCallRaiseFreq[0], 10);
  });
});

describe('turn facing-a-bet node lock (equity-driven core)', () => {
  const b4 = board('Ah Kd 8c 3s');
  const solve = (villainFoldToBet?: number) =>
    solveTurnVsBet({
      heroRange,
      villainRange,
      board: b4,
      potBeforeBet: Q,
      bet,
      raiseSizes: [raiseTo],
      iterations: 1200,
      villainFoldToBet,
    });

  it('the read moves hero\'s raise frequency with a card still to come', () => {
    const eq = solve();
    const overfolder = solve(0.8);
    console.log(`turn air raise: equilibrium=${(raiseFreq(eq, 0) * 100).toFixed(0)}%  vs over-folder=${(raiseFreq(overfolder, 0) * 100).toFixed(0)}%`);
    expect(raiseFreq(overfolder, 0)).toBeGreaterThan(raiseFreq(eq, 0));
    expect(solve(0.8).heroEv[0].raise).toBeGreaterThan(solve().heroEv[0].raise);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Live wiring: the read has to survive the trip from `villainLocks` through
// getNodeStrategy's facing-a-bet gates on all three streets.
// ─────────────────────────────────────────────────────────────────────────────

function vsBetState(street: 'flop' | 'turn' | 'river', heroCards: string, boardStr: string): GameState {
  const villainIn = 12;
  return {
    handNumber: 1,
    buttonIndex: 0,
    board: board(boardStr),
    street,
    currentBet: villainIn,
    lastRaiseSize: villainIn,
    toAct: 0,
    lastAggressor: 1,
    bigBlind: 2,
    seed: 12345,
    log: [],
    players: [
      { id: 0, name: 'You', isHero: true, profileId: 'gto', holeCards: board(heroCards), stack: 200, committed: 0, totalCommitted: 12, folded: false, allIn: false },
      { id: 1, name: 'V', isHero: false, profileId: 'gto', holeCards: [], stack: 200 - villainIn, committed: villainIn, totalCommitted: 12 + villainIn, folded: false, allIn: false },
    ],
  } as unknown as GameState;
}

const lockedModels = (foldToBet: number): VillainModels => ({
  1: resolveVillainModel(undefined, null, { enabled: true, foldToBet }),
});
const raiseFreqOf = (s: ReturnType<typeof getNodeStrategy>) =>
  s.options.filter((o) => o.id.startsWith('bet') || o.id === 'raise' || o.id === 'allin').reduce((a, o) => a + o.freq, 0);

// A read solves the node TWICE (locked + balanced baseline), and the flop's equity matrix
// enumerates both remaining streets — ~1.2s per read on this machine, so these cases need
// more than the 5s default once the suite runs them alongside everything else.
const READ_SOLVE_TIMEOUT = 60_000;

describe('live wiring: a fold read reaches the facing-a-bet gates', () => {
  const BOARDS = { flop: 'Kh 8d 3c', turn: 'Kh 8d 3c 7s', river: 'Kh 8d 3c 7s 2h' } as const;

  for (const street of ['flop', 'turn', 'river'] as const) {
    it(`${street}: the note says the node is locked, and only when a read exists`, () => {
      const st = vsBetState(street, '6s 5s', BOARDS[street]);
      expect(getNodeStrategy(st, 0, undefined, undefined, lockedModels(0.8)).note).toContain('NODE LOCKED');
      const unread = getNodeStrategy(st, 0).note;
      expect(unread).toContain('facing a bet');
      expect(unread).not.toContain('NODE LOCKED');
    }, READ_SOLVE_TIMEOUT);

    it(`${street}: hero attacks an over-folder more than a station`, () => {
      const st = vsBetState(street, '6s 5s', BOARDS[street]);
      const over = getNodeStrategy(st, 0, undefined, undefined, lockedModels(0.85));
      const station = getNodeStrategy(st, 0, undefined, undefined, lockedModels(0.05));
      console.log(`${street} 65s raise: over-folder=${(raiseFreqOf(over) * 100).toFixed(0)}%  station=${(raiseFreqOf(station) * 100).toFixed(0)}%`);
      expect(raiseFreqOf(over)).toBeGreaterThanOrEqual(raiseFreqOf(station));
    }, READ_SOLVE_TIMEOUT);
  }

  it('an exploit delta is attached when the read changes the best line', () => {
    // Scan the streets for a spot where the locked and balanced solves disagree; the delta
    // is what the whole lock is for, so at least one street must produce one.
    const withDelta = (['river', 'turn', 'flop'] as const)
      .map((street) => getNodeStrategy(vsBetState(street, '6s 5s', BOARDS[street]), 0, undefined, undefined, lockedModels(0.9)))
      .filter((s) => s.exploit);
    for (const s of withDelta) {
      expect(s.exploit!.gainBb).toBeGreaterThan(0);
      expect(s.exploit!.source).toBe('locked');
      console.log(`delta: ${s.exploit!.baselineId} → ${s.exploit!.exploitId} +${s.exploit!.gainBb}bb`);
    }
    expect(withDelta.length).toBeGreaterThan(0);
  }, READ_SOLVE_TIMEOUT);
});
