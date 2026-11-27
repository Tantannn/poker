// Betting-story scenario generator for StoryTrainer (split out so the component file
// exports only components — fast refresh).

import { makeDeck, shuffle, type Card } from '@/engine/cards';


import { readVillainStory, readHeroStory, type StreetMove, type VillainStory, type HeroStory, tagToType } from '@/strategy/story';


import { PROFILE_LIST } from '@/ai/decide';


export type Mode = 'villain' | 'hero';
export type PostStreet = 'flop' | 'turn' | 'river';
export const STREETS: PostStreet[] = ['flop', 'turn', 'river'];

export interface Choice {
  id: string;
  label: string;
  hint: string;
}
export const VILLAIN_CHOICES: Choice[] = [
  { id: 'value', label: 'Value story', hint: 'Consistent aggression, sizing up — believe it, fold marginal.' },
  { id: 'polar', label: 'Polarized', hint: 'Big bet or raise — nuts-or-bluff. Decide on blockers + price.' },
  { id: 'bluffy', label: 'Capped / bluffy', hint: 'Slowed down or a late stab — weaker range, call wider.' },
];
export const HERO_CHOICES: Choice[] = [
  { id: 'credible', label: 'Credible', hint: "You've repped it — a bluff is believed, value gets paid." },
  { id: 'fresh', label: 'Fresh start', hint: 'First bet — credible only if this card fits YOUR range.' },
  { id: 'broken', label: 'Broken', hint: 'Passive then big — represents nothing, nobody folds.' },
];
export const CHOICES: Record<Mode, Choice[]> = { villain: VILLAIN_CHOICES, hero: HERO_CHOICES };

// [kind, fracLo, fracHi]; frac ignored for check/call/none.
export type Spec = [StreetMove['kind'], number, number];

// Villain patterns give the FULL shown line (specs.length === revealed).
export const VILLAIN_PATTERNS: Record<2 | 3, Record<VillainStory, Spec[][]>> = {
  2: {
    value: [[['bet', 0.5, 0.6], ['bet', 0.65, 0.8]]],
    polar: [[['check', 0, 0], ['bet', 0.95, 1.3]], [['bet', 0.45, 0.6], ['raise', 0.6, 0.9]]],
    bluffy: [[['check', 0, 0], ['bet', 0.2, 0.32]], [['bet', 0.45, 0.6], ['check', 0, 0]]],
    none: [[['bet', 0.5, 0.6], ['none', 0, 0]]],
  },
  3: {
    value: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['bet', 0.72, 0.9]]],
    polar: [[['check', 0, 0], ['check', 0, 0], ['bet', 1.0, 1.4]], [['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['raise', 0.7, 1.0]]],
    bluffy: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['check', 0, 0]], [['check', 0, 0], ['check', 0, 0], ['bet', 0.2, 0.35]]],
    none: [[['bet', 0.5, 0.6], ['none', 0, 0], ['none', 0, 0]]],
  },
};

// Hero patterns give the PRIOR line only (specs.length === revealed - 1); the
// pending bet is the street being decided and isn't part of the read.
export const HERO_PATTERNS: Record<2 | 3, Record<HeroStory, Spec[][]>> = {
  2: {
    credible: [[['bet', 0.5, 0.66]]],
    fresh: [[['none', 0, 0]]],
    broken: [[['check', 0, 0]], [['call', 0, 0]]],
  },
  3: {
    credible: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72]], [['bet', 0.5, 0.66], ['check', 0, 0]]],
    fresh: [[['none', 0, 0], ['none', 0, 0]]],
    broken: [[['check', 0, 0], ['check', 0, 0]], [['check', 0, 0], ['call', 0, 0]]],
  },
};

export const pick = <T,>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];
export const fr = (lo: number, hi: number, rng: () => number): number => lo + rng() * (hi - lo);

export function buildLine(specs: Spec[], rng: () => number): StreetMove[] {
  const line: StreetMove[] = STREETS.map((s) => ({ street: s, kind: 'none', frac: 0 }));
  specs.forEach(([kind, lo, hi], i) => {
    line[i] = { street: STREETS[i], kind, frac: kind === 'bet' || kind === 'raise' ? fr(lo, hi, rng) : 0 };
  });
  return line;
}

export interface Scenario {
  mode: Mode;
  board: Card[];
  revealed: 2 | 3; // 2 = turn, 3 = river
  line: StreetMove[];
  answer: string; // the reader's verdict — the graded truth (line SHAPE)
  why: string;
  action: string; // what the read prescribes — the decision rep
  pendingStreet: PostStreet; // hero mode: the street being bet
  // villain mode only — the type + player-count overlay (modulates the read).
  readId?: string;
  profileTag?: string;
  profileName?: string;
  opps: number; // live opponents; 1 = heads-up
}

export function genScenario(mode: Mode, rng: () => number = Math.random): Scenario {
  const revealed: 2 | 3 = rng() < 0.6 ? 3 : 2; // weight the river — richer stories
  const board = shuffle(makeDeck(), rng).slice(0, revealed + 2);
  const pendingStreet = STREETS[revealed - 1];

  if (mode === 'villain') {
    const target = pick<VillainStory>(['value', 'polar', 'bluffy'], rng);
    const specs = pick(VILLAIN_PATTERNS[revealed][target], rng);
    const line = buildLine(specs, rng);
    const v = readVillainStory(line, revealed);
    const profile = pick(PROFILE_LIST, rng);
    const opps = rng() < 0.3 ? (rng() < 0.5 ? 2 : 3) : 1; // sometimes multiway
    return {
      mode, board, revealed, line, answer: v.read, why: v.why, action: v.action, pendingStreet,
      readId: tagToType(profile.tag), profileTag: profile.tag, profileName: profile.name, opps,
    };
  }
  const target = pick<HeroStory>(['credible', 'fresh', 'broken'], rng);
  const specs = pick(HERO_PATTERNS[revealed][target], rng);
  const line = buildLine(specs, rng); // prior streets only
  const h = readHeroStory(line, revealed);
  return { mode, board, revealed, line, answer: h.read, why: h.why, action: h.action, pendingStreet, opps: 1 };
}
