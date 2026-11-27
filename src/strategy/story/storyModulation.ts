// Type + multiway modulation for the betting-story read. The story reader
// (bettingStory.ts) gives the objective LINE SHAPE (value / polar / bluffy).
// This layer says how much to TRUST that shape given who's doing it and how many
// players are in — the same line means opposite things from a nit vs a maniac,
// and multiway shifts everything toward value. Pure + shared: the Story Trainer
// reveal and the live Think-First gate both call it, so the overlay is taught
// and graded from ONE source.

import type { VillainStory } from './bettingStory';

// villain tendency, matching the gate's observed-read ids (checklist VillainReadId).
export type VillainType = 'overfold' | 'overcall' | 'spew' | 'unknown';

export type Lean = 'trust' | 'fade' | 'neutral';

interface Mod {
  lean: Lean;
  note: string;
}

// shape × type. `trust` = believe it / fold marginal; `fade` = call wider /
// attack; `neutral` = take the shape at face value.
const MOD: Record<VillainStory, Record<VillainType, Mod>> = {
  value: {
    overfold: { lean: 'trust', note: 'Multi-barrel from a tight, over-folding type is value — believe it, fold marginal hands.' },
    overcall: { lean: 'trust', note: "A station rarely fires streets — when it DOES, it's value. Trust it more than the shape alone says." },
    spew: { lean: 'fade', note: "A maniac/LAG multi-barrels bluffs too — treat this as polar, not pure value; don't over-fold your bluff-catchers." },
    unknown: { lean: 'neutral', note: 'No type read — take the value shape at face value.' },
  },
  polar: {
    overfold: { lean: 'trust', note: 'This type rarely overbet-bluffs — weight it toward value; you need a real catcher or a blocker to call.' },
    overcall: { lean: 'trust', note: 'A passive type suddenly polarizing screams value — fold without a strong hand.' },
    spew: { lean: 'fade', note: 'Genuinely polar from a bluffer — call your good catchers, lean on blockers and the price.' },
    unknown: { lean: 'neutral', note: 'Polar as read — decide on blockers and the price.' },
  },
  bluffy: {
    overfold: { lean: 'fade', note: 'A tight player keeps betting value — giving up is real weakness. Bluff-catch light, and stab if he checks to you.' },
    overcall: { lean: 'neutral', note: "A station 'giving up' means nothing — it's passive by default, so don't read weakness into its checks; its rare bets are still value." },
    spew: { lean: 'fade', note: "From a bluffer a small/delayed stab is often air — call wider. But he also fires value at random, so don't blow up bluff-catching into a big raise." },
    unknown: { lean: 'fade', note: 'Capped / weak line — bluff-catch wider than the raw price.' },
  },
  none: {
    overfold: { lean: 'neutral', note: 'One bet, no story — but a tight player leans value; you need a hand to continue.' },
    overcall: { lean: 'neutral', note: "One bet — a station's bet is value-leaning; don't hero-fold a decent hand, don't bluff-catch trash." },
    spew: { lean: 'neutral', note: 'One bet from a bluffer — could be anything; let the price decide.' },
    unknown: { lean: 'neutral', note: 'One bet, no story and no read — play the price.' },
  },
};

const asType = (id: string | undefined): VillainType =>
  id === 'overfold' || id === 'overcall' || id === 'spew' ? id : 'unknown';

/** live opponents (1 = heads-up); >1 shifts the read toward value/caution. */
function multiwayNote(opps: number): string {
  return opps > 1
    ? ` ⚠ ${opps + 1}-way: bluffs drop and you must beat EVERY range — shade toward value/fold and discount the raw price.`
    : '';
}

/** Combine the objective line shape with the villain type + player count. */
export function modulateStory(shape: VillainStory, readId: string | undefined, opps = 1): Mod {
  const base = MOD[shape][asType(readId)];
  return { lean: base.lean, note: `${base.note}${multiwayNote(opps)}` };
}

/** Map an AI archetype tag (profiles.ts) to the nearest observed-read type — so
 *  the trainer can show a named archetype and reuse the same modulation. */
export function tagToType(tag: string): VillainType {
  switch (tag) {
    case 'MANIAC':
    case 'LAG':
      return 'spew';
    case 'LP':
      return 'overcall';
    case 'NIT':
    case 'TAG':
      return 'overfold';
    default:
      return 'unknown'; // GTO / balanced
  }
}

/** Hero-side (your own story): how villain type changes whether the bet works. */
export function heroStoryTypeNote(readId: string | undefined): string {
  switch (asType(readId)) {
    case 'overfold':
      return 'Villain read: over-folds — a credible story folds them out, so this is a good bluff / thin-value spot.';
    case 'overcall':
      return 'Villain read: station — your story barely matters, they call anyway. Value bet bigger; skip the bluff.';
    case 'spew':
      return "Villain read: bluffer — betting for folds is thin (they don't fold and they bet for you). Prefer checking strong hands to induce.";
    default:
      return '';
  }
}
