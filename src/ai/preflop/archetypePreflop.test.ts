// Archetypes used to be preflop clones: every profile opened the seat chart (nit 14.5% vs
// maniac 16.3% UTG), never limped above Easy, isolated limpers to 2.5bb, and folded ~90%
// of every opening range to a 3-bet — so a 3-bet with any two cards printed vs every bot.
// Facing an open they 3-bet ~3% regardless of archetype and flatted half the deck
// (BB defended ~97%) off a compressed strength threshold.

import { describe, it, expect } from 'vitest';
import { createGame, startHand, type ActionRecord, type GameState } from '@/engine/table';

import type { Card } from '@/engine/cards';

import { decideAction, DIFFICULTIES, PROFILES } from '@/ai/decide';



import { RFI_RANGES, handCombos } from './preflop';
import { entryPercentile, rfiOpenFreq, vs3BetContinueShare } from './blueprint';

const R = 'AKQJT98765432';
const CODES: string[] = [];
for (let a = 0; a < 13; a++)
  for (let b = a; b < 13; b++) {
    if (a === b) CODES.push(R[a] + R[a]);
    else CODES.push(R[a] + R[b] + 's', R[a] + R[b] + 'o');
  }

const PREMIUM = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo']);

function openShare(chart: Set<string>, looseness: number): number {
  return CODES.reduce((n, c) => n + handCombos(c) * rfiOpenFreq(chart, c, looseness), 0) / 1326;
}

function foldTo3Bet(chart: Set<string>, id: string, ip: boolean): number {
  const p = PROFILES[id];
  const share = vs3BetContinueShare(p, ip);
  let entered = 0;
  let continued = 0;
  for (const c of CODES) {
    const w = handCombos(c) * rfiOpenFreq(chart, c, p.openLooseness);
    const pct = entryPercentile(chart, c, p.openLooseness);
    entered += w;
    continued += w * (PREMIUM.has(c) ? 1 : Math.max(0, Math.min(1, 0.5 + (share - pct) / 0.08)));
  }
  return 1 - continued / entered;
}

describe('archetype preflop widths', () => {
  it('opens a measurably different range per archetype', () => {
    const utg = (id: string) => openShare(RFI_RANGES.UTG, PROFILES[id].openLooseness);
    expect(utg('nit')).toBeLessThan(0.13);
    expect(utg('maniac')).toBeGreaterThan(0.25);
    const btn = ['nit', 'tag', 'lag', 'maniac'].map((id) => openShare(RFI_RANGES.BTN, PROFILES[id].openLooseness));
    for (let k = 1; k < btn.length; k++) expect(btn[k]).toBeGreaterThan(btn[k - 1]);
  });

  it('a looseness-0.5 archetype plays the chart', () => {
    const chart = RFI_RANGES.CO;
    const chartShare = [...chart].reduce((n, c) => n + handCombos(c), 0) / 1326;
    expect(Math.abs(openShare(chart, 0.5) - chartShare)).toBeLessThan(0.03);
  });

  it('folds to 3-bets at live-plausible rates, stations and maniacs least', () => {
    for (const id of Object.keys(PROFILES))
      for (const ip of [false, true]) {
        const f = foldTo3Bet(RFI_RANGES.BTN, id, ip);
        expect(f).toBeGreaterThan(0.25);
        expect(f).toBeLessThan(0.7); // a 3-bet to ~4x needs ~70% folds to profit with any two
      }
    expect(foldTo3Bet(RFI_RANGES.BTN, 'lp', false)).toBeLessThan(foldTo3Bet(RFI_RANGES.BTN, 'nit', false));
    expect(foldTo3Bet(RFI_RANGES.BTN, 'maniac', false)).toBeLessThan(foldTo3Bet(RFI_RANGES.BTN, 'tag', false));
  });
});

const card = (rank: number, suit: number): Card => ({ rank, suit }) as Card;
const K9s = [card(13, 0), card(9, 0)];
const AQo = [card(14, 0), card(12, 1)];

