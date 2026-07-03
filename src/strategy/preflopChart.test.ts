import { describe, it, expect } from 'vitest';
import {
  cellStrategy,
  dominantKind,
  getScenario,
  scenariosForSize,
  seatsForSize,
  SCENARIOS,
} from './preflopChart';

const sumFreq = (code: string, id: string) =>
  cellStrategy(getScenario(id), code).reduce((a, o) => a + o.freq, 0);

describe('cellStrategy — RFI open', () => {
  const sc = getScenario('rfi-UTG');
  it('opens a premium at 100% frequency', () => {
    const opts = cellStrategy(sc, 'AA');
    expect(opts).toEqual([expect.objectContaining({ id: 'open', freq: 1, kind: 'value' })]);
  });
  it('folds trash at 100%', () => {
    expect(cellStrategy(sc, '72o')).toEqual([expect.objectContaining({ id: 'fold', freq: 1 })]);
  });
  it('splits a mixed-open hand 50/50 open-fold', () => {
    const opts = cellStrategy(sc, 'A8s'); // in UTG mixOpen
    const open = opts.find((o) => o.id === 'open');
    const fold = opts.find((o) => o.id === 'fold');
    expect(open?.freq).toBeCloseTo(0.5);
    expect(fold?.freq).toBeCloseTo(0.5);
  });
});

describe('cellStrategy — facing an open (btn-vs-utg)', () => {
  it('3-bets a value hand at 100%', () => {
    const opts = cellStrategy(getScenario('btn-vs-utg'), 'QQ');
    expect(opts).toEqual([expect.objectContaining({ id: 'raise', freq: 1, kind: 'value' })]);
  });
  it('splits a pure bluff between raise-bluff and fold', () => {
    const opts = cellStrategy(getScenario('btn-vs-utg'), 'A4s'); // bluff, not in call range
    const raise = opts.find((o) => o.id === 'raise');
    const fold = opts.find((o) => o.id === 'fold');
    expect(raise?.kind).toBe('bluff');
    expect(raise!.freq + fold!.freq).toBeCloseTo(1);
  });
  it('splits a bluff-that-also-flats between raise-bluff and call', () => {
    const opts = cellStrategy(getScenario('btn-vs-utg'), 'KJs'); // in both bluff and call
    const raise = opts.find((o) => o.id === 'raise');
    const call = opts.find((o) => o.id === 'call');
    expect(raise?.kind).toBe('bluff');
    expect(call).toBeDefined();
    expect(raise!.freq + call!.freq).toBeCloseTo(1);
  });
  it('flats a call-only hand at 100%', () => {
    expect(cellStrategy(getScenario('btn-vs-utg'), '99')).toEqual([
      expect.objectContaining({ id: 'call', freq: 1 }),
    ]);
  });
});

describe('cellStrategy — frequencies always sum to ~1', () => {
  for (const [id, code] of [
    ['rfi-BTN', 'A2s'],
    ['rfi-UTG', 'A8s'],
    ['btn-vs-utg', 'A4s'],
    ['btn-vs-utg', 'KJs'],
    ['bb-vs-btn', '54s'],
    ['sb-vs-btn', 'K9s'],
    ['utg-vs-4bet', 'KK'],
  ] as const) {
    it(`${id} / ${code}`, () => expect(sumFreq(code, id)).toBeCloseTo(1));
  }
});

describe('dominantKind', () => {
  it('picks the highest-frequency option kind', () => {
    expect(
      dominantKind([
        { id: 'fold', label: '', freq: 0.2, ev: 0, kind: 'fold' },
        { id: 'call', label: '', freq: 0.8, ev: 0, kind: 'call' },
      ]),
    ).toBe('call');
  });
  it('defaults to fold on an empty option list', () => {
    expect(dominantKind([])).toBe('fold');
  });
});

describe('table-size helpers', () => {
  it('lops early seats off the front as the table shrinks', () => {
    expect(seatsForSize(6)).toEqual(['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB']);
    expect(seatsForSize(3)).toEqual(['BTN', 'SB', 'BB']);
    expect(seatsForSize(2)).toEqual(['SB', 'BB']);
  });

  it('serves only heads-up-tagged scenarios at size 2', () => {
    const hu = scenariosForSize(2);
    expect(hu.length).toBeGreaterThan(0);
    expect(hu.every((s) => s.sizes?.includes(2))).toBe(true);
  });

  it('excludes heads-up-only scenarios from a 6-max table', () => {
    const six = scenariosForSize(6);
    expect(six.some((s) => s.id === 'rfi-UTG')).toBe(true);
    expect(six.some((s) => s.sizes?.includes(2))).toBe(false);
  });

  it('every 6-max scenario seats both hero and villain', () => {
    const seats = seatsForSize(6);
    for (const s of scenariosForSize(6)) {
      expect(seats).toContain(s.heroPos);
      if (s.villainPos) expect(seats).toContain(s.villainPos);
    }
  });
});

describe('getScenario', () => {
  it('falls back to the first scenario for an unknown id', () => {
    expect(getScenario('does-not-exist')).toBe(SCENARIOS[0]);
  });
});
