import type { NodeFeedback } from './grade';
import type { ActionId } from '@/strategy/core';

import type { Card } from '@/engine/cards';

import type { ActionRecord } from '@/engine/table';


// Below this a miss is mix-noise inside a mixed strategy, not a leak worth reviewing.
export const BLOCK_MISTAKE_BB = 0.3;
export const BLOCK_SIZES = [10, 20, 30, 50] as const;

export interface BlockEntry {
  handNumber: number;
  street: string;
  heroCards: Card[];
  board: Card[];
  /** this hand's betting up to (not including) the graded decision */
  actions: ActionRecord[];
  /** hero's net bb for the whole hand — filled in once the hand completes */
  resultBB?: number;
  fb: NodeFeedback;
}

export type LeakKind = 'passiveCall' | 'missedValue' | 'overFold' | 'overAggro' | 'sizing';

export const LEAK_LABEL: Record<LeakKind, string> = {
  passiveCall: 'Called where raise/fold was better (marry-hand)',
  missedValue: 'Checked where a bet/raise was better',
  overFold: 'Folded too much',
  overAggro: 'Bet/raised where check/call/fold was better',
  sizing: 'Right to bet, wrong size',
};

export interface LeakBucket {
  kind: LeakKind;
  label: string;
  count: number;
  evLoss: number;
}

export interface BlockSummary {
  hands: number;
  decisions: number;
  mistakes: number;
  evLoss: number;
  evLossPer100: number;
  byStreet: { street: string; decisions: number; evLoss: number }[];
  leaks: LeakBucket[];
  worst: BlockEntry[];
  callsWhenRaiseOrFold: number;
}

const isAggro = (id: ActionId) => id.startsWith('bet') || id.startsWith('raise') || id === 'allin' || id === 'open';

export function classifyLeak(chosen: ActionId, best: ActionId): LeakKind | null {
  if (chosen === best) return null;
  if (chosen === 'call') return isAggro(best) || best === 'fold' ? 'passiveCall' : null;
  if (chosen === 'fold') return 'overFold';
  if (chosen === 'check') return isAggro(best) ? 'missedValue' : null;
  if (isAggro(chosen)) return isAggro(best) ? 'sizing' : 'overAggro';
  return null;
}

const STREETS = ['preflop', 'flop', 'turn', 'river'];

export function summarizeBlock(entries: BlockEntry[], hands: number, worstCount = 5): BlockSummary {
  const mistakes = entries.filter((e) => e.fb.evLoss >= BLOCK_MISTAKE_BB);
  const evLoss = entries.reduce((s, e) => s + Math.max(0, e.fb.evLoss), 0);

  const byStreet = STREETS.map((street) => {
    const on = entries.filter((e) => e.street === street);
    return { street, decisions: on.length, evLoss: on.reduce((s, e) => s + Math.max(0, e.fb.evLoss), 0) };
  }).filter((s) => s.decisions > 0);

  const buckets = new Map<LeakKind, LeakBucket>();
  for (const e of mistakes) {
    const kind = classifyLeak(e.fb.chosen, e.fb.best);
    if (!kind) continue;
    const b = buckets.get(kind) ?? { kind, label: LEAK_LABEL[kind], count: 0, evLoss: 0 };
    b.count++;
    b.evLoss += e.fb.evLoss;
    buckets.set(kind, b);
  }

  return {
    hands,
    decisions: entries.length,
    mistakes: mistakes.length,
    evLoss,
    evLossPer100: hands > 0 ? (evLoss / hands) * 100 : 0,
    byStreet,
    leaks: [...buckets.values()].sort((a, b) => b.evLoss - a.evLoss),
    worst: [...mistakes].sort((a, b) => b.fb.evLoss - a.fb.evLoss).slice(0, worstCount),
    callsWhenRaiseOrFold: buckets.get('passiveCall')?.count ?? 0,
  };
}
