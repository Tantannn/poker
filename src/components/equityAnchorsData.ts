// Popup anchor sheet for the equity-vs-range drill. Calibrating equity from a blank
// mind is hard; anchoring to a handful of reference points and nudging is not. These
// are the memorize-these numbers: made-hand baselines (vs a wide vs a tight range),
// the Rule-of-2-&-4 draw ladder, and the shift rules for facing a bet / going
// multiway. Rough by design — the drill shows the exact %; this is the gut anchor.

export interface MadeRow {
  hero: string;
  wide: number;
  tight: number;
  threeBet: number;
}

// Made-hand equity heads-up on the flop, averaged over 5000 random flops (all textures)
// vs the app's own ranges: wide = BTN open / BB defend, tight = UTG open, threeBet = the
// 3-bet value range. Dry boards run a few points higher. Ballparks, not solver output —
// anchors to nudge from. Exported so the equity-drill "💡 Why" reproduces the anchor read
// against the true equity (single source — the sheet and the drill can't drift apart).
export const MADE: MadeRow[] = [
  { hero: 'Air (no pair, no draw)', wide: 25, tight: 17, threeBet: 12 },
  { hero: 'Weak / 2nd pair', wide: 55, tight: 48, threeBet: 37 },
  { hero: 'Top pair', wide: 73, tight: 66, threeBet: 52 },
  { hero: 'Overpair / two pair', wide: 81, tight: 78, threeBet: 72 },
  { hero: 'Set / straight+', wide: 91, tight: 90, threeBet: 89 },
];

export interface DrawRow {
  draw: string;
  outs: number;
  river: number; // flop→river, Rule of 4
  oneCard: number; // one card, Rule of 2
}

export const DRAWS: DrawRow[] = [
  { draw: 'Flush draw', outs: 9, river: 35, oneCard: 18 },
  { draw: 'Open-ender', outs: 8, river: 32, oneCard: 16 },
  { draw: 'Two overcards', outs: 6, river: 24, oneCard: 12 },
  { draw: 'Gutshot', outs: 4, river: 16, oneCard: 8 },
];

interface MwRow {
  tier: string;
  hu: number; // heads-up (1 opp)
  w3: number; // 3-way (2 opps)
  w5: number; // 5-way (4 opps)
}

// Multiway decay: same hand vs 1 / 2 / 4 RANDOM opponents (20k-sim Monte Carlo). Random
// hands make it a universal anchor — a tighter range lowers the start, but the DROP per
// player is the point. Nutted hands barely move; one pair below top falls off a cliff.
export const MW: MwRow[] = [
  { tier: 'Set / straight+', hu: 98, w3: 95, w5: 90 },
  { tier: 'Two pair', hu: 94, w3: 89, w5: 80 },
  { tier: 'Top pair / overpair', hu: 88, w3: 80, w5: 63 },
  { tier: 'Middle pair', hu: 73, w3: 56, w5: 35 },
  { tier: 'Bottom / weak pair', hu: 56, w3: 34, w5: 18 },
  { tier: 'Overcards (air)', hu: 54, w3: 33, w5: 16 },
  { tier: 'Flush draw', hu: 68, w3: 53, w5: 43 },
];
