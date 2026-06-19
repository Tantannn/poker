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

/** Minimum defense frequency vs a bet of `bet` into a pot of `pot`. */
export function mdf(pot: number, bet: number): number {
  return pot / (pot + bet);
}

/** Bet as a fraction of the pot -> required equity for the caller. */
export function requiredEquityForBet(betFractionOfPot: number): number {
  return betFractionOfPot / (1 + 2 * betFractionOfPot);
}