/** 6-max, bot in seat 3 on the BUTTON, `limpers` seats (0, 1, …) limped in front. */
function buttonNode(seed: number, profileId: string, hole: Card[], limpers: number): GameState {
  let s = createGame(6, 100, 2, ['tag', 'tag', 'tag', 'tag', 'tag']);
  s = startHand(s);
  s.handNumber = 1;
  s.seed = seed;
  s.street = 'preflop';
  s.buttonIndex = 3;
  s.toAct = 3;
  s.currentBet = 2;
  s.lastRaiseSize = 2;
  s.lastAggressor = -1;
  s.log = [];
  s.players.forEach((q) => Object.assign(q, { committed: 0, totalCommitted: 0, folded: false, allIn: false, hasActed: false, stack: 200 }));
  Object.assign(s.players[4], { committed: 1, totalCommitted: 1 });
  Object.assign(s.players[5], { committed: 2, totalCommitted: 2 });
  for (let k = 0; k < limpers; k++) {
    Object.assign(s.players[k], { committed: 2, totalCommitted: 2, hasActed: true });
    const rec: ActionRecord = {
      handNumber: 1, playerId: s.players[k].id, playerName: 'v', position: 'UTG', type: 'call', amount: 2, street: 'preflop', potAfter: 5 + 2 * k,
    };
    s.log.push(rec);
  }
  s.players[2].folded = true;
  Object.assign(s.players[3], { profileId, holeCards: hole });
  return s;
}

describe('limping and isolation', () => {
  it('a calling station open-limps most of its non-premium hands', () => {
    let limps = 0;
    let entered = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const a = decideAction(buttonNode(seed, 'lp', K9s, 0), { diff: DIFFICULTIES.extreme });
      if (a.type === 'fold') continue;
      entered++;
      if (a.type === 'call') limps++;
    }
    expect(entered).toBeGreaterThan(100);
    expect(limps / entered).toBeGreaterThan(0.5);
  });

  it('a TAG never open-limps', () => {
    for (let seed = 1; seed <= 100; seed++)
      expect(decideAction(buttonNode(seed, 'tag', K9s, 0), { diff: DIFFICULTIES.extreme }).type).not.toBe('call');
  });

  it('isolates two limpers with ~3bb + 1bb per limper, not a 2.5bb open', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const a = decideAction(buttonNode(seed, 'tag', AQo, 2), { diff: DIFFICULTIES.extreme });
      expect(a.type).toBe('raise');
      if (a.type === 'raise') expect(a.amount).toBeGreaterThanOrEqual(10); // ≥5bb at bb=2
    }
  });
});

const RV = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const holeOf = (c: string): Card[] => [card(RV[R.indexOf(c[0])], 0), card(RV[R.indexOf(c[1])], c[2] === 's' ? 0 : 1)];

/** CO (seat 0, button 1) opens 2.5x; the bot defends from the BB (seat 3). */
function bbVsCoOpen(seed: number, profileId: string, hole: Card[]): GameState {
  let s = createGame(6, 100, 2, ['tag', 'tag', 'tag', 'tag', 'tag']);
  s = startHand(s);
  Object.assign(s, { handNumber: 1, seed, street: 'preflop', buttonIndex: 1, currentBet: 5, lastRaiseSize: 3, lastAggressor: 0, toAct: 3 });
  s.players.forEach((q) => Object.assign(q, { committed: 0, totalCommitted: 0, folded: false, allIn: false, hasActed: false, stack: 200 }));
  Object.assign(s.players[2], { committed: 1, totalCommitted: 1 });
  Object.assign(s.players[3], { committed: 2, totalCommitted: 2, profileId, holeCards: hole });
  Object.assign(s.players[0], { committed: 5, totalCommitted: 5, hasActed: true });
  s.log = [{ handNumber: 1, playerId: s.players[0].id, playerName: 'h', position: 'CO', type: 'raise', amount: 5, street: 'preflop', potAfter: 8 }];
  return s;
}

function defendRates(profileId: string): { threeBet: number; call: number } {
  let threeBet = 0;
  let call = 0;
  const seeds = 3;
  for (const c of CODES)
    for (let seed = 1; seed <= seeds; seed++) {
      const w = handCombos(c) / 1326 / seeds;
      const a = decideAction(bbVsCoOpen(seed, profileId, holeOf(c)), { diff: DIFFICULTIES.extreme });
      if (a.type === 'raise') threeBet += w;
      else if (a.type === 'call') call += w;
    }
  return { threeBet, call };
}

describe('facing an open', () => {
  it('3-bets and defends the BB at live-plausible, archetype-ordered rates', () => {
    const nit = defendRates('nit');
    const tag = defendRates('tag');
    const maniac = defendRates('maniac');
    const lp = defendRates('lp');
    expect(tag.threeBet).toBeGreaterThan(0.05);
    expect(tag.threeBet).toBeLessThan(0.1);
    expect(tag.threeBet + tag.call).toBeGreaterThan(0.35);
    expect(tag.threeBet + tag.call).toBeLessThan(0.65); // was ~97%
    expect(maniac.threeBet).toBeGreaterThan(tag.threeBet * 1.5);
    expect(nit.threeBet).toBeLessThan(tag.threeBet);
    expect(lp.threeBet).toBeLessThan(0.03);
    expect(lp.call).toBeGreaterThan(tag.call);
  }, 60000);
});
