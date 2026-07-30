import { describe, it, expect } from 'vitest';
import { raiseSizeGrid } from './betSizeGrid';
import { solveRiverVsBet, locked3BetPolicy, type Combo } from './riverSolver';
import { getNodeStrategy } from '../index';
import { parseCard, type Card } from '../../engine/cards';
import type { GameState } from '../../engine/table';

const C = (s: string): [Card, Card] => {
  const [a, b] = s.split(' ').map(parseCard);
  return [a, b];
};
const board = (s: string) => s.split(' ').map(parseCard);
const w = (s: string, weight = 1): Combo => ({ cards: C(s), w: weight });

describe('raiseSizeGrid', () => {
  const Q = 60;
  const bet = 20;
  const MIN = 40; // currentBet + lastRaiseSize
  const MAX = 400;

  it('offers two raise sizes plus the jam, ascending and distinct', () => {
    const g = raiseSizeGrid(Q, bet, MIN, MAX);
    expect(g.ids).toEqual(['raise', 'raisebig', 'allin']);
    expect(g.raiseTo).toEqual([...g.raiseTo].sort((a, b) => a - b));
    expect(new Set(g.raiseTo).size).toBe(g.raiseTo.length);
  });

  it('sizes the raise off the pot hero would play after calling (Q + 2b)', () => {
    // The same arithmetic Controls.tsx uses for its ½-pot / pot buttons facing a bet
    // (`currentBet + frac × (pot + callAmount)`), so the recommendation is one tap.
    const g = raiseSizeGrid(Q, bet, MIN, MAX);
    const potAfterCall = Q + 2 * bet;
    expect(g.raiseTo[0]).toBe(bet + 0.5 * potAfterCall);
    expect(g.raiseTo[1]).toBe(bet + 1.0 * potAfterCall);
  });

  it('every size is legal, and only the jam reaches the stack', () => {
    const g = raiseSizeGrid(Q, bet, MIN, MAX);
    for (const r of g.raiseTo) {
      expect(r).toBeGreaterThanOrEqual(MIN);
      expect(r).toBeLessThanOrEqual(MAX);
    }
    expect(g.raiseTo.filter((r) => r === MAX)).toHaveLength(1);
  });

  it('the jam has no re-raise, the others do', () => {
    const g = raiseSizeGrid(Q, bet, MIN, MAX);
    const jam = g.ids.indexOf('allin');
    expect(g.threeBetTo[jam]).toBe(g.raiseTo[jam]); // nothing left to re-raise with
    for (let k = 0; k < g.raiseTo.length; k++) {
      if (k === jam) continue;
      expect(g.threeBetTo[k]).toBeGreaterThan(g.raiseTo[k]);
      expect(g.threeBetTo[k]).toBeLessThanOrEqual(MAX); // a re-raise past hero's stack is unreachable
    }
  });

  it('a short stack collapses to a single all-in raise', () => {
    const g = raiseSizeGrid(Q, bet, MIN, 45); // 45 behind: both sized raises are jams
    expect(g.ids).toEqual(['allin']);
    expect(g.raiseTo).toEqual([45]);
    expect(g.threeBetTo).toEqual([45]);
  });

  it('returns nothing when there is no legal raise', () => {
    expect(raiseSizeGrid(Q, bet, MIN, bet).raiseTo).toHaveLength(0);
  });
});

