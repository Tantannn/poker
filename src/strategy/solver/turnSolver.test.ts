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

  it('air bluffs while the draw checks to realise its equity (correct for the v1 no-river-betting tree)', () => {
    const air = betFreq(r.heroStrategy[2]);
    const draw = betFreq(r.heroStrategy[1]);
    expect(air).toBeGreaterThan(0.2); // pure air must bet to win (no showdown value)
    // v1 LIMITATION: a check realises full equity here (no river betting to deny),
    // so the draw prefers checking. A nested river subgame (v2) would semi-bluff it more.
    expect(draw).toBeLessThan(air);
  });
});
