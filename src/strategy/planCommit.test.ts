import { describe, it, expect } from 'vitest';
import { parseCard } from '../engine/cards';
import { isScareCard, heroImproved, policyBets, policyActionId } from './planCommit';

const c = (s: string) => parseCard(s);

describe('planCommit — scare cards', () => {
  const dry = [c('Qs'), c('7d'), c('2c')]; // rainbow, Q-high
  it('flags an overcard', () => expect(isScareCard(c('Ah'), dry)).toBe(true));
  it('flags a board pair', () => expect(isScareCard(c('7h'), dry)).toBe(true));
  it('flags a flush-bringing card', () => expect(isScareCard(c('4s'), [c('Qs'), c('7s'), c('2c')])).toBe(true));
  it('does not flag a low brick', () => expect(isScareCard(c('4d'), dry)).toBe(false));
});

describe('planCommit — hero improvement', () => {
  it('detects a set on the turn', () => {
    const hero = [c('9h'), c('9d')];
    const prev = [c('Qs'), c('7d'), c('2c')]; // 99 = one pair
    const next = [...prev, c('9c')]; // now a set
    expect(heroImproved(hero, prev, next)).toBe(true);
  });
  it('is false on a blank', () => {
    const hero = [c('9h'), c('9d')];
    const prev = [c('Qs'), c('7d'), c('2c')];
    const next = [...prev, c('Kc')];
    expect(heroImproved(hero, prev, next)).toBe(false);
  });
});

describe('planCommit — policy resolution', () => {
  it('barrel always bets, giveup never', () => {
    expect(policyBets('barrel', { scare: false, improved: false })).toBe(true);
    expect(policyBets('giveup', { scare: true, improved: true })).toBe(false);
  });
  it('selective bets only on scare or improve', () => {
    expect(policyBets('selective', { scare: true, improved: false })).toBe(true);
    expect(policyBets('selective', { scare: false, improved: true })).toBe(true);
    expect(policyBets('selective', { scare: false, improved: false })).toBe(false);
  });
  it('maps to concrete action ids', () => {
    expect(policyActionId('barrel', { scare: false, improved: false })).toBe('bet50');
    expect(policyActionId('giveup', { scare: false, improved: false })).toBe('check');
  });
});
