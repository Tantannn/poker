import { describe, it, expect } from 'vitest';
import { parseCard } from '../engine/cards';
import { decideBlocker, countCombos, gradeScenario, SCENARIOS } from './BlockerDrill';

const cards = (...cs: string[]) => cs.map(parseCard);

describe('countCombos — honest blocker removal', () => {
  it('counts full two-pair AK, then removes the combos the board blocks', () => {
    // No dead cards: AK = 4 suited + 12 offsuit = 16 combos.
    expect(countCombos(['AKs', 'AKo'], [])).toBe(16);
    // On an A-K board (As, Kd), two pair AK = 3 aces × 3 kings = 9.
    const board = cards('As', 'Kd', '7h', '3c', '2s');
    expect(countCombos(['AKs', 'AKo'], board)).toBe(9);
    // Now hold the Ah too: only 2 aces remain → 2 × 3 = 6. Your card blocked 3.
    expect(countCombos(['AKs', 'AKo'], [...board, parseCard('Ah')])).toBe(6);
  });

  it('counts a set from the remaining cards of a rank on the board', () => {
    // KK with one king on the board = C(3,2) = 3 combos.
    expect(countCombos(['KK'], cards('Ks', '7h', '2c'))).toBe(3);
    // A blank pocket pair, no cards dead = C(4,2) = 6.
    expect(countCombos(['77'], cards('Ks', 'Qh', '2c'))).toBe(6);
  });
});

describe('decideBlocker — verdict is computed from the cards, never hardcoded', () => {
  // (a) A made hand that blocks value is still a CALL, not a raise: raising would
  //     fold out the bluffs it already beats. Same board / range / price.
  it('a made hand that blocks value CALLS — showdown value is not a bluff-raise', () => {
    const board = cards('Ah', 'Kd', '7s', '4c', '2h');
    const value = ['AKs', 'AKo', 'AA', 'KK', '77'];
    const bluff = ['QJs', 'QJo', 'JTs', 'JTo', 'T9s', 'T9o'];
    const madeBlocker = decideBlocker({ hero: cards('Kc', '5s'), board, value, bluff, pot: 26, bet: 20 });
    const noBlocker = decideBlocker({ hero: cards('6c', '5s'), board, value, bluff, pot: 26, bet: 20 });

    expect(noBlocker.action).toBe('call'); // holding no blocker → pure bluff-catch
    // the king strips his value, but it ALSO made second pair that beats his
    // busted bluffs — so it's a bluff-catch, never a bluff-raise.
    expect(madeBlocker.action).toBe('call');
    expect(madeBlocker.rationale).toBe('showdown-value-call');
    expect(madeBlocker.heroBeatsBluffRate).toBeGreaterThanOrEqual(0.5);
    expect(madeBlocker.valueBlockRate).toBeGreaterThan(noBlocker.valueBlockRate);
  });

  // The genuine bluff-raise: blocks his value AND has no showdown value (jack-high
  // loses even to his overcard bluffs), so raising to fold him out is the only win.
  it('air that blocks value with no showdown value IS a bluff-raise', () => {
    const board = cards('9h', '8d', '7c', '3s', '2h');
    const value = ['JTs', 'JTo', '65s', '65o', '99'];
    const bluff = ['AKs', 'AKo', 'AQs', 'AQo', 'KQs', 'KQo'];
    const v = decideBlocker({ hero: cards('Jc', '5d'), board, value, bluff, pot: 24, bet: 18 });

    expect(v.action).toBe('bluff-raise');
    expect(v.rationale).toBe('block-value-raise');
    expect(v.heroBeatsBluffRate).toBeLessThan(0.5); // jack-high beats none of his overcards
    expect(v.valueBlockRate).toBeGreaterThanOrEqual(0.18);
  });

  // Blocking BLUFFS flips a call into a fold — same board / range / price.
  it('blocking villain bluffs flips a call into a fold', () => {
    const board = cards('Kh', 'Qd', '8s', '5c', '2h');
    const value = ['AKs', 'AKo', 'KQs', 'KQo', 'KTs', 'KTo', 'KK', 'QQ', '88', 'K8s', 'K8o'];
    const bluff = ['JTs', 'JTo', 'J9s', 'J9o', 'J7s', 'J7o'];
    const noBlock = decideBlocker({ hero: cards('3c', '3d'), board, value, bluff, pot: 20, bet: 20 });
    const blockBluffs = decideBlocker({ hero: cards('Jc', 'Jd'), board, value, bluff, pot: 20, bet: 20 });

    expect(noBlock.action).toBe('call');
    expect(blockBluffs.action).toBe('fold');
    // The jacks removed a chunk of his bluffs, dropping his bluff% under the price.
    expect(blockBluffs.bluffAfter).toBeLessThan(blockBluffs.bluffBefore);
    expect(blockBluffs.bluffFracBefore).toBeGreaterThanOrEqual(blockBluffs.need);
    expect(blockBluffs.bluffFracAfter).toBeLessThan(blockBluffs.need);
  });

  // (b) Pot-odds math picks FOLD when the bluffs are simply too few for the price.
  it('folds on a value-heavy overbet where the bluffs cannot pay the price', () => {
    const v = gradeScenario(SCENARIOS.find((s) => s.id === 'bad-price-overbet')!);
    expect(v.action).toBe('fold');
    expect(v.rationale).toBe('price-fold');
    expect(v.bluffBlockRate).toBe(0); // it's the price, not a blocker, driving the fold
    expect(v.bluffFracAfter).toBeLessThan(v.need);
  });

  // A clean bluff-catcher at a tiny price must call: bluff% comfortably beats need.
  it('calls a small bet as a clean bluff-catcher', () => {
    const v = gradeScenario(SCENARIOS.find((s) => s.id === 'good-price')!);
    expect(v.action).toBe('call');
    expect(v.bluffFracAfter).toBeGreaterThanOrEqual(v.need);
  });
});

describe('authored scenarios all grade to their intended line', () => {
  const expected: Record<string, string> = {
    'block-value-raise': 'bluff-raise', // air blocks his value, no showdown value
    'straight-block': 'call', // pair of 8s beats his air → bluff-catch trap
    'king-block': 'call', // second pair beats his bluffs → bluff-catch trap
    'topset-block': 'call', // pair of jacks beats his draws → bluff-catch trap
    'block-bluffs': 'fold',
    'bad-price-overbet': 'fold',
    'bad-price-2': 'fold',
    'good-price': 'call',
    'medium-price': 'call',
    'ace-catch': 'call',
  };

  it('covers call / fold / bluff-raise', () => {
    const actions = new Set(SCENARIOS.map((s) => gradeScenario(s).action));
    expect(actions).toEqual(new Set(['call', 'fold', 'bluff-raise']));
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(8);
  });

  for (const s of SCENARIOS) {
    it(`${s.id} → ${expected[s.id]}`, () => {
      // hero cards never collide with the board (guards typos in the data).
      const board = new Set(s.boardCards);
      for (const h of s.heroCards) expect(board.has(h)).toBe(false);
      expect(gradeScenario(s).action).toBe(expected[s.id]);
    });
  }
});
