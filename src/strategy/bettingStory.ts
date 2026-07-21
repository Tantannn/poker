// Betting-story reader. A line of bets across streets should describe ONE
// believable hand: consistent aggression = value; a big bet/raise after
// passivity = polarized (nuts-or-bluff); taking the lead then slowing down, or
// a small delayed stab = capped / bluffy. Reading the VILLAIN's story tells you
// whether his bet is credible; checking your OWN story tells you whether a bluff
// will be believed. Pure functions (no React) so the reveal NOTES teach the
// pattern and the drill can unit-test them.

import type { ActionRecord } from '../engine/table';

const POSTFLOP = ['flop', 'turn', 'river'] as const;
type PostStreet = (typeof POSTFLOP)[number];

/** One player's action on one postflop street, reduced to what a reader cares
 *  about: was it aggressive, and how big. `none` = didn't act / street unreached. */
export interface StreetMove {
  street: PostStreet;
  kind: 'bet' | 'raise' | 'call' | 'check' | 'none';
  /** aggressive size ÷ pot before the bet (0 when not aggressive). */
  frac: number;
}

/** Reduce one player's THIS-HAND log into a flop/turn/river line. The street's
 *  character is its last aggressive action (a check-raise reads as the raise);
 *  otherwise the last passive action (call > check). */
export function playerLine(
  log: ActionRecord[],
  handNumber: number,
  playerId: number,
): StreetMove[] {
  return POSTFLOP.map((street): StreetMove => {
    const acts = log.filter(
      (l) => l.handNumber === handNumber && l.playerId === playerId && l.street === street,
    );
    if (acts.length === 0) return { street, kind: 'none', frac: 0 };
    const aggr = [...acts].reverse().find((a) => a.type === 'bet' || a.type === 'raise');
    if (aggr) {
      const before = Math.max(1, aggr.potAfter - aggr.amount);
      return { street, kind: aggr.type as 'bet' | 'raise', frac: aggr.amount / before };
    }
    const last = acts[acts.length - 1];
    return { street, kind: last.type === 'call' ? 'call' : 'check', frac: 0 };
  });
}

const sizeWord = (f: number): string =>
  f >= 1.25 ? 'an overbet' : f >= 0.85 ? 'pot-size' : f >= 0.6 ? 'big' : f >= 0.42 ? 'half-pot' : 'small';

function describeMove(m: StreetMove): string {
  switch (m.kind) {
    case 'bet':
      return `bet ${sizeWord(m.frac)} on the ${m.street}`;
    case 'raise':
      return `raised the ${m.street}`;
    case 'call':
      return `called the ${m.street}`;
    case 'check':
      return `checked the ${m.street}`;
    default:
      return '';
  }
}

const recapOf = (moves: StreetMove[]): string =>
  moves.map(describeMove).filter(Boolean).join(', ');

// ── Villain story — is his bet credible? ────────────────────────────────────

export type VillainStory = 'value' | 'polar' | 'bluffy' | 'none';

export interface VillainStoryVerdict {
  read: VillainStory;
  /** English recap of the line + what it means for the call — the teaching payload. */
  why: string;
}

/** Read the villain's line up to (and including) the street facing the hero.
 *  `revealed` = postflop streets reached (2 = turn, 3 = river). */
export function readVillainStory(line: StreetMove[], revealed: number): VillainStoryVerdict {
  const shown = line.slice(0, revealed).filter((m) => m.kind !== 'none');
  const recap = recapOf(shown);
  const aggr = shown.filter((m) => m.kind === 'bet' || m.kind === 'raise');
  if (aggr.length === 0)
    return {
      read: 'none',
      why: recap ? `He ${recap} — passive, nothing aggressive to read yet.` : 'No postflop action to read yet.',
    };

  const last = shown[shown.length - 1];
  const aggressiveNow = last.kind === 'bet' || last.kind === 'raise';
  // took the lead on some street, then CHECKED a later one → gave up.
  const gaveUp = shown.some(
    (m, i) => (m.kind === 'bet' || m.kind === 'raise') && shown.slice(i + 1).some((n) => n.kind === 'check'),
  );
  const passiveEarly = shown.slice(0, -1).some((m) => m.kind === 'check' || m.kind === 'call');

  if (gaveUp)
    return {
      read: 'bluffy',
      why: `He ${recap}. He took the lead then slowed down — a capped / give-up line. Value usually keeps firing, so this leans bluff or a weak made hand: bluff-catch wider.`,
    };
  if (last.kind === 'raise')
    return {
      read: 'polar',
      why: `He ${recap}. A raise is polarized — the nuts or a bluff, little in between. Decide on blockers and the price, not on "he might have it".`,
    };
  if (aggressiveNow && passiveEarly)
    return last.frac >= 0.85
      ? {
          read: 'polar',
          why: `He ${recap}. A big fire after passivity is polarized / delayed — value he slow-played OR a bluff picking its spot. Bluff-catch by the price and how often he actually bluffs.`,
        }
      : {
          read: 'bluffy',
          why: `He ${recap}. Passive, then a modest stab — a delayed, often thin or bluffy line. His range is weaker than a multi-barrel, so call wider than the raw price suggests.`,
        };
  if (aggr.length >= 2 && aggressiveNow)
    return {
      read: 'value',
      why: `He ${recap}. Multi-street aggression with sizing holding or growing is a linear VALUE story — believe it. Fold marginal hands; only strong bluff-catchers continue.`,
    };
  return {
    read: 'none',
    why: `He ${recap}. One bet, no multi-street story yet — decide on the price and the board, not a line read.`,
  };
}

// ── Hero story — will my bluff be believed? ─────────────────────────────────

export type HeroStory = 'credible' | 'fresh' | 'broken';

export interface HeroStoryVerdict {
  read: HeroStory;
  why: string;
}

/** Read the hero's OWN line before the pending bet/raise on street `revealed`
 *  (2 = turn, 3 = river). Judges whether the line tells a coherent value story. */
export function readHeroStory(line: StreetMove[], revealed: number): HeroStoryVerdict {
  const prior = line.slice(0, Math.max(0, revealed - 1)).filter((m) => m.kind !== 'none');
  const recap = recapOf(prior);
  const priorAggr = prior.some((m) => m.kind === 'bet' || m.kind === 'raise');
  const priorPassive = prior.some((m) => m.kind === 'check' || m.kind === 'call');
  const streetName = POSTFLOP[Math.min(revealed - 1, 2)];

  if (priorAggr)
    return {
      read: 'credible',
      why: `You ${recap}. This bet continues a hand you've already repped — the value story holds, so a bluff is believable and a value bet gets paid by the range you built.`,
    };
  if (!priorPassive)
    return {
      read: 'fresh',
      why: `First postflop move of the hand — the story STARTS now. Credible only if this ${streetName} card plausibly hits YOUR range; a bluff needs a board you'd also bet for value.`,
    };
  return {
    read: 'broken',
    why: `You ${recap}, now suddenly betting. Passive-then-big represents almost nothing — a thinking villain won't fold to a line that tells no value story. If bluffing, that's the leak; if value, you let earlier streets go too cheap.`,
  };
}
