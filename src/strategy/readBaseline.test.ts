// The read-adjusted node has to stay legible as a DEVIATION: the un-adjusted chart
// mix travels with it, and the stats that moved it are named. Without the baseline
// riding along, the panel can only show a number the player has no way to check.

import { describe, it, expect } from 'vitest';
import { createGame, startHand, applyAction } from '../engine/table';
import type { GameState } from '../engine/table';
import { parseCard } from '../engine/cards';
import { getNodeStrategy } from './index';
import type { VillainModels } from './index';
import { balancedModel } from './villainModel';
import { resolvePreflopRead } from './preflopModel';
import type { ObservedStats } from '../analysis/observed';

const obs = (o: Partial<ObservedStats>) =>
  ({
    hands: 60, vpip: 0.25, pfr: 0.2, af: 2, aggro: 0.5,
    foldToBet: null, facedBetSample: 0, betFreq: null, betChanceSample: 0,
    riverBetFreq: null, riverBetChanceSample: 0, barrelThrough: null, ledFlopSample: 0,
    turnGiveUp: null, turnGiveUpSample: 0, foldToRaise: null, foldToRaiseSample: 0,
    openFreq: null, openSample: 0, threeBetFreq: null, threeBetSample: 0,
    foldToThreeBet: null, foldToThreeBetSample: 0,
    ...o,
  }) as ObservedStats;

/** Hero (seat 0) on the button facing a single open — the first startHand puts the
 *  button on seat 0, so UTG (seat 3) acts first and everyone between folds.
 *  Hero's hand is forced: the read layer tapers to nothing on premiums, so a random
 *  deal would make "the mix moved" a coin flip on which hole cards came out. */
function facingAnOpen(hand = 'A5s'): GameState {
  let s = startHand(createGame(6, 100, 2, ['tag', 'tag', 'tag', 'tag', 'tag'], false));
  while (s.toAct !== 0 && s.street === 'preflop') {
    s = applyAction(s, s.currentBet === s.bigBlind ? { type: 'raise', amount: Math.round(2.5 * s.bigBlind) } : { type: 'fold' });
  }
  const cards = hand === 'A5s' ? ['Ah', '5h'] : ['Kh', 'Jd'];
  return { ...s, players: s.players.map((p) => (p.id === 0 ? { ...p, holeCards: cards.map(parseCard) } : p)) };
}

const wideOpenerModel = (): VillainModels => ({
  3: {
    ...balancedModel(),
    preflop: resolvePreflopRead(
      obs({ openFreq: 0.5, openSample: 200, foldToThreeBet: 0.8, foldToThreeBetSample: 40 }),
    ),
  },
});

describe('read-adjusted preflop nodes carry their own baseline', () => {
  it('a balanced villain produces no baseline and no read detail', () => {
    const s = facingAnOpen();
    const strat = getNodeStrategy(s, 0, 200);
    expect(strat.source).toBe('preflop-chart');
    expect(strat.baseline).toBeUndefined();
    expect(strat.readDetail).toBeUndefined();
    expect(strat.rangeNote).not.toContain('read-adjusted');
  });

  it('an off-balanced villain produces both, and the mixes actually differ', () => {
    const s = facingAnOpen();
    const strat = getNodeStrategy(s, 0, 200, undefined, wideOpenerModel());
    expect(strat.rangeNote).toContain('read-adjusted');
    expect(strat.baseline).toBeDefined();
    expect(strat.readDetail).toBeDefined();

    const base = new Map(strat.baseline!.options.map((o) => [o.id, o.freq]));
    // every row the panel renders has a baseline twin, so the toggle can't drop a line
    for (const o of strat.options) expect(base.has(o.id)).toBe(true);
    expect(strat.options.some((o) => Math.abs(o.freq - (base.get(o.id) ?? 0)) > 0.02)).toBe(true);
    // and both mixes are still probability distributions
    const sum = (opts: { freq: number }[]) => opts.reduce((a, o) => a + o.freq, 0);
    expect(sum(strat.baseline!.options)).toBeGreaterThan(0.98);
    expect(sum(strat.baseline!.options)).toBeLessThan(1.02);
  });

  it('the read detail names the stats and flags which one prices this node', () => {
    const s = facingAnOpen();
    const d = getNodeStrategy(s, 0, 200, undefined, wideOpenerModel()).readDetail!;
    expect(d.source).toBe('observed');
    expect(d.who).toMatch(/\(/); // "Name (POS)"
    expect(d.stats).toHaveLength(3);
    // facing a single open, the opener's RFI and his fold-to-3-bet are what price hero
    const active = d.stats.filter((x) => x.active).map((x) => x.label);
    expect(active).toContain('Opens unopened pots (RFI)');
    expect(active).toContain('Folds his open to a 3-bet');
    expect(d.stats.every((x) => x.spot.length > 20)).toBe(true);
    expect(d.moves.length).toBeGreaterThan(0);
    expect(d.moves.every((m) => Math.abs(m.to - m.from) >= 0.02)).toBe(true);
  });

  it('a thin sample says so — the caution tracks confidence, not the size of the deviation', () => {
    const s = facingAnOpen();
    const thin: VillainModels = {
      3: { ...balancedModel(), preflop: resolvePreflopRead(obs({ openFreq: 0.9, openSample: 2 })) },
    };
    const d = getNodeStrategy(s, 0, 200, undefined, thin).readDetail;
    if (d) expect(d.caution.toLowerCase()).toContain('thin');
  });
});
