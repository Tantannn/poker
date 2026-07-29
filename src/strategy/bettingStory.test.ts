import { describe, expect, it } from 'vitest';
import { parseCard } from '../engine/cards';
import type { ActionRecord } from '../engine/table';
import { playerLine, readVillainStory, readHeroStory } from './bettingStory';

const cards = (s: string) => s.split(' ').map(parseCard);

// minimal log record; potAfter is set so `amount / (potAfter - amount)` gives the
// intended bet fraction (e.g. 30 into potAfter 60 → 30/30 = 1.0 = overbet-ish).
const rec = (
  playerId: number,
  street: ActionRecord['street'],
  type: ActionRecord['type'],
  amount = 0,
  potAfter = 0,
  allIn = false,
): ActionRecord => ({
  handNumber: 1,
  playerId,
  playerName: 'p',
  position: 'BTN',
  type,
  amount,
  street,
  potAfter,
  ...(allIn ? { allIn: true } : {}),
});

const V = 1; // villain id
const H = 0; // hero id

describe('playerLine', () => {
  it('reduces a hand log into a flop/turn/river line for one player', () => {
    const log = [
      rec(V, 'flop', 'bet', 10, 30), // 10 into 20 → 0.5
      rec(H, 'flop', 'call', 10, 40),
      rec(V, 'turn', 'bet', 40, 80), // 40 into 40 → 1.0
    ];
    const line = playerLine(log, 1, V);
    expect(line.map((m) => m.kind)).toEqual(['bet', 'bet', 'none']);
    expect(line[0].frac).toBeCloseTo(0.5, 2);
    expect(line[1].frac).toBeCloseTo(1.0, 2);
  });

  it('reads a check-raise as the raise', () => {
    const log = [rec(V, 'flop', 'check'), rec(V, 'flop', 'raise', 20, 60)];
    expect(playerLine(log, 1, V)[0].kind).toBe('raise');
  });
});

describe('readVillainStory', () => {
  it('multi-barrel with sizing up = value', () => {
    const line = playerLine([rec(V, 'flop', 'bet', 10, 30), rec(V, 'turn', 'bet', 40, 80)], 1, V);
    expect(readVillainStory(line, 2).read).toBe('value');
  });

  it('took the lead then checked later = bluffy (capped)', () => {
    const line = playerLine(
      [rec(V, 'flop', 'bet', 10, 30), rec(V, 'turn', 'check'), rec(V, 'river', 'bet', 30, 90)],
      1,
      V,
    );
    expect(readVillainStory(line, 3).read).toBe('bluffy');
  });

  it('a raise is polarized', () => {
    const line = playerLine([rec(V, 'flop', 'raise', 20, 60)], 1, V);
    expect(readVillainStory(line, 1).read).toBe('polar');
  });

  it('passive then a BIG bet = polarized', () => {
    const line = playerLine([rec(V, 'flop', 'check'), rec(V, 'turn', 'bet', 40, 80)], 1, V); // 1.0
    expect(readVillainStory(line, 2).read).toBe('polar');
  });

  it('passive then a small stab = bluffy (delayed)', () => {
    const line = playerLine([rec(V, 'flop', 'check'), rec(V, 'turn', 'bet', 10, 60)], 1, V); // 0.2
    expect(readVillainStory(line, 2).read).toBe('bluffy');
  });

  it('one bet, no prior street = no story yet', () => {
    const line = playerLine([rec(V, 'flop', 'bet', 10, 30)], 1, V);
    expect(readVillainStory(line, 1).read).toBe('none');
  });

  it('called down then RAISED the river = value/trap, not polar', () => {
    const line = playerLine(
      [rec(V, 'flop', 'call', 10, 40), rec(V, 'turn', 'call', 20, 90), rec(V, 'river', 'raise', 60, 240)],
      1,
      V,
    );
    const v = readVillainStory(line, 3);
    expect(v.read).toBe('value');
    expect(v.action).toMatch(/TRAP|fold/i);
  });

  it('check-called then check-RAISED = value/trap (passive wakes up)', () => {
    const line = playerLine(
      [rec(V, 'flop', 'check'), rec(V, 'turn', 'call', 20, 90), rec(V, 'river', 'raise', 60, 240)],
      1,
      V,
    );
    expect(readVillainStory(line, 3).read).toBe('value');
  });

  // The A7 blunder spot: CO barrels 663 → 5 → 5 and jams the river. Neither the
  // sizing clause nor "believe it" survives contact with the board or the shove.
  const barrelToRiverJam = () =>
    playerLine(
      [rec(V, 'flop', 'bet', 12, 36), rec(V, 'turn', 'bet', 30, 96), rec(V, 'river', 'bet', 55, 106, true)],
      1,
      V,
    );

  it('a shoved river drops the sizing clause and recaps it as all-in, not pot-size', () => {
    const v = readVillainStory(barrelToRiverJam(), 3);
    expect(v.read).toBe('value');
    expect(v.why).toContain('shoved all-in on the river');
    expect(v.why).toContain('set by his stack, not chosen');
    expect(v.why).not.toContain('believe it');
  });

  it('a double-paired river downgrades a linear multi-barrel to polar (his value has no customers)', () => {
    const v = readVillainStory(barrelToRiverJam(), 3, cards('6h 6c 3d 5s 5d'));
    expect(v.read).toBe('polar');
    expect(v.why).toContain('two pair');
    expect(v.why).toContain('no customers');
    expect(v.action).toMatch(/bluff-catch/i);
  });

  it('an unpaired river keeps the linear value read', () => {
    expect(readVillainStory(barrelToRiverJam(), 3, cards('Kh 9c 4d 2s 7h')).read).toBe('value');
  });

  it('omitting the board reads the line SHAPE only, so the drills are unaffected', () => {
    const line = playerLine([rec(V, 'flop', 'bet', 10, 30), rec(V, 'turn', 'bet', 40, 80)], 1, V);
    expect(readVillainStory(line, 2, undefined).read).toBe('value');
  });
});

describe('readHeroStory', () => {
  it('prior aggression → credible', () => {
    const line = playerLine([rec(H, 'flop', 'bet', 10, 30)], 1, H);
    expect(readHeroStory(line, 2).read).toBe('credible'); // betting the turn
  });

  it('no prior postflop action → fresh', () => {
    const line = playerLine([], 1, H);
    expect(readHeroStory(line, 2).read).toBe('fresh');
  });

  it('passive then betting → broken', () => {
    const line = playerLine([rec(H, 'flop', 'check')], 1, H);
    expect(readHeroStory(line, 2).read).toBe('broken');
  });
});
