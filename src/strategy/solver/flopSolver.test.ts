import { describe, it, expect } from 'vitest';
import { solveFlop } from './flopSolver';
import type { Combo } from './riverSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);

describe('flop solver — range vs range with two chance layers (turn + river)', () => {
  const b = board('Kh 8h 3c'); // flop (3 cards), two hearts
  // HERO: value (top set), a semi-bluff (flush draw + overcards), pure air.
  const hero: Combo[] = [
    { cards: C('Ks Kc'), w: 1 }, // [0] trip kings — value
    { cards: C('Qh Jh'), w: 1 }, // [1] heart flush draw + two overs — semi-bluff
    { cards: C('6c 5c'), w: 1 }, // [2] air (backdoor only)
  ];
  // VILLAIN: a realistic defend range — some continues (top pair / underpair / draw) and
  // some folds (whiffed overcards), so hero has both value and fold equity.
  const villain: Combo[] = [
    { cards: C('Ad Ac'), w: 1 }, // overpair — bluff-catcher
    { cards: C('Kd Qd'), w: 1 }, // top pair — continues
    { cards: C('9h 9s'), w: 1 }, // underpair — marginal
    { cards: C('Jh Th'), w: 1 }, // flush draw + gutshot — continues
    { cards: C('Ac Qc'), w: 1 }, // ace-high — folds to pressure
    { cards: C('7s 6s'), w: 1 }, // air — folds
    { cards: C('5d 4d'), w: 1 }, // air — folds
  ];
  const r = solveFlop({
    heroRange: hero, villainRange: villain, board: b, pot: 20, effStack: 300,
    betSizes: [0.33, 0.5, 0.75], iterations: 1200,
  });
  const betFreq = (row: { action: string; freq: number }[]) =>
    row.filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

  it('every hero combo produces a valid probability mix and finite EVs', () => {
    for (let i = 0; i < hero.length; i++) {
      const total = r.heroStrategy[i].reduce((s, a) => s + a.freq, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
      for (const ev of r.heroActionEv[i]) expect(Number.isFinite(ev)).toBe(true);
    }
  });

  it('the set value-bets heavily and villain defends, not over-folds', () => {
    const f = betFreq(r.heroStrategy[0]);
    console.log(
      `set KKK bet=${(f * 100).toFixed(0)}%  fd bet=${(betFreq(r.heroStrategy[1]) * 100).toFixed(0)}%  ` +
        `air bet=${(betFreq(r.heroStrategy[2]) * 100).toFixed(0)}%  ` +
        `villain call=${r.villainCallFreq.map((x) => (x * 100).toFixed(0) + '%').join(' ')}`,
    );
    expect(f).toBeGreaterThan(0.5);
    for (const c of r.villainCallFreq) expect(c).toBeGreaterThan(0.25);
  });

  it('draws semi-bluff but low-equity backdoors do not spew (correct flop polarity)', () => {
    // The flush draw bets its equity + fold equity; the backdoor air mostly checks to
    // realise/barrel later instead of dumping chips — the opposite of a river bluff.
    expect(betFreq(r.heroStrategy[1])).toBeGreaterThan(0.3); // draw semi-bluffs
    expect(betFreq(r.heroStrategy[2])).toBeLessThan(0.3); // air does not over-bluff the flop
  });
});

describe('flop solver — a CHECK is valued as a turn subgame, not a static showdown', () => {
  // The over-betting fix, one street earlier than turnSolver's: scoring a flop check as an
  // immediate two-street showdown (equity × pot) undervalues checking and makes the solver
  // over-bet. Nesting a turn subgame on the check line fixes it. Board K-8-3 two hearts.
  const b = board('Kh 8h 3c');
  const hero: Combo[] = [
    { cards: C('Qh Jh'), w: 1 }, // [0] flush draw + overs — most future value from checking
    { cards: C('Ks Kc'), w: 1 }, // [1] trip kings — pure value
    { cards: C('7d 6d'), w: 1 }, // [2] air
  ];
  const villain: Combo[] = [
    { cards: C('Ad Ac'), w: 1 }, { cards: C('Ts Tc'), w: 1 },
    { cards: C('9s 9d'), w: 1 }, { cards: C('Ac Kd'), w: 1 },
  ];
  const args = {
    heroRange: hero, villainRange: villain, board: b, pot: 20, effStack: 300,
    betSizes: [0.33, 0.5, 0.75], iterations: 800,
  };
  const flat = solveFlop({ ...args, nestTurnForCheck: false });
  const nested = solveFlop({ ...args, nestTurnForCheck: true, turnNestIterations: 160 });
  const checkEv = (res: typeof flat, i: number) => res.heroActionEv[i][0];
  const betFreq = (res: typeof flat, i: number) =>
    res.heroStrategy[i].filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

  it('nesting never lowers the check EV — playing the turn beats giving up', () => {
    for (let i = 0; i < hero.length; i++) {
      expect(checkEv(nested, i)).toBeGreaterThanOrEqual(checkEv(flat, i) - 0.05);
    }
  });

  it('the flush draw gains real value from checking (it barrels good turns)', () => {
    expect(checkEv(nested, 0)).toBeGreaterThan(checkEv(flat, 0) + 0.1);
  });

  it('value hands are unaffected — the set still bets', () => {
    expect(betFreq(nested, 1)).toBeGreaterThan(0.5);
  });
});
