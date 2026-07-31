// Villain may RAISE hero's bet in the hero-first tree. Before this, a bet could only be folded
// to or called: every bluff was priced as risk-free, and the solver had no way to express
// bet-FOLD at all.
//
// NOT asserted: that adding the raise lowers a bluff's EV at equilibrium. It doesn't have to —
// a re-solve moves villain's whole strategy, and the strong end of his range migrating from
// CALL to RAISE means hero's bluff gets folded on MORE often, which can pay for the raises.
// The honest comparison holds villain FIXED (a node lock pins his fold frequency), and then the
// direction is exact: air is indifferent-to-worse when a call becomes a raise, while a value
// hand is strictly better off, because a raise from a worse hand pays it more.

import { describe, it, expect } from 'vitest';
import { solveRiver, villainRaiseSizes, type Combo } from './riverSolver';
import { solveTurn } from './turnSolver';
import { solveFlop } from './flopSolver';
import { riverExploitability } from './exploitability';
import { getNodeStrategy } from '../index';
import { parseCard, type Card } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);
const w1 = (s: string): Combo => ({ cards: C(s), w: 1 });

const HERO = [w1('Ks Kc'), w1('Qh Jh'), w1('6c 5c')]; // value / draw / air
const VILL = [w1('Ad Ac'), w1('Ts Tc'), w1('9s 9d'), w1('Ah Qd'), w1('Jc Td'), w1('7s 6s'), w1('5d 4d')];
const SIZES = [0.33, 0.66, 1.0];
const VALUE = 0;
const AIR = 2;
const RIVER = board('Kh 8d 3c 2s 7c');

const bestBet = (ev: number[]) => Math.max(...ev.slice(1));
const river = (villainMayRaise: boolean, foldToBet?: number) =>
  solveRiver({
    heroRange: HERO,
    villainRange: VILL,
    board: RIVER,
    pot: 30,
    effStack: 300,
    betSizes: SIZES,
    iterations: 1200,
    villainMayRaise,
    villainLock: foldToBet == null ? undefined : { foldToBet },
  });

describe('the raise size', () => {
  it('is at least a legal min-raise, and disappears once hero is already all-in', () => {
    const bets = [10, 20, 30];
    villainRaiseSizes(30, 300, bets).forEach((x, i) => expect(x).toBeGreaterThanOrEqual(2 * bets[i]));
    expect(villainRaiseSizes(30, 25, [25])[0]).toBe(25); // nothing behind to raise with
  });
});

describe('river — villain held fixed by a lock, so only the raise branch differs', () => {
  const calls = river(false, 0.6);
  const raises = river(true, 0.6);

  it('splits the same continue range into calls and raises', () => {
    const cont = (r: typeof raises) => (r.villainContinueFreq ?? r.villainCallFreq)[1];
    expect(cont(raises)).toBeCloseTo(cont(calls), 1); // the lock fixes how often he continues
    expect((raises.villainRaiseFreq ?? [0])[1]).toBeGreaterThan(0);
    expect(raises.villainCallFreq[1]).toBeLessThan(calls.villainCallFreq[1]);
  });

  it("does not improve hero's bluff — a call turning into a raise never helps air", () => {
    expect(bestBet(raises.heroActionEv[AIR])).toBeLessThanOrEqual(bestBet(calls.heroActionEv[AIR]) + 1e-6);
  });

  it("improves hero's VALUE hand — a raise from a worse hand pays more than a call", () => {
    expect(bestBet(raises.heroActionEv[VALUE])).toBeGreaterThan(bestBet(calls.heroActionEv[VALUE]));
  });
});