describe('locked3BetPolicy', () => {
  const weights = [1, 1, 1, 1];
  const strength = [4, 3, 2, 1]; // strongest first

  it('splits a locked villain into fold / call / re-raise that sum to 1', () => {
    for (const row of locked3BetPolicy(weights, strength, 0.6)) {
      expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 9);
      for (const p of row) expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it('his re-raising hands are a SUBSET of his continuing hands', () => {
    const p = locked3BetPolicy(weights, strength, 0.75);
    for (const row of p) expect(row[2]).toBeLessThanOrEqual(row[1] + row[2] + 1e-9);
    // strongest hand carries the re-raise; the weakest carries the fold
    expect(p[0][2]).toBeGreaterThan(p[3][2]);
    expect(p[3][0]).toBeGreaterThan(p[0][0]);
  });

  it('an over-folder re-raises less in absolute terms than a station', () => {
    const share = (cont: number) =>
      locked3BetPolicy(weights, strength, cont).reduce((a, r) => a + r[2], 0);
    expect(share(0.2)).toBeLessThan(share(0.9));
  });
});

describe("villain's re-raise prices hero's raise honestly", () => {
  const b5 = board('Ah Kd 8c 3s 2h');
  const Q = 60;
  const bet = 20;
  const RAISES = [80, 140];
  const THREE_BET = [176, 308];
  // Villain's betting range: mostly busted, one strong hand that can punish a raise.
  const villain: Combo[] = [w('Jc Tc', 3), w('9d 7d', 3), w('Ad Qd', 2)];

  const solve = (hero: Combo[], reRaise: boolean, foldToBet?: number) =>
    solveRiverVsBet({
      heroRange: hero,
      villainRange: villain,
      board: b5,
      potBeforeBet: Q,
      bet,
      raiseSizes: RAISES,
      threeBetTo: reRaise ? THREE_BET : undefined,
      iterations: 2500,
      villainLock: foldToBet != null ? { foldToBet } : undefined,
    });

  it("a bluff-raise is worth LESS once villain can play back — the bias the depth-1 tree hid", () => {
    const air = [w('7c 6d')];
    const flat = solve(air, false);
    const deep = solve(air, true);
    console.log(`air raise EV: no-reraise=${flat.heroEv[0].raise.toFixed(1)}  with-reraise=${deep.heroEv[0].raise.toFixed(1)}`);
    expect(deep.heroEv[0].raise).toBeLessThan(flat.heroEv[0].raise);
    expect(deep.heroStrategy[0].raise).toBeLessThan(flat.heroStrategy[0].raise + 1e-9);
  });

  it('hero folds air to the re-raise and never folds the winner', () => {
    const airFolds = solve([w('7c 6d')], true).heroFoldTo3BetFreq;
    const nutsFolds = solve([w('Ac Kc')], true).heroFoldTo3BetFreq; // two pair beats his range
    console.log(`fold to re-raise: air=${airFolds.map((f) => (f * 100).toFixed(0)).join('/')}%  two pair=${nutsFolds.map((f) => (f * 100).toFixed(0)).join('/')}%`);
    for (let k = 0; k < airFolds.length; k++) expect(airFolds[k]).toBeGreaterThan(nutsFolds[k]);
    expect(Math.max(...nutsFolds)).toBeLessThan(0.2);
  });

  it('villain re-raises a strong range far more than a busted one', () => {
    const hero = [w('7c 6d'), w('Ac Kc')];
    const vs = (v: Combo[]) =>
      solveRiverVsBet({
        heroRange: hero,
        villainRange: v,
        board: b5,
        potBeforeBet: Q,
        bet,
        raiseSizes: RAISES,
        threeBetTo: THREE_BET,
        iterations: 2500,
      }).villain3BetFreq;
    const strong = vs([w('Kh Kc'), w('8h 8s')]); // trips / set — welcomes a war
    const busted = vs([w('Jc Tc'), w('9d 7d')]);
    expect(Math.max(...strong)).toBeGreaterThan(Math.max(...busted));
  });

  it('hero still raises for value with the best hand', () => {
    const r = solve([w('Ac Kc')], true).heroStrategy[0];
    expect(r.fold).toBeLessThan(0.05);
    expect(r.raise).toBeGreaterThan(0.15);
  });

  it('the mix stays a valid distribution across every raise size', () => {
    for (const hero of [[w('7c 6d')], [w('Ac Kc')], [w('9d 9s')]]) {
      const s = solve(hero, true).heroStrategy[0];
      expect(s.fold + s.call + s.raises.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 5);
      expect(s.raises).toHaveLength(RAISES.length);
    }
  });

  it('a locked villain still re-raises, so the read cannot make raising free', () => {
    const locked = solve([w('7c 6d')], true, 0.85);
    expect(Math.max(...locked.villain3BetFreq)).toBeGreaterThan(0);
    // ...and the read is still worth something: raising beats folding vs an over-folder
    expect(locked.heroEv[0].raise).toBeGreaterThan(solve([w('7c 6d')], true, 0.1).heroEv[0].raise);
  });
});

describe('live wiring: the facing-a-bet node offers real, tappable raise sizes', () => {
  function vsBetState(street: 'flop' | 'turn' | 'river', heroCards: string, boardStr: string): GameState {
    return {
      handNumber: 1,
      buttonIndex: 0,
      board: board(boardStr),
      street,
      currentBet: 12,
      lastRaiseSize: 12,
      toAct: 0,
      lastAggressor: 1,
      bigBlind: 2,
      seed: 12345,
      log: [],
      players: [
        { id: 0, name: 'You', isHero: true, profileId: 'gto', holeCards: board(heroCards), stack: 200, committed: 0, totalCommitted: 12, folded: false, allIn: false },
        { id: 1, name: 'V', isHero: false, profileId: 'gto', holeCards: [], stack: 188, committed: 12, totalCommitted: 24, folded: false, allIn: false },
      ],
    } as unknown as GameState;
  }

  it('exposes ½-pot / pot / jam raises with executable amounts', () => {
    // pot 36, villain bet 12 → Q = 24, pot-after-call = 48. ½ → 12 + 24 = 36, pot → 12 + 48 = 60,
    // jam → hero's whole 200. All three are amounts Controls.tsx can set in one tap.
    const s = getNodeStrategy(vsBetState('river', 'As Ac', 'Kh 8d 3c 7s 2h'), 0);
    const amounts = s.options.filter((o) => o.amount != null).map((o) => o.amount);
    expect(amounts).toContain(36);
    expect(amounts).toContain(60);
    expect(amounts).toContain(200);
    expect(s.options.map((o) => o.id)).toContain('raisebig');
    expect(s.note).toContain('re-raise');
  });

  it('the raise sizes carry distinct EVs, so the grader can tell them apart', () => {
    const s = getNodeStrategy(vsBetState('turn', 'As Ac', 'Kh 8d 3c 7s'), 0);
    const raises = s.options.filter((o) => o.amount != null);
    expect(raises.length).toBeGreaterThan(1);
    expect(new Set(raises.map((o) => o.ev)).size).toBeGreaterThan(1);
  });
});
