// Closed-form audits: games whose equilibrium is known exactly, so the solvers are checked
// against theory rather than against their own past output.
//
// Polar river (nuts + air vs pure bluff-catchers): bluffs : value = B / (P + B), the
// bluff-catcher continues P / (P + B) (MDF). Static K-K-K boards: no runout changes who wins,
// so the turn is an exact two-street game. Pot-sized bets each street: value bets everything,
// turn bluffs = 1.25 × value (villain indifferent across both streets), villain calls ½, and
// the nuts earn P·(1 + ½·(1 + 2·1.5) − ½) = 2.25·P. The flop nests one turn layer, so its
// target is the same 2.25·P (the third street is the disclosed cost bound).

import { describe, it, expect } from 'vitest';
import { solveRiver, type Combo } from './riverSolver';
import { solveTurn } from './turnSolver';
import { solveFlop } from './flopSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);
const combos = (l: string[]): Combo[] => l.map((s) => ({ cards: C(s), w: 1 }));
const betFreq = (row: { action: string; freq: number }[]) =>
  row.filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

describe('river — polar game', () => {
  const B = board('Kh 8d 3c 7s 2h');
  const SETS = combos(['Ks Kd', 'Ks Kc', 'Kd Kc']);
  const AIR = combos(['Qs Jd', 'Qs Jc', 'Qs Jh', 'Qd Js', 'Qd Jc', 'Qd Jh', 'Qc Js', 'Qc Jd', 'Qc Jh']);
  const CATCHERS = combos(['9s 9c', '9s 9d', '9s 9h', '9c 9d', '9c 9h', '9d 9h']);

  it.each([0.5, 1.0, 2.0])('hero bets %f pot: bluff ratio and MDF match theory', (f) => {
    const r = solveRiver({ heroRange: [...SETS, ...AIR], villainRange: CATCHERS, board: B, pot: 100, effStack: 1000, betSizes: [f], iterations: 6000 });
    const bet = r.actions.indexOf('bet:0');
    const bluffWeight = AIR.reduce((s, _, k) => s + r.heroStrategy[3 + k][bet].freq, 0);
    expect(bluffWeight).toBeCloseTo((3 * f) / (1 + f), 0);
    expect(r.villainCallFreq[0]).toBeCloseTo(1 / (1 + f), 1);
  }, 30000);

  it('villain bets ¾ pot when checked to: his bluff ratio and hero\'s MDF match theory', () => {
    // Roles reversed: hero holds only bluff-catchers and checks; villain is polar.
    const r = solveRiver({ heroRange: CATCHERS, villainRange: [...SETS, ...AIR], board: B, pot: 100, effStack: 1000, betSizes: [1.0], iterations: 6000 });
    const stabs = r.villainStabStrategy!;
    const bluffWeight = AIR.reduce((s, _, k) => s + stabs[3 + k][1], 0);
    expect(bluffWeight).toBeCloseTo(3 * (0.75 / 1.75), 1);
    expect(1 - r.heroFoldToStabFreq!).toBeCloseTo(1 / 1.75, 1);
    // hero's catcher wins exactly the pots villain's air checks back: (9 − 1.286) / 12 of 100
    expect(r.heroActionEv[0][0]).toBeCloseTo((100 * (9 - 3 * (0.75 / 1.75))) / 12, 0);
  }, 30000);
});

describe('static multi-street games — the called line carries the later streets', () => {
  const NUTS = combos(['Kc 2d', 'Kc 3d', 'Kc 4d']); // quads on K-K-K: win every runout
  const AIR = combos(['7h 6h', '7d 6d', '7s 6s', '7h 5h', '7d 5d', '6h 5h', '6d 5d', '5s 4s', '5h 4h']);
  const airBet = (rows: { action: string; freq: number }[][]) =>
    AIR.reduce((s, _, k) => s + betFreq(rows[3 + k]), 0) / AIR.length;

  it('turn: the nuts earn the exact two-street value, air bluffs 1.25× value, villain calls ½', () => {
    const r = solveTurn({
      heroRange: [...NUTS, ...AIR], villainRange: combos(['8d 8h', '8d 8s', '8h 8s']),
      board: board('Kh Kd Ks 8c'), pot: 100, effStack: 1000, betSizes: [1.0], iterations: 3000, riverNestIterations: 600,
    });
    expect(betFreq(r.heroStrategy[0])).toBeGreaterThan(0.95);
    expect(Math.abs(r.heroActionEv[0][1] - 225)).toBeLessThan(12);
    expect(Math.abs(airBet(r.heroStrategy) - 1.25 * 3 / 9)).toBeLessThan(0.08);
    expect(r.villainCallFreq[0]).toBeCloseTo(0.5, 1);
  }, 60000);

  it('turn without called-line nesting collapses to one street — the bug this guards', () => {
    const r = solveTurn({
      heroRange: [...NUTS, ...AIR], villainRange: combos(['8d 8h', '8d 8s', '8h 8s']),
      board: board('Kh Kd Ks 8c'), pot: 100, effStack: 1000, betSizes: [1.0], iterations: 2000,
      riverNestIterations: 300, nestRiverForCall: false,
    });
    expect(r.heroActionEv[0][1]).toBeLessThan(180);
  }, 60000);

  it('flop: one nested turn layer on both lines — the nuts reach the two-layer value', () => {
    const r = solveFlop({
      heroRange: [...NUTS, ...AIR], villainRange: combos(['8d 8h', '8d 8s', '8h 8s', '8c 8d', '8c 8h', '8c 8s']),
      board: board('Kh Kd Ks'), pot: 100, effStack: 2000, betSizes: [1.0],
    });
    expect(betFreq(r.heroStrategy[0])).toBeGreaterThan(0.95);
    expect(Math.abs(r.heroActionEv[0][1] - 225)).toBeLessThan(15);
    expect(r.villainCallFreq[0]).toBeCloseTo(0.5, 1);
  }, 60000);
});
