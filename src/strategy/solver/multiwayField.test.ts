import { describe, it, expect } from 'vitest';
import { solveRiver3way, solveTurn3way } from './multiwaySolver';
import type { Combo } from './riverSolver';
import { getNodeStrategy } from '../index';
import { MAX_MULTIWAY_OPPONENTS } from '../index';
import { parseCard, type Card } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);
const w1 = (s: string): Combo => ({ cards: C(s), w: 1 });

const BOARD = board('Kh 8d 3c 7s 2h');
const HERO: Combo[] = [
  w1('Ks Kd'), // top set — pure value
  w1('Qs Jd'), // air — the bluff
  w1('9h 9d'), // bluff-catcher: beats most of the field, loses to any two pair
];
const VILLAIN: Combo[] = [w1('Kc Qd'), w1('Ah Th'), w1('Js Td'), w1('4d 4h')];
// Each field range holds exactly one hand that beats hero's bluff-catcher, so an extra
// player in the pot genuinely lowers his chance of scooping.
const FIELD_A: Combo[] = [w1('Ac Qh'), w1('Jc Tc'), w1('8h 7h'), w1('5s 4s')];
const FIELD_B: Combo[] = [w1('Ad Jh'), w1('8c 3d'), w1('6s 5h'), w1('Tc 9s')];

const AIR = 1;
const NUTS = 0;
const CATCHER = 2;
const betFreq = (row: { action: string; freq: number }[]) =>
  row.filter((a) => a.action.startsWith('bet:')).reduce((s, a) => s + a.freq, 0);

const solve = (field: Combo[][], reads?: (number | undefined)[]) =>
  solveRiver3way({
    heroRange: HERO,
    villainRange: VILLAIN,
    fieldRanges: field,
    board: BOARD,
    pot: 30,
    effStack: 300,
    betSizes: [0.5, 0.75, 1.0],
    iterations: 1200,
    fieldFoldToBet: reads,
  });

describe('the fixed field scales past one opponent', () => {
  it('every extra player to get through cuts hero bluffing', () => {
    const threeWay = betFreq(solve([FIELD_A]).heroStrategy[AIR]);
    const fourWay = betFreq(solve([FIELD_A, FIELD_B]).heroStrategy[AIR]);
    console.log(`air bluffs: 3-way=${(threeWay * 100).toFixed(0)}%  4-way=${(fourWay * 100).toFixed(0)}%`);
    expect(fourWay).toBeLessThanOrEqual(threeWay + 1e-9);
  });

  it('a 4-way checkdown is worth less than a 3-way one — the scoop needs one more win', () => {
    const three = solve([FIELD_A]).heroActionEv[CATCHER][0];
    const four = solve([FIELD_A, FIELD_B]).heroActionEv[CATCHER][0];
    expect(four).toBeLessThan(three);
  });

  it('value still bets 4-way — a bigger field pays a made hand more, not less', () => {
    const r = solve([FIELD_A, FIELD_B]);
    expect(betFreq(r.heroStrategy[NUTS])).toBeGreaterThan(0.5);
    expect(Math.max(...r.heroActionEv[NUTS].slice(1))).toBeGreaterThan(r.heroActionEv[NUTS][0]);
  });

  it('5-way solves and stays a valid mix', () => {
    const r = solve([FIELD_A, FIELD_B, [w1('As 2c'), w1('Qc Tc'), w1('6d 6h')]]);
    for (const row of r.heroStrategy) {
      const total = row.reduce((s, a) => s + a.freq, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
    }
  });

  it('reads are applied per fixed player, not pooled', () => {
    const bothSticky = solve([FIELD_A, FIELD_B], [0.05, 0.05]);
    const bothFolding = solve([FIELD_A, FIELD_B], [0.9, 0.9]);
    const mixed = solve([FIELD_A, FIELD_B], [0.9, 0.05]);
    const air = (r: ReturnType<typeof solve>) => betFreq(r.heroStrategy[AIR]);
    console.log(`air bluffs 4-way: sticky=${(air(bothSticky) * 100).toFixed(0)}%  mixed=${(air(mixed) * 100).toFixed(0)}%  folding=${(air(bothFolding) * 100).toFixed(0)}%`);
    expect(air(bothFolding)).toBeGreaterThan(air(bothSticky));
    // one station in the field is enough to kill a bluff that must clear everyone
    expect(air(mixed)).toBeLessThan(air(bothFolding) + 1e-9);
  });

  it('an unread field is untouched by the read plumbing (3-way regression)', () => {
    const a = solve([FIELD_A]);
    const b = solve([FIELD_A], [undefined]);
    expect(a.heroStrategy[AIR]).toEqual(b.heroStrategy[AIR]);
  });

  it('the turn path takes a 2-player field too', () => {
    const r = solveTurn3way({
      heroRange: HERO,
      villainRange: VILLAIN,
      fieldRanges: [FIELD_A, FIELD_B],
      board: board('Kh 8d 3c 7s'),
      pot: 30,
      effStack: 300,
      betSizes: [0.5, 0.75, 1.0],
      iterations: 300,
      riverNestIterations: 40,
    });
    for (const row of r.heroStrategy) {
      const total = row.reduce((s, a) => s + a.freq, 0);
      expect(total).toBeGreaterThan(0.95);
      expect(total).toBeLessThan(1.05);
    }
  });
});

describe('live wiring: 4-way and 5-way hero-first nodes reach the multiway solver', () => {
  function multiwayState(liveOpps: number, street: 'turn' | 'river'): GameState {
    const seats = liveOpps + 1;
    return {
      handNumber: 1,
      buttonIndex: 0,
      board: board(street === 'river' ? 'Kh 8d 3c 7s 2h' : 'Kh 8d 3c 7s'),
      street,
      currentBet: 0,
      lastRaiseSize: 2,
      toAct: 0,
      lastAggressor: -1,
      bigBlind: 2,
      seed: 7,
      log: [],
      players: Array.from({ length: seats }, (_, i) => ({
        id: i,
        name: i === 0 ? 'You' : `V${i}`,
        isHero: i === 0,
        profileId: 'gto',
        holeCards: i === 0 ? board('Ks Kd') : [],
        stack: 200,
        committed: 0,
        totalCommitted: 8,
        folded: false,
        allIn: false,
      })),
    } as unknown as GameState;
  }

  it('a 4-way river node says 4-way and names the two fixed opponents', () => {
    const s = getNodeStrategy(multiwayState(3, 'river'), 0);
    expect(s.note).toContain('4-way river solver');
    expect(s.note).toContain('2 opponents each follow');
  });

  // Derived from the constant, not hardcoded: the ceiling is a measured cost decision that
  // has moved once already, and the claim being pinned is "the ceiling solves", not its value.
  it('a node at the ceiling solves', () => {
    const s = getNodeStrategy(multiwayState(MAX_MULTIWAY_OPPONENTS, 'river'), 0);
    expect(s.note).toContain(`${MAX_MULTIWAY_OPPONENTS + 1}-way river solver`);
  });

  it('past the ceiling it falls back to the per-hand model instead of stalling', () => {
    const s = getNodeStrategy(multiwayState(MAX_MULTIWAY_OPPONENTS + 1, 'river'), 0);
    expect(s.note).not.toContain('way river solver');
    expect(s.options.length).toBeGreaterThan(1);
  });

  it('a 4-way turn node routes to the multiway turn solver', () => {
    const s = getNodeStrategy(multiwayState(3, 'turn'), 0);
    expect(s.note).toContain('4-way turn solver');
  }, 60_000);
});
