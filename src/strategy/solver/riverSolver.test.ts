import { describe, it, expect } from 'vitest';
import { solveRiver, type Combo } from './riverSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);

describe('river solver — range vs range CFR', () => {
  // Classic polar toy: hero holds nuts (trip aces) or air; villain holds a pure
  // bluff-catcher (pair of jacks). Known GTO for a POT-sized bet: hero bets the
  // nuts 100%, bluffs air 50% (value:bluff 2:1), villain calls 50% (MDF).
  const heroRange: Combo[] = [
    { cards: C('As Ac'), w: 1 }, // trip aces = nuts
    { cards: C('3c 4d'), w: 1 }, // air
  ];
  const villainRange: Combo[] = [{ cards: C('Jd Jh'), w: 1 }]; // pair of jacks, bluff-catcher
  const b = board('Ah Kd Qc 7s 2h');

  it('converges to the analytic polar equilibrium (pot bet)', () => {
    const r = solveRiver({ heroRange, villainRange, board: b, pot: 30, effStack: 300, betSizes: [1.0], iterations: 3000 });
    const nutsBet = r.heroStrategy[0].find((a) => a.action === 'bet:0')!.freq;
    const airBet = r.heroStrategy[1].find((a) => a.action === 'bet:0')!.freq;
    const call = r.villainCallFreq[0];
    console.log(`nuts bet=${(nutsBet * 100).toFixed(0)}%  air bluff=${(airBet * 100).toFixed(0)}%  villain call=${(call * 100).toFixed(0)}%`);
    expect(nutsBet).toBeGreaterThan(0.9); // value always bets
    expect(airBet).toBeGreaterThan(0.35); // bluffs ~50%
    expect(airBet).toBeLessThan(0.65);
    expect(call).toBeGreaterThan(0.35); // villain defends ~MDF 50%
    expect(call).toBeLessThan(0.65);
  });

  it('unlocks overbets: vs a pure bluff-catcher, the nuts prefer the bigger size', () => {
    // What the per-hand model CANNOT do — with sizes {pot, 2x} the nuts overbet.
    const r = solveRiver({ heroRange, villainRange, board: b, pot: 30, effStack: 300, betSizes: [1.0, 2.0], iterations: 4000 });
    const nuts = r.heroStrategy[0];
    const pot = nuts.find((a) => a.action === 'bet:0')!.freq;
    const over = nuts.find((a) => a.action === 'bet:1')!.freq;
    console.log(`nuts: pot=${(pot * 100).toFixed(0)}%  overbet=${(over * 100).toFixed(0)}%`);
    expect(over).toBeGreaterThan(0.2); // the overbet is a real part of the strategy
  });
});
