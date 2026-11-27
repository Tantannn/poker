import { describe, expect, it } from 'vitest';
import { modulateStory, tagToType, heroStoryTypeNote } from './storyModulation';

describe('modulateStory', () => {
  it('a value line is trusted vs a tight type, faded vs a bluffer', () => {
    expect(modulateStory('value', 'overfold').lean).toBe('trust');
    expect(modulateStory('value', 'spew').lean).toBe('fade');
  });

  it('a bluffy line is attackable vs a nit, meaningless vs a station', () => {
    expect(modulateStory('bluffy', 'overfold').lean).toBe('fade');
    expect(modulateStory('bluffy', 'overcall').lean).toBe('neutral');
  });

  it('unknown type falls back to a neutral/shape-only read', () => {
    expect(modulateStory('value', undefined).lean).toBe('neutral');
    expect(modulateStory('polar', 'garbage').lean).toBe('neutral');
  });

  it('multiway appends a value-shading caution', () => {
    expect(modulateStory('polar', 'spew', 1).note).not.toMatch(/way:/);
    expect(modulateStory('polar', 'spew', 3).note).toMatch(/4-way:/);
  });
});

describe('tagToType', () => {
  it('maps archetypes to the nearest observed-read type', () => {
    expect(tagToType('MANIAC')).toBe('spew');
    expect(tagToType('LAG')).toBe('spew');
    expect(tagToType('LP')).toBe('overcall');
    expect(tagToType('NIT')).toBe('overfold');
    expect(tagToType('TAG')).toBe('overfold');
    expect(tagToType('GTO')).toBe('unknown');
  });
});

describe('heroStoryTypeNote', () => {
  it('warns against bluffing a station, encourages it vs an over-folder', () => {
    expect(heroStoryTypeNote('overcall')).toMatch(/skip the bluff/i);
    expect(heroStoryTypeNote('overfold')).toMatch(/bluff/i);
    expect(heroStoryTypeNote(undefined)).toBe('');
  });
});
