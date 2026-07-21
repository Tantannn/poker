import { describe, expect, it } from 'vitest';
import { readSizing, sizingTypeNote } from './sizingTell';
import { parseCard } from '../engine/cards';

const cards = (s: string) => s.split(' ').map(parseCard);
const DRY = cards('Kh 7d 2c'); // dry rainbow flop
const WET = cards('9s 8s 7h'); // wet, connected + flush draw

describe('readSizing', () => {
  it('overbet and pot are polar', () => {
    expect(readSizing(1.5, 'river', DRY).meaning).toBe('polar');
    expect(readSizing(1.0, 'turn', DRY).meaning).toBe('polar');
  });

  it('half and big are value / protection', () => {
    expect(readSizing(0.5, 'turn', DRY).meaning).toBe('value');
    expect(readSizing(0.7, 'flop', WET).meaning).toBe('value');
  });

  it('a small bet on a dry flop is a range/merged bet', () => {
    expect(readSizing(0.3, 'flop', DRY).meaning).toBe('merged');
  });

  it('a small bet on a wet flop, or late, is capped/weak', () => {
    expect(readSizing(0.3, 'flop', WET).meaning).toBe('capped');
    expect(readSizing(0.3, 'turn', DRY).meaning).toBe('capped');
    expect(readSizing(0.25, 'river', DRY).meaning).toBe('capped');
  });
});

describe('sizingTypeNote', () => {
  it('keys off the villain type, empty for unknown', () => {
    expect(sizingTypeNote('overcall')).toMatch(/station/i);
    expect(sizingTypeNote('spew')).toMatch(/maniac|lag/i);
    expect(sizingTypeNote('overfold')).toMatch(/nit|tag/i);
    expect(sizingTypeNote(undefined)).toBe('');
  });
});
