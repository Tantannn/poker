// ICM (Independent Chip Model) for the single-table tournament. Chips are not
// money in a tournament: doubling your stack does NOT double your prize equity,
// because payouts are capped per place — so late-tournament (especially bubble)
// decisions must weigh $EV, not chip EV. This module gives the two pieces the
// UI needs: the payout structure, and each stack's Malmuth–Harville $ equity.

/** Prize-pool split (fraction by 1-indexed place) for a single-table freezeout:
 *  winner-take-all when tiny, top-2 short-handed, top-3 once it's a full ring —
 *  the standard SNG payout shape. Prize pool = one buy-in per entrant. */
export function payoutTable(field: number): number[] {
  if (field <= 3) return [1];
  if (field <= 5) return [0.65, 0.35];
  return [0.5, 0.3, 0.2];
}

/**
 * Malmuth–Harville ICM: each stack's expected share of the prize pool.
 * P(player i finishes 1st) = stack_i / total; the model then recurses — remove
 * the presumed winner and re-normalise for 2nd, and so on down the paid places.
 * Exact recursion is fine here: fields are ≤6 and payouts ≤3 deep.
 *
 * @param stacks chip counts (0 allowed — a busted stack has 0 equity)
 * @param payouts prize fraction per place, e.g. [0.5, 0.3, 0.2]
 * @returns equity per player, same order as `stacks`, summing to ~1
 */
export function icmEquities(stacks: number[], payouts: number[]): number[] {
  const n = stacks.length;
  const total = stacks.reduce((a, b) => a + b, 0);
  const out = new Array<number>(n).fill(0);
  if (total <= 0 || payouts.length === 0) return out;

  // recursive place-by-place: `alive` = indices still unassigned, `place` = the
  // 0-indexed finishing position being awarded, `prob` = probability of this branch.
  const walk = (alive: number[], place: number, prob: number) => {
    if (place >= payouts.length || alive.length === 0) return;
    const sum = alive.reduce((a, i) => a + stacks[i], 0);
    if (sum <= 0) return;
    for (const i of alive) {
      if (stacks[i] <= 0) continue;
      const p = prob * (stacks[i] / sum);
      out[i] += p * payouts[place];
      walk(alive.filter((j) => j !== i), place + 1, p);
    }
  };
  walk(Array.from({ length: n }, (_, i) => i), 0, 1);
  return out;
}

export interface IcmRead {
  /** hero's prize equity in buy-ins (pool = field × 1 buy-in). */
  equityBuyins: number;
  /** hero's equity as a share of the pool (0..1). */
  equityShare: number;
  /** places that cash. */
  paid: number;
  /** true when exactly one elimination remains before the money. */
  onBubble: boolean;
  /** true once everyone left is guaranteed a payout. */
  inTheMoney: boolean;
}

/** Hero's live ICM situation. `stacks` = every REMAINING player's chips (hero
 *  included), `field` = original entrant count (fixes the payout structure). */
export function icmRead(stacks: number[], heroIdx: number, field: number): IcmRead {
  const payouts = payoutTable(field);
  const eq = icmEquities(stacks, payouts);
  const alive = stacks.filter((s) => s > 0).length;
  return {
    equityBuyins: (eq[heroIdx] ?? 0) * field,
    equityShare: eq[heroIdx] ?? 0,
    paid: payouts.length,
    onBubble: alive === payouts.length + 1,
    inTheMoney: alive <= payouts.length,
  };
}
