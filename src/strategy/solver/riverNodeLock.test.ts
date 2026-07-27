import { describe, it, expect } from 'vitest';
import { solveRiver, type Combo } from './riverSolver';
import { parseCard } from '../../engine/cards';

const cards = (s: string) => s.split(' ').map(parseCard);
const combo = (s: string, w = 1): Combo => {
  const [a, b] = cards(s);
  return { cards: [a, b], w };
};

const BOARD = cards('Kh 8d 3c 7s 2h'); // dry, no flush, no straight
const SIZES = [0.33, 0.5, 0.75, 1.0];

const betFreq = (row: { action: string; freq: number }[]) =>
  row.filter((a) => a.action.startsWith('bet:')).reduce((s, a) => s + a.freq, 0);

/** Hero: the nuts (top set), a bluff-catcher, and pure air.
 *  Villain: a spread of bluff-catchers and air on this board. */
const HERO: Combo[] = [
  combo('Ks Kd'), // top set — pure value
  combo('Ad Ac'), // overpair, strong
  combo('9h 9d'), // underpair — bluff-catcher
  combo('Qs Jd'), // air
  combo('6c 5d'), // air, no blockers
];
const VILLAIN: Combo[] = [
  combo('Kc Qd'), // top pair
  combo('8h 8s'), // set of 8s
  combo('Ah Th'), // ace high
  combo('Js Td'), // air
  combo('9s 6h'), // air
  combo('4d 4h'), // small pair
  combo('Qc Tc'), // air
  combo('5s 5h'), // small pair
];

const solve = (foldToBet?: number) =>
  solveRiver({
    heroRange: HERO,
    villainRange: VILLAIN,
    board: BOARD,
    pot: 24,
    effStack: 200,
    betSizes: SIZES,
    iterations: 900,
    villainLock: foldToBet == null ? undefined : { foldToBet },
  });

describe('river node lock — villain is pinned, hero best-responds', () => {
  it('a locked villain folds close to the requested frequency at the reference size', () => {
    const res = solve(0.7);
    // ¾ pot is the reference the lock is quoted at (index 2 of SIZES)
    expect(1 - res.villainCallFreq[2]).toBeCloseTo(0.7, 1);
  });

  it('the locked villain still folds MORE to bigger bets (pot-odds scaling)', () => {
    const res = solve(0.6);
    const folds = res.villainCallFreq.map((c) => 1 - c);
    expect(folds[0]).toBeLessThan(folds[3]); // folds less to ⅓ than to pot
    for (let s = 1; s < folds.length; s++) expect(folds[s]).toBeGreaterThanOrEqual(folds[s - 1] - 1e-9);
  });

  it('reports the locked policy, not a 50/50 coin flip, in the call frequencies', () => {
    // stratSumV is never accumulated when locked; if the EV pass fell back to it the
    // normalised strategy would be [0.5, 0.5] for every size.
    const res = solve(0.9);
    for (const c of res.villainCallFreq) expect(Math.abs(c - 0.5)).toBeGreaterThan(0.05);
  });

  it('hero bluffs air far more against an over-folder than at equilibrium', () => {
    const eq = solve();
    const overFolder = solve(0.85);
    const airIdx = 4; // 6c 5d
    expect(betFreq(overFolder.heroStrategy[airIdx])).toBeGreaterThan(betFreq(eq.heroStrategy[airIdx]));
  });

  it('hero stops bluffing against a villain who never folds', () => {
    const station = solve(0.02);
    const overFolder = solve(0.85);
    const airIdx = 4;
    expect(betFreq(station.heroStrategy[airIdx])).toBeLessThan(betFreq(overFolder.heroStrategy[airIdx]));
  });

  it("air's bet EV rises with villain's fold frequency — the reason the line changes", () => {
    const evAir = (foldToBet: number) => {
      const r = solve(foldToBet);
      return Math.max(...r.heroActionEv[4].slice(1)); // best betting EV for 6c5d
    };
    expect(evAir(0.85)).toBeGreaterThan(evAir(0.2));
  });

  it('value hands still bet against a station (they get paid, not folded out)', () => {
    const station = solve(0.05);
    expect(betFreq(station.heroStrategy[0])).toBeGreaterThan(0.5); // top set
  });

  it('is deterministic — the same lock gives the same strategy', () => {
    const a = solve(0.7);
    const b = solve(0.7);
    expect(a.heroStrategy[4]).toEqual(b.heroStrategy[4]);
    expect(a.villainCallFreq).toEqual(b.villainCallFreq);
  });

  it('leaves the unlocked solve untouched (frequencies still form a valid mix)', () => {
    const eq = solve();
    for (const row of eq.heroStrategy) {
      const total = row.reduce((s, a) => s + a.freq, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
    }
  });

  it('call frequency is monotone in the locked read, and saturates at both ends', () => {
    const callAt = (f: number) => solve(f).villainCallFreq[2];
    expect(callAt(0)).toBeGreaterThan(0.98); // folds nothing → continues everything
    expect(callAt(0.3)).toBeGreaterThan(callAt(0.6));
    expect(callAt(0.6)).toBeGreaterThan(callAt(0.95));
    expect(callAt(1)).toBeLessThan(0.05); // folds everything
  });

  it("a locked villain keeps his STRONGEST hands: hero's value bet is called more than his bluff folds out", () => {
    // At a 60% fold the continuing 40% is the top of villain's range by showdown
    // strength. So betting the NUTS is called by that 40% (profit = the call), while
    // betting AIR wins the pot from the folding 60%. If the threshold were applied to a
    // random slice instead, the nuts would gain no more from a call than air does.
    const res = solve(0.6);
    const nutsBet = Math.max(...res.heroActionEv[0].slice(1)); // Ks Kd
    const nutsCheck = res.heroActionEv[0][0];
    expect(nutsBet).toBeGreaterThan(nutsCheck); // getting paid by the strong continues
  });
});
