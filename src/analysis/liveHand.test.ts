// The live-capture loop only earns its keep if an entered hand is indistinguishable
// from a played one to the grader and the leak finder. These assert that end to end.

import { describe, it, expect } from 'vitest';
import { replayLiveHand, parseActionScript, parseCards } from './liveHand';
import type { LiveHandInput } from './liveHand';
import { emptyStats, recordDecision, findLeaks } from '../store/stats';

const base = (over: Partial<LiveHandInput> = {}): LiveHandInput => ({
  tableSize: 6,
  heroPosition: 'BTN',
  stackBB: 100,
  heroCards: parseCards('Ah Kd'),
  board: [],
  actions: parseActionScript('fold, fold, fold, raise 2.5, fold, fold').actions,
  ...over,
});

describe('entry parsing', () => {
  it('reads cards in any spacing/case', () => {
    expect(parseCards('AhKd').map((c) => c.rank)).toEqual([14, 13]);
    expect(parseCards('ah, kd')).toHaveLength(2);
    expect(parseCards('7c 2d 9s')).toHaveLength(3);
  });

  it('reads an action script with shorthand and sizes', () => {
    const { actions, error } = parseActionScript('f\nx\nc\nraise 7.5');
    expect(error).toBeUndefined();
    expect(actions).toEqual([
      { type: 'fold' }, { type: 'check' }, { type: 'call' }, { type: 'raise', toBB: 7.5 },
    ]);
  });

  it('names the offending action instead of failing silently', () => {
    expect(parseActionScript('call, shove').error).toContain('Action 2');
    expect(parseActionScript('raise').error).toContain('size in bb');
  });
});

describe('replayLiveHand', () => {
  it('grades the hero decisions in an entered hand', () => {
    const r = replayLiveHand(base());
    expect(r.error).toBeUndefined();
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.hand?.decisions?.length).toBe(r.records.length);
    // A real solved node, not a stub: the snapshot carries the option mix and the pot.
    const d = r.hand!.decisions![0];
    expect(d.options.length).toBeGreaterThan(1);
    expect(d.pot).toBeGreaterThan(0);
    expect(d.position).toBe('BTN');
  });

  it('keeps hero cards and the entered board — the engine deals around them', () => {
    const r = replayLiveHand(
      base({
        heroPosition: 'CO',
        board: parseCards('Kc 7h 2d'),
        actions: parseActionScript('fold, fold, raise 2.5, fold, fold, call, check, bet 3, call').actions,
      }),
    );
    expect(r.error).toBeUndefined();
    expect(r.hand!.board.map((c) => c.rank)).toEqual([13, 7, 2]);
    expect(r.hand!.heroCards.map((c) => c.rank)).toEqual([14, 13]);
    expect(r.hand!.decisions!.some((d) => d.street === 'flop')).toBe(true);
  });

  it('rejects an action that is not legal for the seat on turn, with its index', () => {
    const r = replayLiveHand(base({ actions: parseActionScript('check').actions }));
    expect(r.error).toContain('Action 1');
    expect(r.hand).toBeUndefined();
  });

  it('rejects duplicate cards and a board the hand outran', () => {
    expect(replayLiveHand(base({ board: parseCards('Ah 7h 2d') })).error).toContain('twice');
    const short = replayLiveHand(
      base({ board: [], actions: parseActionScript('fold, fold, raise 2.5, fold, fold, call, check').actions }),
    );
    expect(short.error).toContain('board cards');
  });

  it('feeds the existing leak finder — a fold-everything session shows up as a leak', () => {
    let stats = emptyStats();
    for (let i = 0; i < 12; i++) {
      const r = replayLiveHand(base({ heroCards: parseCards('Ah Kd'), actions: parseActionScript('fold, fold, fold, fold, fold, check').actions }));
      expect(r.error).toBeUndefined();
      for (const rec of r.records) stats = recordDecision(stats, rec);
    }
    expect(stats.decisions.length).toBeGreaterThan(0);
    expect(findLeaks(stats).length).toBeGreaterThan(0);
  });

  it('marks the hand as live so review can label it', () => {
    expect(replayLiveHand(base()).hand?.live).toBe(true);
  });
});
