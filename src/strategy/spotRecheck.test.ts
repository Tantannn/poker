// Regression tests for the paired-board bluff-catcher fixes: countOuts must not
// credit board-driven boat outs, texture must read the full board, handClass must
// demote pair+board-pair "two pair", and the model must not rate the BB's OOP
// bluff-catch (99 on AAQT facing a big barrel) as a clearly +EV call.
import { describe, it, expect } from 'vitest';
import { solvePostflop } from './postflopModel';
import { classifyHandClass } from './handClass';
import { parseCard } from '../engine/cards';
import { countOuts } from '../engine/equity';
import { classifyFlop, describeTexture } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import { BB_DEFEND_RANGE } from '../ai/preflop';

const cards = (s: string) => s.split(' ').map(parseCard);
const hero = cards('9d 9s');
const board = cards('Qd Ad Ts Ac');

describe('AAQT / 99 spot recheck', () => {
  it('counts only the two nines as outs (aces are board-driven boat outs)', () => {
    const o = countOuts(hero, board);
    expect(o.outs).toBe(2);
    expect(o.cards.every((c) => c.rank === 9)).toBe(true);
  });

  it('still counts real draws (nut flush draw = 9 outs)', () => {
    const o = countOuts(cards('Ah Kh'), cards('Qh 7h 2c'));
    expect(o.byCategory.find((g) => g.category === 'Flush')?.cards).toHaveLength(9);
  });

  it('keeps trips-up outs when hero holds the pairing rank', () => {
    // AK on AQT: an ace trips HERO's rank — legit out, must not be rejected
    const o = countOuts(cards('As Kd'), cards('Ah Qc Ts'));
    expect(o.cards.some((c) => c.rank === 14)).toBe(true);
  });

  it('classifies the turned board as paired, not connected two-tone', () => {
    const t = classifyFlop(board);
    expect(t.paired).toBe(true);
    expect(describeTexture(board).label).toContain('Paired');
  });

  it('leaves flop classification unchanged (QAT = two-tone connected unpaired)', () => {
    const t = classifyFlop(cards('Qd Ad Ts'));
    expect(t.paired).toBe(false);
    expect(t.connected).toBe(true);
    expect(t.suitPattern).toBe('twotone');
  });

  it('classifies 99 on AAQT as a bluff-catcher, not strong two pair', () => {
    const h = classifyHandClass(hero, board);
    expect(h.label).toContain('Board Pair');
    expect(h.strength).toBe(2);
  });

  it('keeps real two pair strong (AK on AK5 5x is genuine two pair)', () => {
    const h = classifyHandClass(cards('As Kd'), cards('Ah Kc 5s 5d 2h'));
    expect(h.label).toBe('Two Pair');
    expect(h.strength).toBe(4);
  });

  it('rates fold >= call for the drill spot once OOP + no phantom implied odds', () => {
    // Exact drill node: pot 75 (incl. villain 34), call 34, bb 2, deep stacks,
    // hero OOP, HUD equity 32.3%.
    const s = solvePostflop({
      hero,
      board,
      oppRange: rangeFromSet(BB_DEFEND_RANGE),
      pot: 75,
      toCall: 34,
      heroCommitted: 0,
      currentBet: 34,
      minRaiseTo: 68,
      maxRaiseTo: 400,
      canCheck: false,
      canRaise: true,
      bigBlind: 2,
      iterations: 800,
      position: 'oop',
      effStack: 300,
      precomputedEquity: 0.323,
    });
    const ev = (id: string) => s.options.find((o) => o.id === id)?.ev ?? NaN;
    expect(ev('call')).toBeLessThanOrEqual(ev('fold') + 0.05);
  });

  it('does not apply the OOP realisation discount to a RIVER call (closes action)', () => {
    // Villain pot-bets 60 into 60 on the river: need 33.3%, hero has 36% — a
    // profitable bluff-catch. The old code discounted 36% × 0.9 = 32.4% OOP and
    // folded a +EV call.
    const s = solvePostflop({
      hero,
      board: cards('Qd Ad Ts Ac 2h'),
      oppRange: rangeFromSet(BB_DEFEND_RANGE),
      pot: 120,
      toCall: 60,
      heroCommitted: 0,
      currentBet: 60,
      minRaiseTo: 120,
      maxRaiseTo: 400,
      canCheck: false,
      canRaise: true,
      bigBlind: 2,
      iterations: 400,
      position: 'oop',
      effStack: 300,
      precomputedEquity: 0.36,
    });
    const ev = (id: string) => s.options.find((o) => o.id === id)?.ev ?? NaN;
    expect(ev('call')).toBeGreaterThan(ev('fold'));
    expect(ev('call')).toBeCloseTo((0.36 * 180 - 60) / 2, 1);
  });

  it('never labels a board-playing hand (K5 on AAQT) as a value bet', () => {
    const s = solvePostflop({
      hero: cards('Kh 5c'),
      board,
      oppRange: rangeFromSet(BB_DEFEND_RANGE),
      pot: 40,
      toCall: 0,
      heroCommitted: 0,
      currentBet: 0,
      minRaiseTo: 2,
      maxRaiseTo: 400,
      canCheck: true,
      canRaise: true,
      bigBlind: 2,
      iterations: 800,
    });
    const bets = s.options.filter((o) => o.id.startsWith('bet') || o.id === 'allin');
    expect(bets.length).toBeGreaterThan(0);
    expect(bets.every((o) => o.kind === 'bluff')).toBe(true);
  });
});
