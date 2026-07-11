import { describe, it, expect } from 'vitest';
import { parseCard } from '../engine/cards';
import { classifyHandClass } from './handClass';

const cards = (...ss: string[]) => ss.map(parseCard);

describe('classifyHandClass — made hand + draw = semi-bluff', () => {
  // The reported spot: bottom pair (2♥ pairs 2♣) with the NUT flush draw (A♣) on
  // a monotone board. This must read as a strong semi-bluff, NOT "keep the pot
  // small" — the flush draw drives the bet.
  it('bottom pair + nut flush draw upgrades to a semi-bluff', () => {
    const h = classifyHandClass(cards('Ac', '2h'), cards('9c', 'Tc', '2c', '6d'));
    expect(h.label).toBe('Bottom Pair + Flush Draw');
    expect(h.strength).toBe(3); // was 2 → downstream advised a check
    expect(h.blurb).toContain('SEMI-BLUFF');
    expect(h.blurb).not.toContain('keep the pot small');
  });

  // Control: the SAME pair with NO draw (swap the A♣ for A♦) stays a weak made
  // hand — the fix must not blanket-upgrade every bottom pair.
  it('bottom pair with no draw stays a weak made hand', () => {
    const h = classifyHandClass(cards('Ad', '2h'), cards('9c', 'Tc', '2c', '6d'));
    expect(h.label).toBe('Bottom Pair');
    expect(h.strength).toBe(2);
    expect(h.blurb).toContain('keep the pot small');
  });

  it('middle pair + flush draw is also a semi-bluff', () => {
    // 9d pairs the middle 9c; Qc makes a flush draw on the K-high monotone board.
    const h = classifyHandClass(cards('9d', 'Qc'), cards('Kc', '9c', '4c', '2s'));
    expect(h.label).toBe('Middle Pair + Flush Draw');
    expect(h.strength).toBe(3);
    expect(h.blurb).toContain('SEMI-BLUFF');
    // control: pocket 99 below top on a dry board stays a pot-control hand
    const control = classifyHandClass(cards('9c', '9d'), cards('Ks', '7h', '4d', '2s'));
    expect(control.strength).toBe(2);
  });

  it('a value-strong made hand plus a draw still bets, note appended', () => {
    // top pair top kicker (A) + flush draw
    const h = classifyHandClass(cards('Ac', 'Kc'), cards('Ah', 'Tc', '4c', '2s'));
    expect(h.strength).toBeGreaterThanOrEqual(4);
    expect(h.blurb).toContain('ALSO hold');
  });
});