describe('river — the bet-fold decision the old tree could not express', () => {
  const r = river(true);

  it('folds air to the raise far more often than it folds the value hand', () => {
    const resp = r.heroRaiseResponse!;
    for (let s = 0; s < SIZES.length; s++) expect(resp[s][AIR][0]).toBeGreaterThan(resp[s][VALUE][0]);
  });

  it('reports a fold-to-raise frequency per size for the coach to quote', () => {
    const folds = r.heroFoldToRaiseFreq ?? [];
    expect(folds.length).toBe(SIZES.length);
    for (const f of folds) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('keeps continue = call + raise, so a fold read still means what it says', () => {
    const cont = r.villainContinueFreq ?? [];
    r.villainCallFreq.forEach((c, s) => expect(cont[s]).toBeCloseTo(c + (r.villainRaiseFreq ?? [])[s], 6));
  });

  it('leaves the check line untouched — only the bet branches gained a decision', () => {
    expect(r.heroActionEv[AIR][0]).toBeCloseTo(river(false).heroActionEv[AIR][0], 6);
  });

  it('stays near-Nash with the extra decision node — payoffs and signs check out', () => {
    // The harness re-derives every payoff itself, so this is the real audit of the new branch.
    const ex = riverExploitability({
      heroRange: HERO,
      villainRange: VILL,
      board: RIVER,
      pot: 30,
      effStack: 300,
      betSizes: SIZES,
      iterations: 4000,
    });
    expect(ex.heroGap).toBeGreaterThanOrEqual(-1e-6);
    expect(ex.villGap).toBeGreaterThanOrEqual(-1e-6);
    expect(ex.potFrac).toBeLessThan(0.05);
  });
});

describe('the bet-fold plan reaches the hero', () => {
  it('attaches "he raises this ~X% — plan to fold/call" to the bet options', () => {
    const state = {
      handNumber: 1, buttonIndex: 0, board: RIVER, street: 'river', currentBet: 0,
      lastRaiseSize: 2, toAct: 0, lastAggressor: -1, bigBlind: 2, seed: 7, log: [],
      players: [
        { id: 0, name: 'You', isHero: true, profileId: 'gto', holeCards: [...C('6c 5c')], stack: 300, committed: 0, totalCommitted: 15, folded: false, allIn: false },
        { id: 1, name: 'V', isHero: false, profileId: 'gto', holeCards: [], stack: 300, committed: 0, totalCommitted: 15, folded: false, allIn: false },
      ],
    } as unknown as GameState;
    const s = getNodeStrategy(state, 0);
    const notes = s.options.filter((o) => o.kind === 'aggressive').map((o) => o.sizeNote ?? '');
    expect(notes.some((n) => /raises this ~\d+%/.test(n))).toBe(true);
    expect(notes.some((n) => /plan to fold|plan to call|fold\/call mix/.test(n))).toBe(true);
  }, 30000);
});

describe('turn and flop carry the same tree', () => {
  const turn = (villainMayRaise: boolean, foldToBet?: number) =>
    solveTurn({
      heroRange: HERO,
      villainRange: VILL,
      board: board('Kh 8d 3c 2s'),
      pot: 30,
      effStack: 300,
      betSizes: SIZES,
      iterations: 800,
      nestRiverForCheck: false,
      villainMayRaise,
      villainLock: foldToBet == null ? undefined : { foldToBet },
    });
  const flop = (villainMayRaise: boolean) =>
    solveFlop({
      heroRange: HERO,
      villainRange: VILL,
      board: board('Kh 8d 3c'),
      pot: 30,
      effStack: 300,
      betSizes: SIZES,
      iterations: 500,
      nestTurnForCheck: false,
      villainMayRaise,
    });

  it('turn: villain raises, hero answers, and air is never helped by it', () => {
    const r = turn(true, 0.6);
    expect(Math.max(...(r.villainRaiseFreq ?? [0]))).toBeGreaterThan(0);
    expect((r.heroFoldToRaiseFreq ?? []).length).toBe(SIZES.length);
    expect(bestBet(r.heroActionEv[AIR])).toBeLessThanOrEqual(bestBet(turn(false, 0.6).heroActionEv[AIR]) + 1e-6);
  });

  it('flop: villain raises and hero answers', () => {
    // No villain-fixed comparison here: the heads-up FLOP gate deliberately has no node lock
    // (it keeps the per-hand model's exploit path instead), so there is no way to hold villain
    // still — and at equilibrium the bluff's EV may move either way, as the header explains.
    const r = flop(true);
    expect(Math.max(...(r.villainRaiseFreq ?? [0]))).toBeGreaterThan(0);
    expect((r.heroFoldToRaiseFreq ?? []).length).toBe(SIZES.length);
    const resp = r.heroRaiseResponse!;
    expect(resp[1][AIR][0]).toBeGreaterThan(resp[1][VALUE][0]); // air gives up, the set pays
  });
});
