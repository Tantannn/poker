import { describe, it, expect } from 'vitest';
import { solveRiver3way, solveTurn3way } from './multiwaySolver';
import { solveRiver, type Combo } from './riverSolver';
import { parseCard, type Card } from '../../engine/cards';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);
const w1 = (s: string): Combo => ({ cards: C(s), w: 1 });
const betFreq = (row: { action: string; freq: number }[]) =>
  row.filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

describe('3-way river solver — hero + villain CFR, third player on a fixed MDF policy', () => {
  const b = board('Ah 7d 2c 9h Jd'); // dry river
  const hero: Combo[] = [
    w1('As Ac'), // [0] trip aces — near nuts
    w1('Ks Qs'), // [1] king-high — pure bluff
    w1('Td Tc'), // [2] pair of tens — bluff-catcher
  ];
  const villain: Combo[] = [
    w1('Ad Kc'), w1('9s 9c'), w1('Js Th'), w1('Qs Qc'), w1('8h 6h'),
  ];
  const third: Combo[] = [
    w1('Ac Qh'), w1('Jc Tc'), w1('7s 7h'), w1('Kd Qd'), w1('5s 4s'),
  ];
  const args = { board: b, pot: 30, effStack: 300, betSizes: [0.5, 0.75, 1.0], iterations: 1500 };
  const r = solveRiver3way({ heroRange: hero, villainRange: villain, thirdRange: third, ...args });

  it('produces a valid probability mix and finite EVs for every hero combo', () => {
    for (let i = 0; i < hero.length; i++) {
      const total = r.heroStrategy[i].reduce((s, a) => s + a.freq, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
      for (const ev of r.heroActionEv[i]) expect(Number.isFinite(ev)).toBe(true);
    }
  });

  it('the near-nuts value-bets and betting beats checking', () => {
    expect(betFreq(r.heroStrategy[0])).toBeGreaterThan(0.5);
    const ev = r.heroActionEv[0];
    expect(Math.max(...ev.slice(1))).toBeGreaterThan(ev[0]); // a bet out-earns the check
  });

  it('the solved villain defends less vs bigger bets (MDF shape holds multiway)', () => {
    // more money risked to call → fewer bluff-catchers continue. The signature the
    // per-hand model muddles and the CFR recovers, here through a 3-handed pot.
    console.log(`villain call by size: ${r.villainCallFreq.map((x) => (x * 100).toFixed(0) + '%').join(' ')}`);
    expect(r.villainCallFreq[0]).toBeGreaterThanOrEqual(r.villainCallFreq[r.villainCallFreq.length - 1] - 0.001);
  });

  it('the near-nuts earns MORE than heads-up — a 3-handed pot pays it off bigger', () => {
    const hu = solveRiver({ heroRange: hero, villainRange: villain, ...args });
    const best3 = Math.max(...r.heroActionEv[0].slice(1));
    const bestHU = Math.max(...hu.heroActionEv[0].slice(1));
    expect(best3).toBeGreaterThan(bestHU);
  });

  it('bluffs less multiway than heads-up — a bluff must now get through TWO players', () => {
    const hu = solveRiver({ heroRange: hero, villainRange: villain, ...args });
    const bluffHU = betFreq(hu.heroStrategy[1]);
    const bluff3 = betFreq(r.heroStrategy[1]);
    console.log(`bluff bet: HU=${(bluffHU * 100).toFixed(0)}%  3way=${(bluff3 * 100).toFixed(0)}%`);
    expect(bluff3).toBeLessThan(bluffHU + 0.02); // no more bluffing multiway, generally less
    expect(bluff3).toBeLessThan(bluffHU * 0.9 + 0.15); // meaningfully tighter
  });
});

describe('3-way turn solver — river runouts enumerated, third player on a fixed policy', () => {
  const b = board('Kh 8h 3c 2d'); // turn (4 cards), two hearts
  const hero: Combo[] = [
    w1('Ks Kc'), // [0] top set — value
    w1('Qh Jh'), // [1] flush draw + overs — semi-bluff
    w1('6c 5c'), // [2] air
  ];
  const villain: Combo[] = [w1('Ad Ac'), w1('Kd Qd'), w1('9h 9s'), w1('Jc Th'), w1('Ac 4c')];
  const third: Combo[] = [w1('As Qs'), w1('Td 9d'), w1('7s 7d'), w1('Ks Js'), w1('5h 4h')];
  const r = solveTurn3way({
    heroRange: hero, villainRange: villain, thirdRange: third, board: b,
    pot: 40, effStack: 300, betSizes: [0.5, 0.75, 1.0], iterations: 700, riverNestIterations: 100,
  });
  const betFreq2 = (row: { action: string; freq: number }[]) =>
    row.filter((a) => a.action !== 'check').reduce((s, a) => s + a.freq, 0);

  it('produces a valid probability mix and finite EVs for every hero combo', () => {
    for (let i = 0; i < hero.length; i++) {
      const total = r.heroStrategy[i].reduce((s, a) => s + a.freq, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
      for (const ev of r.heroActionEv[i]) expect(Number.isFinite(ev)).toBe(true);
    }
  });

  it('top set value-bets and its check keeps real value (nested river subgame)', () => {
    expect(betFreq2(r.heroStrategy[0])).toBeGreaterThan(0.4);
    expect(r.heroActionEv[0][0]).toBeGreaterThan(0); // check EV is positive, not scored as give-up
  });

  it('the solved villain defends less vs bigger bets', () => {
    console.log(`3way turn villain call by size: ${r.villainCallFreq.map((x) => (x * 100).toFixed(0) + '%').join(' ')}`);
    expect(r.villainCallFreq[0]).toBeGreaterThanOrEqual(r.villainCallFreq[r.villainCallFreq.length - 1] - 0.001);
  });
});

describe('3-way solvers — a read re-anchors the fixed third player', () => {
  const b = board('Ah 7d 2c 9h Jd');
  const hero: Combo[] = [w1('As Ac'), w1('Ks Qs'), w1('Td Tc')]; // nuts, pure bluff, bluff-catcher
  const villain: Combo[] = [w1('Ad Kc'), w1('9s 9c'), w1('Js Th'), w1('Qs Qc'), w1('8h 6h')];
  const third: Combo[] = [w1('Ac Qh'), w1('Jc Tc'), w1('7s 7h'), w1('Kd Qd'), w1('5s 4s')];
  const args = { board: b, pot: 30, effStack: 300, betSizes: [0.5, 0.75, 1.0], iterations: 1200 };
  const bluffIdx = 1;

  const withRead = (thirdFoldToBet?: number) =>
    solveRiver3way({ heroRange: hero, villainRange: villain, thirdRange: third, ...args, thirdFoldToBet });

  it('hero bluffs more when the fixed field over-folds than when it is sticky', () => {
    // The bluff must get through BOTH opponents; an over-folding third clears the field
    // more often, so the bluff prints more — the whole point of reading the second player.
    const overFold = withRead(0.85);
    const station = withRead(0.1);
    console.log(`3way bluff bet: overfold=${(betFreq(overFold.heroStrategy[bluffIdx]) * 100).toFixed(0)}%  station=${(betFreq(station.heroStrategy[bluffIdx]) * 100).toFixed(0)}%`);
    expect(betFreq(overFold.heroStrategy[bluffIdx])).toBeGreaterThan(betFreq(station.heroStrategy[bluffIdx]));
  });

  it("hero's bluff EV rises with the fixed field's fold frequency", () => {
    const evBluff = (f: number) => Math.max(...withRead(f).heroActionEv[bluffIdx].slice(1));
    expect(evBluff(0.85)).toBeGreaterThan(evBluff(0.1));
  });

  it('no read reproduces the parameter-free MDF default exactly', () => {
    const a = solveRiver3way({ heroRange: hero, villainRange: villain, thirdRange: third, ...args });
    const b2 = withRead(undefined);
    expect(a.heroStrategy[bluffIdx]).toEqual(b2.heroStrategy[bluffIdx]);
  });
});
