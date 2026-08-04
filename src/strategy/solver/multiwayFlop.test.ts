// Multiway FLOP solver — the limped-family-pot street, and the one the per-hand model was
// still handling. What must hold: a bet has to get through every live player, so air stops
// bluffing; a hand that wants to charge a field on a WET board bets; the check line is valued
// as a real turn subgame (else the solve over-bets); and it finishes inside a hero turn.
//
// Deliberately NOT asserted: that a set bets a DRY multiway flop. Checking top set on
// A-7-2 rainbow three-handed is a real line (nobody can call, so betting folds the field out),
// and the solve reports it as near-indifferent — pinning a direction there would encode a
// prior the model does not support.

import { describe, it, expect } from 'vitest';
import { solveFlop3way } from './multiwaySolver';
import { solveFlop } from './flopSolver';
import type { Combo } from './riverSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);
const w1 = (s: string): Combo => ({ cards: C(s), w: 1 });
const betFreq = (row: { action: string; freq: number }[]) =>
  row.filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

const villain: Combo[] = [w1('Ad Kc'), w1('9s 9c'), w1('Js Th'), w1('Qs Qc'), w1('8h 6h')];
const field: Combo[] = [w1('Ac Qh'), w1('Jc Tc'), w1('7s 7h'), w1('Kd Qd'), w1('5s 4s')];
const field2: Combo[] = [w1('Ac Qh'), w1('Jc Tc'), w1('7s 7h'), w1('6d 5d')];
const sizes = [0.33, 0.5, 0.75, 1.0];

