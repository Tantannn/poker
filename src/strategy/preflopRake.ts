// RAKE ADJUSTMENT for preflop chart frequencies — the half of the rake model the
// engine-level `rake.ts` never reached. `GameState.rake` is charged on every pot the
// table awards, but the preflop charts are static ~100bb tables, so hero was being
// graded rake-free in exactly the spots the drop kills: the small-blind flat, the thin
// cold-call, the marginal steal.
//
// Two mechanics carry it, and neither is a flat frequency cut:
//
//   THE CAP MAKES IT REGRESSIVE. `rakeOn` is a percentage capped in chips plus a flat
//   drop, so the tax RATE on a small preflop pot is several times the rate on a big
//   one. That is why rake bites the marginal tail and leaves coolers alone — the same
//   taper the read layer uses (`marginality`), for the same reason.
//
//   NO FLOP, NO DROP. A pot that ends preflop is never raked. So folding is untaxed,
//   RAISING is taxed only on the branch where someone calls, and CALLING is taxed in
//   full — a call guarantees a flop. The live lesson falls straight out of that: rake
//   pushes you toward raise-or-fold and away from flatting.
//
// This is a teaching-standard approximation of that axis, not rake-solved charts.
// Disclosed gap: the bots don't see it — `ai/decide.ts` plays its charts rake-free, so
// this shades what hero is TAUGHT, not how the table plays.

import { rakeInChips, rakeOn, type RakeProfileId } from '../engine/rake';
import { marginality } from './preflopModel';

/** Share of a RAISE's tax that survives "no flop, no drop" — the branch where hero gets
 *  called and a flop is dealt. Multiway there is almost always a caller, so the relief
 *  a heads-up steal enjoys is mostly gone. */
const RAISE_TAX_SHARE = 0.5;
const RAISE_TAX_SHARE_MULTIWAY = 0.8;
/** Floor on the multiplier: rake shades a marginal cell, it never deletes it. */
const MIN_MULT = 0.55;

/** Effective rake rate on a pot of `potBB` big blinds — the cap and drop make this a
 *  function of pot size, not a constant. 0 when the table is rake-free. */
export function rakeTaxRate(rakeId: RakeProfileId | undefined, potBB: number): number {
  if (!rakeId || rakeId === 'none' || potBB <= 0) return 0;
  const rake = rakeInChips(rakeId, 1); // work in big blinds; bb = 1 chip
  return rakeOn(rake, potBB) / potBB;
}

/** Per-action multiplier on a charted preflop frequency. Aggressive actions keep the
 *  fold-equity relief; calls pay the full rate; fold is the residual (never scaled). */
function multFor(id: string, tax: number, m: number, multiway: boolean): number {
  if (id === 'fold' || id === 'check') return 1;
  const share = id === 'call' ? 1 : multiway ? RAISE_TAX_SHARE_MULTIWAY : RAISE_TAX_SHARE;
  return Math.max(MIN_MULT, 1 - tax * m * share);
}

/**
 * Shade a charted mix for the house rake, giving the slack to FOLD so the mix still
 * sums to 1 — same contract as `shadeForDepth`, and fold is the residual for the same
 * reason: a hand that plays worse under rake should fold more BECAUSE its playing
 * frequencies dropped, not on top of it.
 *
 * Unlike depth this is per-ACTION, because rake is not symmetric across them: the
 * un-raked preflop-fold-out branch is what makes a raise cheaper than a call.
 */
export function shadeForRake<T extends { id: string; freq: number }>(
  options: T[],
  code: string,
  rakeId: RakeProfileId | undefined,
  potBB: number,
  multiway: boolean,
): T[] {
  const tax = rakeTaxRate(rakeId, potBB);
  const m = marginality(code);
  if (tax <= 0 || m <= 0 || options.length === 0) return options;
  const fold = options.find((o) => o.id === 'fold');
  if (!fold) return options; // nothing to absorb it (e.g. a free check) — leave it
  const playedBefore = options.reduce((a, o) => a + (o.id === 'fold' ? 0 : o.freq), 0);
  if (playedBefore <= 0) return options;
  const shaded = options.map((o) =>
    o.id === 'fold' ? o : { ...o, freq: o.freq * multFor(o.id, tax, m, multiway) },
  );
  const playedAfter = shaded.reduce((a, o) => a + (o.id === 'fold' ? 0 : o.freq), 0);
  return shaded.map((o) => (o.id === 'fold' ? { ...o, freq: Math.max(0, 1 - playedAfter) } : o));
}

/** One line explaining a rake adjustment, or undefined when the chart stands as written. */
export function rakeNote(
  code: string,
  rakeId: RakeProfileId | undefined,
  potBB: number,
  multiway: boolean,
): string | undefined {
  const tax = rakeTaxRate(rakeId, potBB);
  const m = marginality(code);
  if (tax <= 0 || m <= 0) return undefined;
  const callMult = multFor('call', tax, m, multiway);
  if (callMult > 0.97) return undefined;
  const pct = (tax * 100).toFixed(0);
  return `Rake: the house takes ~${pct}% of a pot this size, and ${code} is marginal enough that it matters — the flat loses most (a call always sees a flop and is always raked), the raise least (no flop, no drop: a steal that ends it preflop pays nothing). Under rake, marginal hands are raise-or-fold.`;
}
