// A limped pot is the modal live low-stakes pot, and it is the one preflop role the RFI
// charts cannot express. These pin the SHAPE (wide, weak-tailed, capped) and the direction
// of each role, not exact percentages.

import { describe, it, expect } from 'vitest';
import { createGame, startHand, applyAction } from '../engine/table';
import type { GameState } from '../engine/table';
import { roleBaseRange } from './index';
import { LIMP_RANGE, BB_OPTION_RANGE, RFI_RANGES, THREEBET_RANGE, preflopStrength } from '../ai/preflop';
import { rangeMultForRole } from './preflopModel';
import type { PreflopRead } from './preflopModel';

function limpedPot(): GameState {
  let s = startHand(createGame(6, 100, 2, ['tag', 'tag', 'tag', 'tag', 'tag'], false));
  // Everyone left to act preflop just calls the blind; the blinds then check/complete.
  while (s.street === 'preflop') {
    const next = s.toAct;
    if (next < 0) break;
    const before = s.players[next].committed;
    s = applyAction(s, before < s.currentBet ? { type: 'call' } : { type: 'check' });
  }
  return s;
}

const weakTail = (set: Set<string>) => [...set].filter((c) => preflopStrength(c) < 0.5).length;

describe('open-limp range', () => {
  it('is wider and weaker-tailed than any opening range', () => {
    expect(LIMP_RANGE.size).toBeGreaterThan(RFI_RANGES.BTN.size);
    expect(weakTail(LIMP_RANGE)).toBeGreaterThan(weakTail(RFI_RANGES.BTN));
  });

  it('is capped at the top — a binary set must not hand a limper the premiums', () => {
    for (const code of ['AA', 'KK', 'QQ', 'AKs', 'AKo']) expect(LIMP_RANGE.has(code)).toBe(false);
  });

  it('BB checking its option is wider still — it never chose a range', () => {
    expect(BB_OPTION_RANGE.size).toBeGreaterThan(LIMP_RANGE.size);
    expect(BB_OPTION_RANGE.has('72o')).toBe(true);
    expect(BB_OPTION_RANGE.has('AA')).toBe(false);
  });
});

describe('roleBaseRange in a limped pot', () => {
  it('gives limpers the limp range, not a tightened opening range', () => {
    const s = limpedPot();
    const limpers = s.players.filter(
      (p) => !p.folded && s.log.some((l) => l.handNumber === s.handNumber && l.playerId === p.id && l.type === 'call'),
    );
    expect(limpers.length).toBeGreaterThan(0);
    for (const p of limpers) {
      const { baseSet, note } = roleBaseRange(s, p.id);
      expect(note).toContain('limp');
      // The old code routed these through the cold-call branch and produced an
      // OPENING-derived range: too tight, too strong, in the pot type hero sees most.
      const opener = RFI_RANGES.BTN;
      expect(baseSet.size).toBeGreaterThan(opener.size * 0.9);
      expect(weakTail(baseSet)).toBeGreaterThan(weakTail(opener));
      expect([...THREEBET_RANGE].every((c) => !baseSet.has(c) || c === 'A5s' || c === 'A4s' || c === 'KQs')).toBe(true);
    }
  });

  it('never mislabels a limped pot as a call of an open', () => {
    const s = limpedPot();
    for (const p of s.players.filter((x) => !x.folded)) {
      expect(roleBaseRange(s, p.id).note).not.toContain('flat-call range vs');
    }
  });
});

describe('read resizing', () => {
  it('leaves the limp range unresized — a limper\'s RFI% is low by construction', () => {
    const read: PreflopRead = {
      source: 'observed',
      openFreq: 0.05,
      threeBetFreq: 0.03,
      foldToThreeBet: 0.6,
      confidence: 0.9,
      label: 'limps everything',
    };
    expect(rangeMultForRole('limp', read)).toBe(1);
    // The same read tightens a genuine opener — that is the behaviour being kept out.
    expect(rangeMultForRole('open', read)).toBeLessThan(1);
  });
});
