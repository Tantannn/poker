// Pre-lock measuring aid for the equity drill: split villain's range into the
// hand-strength piles you would sort at the table, then let the user price each pile.
import type { Card } from '../engine/cards';
import { buildSampleTable } from '../engine/range';
import type { ComboWeight, WeightedRange } from '../engine/range';
import { comboEquity } from '../engine/equity';
import { classifyHandClass } from './handClass';

export const TALLY_STEPS = [0, 25, 50, 75, 100] as const;
export const UNTOUCHED_PCT = 50;

const GROUPS = [
  { id: 'nuts', label: 'Straight / flush / boat+', match: /^(Straight Flush|Four of a Kind|Full House|Nut Flush|Flush|Straight)$/ },
  { id: 'set', label: 'Set / trips', match: /^(Set|Trips)$/ },
  { id: 'twopair', label: 'Two pair', match: /^Two Pair$/ },
  { id: 'toppair', label: 'Overpair / top pair', match: /^(Overpair|Top Pair)/ },
  { id: 'weakpair', label: 'Weaker pair', match: /Pair|Playing the Board/ },
  { id: 'draw', label: 'Draws', match: /Draw/ },
  { id: 'air', label: 'Air / overcards', match: /./ },
] as const;

export interface TallyGroup {
  id: string;
  label: string;
  share: number;
  members: { combo: [Card, Card]; weight: number }[];
}

function groupIdOf(label: string): string {
  return GROUPS.find((g) => g.match.test(label))!.id;
}

export function buildTallyGroups(
  hero: Card[],
  board: Card[],
  range: WeightedRange,
  comboWeight?: ComboWeight,
): TallyGroup[] {
  const table = buildSampleTable(range, [...hero, ...board], comboWeight);
  if (table.total <= 0) return [];
  const byId = new Map<string, TallyGroup>();
  let prev = 0;
  table.combos.forEach((combo, i) => {
    const weight = table.cum[i] - prev;
    prev = table.cum[i];
    const id = groupIdOf(classifyHandClass([...combo], board).label);
    const def = GROUPS.find((g) => g.id === id)!;
    const group = byId.get(id) ?? { id, label: def.label, share: 0, members: [] };
    group.share += weight / table.total;
    group.members.push({ combo, weight });
    byId.set(id, group);
  });
  return GROUPS.flatMap((g) => byId.get(g.id) ?? []);
}

export function tallyEstimate(groups: TallyGroup[], picks: Record<string, number>): number {
  return groups.reduce((sum, g) => sum + g.share * (picks[g.id] ?? UNTOUCHED_PCT), 0);
}

/** What each pile is REALLY worth to hero — computed only after the guess is locked. */
export function groupTruth(hero: Card[], board: Card[], group: TallyGroup): number {
  const needBoard = 5 - board.length;
  let weighted = 0;
  let total = 0;
  for (const { combo, weight } of group.members) {
    weighted += weight * comboEquity(hero, board, combo, needBoard, Math.random);
    total += weight;
  }
  return total > 0 ? (100 * weighted) / total : 0;
}

export function exampleCombos(group: TallyGroup, n = 3): [Card, Card][] {
  const seen = new Set<string>();
  const out: [Card, Card][] = [];
  const heaviestFirst = [...group.members].sort((a, b) => b.weight - a.weight);
  for (const { combo } of heaviestFirst) {
    const hi = combo[0].rank >= combo[1].rank ? combo[0] : combo[1];
    const lo = hi === combo[0] ? combo[1] : combo[0];
    const type = `${hi.rank}-${lo.rank}-${hi.suit === lo.suit}`;
    if (seen.has(type)) continue;
    seen.add(type);
    out.push(combo);
    if (out.length >= n) break;
  }
  return out;
}

// Rule of 4 (flop, two cards to come) overshoots past 8 outs by one point per extra out.
// Rule of 2 on the turn is accurate enough as is.
export function ruleOfFourEstimate(outs: number, street: 'Flop' | 'Turn'): number {
  if (street === 'Turn') return outs * 2;
  return outs * 4 - Math.max(0, outs - 8);
}