describe('3-way flop — dry ace-high board', () => {
  const hero: Combo[] = [
    w1('As Ac'), // [0] top set
    w1('Ks Qs'), // [1] air
    w1('Td Tc'), // [2] underpair
  ];
  const args = { board: board('Ah 7d 2c'), pot: 30, effStack: 300, betSizes: sizes };
  const r = solveFlop3way({
    heroRange: hero,
    villainRange: villain,
    fieldRanges: [field],
    iterations: 400,
    turnNestIterations: 100,
    ...args,
  });

  it('produces a valid mix and finite EVs for every hero combo', () => {
    for (let i = 0; i < hero.length; i++) {
      const total = r.heroStrategy[i].reduce((s, a) => s + a.freq, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
      for (const ev of r.heroActionEv[i]) expect(Number.isFinite(ev)).toBe(true);
    }
  });

  it('ranks the hands right: the set is worth more than the underpair, which beats air', () => {
    const best = (i: number) => Math.max(...r.heroActionEv[i]);
    expect(best(0)).toBeGreaterThan(best(2));
    expect(best(2)).toBeGreaterThan(best(1));
  });

  it('air stabs far less than it does heads-up — a bet must get through two players', () => {
    const hu = solveFlop({ heroRange: hero, villainRange: villain, iterations: 400, turnNestIterations: 100, ...args });
    expect(betFreq(r.heroStrategy[1])).toBeLessThan(betFreq(hu.heroStrategy[1]) - 0.2);
  });

  it('the underpair never bets into two opponents on an ace-high board', () => {
    expect(betFreq(r.heroStrategy[2])).toBeLessThan(0.2);
  });

  it('the solved villain defends less vs bigger bets — MDF shape survives multiway', () => {
    expect(r.villainCallFreq[0]).toBeGreaterThanOrEqual(r.villainCallFreq[r.villainCallFreq.length - 1] - 0.001);
  });
});

describe('3-way flop — wet board, where multiway betting has to happen', () => {
  const hero: Combo[] = [
    w1('9s 9c'), // [0] set on a drawy board — must charge the field
    w1('Ah Kh'), // [1] nut flush draw
    w1('Td Tc'), // [2] overpair
  ];
  const args = { board: board('9h 8h 5c'), pot: 30, effStack: 300, betSizes: sizes };
  const r = solveFlop3way({
    heroRange: hero,
    villainRange: villain,
    fieldRanges: [field],
    iterations: 400,
    turnNestIterations: 100,
    ...args,
  });

  it('the set bets, and betting out-earns checking — denial against a field of draws', () => {
    expect(betFreq(r.heroStrategy[0])).toBeGreaterThan(0.5);
    expect(Math.max(...r.heroActionEv[0].slice(1))).toBeGreaterThan(r.heroActionEv[0][0]);
  });

  it('the overpair bets too — two live opponents on a draw-heavy board have to pay', () => {
    expect(betFreq(r.heroStrategy[2])).toBeGreaterThan(0.5);
  });
});

describe('3-way flop — the check line is a turn subgame, not a static showdown', () => {
  const hero: Combo[] = [w1('Ah Kh'), w1('9s 9c'), w1('7d 6d')];
  const args = {
    heroRange: hero,
    villainRange: villain,
    fieldRanges: [field],
    board: board('9h 8h 5c'),
    pot: 30,
    effStack: 300,
    betSizes: sizes,
    iterations: 400,
  };
  const flat = solveFlop3way({ ...args, nestTurnForCheck: false });
  const nested = solveFlop3way({ ...args, turnNestIterations: 100 });

  it('nesting never lowers the check EV — playing the turn beats giving up', () => {
    for (let i = 0; i < hero.length; i++) {
      expect(nested.heroActionEv[i][0]).toBeGreaterThanOrEqual(flat.heroActionEv[i][0] - 0.05);
    }
  });

  it('the flush draw gains real value from checking (it barrels good turns)', () => {
    expect(nested.heroActionEv[0][0]).toBeGreaterThan(flat.heroActionEv[0][0] + 0.1);
  });

  it('and the bet line carries that later-street value too, so betting is not penalised', () => {
    // Without the called-line correction the nested solve refuses to semi-bluff at all: the
    // check kept a street of value the bet did not. Guard the fix, not a frequency.
    const bestBet = (r: typeof flat, i: number) => Math.max(...r.heroActionEv[i].slice(1));
    expect(bestBet(nested, 0)).toBeGreaterThan(bestBet(flat, 0));
  });
});

describe('4-way to 9-way flop', () => {
  // A realistic three-part range (value / draw / air). A two-combo range makes the CFR game
  // degenerate — villain's response to a range that is half air is nothing like his real one.
  const hero: Combo[] = [w1('9s 9c'), w1('Ah Kh'), w1('Ks Qs')];
  const args = { board: board('9h 8h 5c'), pot: 30, effStack: 300, betSizes: sizes };

  const solve = (F: Combo[][]) =>
    solveFlop3way({ heroRange: hero, villainRange: villain, fieldRanges: F, iterations: 300, turnNestIterations: 80, ...args });

  it('solves 4-way and still bets the set on a wet board', () => {
    const r4 = solve([field, field2]);
    for (const ev of r4.heroActionEv[0]) expect(Number.isFinite(ev)).toBe(true);
    expect(betFreq(r4.heroStrategy[0])).toBeGreaterThan(0.5);
  });

  it('still charges the field 5-way — the spot the per-hand model used to answer', () => {
    const r5 = solve([field, field2, field]);
    expect(betFreq(r5.heroStrategy[0])).toBeGreaterThan(0.5);
    expect(Math.max(...r5.heroActionEv[0].slice(1))).toBeGreaterThan(r5.heroActionEv[0][0]);
  });

  it('air bluffs no more 4-way than 3-way', () => {
    expect(betFreq(solve([field, field2]).heroStrategy[2])).toBeLessThan(betFreq(solve([field]).heroStrategy[2]) + 0.05);
  });

  it('a 5-way flop solve at shipped settings stays inside a hero-turn budget', () => {
    const t0 = performance.now();
    solveFlop3way({
      heroRange: [...hero, w1('Jh Td'), w1('5s 4s')],
      villainRange: villain,
      fieldRanges: [field, field2, field],
      iterations: 600,
      turnNestIterations: 120,
      ...args,
    });
    const ms = performance.now() - t0;
    console.log(`5-way flop solve: ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(6000);
  });

  it('solves 6-way and still charges the field with a set on a wet board', () => {
    const r6 = solve([field, field2, field, field2]);
    for (const ev of r6.heroActionEv[0]) expect(Number.isFinite(ev)).toBe(true);
    expect(betFreq(r6.heroStrategy[0])).toBeGreaterThan(0.5);
  });

  it('air bluffs no more 6-way than 5-way — every extra player kills more fold equity', () => {
    expect(betFreq(solve([field, field2, field, field2]).heroStrategy[2]))
      .toBeLessThan(betFreq(solve([field, field2, field]).heroStrategy[2]) + 0.05);
  });

  // 9-way (8 opponents = 7 fixed field + 1 solved villain) is every pot the app's largest
  // table can deal. It used to fall out of the solver: the field's caller-set enumeration was
  // 2^field, so past 6-way it stopped paying for itself. `fieldCoef` replaced that with the
  // exact O(field²) generating-function collapse, so the field side is now cheap and the same
  // strategic invariants must still hold at full ring: a set charges a wet field, air does not
  // gain fold equity from more players.
  const nineWay = [field, field2, field, field2, field, field2, field]; // 7 fixed field players

  it('solves 9-way and still charges the field with a set on a wet board', () => {
    const r9 = solve(nineWay);
    for (const ev of r9.heroActionEv[0]) expect(Number.isFinite(ev)).toBe(true);
    expect(betFreq(r9.heroStrategy[0])).toBeGreaterThan(0.5);
  });

  it('air bluffs no more 9-way than 6-way — the field only ever kills more fold equity', () => {
    expect(betFreq(solve(nineWay).heroStrategy[2]))
      .toBeLessThan(betFreq(solve([field, field2, field, field2]).heroStrategy[2]) + 0.05);
  });

  it('a 9-way flop solve at shipped settings stays inside a hero-turn budget', () => {
    const t0 = performance.now();
    solveFlop3way({
      heroRange: [...hero, w1('Jh Td'), w1('5s 4s')],
      villainRange: villain,
      fieldRanges: nineWay,
      iterations: 600,
      turnNestIterations: 120,
      ...args,
    });
    const ms = performance.now() - t0;
    console.log(`9-way flop solve: ${ms.toFixed(0)}ms`);
    // Only ~a few extra ThirdAgg builds over 6-way now the enumeration is gone, so the
    // budget barely moves — the nested subgames (cap-bound, floored) dominate.
    expect(ms).toBeLessThan(9000);
  }, 30000);
});
