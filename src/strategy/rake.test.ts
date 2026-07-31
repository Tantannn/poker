// Rake DIRECTION tests. The point of raking the EV engines is that the trainer's answer
// changes where a real cardroom changes it: every collected pot is netted, so calls need
// more equity and thin value shrinks — while a big stacks-in pot is barely touched
// (the cap). These pin the direction, not exact numbers.

import { describe, it, expect } from 'vitest';
import { getNodeStrategy } from './index';
import { solvePostflop, type PostflopInput } from './postflopModel';
import { solveRiver, type Combo } from './solver/riverSolver';
import { parseCard } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import { rakeInChips } from '../engine/rake';
import type { GameState } from '../engine/table';
import { BB_DEFEND_RANGE } from '../ai/preflop';

const cards = (s: string) => s.split(' ').map(parseCard);
const combo = (s: string, w = 1): Combo => {
  const [a, b] = cards(s);
  return { cards: [a, b], w };
};
const range = rangeFromSet(BB_DEFEND_RANGE);
const RAKE = rakeInChips('live-1-2', 2)!; // 10%, cap 4 chips, drop 2 chips
const ev = (r: ReturnType<typeof solvePostflop>, id: string) => r.options.find((o) => o.id === id)!.ev;

// Hero facing a ¾-pot river bet with a bluff-catcher — the price is what rake moves.
const facingBet: PostflopInput = {
  hero: cards('Kd Qc'),
  board: cards('Ah 7c 2d 5s 9h'),
  oppRange: range,
  pot: 42,
  toCall: 18,
  heroCommitted: 0,
  currentBet: 18,
  minRaiseTo: 36,
  maxRaiseTo: 200,
  canCheck: false,
  canRaise: true,
  bigBlind: 2,
  iterations: 1200,
  precomputedEquity: 0.34,
};

describe('rake in the per-hand model', () => {
  it('is a no-op when unset — the rake-free path must stay byte-identical', () => {
    const a = solvePostflop(facingBet);
    const b = solvePostflop({ ...facingBet, rake: undefined });
    expect(ev(b, 'call')).toBe(ev(a, 'call'));
  });

  it('makes a call worth less: you win the pot minus the drop', () => {
    const free = ev(solvePostflop(facingBet), 'call');
    const raked = ev(solvePostflop({ ...facingBet, rake: RAKE }), 'call');
    expect(raked).toBeLessThan(free);
  });

  it('raises the equity a call needs — the printed pot-odds line moves with it', () => {
    const raked = solvePostflop({ ...facingBet, rake: RAKE }).options.find((o) => o.id === 'call')!;
    expect(raked.math).toMatch(/after rake/);
  });

  it('shrinks a thin river value bet more than it shrinks the checkdown', () => {
    const thin: PostflopInput = {
      ...facingBet,
      hero: cards('Ac 4d'), // top pair, no kicker: the bet that dies first
      toCall: 0,
      currentBet: 0,
      canCheck: true,
      pot: 24,
      precomputedEquity: 0.62,
    };
    const free = solvePostflop(thin);
    const raked = solvePostflop({ ...thin, rake: RAKE });
    const betDrop = ev(free, 'bet50') - ev(raked, 'bet50');
    const checkDrop = ev(free, 'check') - ev(raked, 'check');
    expect(betDrop).toBeGreaterThan(0);
    expect(betDrop).toBeGreaterThan(checkDrop);
  });

  it('costs a big pot proportionally less than a small one — the cap is regressive', () => {
    const small = { ...facingBet, pot: 12, toCall: 6, currentBet: 6 };
    const big = { ...facingBet, pot: 300, toCall: 150, currentBet: 150, maxRaiseTo: 900 };
    const share = (p: PostflopInput) => {
      const free = ev(solvePostflop(p), 'call');
      const raked = ev(solvePostflop({ ...p, rake: RAKE }), 'call');
      return (free - raked) / Math.abs(free);
    };
    expect(share(small)).toBeGreaterThan(share(big));
  });
});

describe('rake in the river CFR', () => {
  const heroRange = [combo('Ac Kc'), combo('7h 7d'), combo('5c 4c')];
  const villainRange = [combo('Ad Qd'), combo('8s 8h'), combo('Jc Tc')];
  const solve = (rake?: ReturnType<typeof rakeInChips>) =>
    solveRiver({
      heroRange,
      villainRange,
      board: cards('Ah 7c 2d 5s 9h'),
      pot: 40,
      effStack: 100,
      betSizes: [0.5, 1],
      iterations: 400,
      rake,
    });

  it('leaves the rake-free solve untouched', () => {
    expect(solve(undefined).actionEv.check).toBe(solve().actionEv.check);
  });

  it('nets the checkdown pot', () => {
    // check-check is a pure showdown for the pot, so the EV drop is the rake share of it.
    expect(solve(RAKE).actionEv.check).toBeLessThan(solve().actionEv.check);
  });

  it('nets every bet line too — a bet cannot escape the drop by folding villain out', () => {
    const free = solve();
    const raked = solve(RAKE);
    for (const a of free.actions) expect(raked.actionEv[a]).toBeLessThan(free.actionEv[a]);
  });
});

// The wiring test that matters: the profile id lives on GameState, and getNodeStrategy has
// to resolve it and hand it to whichever engine the node routes to. Silent to type-checking.
function riverState(rake: GameState['rake']): GameState {
  return {
    handNumber: 1,
    buttonIndex: 0,
    board: cards('Ah 7c 2d 5s 9h'),
    street: 'river',
    currentBet: 0,
    lastRaiseSize: 2,
    toAct: 0,
    lastAggressor: -1,
    bigBlind: 2,
    seed: 12345,
    log: [],
    rake,
    players: [
      { id: 0, name: 'You', isHero: true, profileId: 'gto', holeCards: cards('Ac Kc'), stack: 200, committed: 0, totalCommitted: 20, folded: false, allIn: false },
      { id: 1, name: 'V', isHero: false, profileId: 'gto', holeCards: [], stack: 200, committed: 0, totalCommitted: 20, folded: false, allIn: false },
    ],
  } as unknown as GameState;
}

describe('rake reaches the engines through GameState', () => {
  it('a raked node quotes lower EV than the same node rake-free', () => {
    const free = getNodeStrategy(riverState('none'), 0);
    const raked = getNodeStrategy(riverState('live-1-2'), 0);
    expect(raked.bestEv).toBeLessThan(free.bestEv);
  });
});
