import { describe, it, expect } from 'vitest';
import { solveTurn } from './turnSolver';
import type { Combo } from './riverSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);

describe('turn solver — range vs range with a river chance layer', () => {
  const b = board('Kh 8d 3c 2s'); // turn (4 cards)
  // HERO has a polar-ish range: value (set), a semi-bluff (flush draw), pure air.
  const hero: Combo[] = [
    { cards: C('Ks Kc'), w: 1 }, // [0] trip kings — value
    { cards: C('Qh Jh'), w: 1 }, // [1] heart flush draw — semi-bluff candidate
    { cards: C('6c 5c'), w: 1 }, // [2] air (weak gutshot)
  ];
  // VILLAIN holds bluff-catchers (overpairs that beat the draws, lose to the set).
  const villain: Combo[] = [
    { cards: C('Ad Ac'), w: 1 },
    { cards: C('Ts Tc'), w: 1 },
  ];
  const r = solveTurn({ heroRange: hero, villainRange: villain, board: b, pot: 30, effStack: 300, betSizes: [0.5, 0.75, 1.0], iterations: 1500 });
  const betFreq = (row: { action: string; freq: number }[]) =>
    row.filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

  it('the set value-bets heavily and villain defends near MDF', () => {
    const f = betFreq(r.heroStrategy[0]);
    console.log(`set KKK bet=${(f * 100).toFixed(0)}%  fd bet=${(betFreq(r.heroStrategy[1]) * 100).toFixed(0)}%  air bet=${(betFreq(r.heroStrategy[2]) * 100).toFixed(0)}%  villain call=${r.villainCallFreq.map((x) => (x * 100).toFixed(0) + '%').join(' ')}`);
    expect(f).toBeGreaterThan(0.5);
    for (const c of r.villainCallFreq) expect(c).toBeGreaterThan(0.3); // defends, not over-folding
  });

  it('air bluffs while the draw mostly checks to realise its equity', () => {
    const air = betFreq(r.heroStrategy[2]);
    const draw = betFreq(r.heroStrategy[1]);
    expect(air).toBeGreaterThan(0.2); // pure air must bet to win (no showdown value)
    // The check now values a real river subgame (nestRiverForCheck), so the flush
    // draw can check-and-realise: it still bets less than pure air, which has no
    // showdown value and must bet to win.
    expect(draw).toBeLessThan(air);
  });
});

describe('turn solver — a CHECK is valued as a river subgame, not an instant showdown', () => {
  // The bug this locks in: scoring a turn check as an immediate showdown (equity ×
  // pot) undervalues checking, so the solver over-bet — and the grader flagged a
  // sound check as a "Wrong" ~1.5bb blunder. Nesting the river subgame on the check
  // line fixes it. Board 2-Q-9-5 rainbow (a dry turn).
  const b = board('2c Qd 9h 5s');
  const hero: Combo[] = [
    { cards: C('Ks Tc'), w: 1 }, // [0] KTo — a bare gutshot to the NUT straight (any J)
    { cards: C('9s 9d'), w: 1 }, // [1] set of nines — pure value
    { cards: C('8h 7h'), w: 1 }, // [2] air
  ];
  const villain: Combo[] = [
    { cards: C('Ah Qs'), w: 1 }, { cards: C('Kc Qh'), w: 1 }, { cards: C('Qc Jc'), w: 1 },
    { cards: C('Jd Th'), w: 1 }, { cards: C('5h 5c'), w: 1 }, { cards: C('2d 2h'), w: 1 },
    { cards: C('Ac 4c'), w: 1 }, { cards: C('Ad Kd'), w: 1 }, { cards: C('Td 8d'), w: 1 },
  ];
  const args = {
    heroRange: hero, villainRange: villain, board: b, pot: 28, effStack: 372,
    betSizes: [0.33, 0.5, 0.75, 1.0], iterations: 1200,
  };
  const flat = solveTurn({ ...args, nestRiverForCheck: false });
  const nested = solveTurn({ ...args, nestRiverForCheck: true, riverNestIterations: 120 });
  const checkEv = (r: typeof flat, i: number) => r.heroActionEv[i][0];
  const gapToBest = (r: typeof flat, i: number) => Math.max(...r.heroActionEv[i]) - r.heroActionEv[i][0];
  const betFreq = (r: typeof flat, i: number) =>
    r.heroStrategy[i].filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

  it('nesting raises the check EV for every combo (river play is worth ≥ giving up)', () => {
    for (let i = 0; i < hero.length; i++) {
      expect(checkEv(nested, i)).toBeGreaterThanOrEqual(checkEv(flat, i) - 0.05);
    }
  });

  it('the gutshot gains real river value from checking (it bets when the J lands)', () => {
    // strictly better than the instant-showdown baseline — the fix, in one number.
    expect(checkEv(nested, 0)).toBeGreaterThan(checkEv(flat, 0) + 0.2);
  });

  it('checking the gutshot is near-indifferent, not a blunder', () => {
    // gap-to-best under 1.5bb (= 3 chips at pot 28 / bb 2) → graded sound, never "Wrong".
    expect(gapToBest(nested, 0)).toBeLessThan(3);
  });

  it('value hands are unaffected — the set still bets big', () => {
    expect(betFreq(nested, 1)).toBeGreaterThan(0.6);
  });
});
