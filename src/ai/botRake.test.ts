// The bots play the trainer's preflop rake shade (strategy/preflopRake.ts): under rake a
// flat or limp of a marginal hand is taxed in full, a raise only on its called branch, a
// fold never — so marginal hands go raise-or-fold at the table too. Premiums are exempt.

import { describe, it, expect } from 'vitest';
import { createGame, startHand, type Action, type GameState } from '../engine/table';
import type { RakeProfileId } from '../engine/rake';
import type { Card } from '../engine/cards';
import { decideAction } from './decide';
import { DIFFICULTIES } from './difficulty';
import { handCombos } from './preflop';

const R = 'AKQJT98765432';
const RV = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const CODES: string[] = [];
for (let a = 0; a < 13; a++)
  for (let b = a; b < 13; b++) {
    if (a === b) CODES.push(R[a] + R[a]);
    else CODES.push(R[a] + R[b] + 's', R[a] + R[b] + 'o');
  }
const card = (rank: number, suit: number): Card => ({ rank, suit }) as Card;
const holeOf = (c: string): Card[] => [card(RV[R.indexOf(c[0])], 0), card(RV[R.indexOf(c[1])], c[2] === 's' ? 0 : 1)];

function blank(seed: number): GameState {
  let s = createGame(6, 100, 2, ['tag', 'tag', 'tag', 'tag', 'tag']);
  s = startHand(s);
  s.players.forEach((q) => Object.assign(q, { committed: 0, totalCommitted: 0, folded: false, allIn: false, hasActed: false, stack: 200 }));
  Object.assign(s, { handNumber: 1, seed, street: 'preflop', log: [] });
  return s;
}

/** Folded to the bot on the BUTTON (seat 3). */
function buttonUnopened(seed: number, profileId: string, code: string, rake: RakeProfileId): GameState {
  const s = blank(seed);
  Object.assign(s, { buttonIndex: 3, toAct: 3, currentBet: 2, lastRaiseSize: 2, lastAggressor: -1, rake });
  s.players[0].folded = s.players[1].folded = s.players[2].folded = true;
  Object.assign(s.players[4], { committed: 1, totalCommitted: 1 });
  Object.assign(s.players[5], { committed: 2, totalCommitted: 2 });
  Object.assign(s.players[3], { profileId, holeCards: holeOf(code) });
  return s;
}

/** CO (seat 0) opens 2.5x; the bot defends from the BB (seat 3). */
function bbVsCoOpen(seed: number, profileId: string, code: string, rake: RakeProfileId): GameState {
  const s = blank(seed);
  Object.assign(s, { buttonIndex: 1, currentBet: 5, lastRaiseSize: 3, lastAggressor: 0, toAct: 3, rake });
  Object.assign(s.players[2], { committed: 1, totalCommitted: 1 });
  Object.assign(s.players[3], { committed: 2, totalCommitted: 2, profileId, holeCards: holeOf(code) });
  Object.assign(s.players[0], { committed: 5, totalCommitted: 5, hasActed: true });
  s.log = [{ handNumber: 1, playerId: s.players[0].id, playerName: 'h', position: 'CO', type: 'raise', amount: 5, street: 'preflop', potAfter: 8 }];
  return s;
}

type Node = (seed: number, profileId: string, code: string, rake: RakeProfileId) => GameState;
const SEEDS = 4;

function rates(node: Node, profileId: string, rake: RakeProfileId, codes = CODES) {
  const out = { raise: 0, call: 0, fold: 0 };
  const total = codes.reduce((n, c) => n + handCombos(c), 0) * SEEDS;
  for (const c of codes)
    for (let seed = 1; seed <= SEEDS; seed++) {
      const a = decideAction(node(seed, profileId, c, rake), { diff: DIFFICULTIES.extreme });
      const k = a.type === 'raise' ? 'raise' : a.type === 'call' ? 'call' : 'fold';
      out[k] += handCombos(c) / total;
    }
  return out;
}

const act = (node: Node, profileId: string, code: string, rake: RakeProfileId, seed: number): Action =>
  decideAction(node(seed, profileId, code, rake), { diff: DIFFICULTIES.extreme });

describe('bots shade their preflop for rake', () => {
  it("rake 'none' plays exactly like an unset rake", () => {
    for (const node of [buttonUnopened, bbVsCoOpen])
      for (const id of ['tag', 'lp', 'maniac'])
        for (const c of CODES.filter((_, k) => k % 7 === 0))
          for (let seed = 1; seed <= 3; seed++) {
            const unset = node(seed, id, c, 'none');
            delete (unset as Partial<GameState>).rake;
            expect(act(node, id, c, 'none', seed)).toEqual(decideAction(unset, { diff: DIFFICULTIES.extreme }));
          }
  });

  it('live 1-2 rake cuts open-limps harder than open-raises (raise-or-fold)', () => {
    const free = rates(buttonUnopened, 'lp', 'none');
    const raked = rates(buttonUnopened, 'lp', 'live-1-2');
    expect(raked.call).toBeLessThan(free.call * 0.9);
    expect(raked.raise / free.raise).toBeGreaterThan(raked.call / free.call);
    expect(raked.fold).toBeGreaterThan(free.fold);
  }, 30000);

  it('live 1-2 rake cuts BB flats vs an open, and the slack mostly folds', () => {
    for (const id of ['tag', 'lp']) {
      const free = rates(bbVsCoOpen, id, 'none');
      const raked = rates(bbVsCoOpen, id, 'live-1-2');
      // the shade bites marginal flats; a TAG's tight BB defence has few of them left
      expect(raked.call).toBeLessThan(free.call * (id === 'lp' ? 0.95 : 0.995));
      expect(raked.fold - free.fold).toBeGreaterThan((free.call - raked.call) * 0.5);
    }
  }, 60000);

  it('premiums play identically under rake', () => {
    for (const node of [buttonUnopened, bbVsCoOpen])
      for (const id of ['tag', 'lp', 'nit', 'maniac'])
        for (const c of ['AA', 'KK', 'QQ', 'AKs', 'AKo'])
          for (let seed = 1; seed <= 20; seed++)
            expect(act(node, id, c, 'live-1-2', seed)).toEqual(act(node, id, c, 'none', seed));
  });
});
