// Lightweight preflop "blueprint" — the Pluribus idea (a precomputed strategy
// table the bot reads) without the MCCFR training or a backend. It turns our
// chart SETS into mixed action FREQUENCIES, so bots play balanced, less-
// predictable preflop ranges: the strongest hands act ~always, the weakest in a
// range only some of the time. Frequencies are chart-derived approximations
// (smoothed by hand strength), NOT solver output — they make play more balanced
// and harder to read while staying cheap and fully client-side.

import { handCombos, preflopStrength } from './preflop';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const ALL_CODES: string[] = (() => {
  const R = 'AKQJT98765432';
  const out: string[] = [];
  for (let a = 0; a < 13; a++)
    for (let b = a; b < 13; b++) {
      if (a === b) out.push(R[a] + R[a]);
      else out.push(R[a] + R[b] + 's', R[a] + R[b] + 'o');
    }
  return out;
})();

/** Exponent on the chart's fold share: looseness 0.5 plays the chart exactly, 0 → ×0.45,
 *  1 → ×2.4. Width = 1 − (1 − chart%)^m saturates naturally, so a maniac's button
 *  range lands near 70% rather than past 100%. */
export function openRangeExponent(openLooseness: number): number {
  const L = clamp01(openLooseness);
  return L < 0.5 ? 0.2 + 1.6 * L : 1 + 2.8 * (L - 0.5);
}

/** Ramp width (share of all hands) over which the boundary hands mix. */
const EDGE_BAND = 0.04;
/** Chart membership outranks raw strength, so a nit trims the chart's weakest hands
 *  instead of swapping its suited connectors for off-chart offsuit broadways. */
const CHART_BONUS = 0.15;

interface EntryTable {
  freq: Map<string, number>;
  /** share of the entering range (by weighted combos) ranked above this hand */
  percentile: Map<string, number>;
}

const freqCache = new WeakMap<Set<string>, Map<number, EntryTable>>();

function openFreqTable(chart: Set<string>, openLooseness: number): EntryTable {
  let byLoose = freqCache.get(chart);
  if (!byLoose) freqCache.set(chart, (byLoose = new Map()));
  const cached = byLoose.get(openLooseness);
  if (cached) return cached;

  let chartCombos = 0;
  chart.forEach((c) => (chartCombos += handCombos(c)));
  const chartShare = chartCombos / 1326;
  const width = 1 - Math.pow(1 - chartShare, openRangeExponent(openLooseness));
  const ranked = [...ALL_CODES].sort(
    (a, b) =>
      preflopStrength(b) + (chart.has(b) ? CHART_BONUS : 0) - (preflopStrength(a) + (chart.has(a) ? CHART_BONUS : 0)),
  );
  const freq = new Map<string, number>();
  let cum = 0;
  for (const code of ranked) {
    const share = handCombos(code) / 1326;
    const mid = cum + share / 2;
    cum += share;
    freq.set(code, clamp01(0.5 + (width - mid) / EDGE_BAND));
  }
  const entered = ranked.reduce((n, c) => n + handCombos(c) * (freq.get(c) ?? 0), 0);
  const percentile = new Map<string, number>();
  let above = 0;
  for (const code of ranked) {
    const w = handCombos(code) * (freq.get(code) ?? 0);
    percentile.set(code, entered > 0 && w > 0 ? (above + w / 2) / entered : 1);
    above += w;
  }
  const table = { freq, percentile };
  byLoose.set(openLooseness, table);
  return table;
}

/**
 * RFI node (folded to the bot): probability this hand enters the pot. The seat's chart
 * is the looseness-0.5 baseline; tighter archetypes trim its weakest hands, looser ones
 * extend it by strength, so a nit and a maniac open measurably different ranges.
 */
export function rfiOpenFreq(chart: Set<string>, code: string, openLooseness: number): number {
  if (chart.size === 0) return 0;
  return openFreqTable(chart, openLooseness).freq.get(code) ?? 0;
}

/** Where this hand sits in the bot's own entering range: 0 = its best hand, 1 = its worst
 *  (or outside the range). */
export function entryPercentile(chart: Set<string>, code: string, openLooseness: number): number {
  if (chart.size === 0) return 1;
  return openFreqTable(chart, openLooseness).percentile.get(code) ?? 1;
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
 * Facing a 3-bet: the share of its OWN entering range a bot continues with. A fixed
 * continue list folds a wide opener 85–95% of the time, which makes a 3-bet with any two
 * cards profitable; scaling by range keeps fold-to-3-bet near live norms (nit/tag ~60%,
 * station/maniac ~40–45%). Stations continue by calling, aggressive types by fighting back.
 */
export function vs3BetContinueShare(
  profile: { callRaiseLooseness: number; aggression: number },
  inPosition: boolean,
): number {
  return clamp01(
    0.3 + profile.callRaiseLooseness * 0.3 + Math.max(0, profile.aggression - 0.7) * 0.6 + (inPosition ? 0.08 : 0),
  );
}

/** Share of all hands stronger than this one (midpoint), by preflopStrength. */
const STRENGTH_PCT: Map<string, number> = (() => {
  const ranked = [...ALL_CODES].sort((a, b) => preflopStrength(b) - preflopStrength(a));
  const pct = new Map<string, number>();
  let cum = 0;
  for (const c of ranked) {
    const share = handCombos(c) / 1326;
    pct.set(c, cum + share / 2);
    cum += share;
  }
  return pct;
})();
export const strengthPercentile = (code: string): number => STRENGTH_PCT.get(code) ?? 1;

export type DefendSeat = 'BB' | 'SB' | 'cold';

export interface VsOpenPlan {
  /** share of ALL hands that 3-bet */
  threeBet: number;
  /** share of ALL hands that continue (3-bet + call) */
  cont: number;
}

/**
 * Facing a single open: how much of the deck 3-bets and how much continues. Anchored on
 * a ~2.5x CO open (≈25% range): tag ~6% 3-bet / ~12% cold-call VPIP, maniac ~13% 3-bet,
 * station ~1% 3-bet but calls wide, BB defends ~40–60%. Scales with the opener's width
 * (a button steal gets defended wider than a UTG open) and with the price.
 */
export function vsOpenPlan(
  profile: { threeBetFreq: number; aggression: number; callRaiseLooseness: number },
  seat: DefendSeat,
  openerShare: number,
  requiredEquity: number,
): VsOpenPlan {
  const cr = clamp01(profile.callRaiseLooseness);
  const widthMult = Math.pow(Math.max(0.05, openerShare) / 0.25, 0.6);
  const blindMult = seat === 'cold' ? 1 : 1.3;
  const threeBet = clamp01(
    (profile.threeBetFreq * 0.1 + Math.max(0, profile.aggression - 0.7) * 0.15) * blindMult * widthMult,
  );
  // Cheaper price → wider defence. Reference = the price of a 2.5x open at each seat.
  const refReq = seat === 'BB' ? 0.3 : 0.4;
  const priceMult = Math.max(0.15, Math.min(1.3, refReq / Math.max(0.05, requiredEquity)));
  const flat =
    seat === 'BB' ? 0.14 + cr * 0.55 : seat === 'SB' ? Math.max(0, cr - 0.7) * 0.5 : Math.max(0, cr * 0.24 - 0.015);
  const cont = clamp01(Math.max(threeBet, (threeBet + flat * Math.sqrt(widthMult)) * priceMult));
  return { threeBet: Math.min(threeBet, cont), cont };
}
