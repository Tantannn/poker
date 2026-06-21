// Lightweight preflop "blueprint" — the Pluribus idea (a precomputed strategy
// table the bot reads) without the MCCFR training or a backend. It turns our
// chart SETS into mixed action FREQUENCIES, so bots play balanced, less-
// predictable preflop ranges: the strongest hands act ~always, the weakest in a
// range only some of the time. Frequencies are chart-derived approximations
// (smoothed by hand strength), NOT solver output — they make play more balanced
// and harder to read while staying cheap and fully client-side.

import { preflopStrength } from './preflop';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * RFI node (folded to hero): probability of opening this hand.
 * In-range hands open often, with the borderline ones mixed by strength; a few
 * just-off-chart hands get an occasional steal (looser archetypes more so).
 */
export function rfiOpenFreq(inRange: boolean, code: string, openLooseness: number): number {
  const s = preflopStrength(code);
  if (inRange) {
    // deep-in-range hands ≈ always open; the weakest in-range hands mix down
    return clamp01(0.5 + s * 0.55 + openLooseness * 0.12);
  }
  // a thin band of off-chart hands gets the occasional steal-open
  if (s > 0.58) return clamp01((s - 0.55) * openLooseness * 1.2);
  return 0;
}

/**
 * BB option / limped pot (no bet to call): probability of raising for value
 * rather than checking, mixed by strength and aggression.
 */
export function limpedRaiseFreq(code: string, aggression: number): number {
  const s = preflopStrength(code);
  if (s < 0.55) return 0;
  return clamp01((s - 0.5) * (0.7 + aggression * 0.6));
}

/**
 * Value 3-bet/4-bet frequency for a hand already deemed worthy. Premiums jam
 * near always; borderline value hands mix at the profile's base 3-bet rate.
 */
export function valueThreeBetFreq(code: string, baseFreq: number): number {
  const s = preflopStrength(code);
  return clamp01(baseFreq * (0.5 + s));
}
