import { describe, expect, it } from 'vitest';
import { genScenario } from './StoryTrainer';
import { readVillainStory, readHeroStory } from '../strategy/bettingStory';

// tiny deterministic PRNG so the generator is reproducible in tests.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('StoryTrainer generator', () => {
  it('every villain scenario is self-consistent and covers all three stories', () => {
    const rng = mulberry32(42);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = genScenario('villain', rng);
      // the shown answer must equal the reader's verdict on the shown line
      expect(readVillainStory(s.line, s.revealed).read).toBe(s.answer);
      expect(['value', 'polar', 'bluffy']).toContain(s.answer);
      expect(s.board).toHaveLength(s.revealed + 2);
      // villain scenarios carry the type + player-count overlay
      expect(['overfold', 'overcall', 'spew', 'unknown']).toContain(s.readId);
      expect(s.opps).toBeGreaterThanOrEqual(1);
      seen.add(s.answer);
    }
    expect(seen).toEqual(new Set(['value', 'polar', 'bluffy']));
  });

  it('every hero scenario is self-consistent and covers all three stories', () => {
    const rng = mulberry32(7);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = genScenario('hero', rng);
      expect(readHeroStory(s.line, s.revealed).read).toBe(s.answer);
      expect(['credible', 'fresh', 'broken']).toContain(s.answer);
      seen.add(s.answer);
    }
    expect(seen).toEqual(new Set(['credible', 'fresh', 'broken']));
  });
});
