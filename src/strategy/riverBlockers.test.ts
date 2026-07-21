import { describe, it, expect } from 'vitest';
import { parseCard } from '../engine/cards';
import { readRiverBlockers } from './riverBlockers';

const cards = (s: string) => s.split(' ').map(parseCard);

describe('readRiverBlockers', () => {
  it('flush board + nut-flush card = blocks value (nut-flush blocker)', () => {
    const v = readRiverBlockers(cards('As 7c'), cards('Ks 9s 2s Ah 4d'), 'aggressive');
    expect(v.read).toBe('blockValue');
    expect(v.why).toMatch(/nut-flush blocker/i);
  });

  it('flush board + a low card of the suit still blocks some flushes', () => {
    const v = readRiverBlockers(cards('6s 7c'), cards('Ks 9s 2s Ah 4d'), 'aggressive');
    expect(v.read).toBe('blockValue');
  });

  it('flush board + no card of the suit: neutral to bluff, blocks bluffs when catching', () => {
    const board = cards('Ks 9s 2s Ah 4d');
    expect(readRiverBlockers(cards('Ah Kd'), board, 'aggressive').read).toBe('neutral');
    expect(readRiverBlockers(cards('Ah Kd'), board, 'call').read).toBe('blockBluffs');
  });

  it('paired board + a card matching the board blocks trips/boats', () => {
    const v = readRiverBlockers(cards('Ks 3d'), cards('Kh Kd 7c 2s 9h'), 'call');
    expect(v.read).toBe('blockValue');
  });

  it('paired board with no match = neutral (no removal help)', () => {
    const v = readRiverBlockers(cards('Ac Qd'), cards('Kh Kd 7c 2s 9h'), 'aggressive');
    expect(v.read).toBe('neutral');
  });

  it('unpaired dry board + top card blocks top-pair value', () => {
    const v = readRiverBlockers(cards('As 5c'), cards('Ah Kd 9c 4s 2h'), 'aggressive');
    expect(v.read).toBe('blockValue');
  });

  it('bluff-catch: big overcards hold his bluff combos = blocks bluffs', () => {
    const v = readRiverBlockers(cards('Ac Kd'), cards('Qh 9d 6c 4s 2h'), 'call');
    expect(v.read).toBe('blockBluffs');
  });

  it('no clear interaction = neutral', () => {
    const v = readRiverBlockers(cards('8s 7c'), cards('Qh 9d 6c 4s 2h'), 'aggressive');
    expect(v.read).toBe('neutral');
  });

  it('pre-river (no 5th card) is always neutral — removal is equity, not blockers', () => {
    const v = readRiverBlockers(cards('As Ks'), cards('Qs 9s 2s Ah'), 'aggressive');
    expect(v.read).toBe('neutral');
  });
});
