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
  | 'bet150'      // polar overbet (1½× pot) — only a range-vs-range solve prices it
  | 'allin'
  | 'raise'        // generic raise (preflop 3-bet/4-bet or postflop raise)
  | 'raisebig'     // the larger of two postflop raise sizes facing a bet
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
  /** hero's equity WHEN CALLED (0..1) for a bet/raise — i.e. vs the part of
   *  villain's range that continues. Falls as the size grows (bigger bet → only
   *  stronger hands call). Used to coach oversizing. Undefined for check/call/fold. */
  calledEq?: number;
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

/** The gap between the balanced (GTO-baseline) line and the line that maximises EV
 *  against a specific, off-balanced opponent. `gainBb` is what the exploit is worth
 *  per hand at this node — the number that justifies deviating at all.
 *
 *  Both lines are solved at the SAME node with the SAME hero range; only the villain
 *  model differs. `gainBb` is measured in the exploit solve's own EV frame (how much
 *  the exploit action beats the baseline action against THIS villain), because that
 *  is the question the player is asking: "what does deviating win me here?" */
export interface ExploitDelta {
  /** the action the balanced model prefers */
  baselineId: ActionId;
  baselineLabel: string;
  /** the action the villain-specific model prefers */
  exploitId: ActionId;
  exploitLabel: string;
  /** bb gained by taking the exploit line instead of the baseline line vs this villain */
  gainBb: number;
  /** why this villain's tendencies move the line */
  why: string;
  /** 'locked' when the user set the read by hand, else how firm the observed read is */
  confidence: number;
  source: 'observed' | 'locked';
}

/** The same node with the villain treated as BALANCED — the plain chart line before
 *  any read moved it. Present only when a read actually changed the mix, so the panel
 *  can put the two side by side: seeing what you'd do against an unknown is what makes
 *  the deviation legible as a deviation rather than as "the answer". */
export interface BaselineMix {
  /** what the baseline is, e.g. "BTN open chart" */
  label: string;
  options: ActionOption[];
  bestId: ActionId;
}

/** One observed/locked number behind a read, with everything needed to judge it:
 *  where it sits against balanced, how much evidence is behind it, whether it moves
 *  THIS node, and what to watch for at a live table to confirm it. */
export interface ReadStat {
  label: string;
  value: number;
  baseline: number;
  /** decisions behind the number; 0 when locked by hand */
  sample: number;
  /** does this stat price anything at this node, or is it just context? */
  active: boolean;
  effect: string;
  spot: string;
}

/** Why the mix moved: the numbers, the per-action deltas, and the caveat. Preflop
 *  only — the postflop engines carry their read in `ExploitDelta.why`. */
export interface ReadDetail {
  source: 'observed' | 'locked';
  confidence: number;
  /** whose tendencies moved this node */
  who: string;
  headline: string;
  stats: ReadStat[];
  moves: { id: ActionId; label: string; from: number; to: number; why: string }[];
  caution: string;
}

export interface NodeStrategy {
  options: ActionOption[];
  bestEv: number;
  bestId: ActionId;
  source: 'preflop-chart' | 'postflop-model';
  /** How a `postflop-model` node was actually computed: `cfr` = a real range-vs-range
   *  CFR solve (riverAdapter), `heuristic` = the per-hand EV model (postflopModel), which
   *  answers everything the solver gates don't reach (villain-first multiway, facing-a-bet
   *  multiway, a read carve-out). The UI badges the two differently so a teaching estimate is
   *  never presented as solver output (README). Undefined for `preflop-chart`. */
  engine?: 'cfr' | 'heuristic';
  note: string;
  /** `note` split into one line per idea, for bulleted rendering. Postflop only;
   *  preflop leaves this undefined and the paragraph `note` is used. */
  notes?: string[];
  /** hero equity vs the opponent range at this node (0..1), when computed. */
  equity?: number;
  rangeNote?: string;
  /** Set when the node was solved against an off-balanced villain model (a read or a
   *  manual node lock) AND the balanced line differs — the "GTO says X, vs THIS
   *  player do Y" delta. Absent when the villain is balanced or the two lines agree. */
  exploit?: ExploitDelta;
  /** the un-adjusted chart mix, when a read moved this node (preflop only). */
  baseline?: BaselineMix;
  /** the read that moved it, broken out stat by stat (preflop only). */
  readDetail?: ReadDetail;
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
