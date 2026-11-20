import { describe, it, expect } from 'vitest';
import { checkVsStab, solvePostflop, type PostflopInput } from './postflopModel';
import { parseCard } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import { BB_DEFEND_RANGE } from '../ai/preflop';

const cards = (s: string) => s.split(' ').map(parseCard);
const P = 100;

describe('checkVsStab — an OOP check is not a free showdown', () => {
  it('conserves equity: the stab only redistributes it between the two branches', () => {
    for (const e of [0.1, 0.35, 0.5, 0.7, 0.9]) {
      const r = checkVsStab(e, P, true, 1, 0, false);
      expect(r.stabFreq * r.eVsBet + (1 - r.stabFreq) * r.eVsCheck).toBeCloseTo(e, 6);
    }
  });

  it('air realises less than its raw equity — it check-folds to the stab', () => {
    const r = checkVsStab(0.1, P, true, 1, 0, false);
    expect(r.callsStab).toBe(false);
    expect(r.ev).toBeLessThan(0.1 * P);
  });

  it('a bluff-catcher realises less than raw equity on the river (villain bets his value into it)', () => {
    const r = checkVsStab(0.5, P, true, 1, 0, false);
    expect(r.ev).toBeLessThan(0.5 * P);
  });

  it('the nuts realises MORE than the pot — it check-calls his bluffs', () => {
    const r = checkVsStab(1, P, true, 1, 0, false);
    expect(r.callsStab).toBe(true);
    expect(r.ev).toBeGreaterThan(P);
  });

  it('a passive villain stabs less, so air keeps more of its showdown share', () => {
    const agg = checkVsStab(0.25, P, true, 1, 0, false);
    const pas = checkVsStab(0.25, P, true, 1, 0, true);
    expect(pas.stabFreq).toBeLessThan(agg.stabFreq);
    expect(pas.ev).toBeGreaterThan(agg.ev);
  });

  it('a flop draw keeps its outs vs his value bets, so it check-calls where pure air folds', () => {
    const draw = checkVsStab(0.35, P, false, 0.9, 0.35, false);
    const air = checkVsStab(0.35, P, false, 0.9, 0, false);
    expect(draw.eVsBet).toBeGreaterThan(air.eVsBet);
    expect(draw.callsStab).toBe(true);
  });
});

describe('solvePostflop — the check line prices the stab out of position only', () => {
  const base: PostflopInput = {
    hero: cards('3c 4d'),
    board: cards('Ah Kc 9d 8s 2h'),
    oppRange: rangeFromSet(BB_DEFEND_RANGE),
    pot: 20,
    toCall: 0,
    heroCommitted: 0,
    currentBet: 0,
    minRaiseTo: 2,
    maxRaiseTo: 200,
    canCheck: true,
    canRaise: true,
    bigBlind: 2,
    precomputedEquity: 0.2,
  };
  const checkEv = (inp: PostflopInput) => solvePostflop(inp).options.find((o) => o.id === 'check')!.ev;

  it('river IP check-back is the raw showdown; OOP air loses its share to the stab', () => {
    expect(checkEv({ ...base, position: 'ip' })).toBeCloseTo((0.2 * 20) / 2, 6);
    expect(checkEv({ ...base, position: 'oop' })).toBeLessThan((0.2 * 20) / 2);
  });

  it('OOP with the nuts, checking earns more than the pot', () => {
    expect(checkEv({ ...base, position: 'oop', precomputedEquity: 1 })).toBeGreaterThan(20 / 2);
  });
});
