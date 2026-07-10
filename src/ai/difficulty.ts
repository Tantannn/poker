// Bot difficulty tiers. One skill knob scales how well the field plays: how
// often it errs, how accurately it reads its equity, and whether it adapts to
// the hero's tendencies. easy = beginner who calls too much; extreme = accurate
// hand-reads + fully exploits the hero's leaks.

export type Difficulty = 'easy' | 'normal' | 'hard' | 'extreme';

export interface DifficultyParams {
  id: Difficulty;
  label: string;
  blurb: string;
  mistakeRate: number; // chance per decision to play a fishy / suboptimal line
  equityNoise: number; // ± random error added to its equity read (misreads hands)
  adapt: number; // 0..1 how strongly it exploits the hero's leaks
  iters: number; // Monte-Carlo iterations behind its equity (accuracy)
  temp: number; // softness of the call/fold boundary — bigger = more random near
  // the break-even line (human), smaller = sharper/closer to a hard cutoff (GTO).
}

export const DIFFICULTIES: Record<Difficulty, DifficultyParams> = {
  easy: {
    id: 'easy',
    label: 'Easy',
    blurb: 'Raw fish — limps everything, chases, calls too much, random bluffs.',
    mistakeRate: 0.45,
    equityNoise: 0.2,
    adapt: 0,
    iters: 300,
    temp: 0.1,
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    blurb: 'Solid fundamentals with the occasional slip.',
    mistakeRate: 0.12,
    equityNoise: 0.06,
    adapt: 0,
    iters: 500,
    temp: 0.06,
  },
  hard: {
    id: 'hard',
    label: 'Hard',
    blurb: 'Sharp, balanced, and starts exploiting your tendencies.',
    mistakeRate: 0.03,
    equityNoise: 0.02,
    adapt: 0.5,
    iters: 700,
    temp: 0.035,
  },
  extreme: {
    id: 'extreme',
    label: 'Extreme',
    blurb: 'Near-perfect: accurate hand-reads and fully adapts to your leaks.',
    mistakeRate: 0,
    equityNoise: 0,
    adapt: 1,
    iters: 900,
    temp: 0.015,
  },
};

export const DIFFICULTY_LIST = Object.values(DIFFICULTIES);

/** Running tally of how the hero plays, so hard/extreme bots can exploit it.
 *  Beyond the coarse fold-to-bet, the granular buckets let a bot read the hero
 *  by SIZE (overfolds big? sticky vs small?), by STREET/BOARD (folds flop c-bets?),
 *  by SHOWDOWN (river station?), and by POSITION (passive out of position?) — so it
 *  can counter-exploit specific leaks instead of one blunt tendency. Each bucket
 *  carries its own denominator so a read only fires once it has a real sample. */
export interface HeroReads {
  decisions: number;
  preflopActions: number;
  vpipActions: number; // preflop voluntary money in (call/raise)
  aggrActions: number; // bets/raises (any street)
  passiveActions: number; // calls (any street)
  betsFaced: number; // decisions where the hero faced a bet
  foldToBet: number; // folds when facing a bet
  // --- SIZE-specific fold-to-bet (postflop) ---
  bigBetsFaced: number; // faced a bet ≥ ~⅔ pot
  foldToBig: number;
  smallBetsFaced: number; // faced a bet < ~⅔ pot
  foldToSmall: number;
  // --- STREET/BOARD: flop c-bet defence (highest-frequency spot) ---
  flopBetsFaced: number;
  foldToFlopBet: number;
  // --- SHOWDOWN: river calling (station read) ---
  riverBetsFaced: number;
  riverCalls: number;
  // --- POSITION: how passive the hero is out of position postflop ---
  oopActions: number;
  oopPassive: number; // checked or folded while OOP
}

export function emptyReads(): HeroReads {
  return {
    decisions: 0,
    preflopActions: 0,
    vpipActions: 0,
    aggrActions: 0,
    passiveActions: 0,
    betsFaced: 0,
    foldToBet: 0,
    bigBetsFaced: 0,
    foldToBig: 0,
    smallBetsFaced: 0,
    foldToSmall: 0,
    flopBetsFaced: 0,
    foldToFlopBet: 0,
    riverBetsFaced: 0,
    riverCalls: 0,
    oopActions: 0,
    oopPassive: 0,
  };
}
