// House rake. A percentage of the pot capped in absolute chips, plus the flat
// promo/bad-beat drop most live rooms take alongside it. The cap is what makes
// rake *regressive*: it is a flat tax on small pots and near-zero on big ones,
// which is why it kills marginal preflop opens and thin river value bets while
// barely touching a stacks-in cooler.
//
// "No flop, no drop": a hand that ends before the flop is not raked. Callers
// decide that (the engine gates on board.length); every postflop node is raked.

export type RakeProfileId = 'none' | 'online' | 'live-1-2' | 'live-2-5' | 'live-5-10';

export interface RakeProfile {
  id: RakeProfileId;
  label: string;
  pct: number; // fraction of the pot taken
  capBB: number; // rake cap, in big blinds
  dropBB: number; // flat jackpot/promo drop, in big blinds
  note: string;
}

export const RAKE_PROFILES: RakeProfile[] = [
  { id: 'none', label: 'None (solver-style)', pct: 0, capBB: 0, dropBB: 0, note: 'Rake-free EV, like a solver output.' },
  {
    id: 'online',
    label: 'Online 5% cap 1.5bb',
    pct: 0.05,
    capBB: 1.5,
    dropBB: 0,
    note: 'Typical mid-stakes online: 5% of the pot, capped around 1.5bb, no promo drop.',
  },
  {
    id: 'live-1-2',
    label: 'Live $1/$2 — 10% to $4 + $1',
    pct: 0.1,
    capBB: 2,
    dropBB: 0.5,
    note: 'The heaviest common structure: at $2 blinds the cap is 2bb and the drop another 0.5bb.',
  },
  {
    id: 'live-2-5',
    label: 'Live $2/$5 — 10% to $5 + $1',
    pct: 0.1,
    capBB: 1,
    dropBB: 0.2,
    note: 'Same percentage as $1/$2 but a far lighter cap in big blinds.',
  },
  {
    id: 'live-5-10',
    label: 'Live $5/$10 — 10% to $6 + $1',
    pct: 0.1,
    capBB: 0.6,
    dropBB: 0.1,
    note: 'Cap barely over half a blind — rake stops driving strategy at this level.',
  },
];

export function rakeProfile(id: RakeProfileId): RakeProfile {
  return RAKE_PROFILES.find((p) => p.id === id) ?? RAKE_PROFILES[0];
}

/** Rake denominated in chips, so consumers never need the big blind again. */
export interface Rake {
  pct: number;
  cap: number;
  drop: number;
}

export function rakeInChips(id: RakeProfileId, bigBlind: number): Rake | undefined {
  const p = rakeProfile(id);
  if (p.pct <= 0 && p.dropBB <= 0) return undefined;
  return { pct: p.pct, cap: p.capBB * bigBlind, drop: p.dropBB * bigBlind };
}

/** Chips the house takes from a pot of `pot`. Never more than the pot itself. */
export function rakeOn(rake: Rake | undefined, pot: number): number {
  if (!rake || pot <= 0) return 0;
  return Math.min(pot, Math.min(rake.pct * pot, rake.cap) + rake.drop);
}

/** What the winner actually collects from a pot of `pot`. */
export function netPot(rake: Rake | undefined, pot: number): number {
  return pot - rakeOn(rake, pot);
}

/** d(rake)/d(pot) — the tax on the NEXT chip won. Zero past the cap, which is why
 *  extra value is cheap in a big pot and expensive in a small one. */
export function rakeMarginal(rake: Rake | undefined, pot: number): number {
  if (!rake || pot <= 0) return 0;
  return rake.pct * pot >= rake.cap ? 0 : rake.pct;
}
