// A MEASURED fold-to-raise at the facing-a-bet node lock. Before this, villain's response to
// hero's raise was always re-derived from his fold-to-BET through pot odds — a model. Once the
// hero has actually watched his bets get raised, that observation should win.
//
// The drift guard is the important test here: two modules hold the same MDF re-pricing
// (riverSolver's lockedContinueVsRaise and villainModel's RAISE_MDF_RATIO), so feeding the
// derived number back in must be a no-op. If it isn't, one of them moved.

import { describe, it, expect } from 'vitest';
import { solveRiverVsBet, lockedContinueVsRaise, type Combo } from './riverSolver';
import { solveTurnVsBet } from './turnSolver';
import { foldToRaiseFromFoldToBet, resolveVillainModel } from '../villainModel';
import { parseCard, type Card } from '../../engine/cards';
import type { ObservedStats } from '../../analysis/observed';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);

const heroRange: Combo[] = [
  { cards: C('7c 6d'), w: 1 }, // air — the bluff-raise candidate
  { cards: C('Ac Kc'), w: 1 }, // two pair
];
const villainRange: Combo[] = [
  { cards: C('Jc Tc'), w: 3 },
  { cards: C('9d 7d'), w: 3 },
  { cards: C('Ad Qd'), w: 1 },
];
const b5 = board('Ah Kd 8c 3s 2h');
const b4 = board('Ah Kd 8c 3s');
const Q = 60;
const bet = 20;
const raiseTo = 100;
const raiseFreq = (r: { heroStrategy: { raise: number }[] }, i: number) => r.heroStrategy[i].raise;

describe('measured fold-to-raise vs the derived one', () => {
  it('feeding back the DERIVED value changes nothing (cross-module drift guard)', () => {
    for (const f2b of [0.3, 0.45, 0.6, 0.8]) {
      for (const r of [60, 100, 200]) {
        const derived = lockedContinueVsRaise(f2b, Q, bet, r);
        const roundTrip = lockedContinueVsRaise(f2b, Q, bet, r, foldToRaiseFromFoldToBet(f2b));
        expect(roundTrip).toBeCloseTo(derived, 6);
      }
    }
  });

  it('a measured over-folder folds more than his fold-to-bet implied', () => {
    const f2b = 0.45;
    const implied = foldToRaiseFromFoldToBet(f2b);
    expect(lockedContinueVsRaise(f2b, Q, bet, raiseTo, implied + 0.25)).toBeLessThan(
      lockedContinueVsRaise(f2b, Q, bet, raiseTo),
    );
  });

  it('still scales across raise sizes — a jam folds him out more than a min-raise', () => {
    const small = lockedContinueVsRaise(0.45, Q, bet, 60, 0.5);
    const big = lockedContinueVsRaise(0.45, Q, bet, 240, 0.5);
    expect(big).toBeLessThan(small);
  });
});

describe('the measured read reaches the solve', () => {
  const solveRiver = (foldToRaise?: number) =>
    solveRiverVsBet({
      heroRange,
      villainRange,
      board: b5,
      potBeforeBet: Q,
      bet,
      raiseSizes: [raiseTo],
      iterations: 2500,
      villainLock: { foldToBet: 0.45, foldToRaise },
    });

  it('a measured give-up-when-raised read raises hero\'s air more than the derivation does', () => {
    const derived = solveRiver();
    const measured = solveRiver(0.75);
    expect(raiseFreq(measured, 0)).toBeGreaterThan(raiseFreq(derived, 0));
    expect(measured.heroEv[0].raise).toBeGreaterThan(derived.heroEv[0].raise);
  });

  it('a measured never-folds read kills the bluff-raise the derivation allowed', () => {
    expect(solveRiver(0.02).heroEv[0].raise).toBeLessThan(solveRiver().heroEv[0].raise);
  });

  it('carries into the equity-driven turn core', () => {
    const solve = (villainFoldToRaise?: number) =>
      solveTurnVsBet({
        heroRange,
        villainRange,
        board: b4,
        potBeforeBet: Q,
        bet,
        raiseSizes: [raiseTo],
        iterations: 1200,
        villainFoldToBet: 0.45,
        villainFoldToRaise,
      });
    expect(solve(0.75).heroEv[0].raise).toBeGreaterThan(solve().heroEv[0].raise);
  });
});

const obs = (o: Partial<ObservedStats>): ObservedStats => ({
  hands: 40,
  vpip: 0.25,
  pfr: 0.2,
  af: 2,
  foldToBet: null,
  betFreq: null,
  facedBetSample: 0,
  betChanceSample: 0,
  riverBetFreq: null,
  riverBetChanceSample: 0,
  turnBetFreq: null,
  barrelThrough: null,
  ledFlopSample: 0,
  turnGiveUp: null,
  turnGiveUpSample: 0,
  foldToRaise: null,
  foldToRaiseSample: 0,
  foldToBetRecent: null,
  foldToBetShift: null,
  betFreqRecent: null,
  betFreqShift: null,
  openFreq: null,
  openSample: 0,
  threeBetFreq: null,
  threeBetSample: 0,
  foldToThreeBet: null,
  foldToThreeBetSample: 0,
  ...o,
});

describe('resolveVillainModel: the raise read', () => {
  it('is null with no sample, so the solver keeps its own derivation', () => {
    expect(resolveVillainModel(undefined, obs({ foldToBet: 0.7, facedBetSample: 30 }), null).foldToRaise).toBeNull();
    expect(resolveVillainModel(undefined, null, null).foldToRaise).toBeNull();
  });

  it('shrinks a thin sample toward what the lock would have derived anyway', () => {
    const thin = resolveVillainModel(undefined, obs({ foldToRaise: 1, foldToRaiseSample: 1 }), null).foldToRaise;
    const solid = resolveVillainModel(undefined, obs({ foldToRaise: 1, foldToRaiseSample: 60 }), null).foldToRaise;
    const prior = foldToRaiseFromFoldToBet(0.45);
    expect(thin as number).toBeGreaterThan(prior);
    expect(thin as number).toBeLessThan(solid as number);
    expect(solid as number).toBeGreaterThan(0.9);
  });

  it('resolves on its OWN sample, independent of the fold-to-bet sample', () => {
    const m = resolveVillainModel(undefined, obs({ foldToRaise: 0.9, foldToRaiseSample: 40 }), null);
    expect(m.foldToRaise as number).toBeGreaterThan(0.7);
    expect(m.confidence).toBe(0); // no fold-to-bet / bet-freq read at all
  });

  it('a lock overrides outright, and an absent lock field stays null', () => {
    expect(resolveVillainModel(undefined, null, { enabled: true, foldToBet: 0.5, foldToRaise: 0.85 }).foldToRaise).toBe(0.85);
    expect(resolveVillainModel(undefined, null, { enabled: true, foldToBet: 0.5 }).foldToRaise).toBeNull();
  });
});
