import { describe, it, expect } from 'vitest';
import { solveTurnVsBet } from './turnSolver';
import { solveFlopVsBet } from './flopSolver';
import type { Combo } from './riverSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);
const w1 = (s: string): Combo => ({ cards: C(s), w: 1 });

// villain BETTING range: value-heavy (overpair + top pair) with one air bluff.
const VILLAIN: Combo[] = [w1('Ac Ad'), w1('Kd Qs'), w1('Jc Td')];

describe('turn solver — facing a bet (fold / call / raise), equity over river runouts', () => {
  const b = board('Kh 8d 3c 2s');
  const solve = (hero: Combo[]) =>
    solveTurnVsBet({ heroRange: hero, villainRange: VILLAIN, board: b, potBeforeBet: 30, bet: 20, raiseTo: 70, iterations: 2500 });

  it('a set never folds and takes a value-raising line', () => {
    const r = solve([w1('8c 8h')]).heroStrategy[0]; // trip eights
    console.log(`turn set: fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.fold).toBeLessThan(0.05);
    expect(r.raise).toBeGreaterThan(0.2);
  });

  it('air folds most of the time vs a value-heavy bettor', () => {
    const r = solve([w1('6c 5h')]).heroStrategy[0];
    console.log(`turn air: fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.fold).toBeGreaterThan(0.5);
  });

  it('an underpair bluff-catcher prefers calling over raising', () => {
    const r = solve([w1('9d 9s')]).heroStrategy[0];
    console.log(`turn bc:  fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.raise).toBeLessThan(0.25);
    expect(r.call).toBeGreaterThan(r.raise);
  });

  it('every action mix is a valid probability distribution', () => {
    for (const h of ['8c 8h', '6c 5h', '9d 9s']) {
      const r = solve([w1(h)]).heroStrategy[0];
      expect(r.fold + r.call + r.raise).toBeCloseTo(1, 5);
    }
  });
});

describe('flop solver — facing a bet (fold / call / raise), equity over turn+river runouts', () => {
  const b = board('Kh 8d 3c');
  const solve = (hero: Combo[]) =>
    solveFlopVsBet({ heroRange: hero, villainRange: VILLAIN, board: b, potBeforeBet: 30, bet: 20, raiseTo: 70, iterations: 2500 });

  it('a set never folds and raises for value + protection', () => {
    const r = solve([w1('8c 8h')]).heroStrategy[0];
    console.log(`flop set: fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.fold).toBeLessThan(0.05);
    expect(r.raise).toBeGreaterThan(0.2);
  });

  it('air folds a large share vs a value-heavy bettor', () => {
    const r = solve([w1('6c 5h')]).heroStrategy[0];
    console.log(`flop air: fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.fold).toBeGreaterThan(0.4);
  });

  it('every action mix is a valid probability distribution', () => {
    for (const h of ['8c 8h', '6c 5h', '9d 9s']) {
      const r = solve([w1(h)]).heroStrategy[0];
      expect(r.fold + r.call + r.raise).toBeCloseTo(1, 5);
    }
  });
});
