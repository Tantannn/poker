import { describe, it, expect } from 'vitest';
import { createGame, startHand, type GameState } from '../engine/table';
import { getNodeStrategy } from './index';
import { parseCard } from '../engine/cards';

const cards = (s: string) => s.split(' ').map(parseCard);

// Build a preflop node where seat 0 acts on a chosen hand at a chosen depth.
function node(hole: string, heroStackBB: number): ReturnType<typeof getNodeStrategy> {
  const g: GameState = createGame(6, 100, 2, ['tag', 'tag', 'tag', 'tag', 'tag'], true);
  startHand(g);
  g.toAct = 0;
  g.players[0].folded = false;
  g.players[0].committed = 0;
  g.players[0].holeCards = cards(hole);
  g.players[0].stack = heroStackBB * g.bigBlind;
  return getNodeStrategy(g, 0);
}

describe('push/fold strategy (≤15bb effective)', () => {
  it('routes short stacks to a jam-or-fold node', () => {
    const s = node('As Ac', 10);
    expect(s.scenarioId).toBe('pushfold');
    expect(s.rangeNote).toContain('push/fold');
  });

  it('open-jams a premium and grades the jam as best', () => {
    const s = node('As Ac', 10);
    expect(s.bestId).toBe('open'); // open-jam
    const jam = s.options.find((o) => o.id === 'open');
    expect(jam?.freq).toBe(1);
    expect(jam?.amount).toBeGreaterThan(0); // all-in target
  });

  it('folds trash when short', () => {
    const s = node('7d 2c', 10);
    expect(s.bestId).toBe('fold');
    const jam = s.options.find((o) => o.id === 'open');
    expect(jam?.freq).toBe(0);
  });

  it('widens the jam range as the stack shortens', () => {
    // a middling hand below the 10bb floor can clear the wider 5bb floor
    const at10 = node('Kd 8c', 10).options.find((o) => o.id === 'open')?.freq ?? 0;
    const at5 = node('Kd 8c', 5).options.find((o) => o.id === 'open')?.freq ?? 0;
    expect(at5).toBeGreaterThanOrEqual(at10);
  });

  it('does NOT push/fold at a normal cash depth', () => {
    const s = node('As Ac', 100);
    expect(s.scenarioId).not.toBe('pushfold');
  });
});
