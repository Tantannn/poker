import { describe, it, expect } from 'vitest';
import { solveRiverVsBet, type Combo } from './riverSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);

describe('river solver — facing a bet (fold / call / raise)', () => {
  const b = board('Ah Kd Qc 7s 2h');
  // villain BETTING range: value-heavy (trip kings ×2) + a few bluffs (air ×1)
  const villain: Combo[] = [
    { cards: C('Kh Kc'), w: 2 }, // trip kings — value
    { cards: C('5c 6c'), w: 1 }, // air — bluff
  ];
  const solve = (hero: Combo[]) =>
    solveRiverVsBet({ heroRange: hero, villainRange: villain, board: b, potBeforeBet: 30, bet: 20, raiseTo: 70, iterations: 3000 });

  it('the nuts never fold and take a raising line for value', () => {
    const r = solve([{ cards: C('As Ac'), w: 1 }]).heroStrategy[0];
    console.log(`nuts: fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.fold).toBeLessThan(0.02); // never fold the nuts
    expect(r.raise).toBeGreaterThan(0.3); // value-raise a meaningful share
  });

  it('air folds most of the time vs a value-heavy bettor', () => {
    const r = solve([{ cards: C('3c 4d'), w: 1 }]).heroStrategy[0];
    console.log(`air:  fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.fold).toBeGreaterThan(0.5); // mostly give up
  });

  it('a bluff-catcher prefers calling over raising', () => {
    const r = solve([{ cards: C('Jd Jh'), w: 1 }]).heroStrategy[0];
    console.log(`bc:   fold=${(r.fold * 100).toFixed(0)}% call=${(r.call * 100).toFixed(0)}% raise=${(r.raise * 100).toFixed(0)}%`);
    expect(r.raise).toBeLessThan(0.2); // don't raise a bluff-catcher for value
    expect(r.call).toBeGreaterThan(r.raise);
  });
});
