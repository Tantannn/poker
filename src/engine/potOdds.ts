// Pot-odds helpers used by the HUD and the AI.

export interface PotOdds {
  toCall: number;
  potBefore: number; // pot before hero calls
  potAfter: number; // pot after hero calls
  requiredEquity: number; // fraction needed to break even
  oddsRatio: number; // pot : call  (e.g. 2 means 2:1)
}

export function potOdds(potBefore: number, toCall: number): PotOdds {
  const potAfter = potBefore + toCall;
  const requiredEquity = toCall > 0 ? toCall / potAfter : 0;
  const oddsRatio = toCall > 0 ? potBefore / toCall : 0;
  return { toCall, potBefore, potAfter, requiredEquity, oddsRatio };
}

// ─────────────────────────────────────────────────────────────────────────
// POT GEOMETRY — the three numbers you can't easily compute at the table, all
// fall out of one variable: the bet size `f` (as a fraction of the pot).
//
//   • Equity to call a bet of size f  = f / (1 + 2f)   (requiredEquityForBet)
//   • Bluffs the bettor needs at f     = f / (1 + 2f)   ← SAME formula!
//   • MDF (defend frequency) vs size f = 1 / (1 + f)    (mdf, rewritten)
//
// MEMORIZE this cheat-sheet instead of the algebra (see POT_GEOMETRY below):
//
//   size      equity to call   bluff %   MDF
//   ⅓ pot         20%            20%      75%
//   ½ pot         25%            25%      67%
//   ⅔ pot         29%            29%      60%
//   ¾ pot         30%            30%      57%
//   pot           33%            33%      50%
//   2× pot        40%            40%      33%
//
// Two hooks: (1) "equity to call = bluffs needed" — it's the exact same number,
// so one row teaches both attack and defense. (2) MDF: "half-pot defend two-
// thirds, pot-bet defend half" — bet bigger, fold more.
// ─────────────────────────────────────────────────────────────────────────

/** Minimum defense frequency vs a bet of `bet` into a pot of `pot`. = 1/(1+f). */
export function mdf(pot: number, bet: number): number {
  return pot / (pot + bet);
}

/**
 * Bet as a fraction of the pot -> required equity for the caller, = f/(1+2f).
 * NOTE: this is the SAME number as the bluff frequency the bettor needs at this
 * size (river balance). `riverBalance` in postflopModel reuses this.
 */
export function requiredEquityForBet(betFractionOfPot: number): number {
  return betFractionOfPot / (1 + 2 * betFractionOfPot);
}

/** Bet size (×pot) -> required equity / bluff% / MDF. The memorizable cheat-sheet. */
export const POT_GEOMETRY: { size: string; frac: number }[] = [
  { size: '⅓ pot', frac: 1 / 3 },
  { size: '½ pot', frac: 1 / 2 },
  { size: '⅔ pot', frac: 2 / 3 },
  { size: '¾ pot', frac: 3 / 4 },
  { size: 'Pot', frac: 1 },
  { size: '2× pot', frac: 2 },
];
