// Shared types for the heuristic strategy ("solver-model") engine.

import type { WeightedRange } from '../engine/range';

export type ActionId =
  | 'fold'
  | 'check'
  | 'call'
  | 'bet33'
  | 'bet50'
  | 'bet75'
  | 'betpot'
  | 'allin'
  | 'raise'        // generic raise (preflop 3-bet/4-bet or postflop raise)
  | 'open';        // preflop RFI open

export interface ActionOption {
  id: ActionId;
  label: string;
  freq: number; // mixed-strategy frequency 0..1
  ev: number; // expected value in big blinds
  /** raise/bet target as total chips committed this street (for execution), if applicable. */
  amount?: number;
  /** size as fraction of pot, for display. */
  sizePct?: number;
  /** sub-classification for chart coloring (e.g. value vs bluff). */
  kind?: 'fold' | 'call' | 'value' | 'bluff' | 'passive' | 'aggressive';
  /** plain-English reason this action has the EV/frequency it does. */
  why?: string;
  /** the EV calculation written out with the actual numbers plugged in. */
  math?: string;
  /** compact range-balance note for a BET/RAISE size: on the river the value:bluff
   *  balance ("~33% bluffs · 2:1"), on the flop/turn the opponent's minimum-defence
   *  frequency ("villain defends ~57%"). Undefined for check/call/fold. */
  sizeNote?: string;
}

export interface NodeStrategy {
  options: ActionOption[];
  bestEv: number;
  bestId: ActionId;
  source: 'preflop-chart' | 'postflop-model';
  note: string;
  /** hero equity vs the opponent range at this node (0..1), when computed. */
  equity?: number;
  rangeNote?: string;
  /** hero's 169-code, for highlighting the cell in the chart popup. */
  heroCode?: string;
  /** preflop scenario id (for the chart popup), when source is preflop-chart. */
  scenarioId?: string;
  /** villain range (for the chart popup), when source is postflop-model. */
  villainRange?: WeightedRange;
}

/** Map an executed action to the closest strategy option id, to score EV loss. */
export function evLoss(strategy: NodeStrategy, chosenId: ActionId): number {
  const opt = strategy.options.find((o) => o.id === chosenId);
  const chosenEv = opt ? opt.ev : Math.min(...strategy.options.map((o) => o.ev), 0);
  return Math.max(0, strategy.bestEv - chosenEv);
}

/** Given an RNG roll 1..100, which option does the mixed strategy prescribe? */
export function rngPrescription(strategy: NodeStrategy, roll: number): ActionId {
  let cum = 0;
  const sorted = [...strategy.options].filter((o) => o.freq > 0).sort((a, b) => b.freq - a.freq);
  for (const o of sorted) {
    cum += o.freq * 100;
    if (roll <= cum + 1e-9) return o.id;
  }
  return sorted.length ? sorted[sorted.length - 1].id : strategy.bestId;
}

/** Softmax-style mixing: actions near the top EV get frequency; dominated ones ~0. */
export function mixFromEv(
  evs: { id: ActionId; ev: number }[],
  temperature = 0.45,
  window = 1.2,
): Map<ActionId, number> {
  const out = new Map<ActionId, number>();
  if (evs.length === 0) return out;
  const best = Math.max(...evs.map((e) => e.ev));
  const eligible = evs.filter((e) => e.ev >= best - window);
  let sum = 0;
  const exps = eligible.map((e) => {
    const v = Math.exp((e.ev - best) / temperature);
    sum += v;
    return v;
  });
  eligible.forEach((e, i) => out.set(e.id, exps[i] / sum));
  for (const e of evs) if (!out.has(e.id)) out.set(e.id, 0);
  return out;
}
