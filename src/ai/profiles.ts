// Opponent AI archetypes. Each profile is a set of tunable parameters; the
// decision logic in decide.ts reads these so new archetypes plug in by adding
// an entry here — no changes to the engine.

export interface AIProfile {
  id: string;
  name: string;
  blurb: string;
  // preflop
  openLooseness: number; // 0 tight .. 1 loose (scales the RFI range)
  threeBetFreq: number; // chance to 3-bet a strong-enough hand
  callRaiseLooseness: number; // willingness to flat-call raises
  // postflop
  aggression: number; // 0 passive .. 1 aggressive (bet/raise tendency)
  bluffFreq: number; // chance to bluff with no equity
  callStation: number; // 0 folds correctly .. 1 calls too much
  cbetFreq: number; // continuation-bet frequency as aggressor
  tag: 'TAG' | 'LAG' | 'LP' | 'MANIAC' | 'GTO' | 'NIT' | 'REG';
  /** 0..1 how strongly this archetype COUNTER-ADJUSTS to the hero, independent of the
   *  difficulty slider. A reg adapts because that's what regs do (they level you); a fish
   *  never does. decide.ts uses max(diff.adapt, profile.adapt), so a reg adapts even on Normal
   *  and the difficulty slider still makes everyone adapt. Omitted = 0 (static archetype). */
  adapt?: number;
  /** one-line guidance on how to exploit this archetype. */
  exploit: string;
}

export const PROFILES: Record<string, AIProfile> = {
  tag: {
    id: 'tag',
    name: 'Tight-Aggressive',
    blurb: 'Plays few hands but bets/raises them hard. The classic solid reg.',
    openLooseness: 0.4,
    threeBetFreq: 0.55,
    callRaiseLooseness: 0.35,
    aggression: 0.7,
    bluffFreq: 0.25,
    callStation: 0.2,
    cbetFreq: 0.7,
    tag: 'TAG',
    exploit:
      'Respect their raises but attack their checks — when a TAG gives up, the pot is usually yours. ' +
      'Float wide in position and 3-bet their late-position opens to deny their range advantage.',
  },
  lag: {
    id: 'lag',
    name: 'Loose-Aggressive',
    blurb: 'Wide ranges, relentless pressure. Hard to read, lots of bluffs.',
    openLooseness: 0.8,
    threeBetFreq: 0.7,
    callRaiseLooseness: 0.5,
    aggression: 0.85,
    bluffFreq: 0.45,
    callStation: 0.25,
    cbetFreq: 0.8,
    tag: 'LAG',
    exploit:
      'Stop folding to relentless aggression — their range is wide and full of bluffs, so call down lighter ' +
      'and let them barrel into your strong hands. Trap rather than bloat pots out of position.',
  },
  lp: {
    id: 'lp',
    name: 'Loose-Passive (Calling Station)',
    blurb: 'Plays many hands, calls too much, rarely raises. Punish by value betting.',
    openLooseness: 0.7,
    threeBetFreq: 0.1,
    callRaiseLooseness: 0.85,
    aggression: 0.25,
    bluffFreq: 0.08,
    callStation: 0.85,
    cbetFreq: 0.35,
    tag: 'LP',
    exploit:
      'Value bet relentlessly and STOP bluffing — they call too much, so thin value prints and bluffs burn money. ' +
      'Bet bigger with strong hands; check back air instead of firing.',
  },
  maniac: {
    id: 'maniac',
    name: 'Maniac',
    blurb: 'Raises and bluffs constantly. High variance — let them hang themselves.',
    openLooseness: 0.95,
    threeBetFreq: 0.85,
    callRaiseLooseness: 0.4,
    aggression: 0.98,
    bluffFreq: 0.7,
    callStation: 0.3,
    cbetFreq: 0.9,
    tag: 'MANIAC',
    exploit:
      'Tighten up and let them hang themselves. Trap with strong hands, call down wide, and avoid bluffing — ' +
      'they will bet for you. Pot control is unnecessary; just get it in when ahead.',
  },
  nit: {
    id: 'nit',
    name: 'Nit',
    blurb: 'Extremely tight. If they put money in, believe them.',
    openLooseness: 0.2,
    threeBetFreq: 0.35,
    callRaiseLooseness: 0.2,
    aggression: 0.55,
    bluffFreq: 0.08,
    callStation: 0.1,
    cbetFreq: 0.55,
    tag: 'NIT',
    exploit:
      'Steal their blinds relentlessly and fold the moment they show aggression — if a nit puts money in, believe them. ' +
      'Bluff their checks, but never pay off their big bets.',
  },
  gto: {
    id: 'gto',
    name: 'GTO-ish',
    blurb: 'Balanced ranges, mixes value and bluffs near game-theory-optimal frequencies.',
    openLooseness: 0.5,
    threeBetFreq: 0.5,
    callRaiseLooseness: 0.45,
    aggression: 0.6,
    bluffFreq: 0.33,
    callStation: 0.3,
    cbetFreq: 0.62,
    tag: 'GTO',
    // deliberately NO adapt: a GTO player plays the unexploitable strategy regardless of the
    // hero — it never deviates. The exploitative counter-adjuster is the `reg` below.
    exploit:
      "Hard to exploit by design — play solid, balanced poker back. Edges come only from your own mistakes, " +
      'so focus on clean fundamentals and avoid spewing into their balanced ranges.',
  },
  reg: {
    id: 'reg',
    name: 'Reg (thinking regular)',
    blurb: 'Solid, near-balanced, few static leaks — but he ADJUSTS to you. The low-pro you actually have to beat.',
    // near-GTO with small, findable leaks: over-c-bets the flop and gives up the turn.
    openLooseness: 0.48,
    threeBetFreq: 0.52,
    callRaiseLooseness: 0.42,
    aggression: 0.62,
    bluffFreq: 0.3,
    callStation: 0.28,
    cbetFreq: 0.72,
    tag: 'REG',
    adapt: 0.6, // the defining trait — he counter-adjusts to how YOU have been playing
    exploit:
      'Few static leaks, so change gears BEFORE he does. He over-c-bets the flop and gives up the turn — float and ' +
      'take it away. Above all he ADAPTS: if you have been aggressive he stops folding (switch to value); if you have ' +
      'been passive he steals more (fight back). Watch the “⚠ he’s adjusting” read and re-level first.',
  },
};

export const PROFILE_LIST = Object.values(PROFILES);

export function getProfile(id: string): AIProfile {
  return PROFILES[id] ?? PROFILES.tag;
}
