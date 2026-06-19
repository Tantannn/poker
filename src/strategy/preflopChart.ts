// Scenario-based preflop strategy charts with mixed frequencies and action
// kinds (fold / call / 3-bet value / 3-bet bluff / 4-bet) for the 13x13 grid
// and for live preflop feedback.

import type { Position } from '../engine/table';
import { buildRange } from '../ai/preflop';
import type { ActionId, ActionOption } from './types';

export type Facing = 'rfi' | 'vsopen' | 'vs3bet';

export interface PreflopScenario {
  id: string;
  label: string;
  short: string;
  facing: Facing;
  heroPos: Position;
  villainPos?: Position;
  bluffFreq: number;
  open?: Set<string>;
  mixOpen?: Set<string>;
  value?: Set<string>; // 3-bet / 4-bet for value
  bluff?: Set<string>; // 3-bet / 4-bet bluffs (semi-mixed)
  call?: Set<string>;
}

function S(tokens: string[]): Set<string> {
  return buildRange(tokens);
}

// ---- RFI opening ranges (reuse teaching baselines) ----
const RFI: Record<Position, string[]> = {
  UTG: ['22+', 'A9s+', 'A5s-A4s', 'KTs+', 'QTs+', 'JTs', 'T9s', '98s', 'AJo+', 'KQo'],
  MP: ['22+', 'A8s+', 'A5s-A4s', 'K9s+', 'QTs+', 'JTs', 'T9s', '98s', '87s', 'ATo+', 'KJo+', 'QJo'],
  CO: ['22+', 'A2s+', 'K8s+', 'Q9s+', 'J9s+', 'T8s+', '97s+', '86s+', '76s', '65s', '54s', 'A9o+', 'KTo+', 'QTo+', 'JTo'],
  BTN: ['22+', 'A2s+', 'K2s+', 'Q5s+', 'J7s+', 'T7s+', '96s+', '86s+', '75s+', '64s+', '54s', '43s', 'A2o+', 'K7o+', 'Q9o+', 'J9o+', 'T8o+', '98o', '87o'],
  SB: ['22+', 'A2s+', 'K4s+', 'Q6s+', 'J7s+', 'T7s+', '96s+', '85s+', '75s+', '64s+', '54s', 'A4o+', 'K8o+', 'Q9o+', 'J9o+', 'T9o'],
  BB: [],
};

const MIX_OPEN: Partial<Record<Position, string[]>> = {
  UTG: ['A8s', 'KJo', 'QJo', '76s'],
  MP: ['A7s', 'A5o', 'K9o', '65s'],
  CO: ['K7s', 'Q8s', 'A8o', 'J8o'],
  BTN: ['Q4s', 'J6s', 'K6o', 'Q8o', '53s'],
  SB: ['Q5s', 'J6s', 'K7o', 'Q8o', '64s'],
};

const POS_LIST: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB'];

export const SCENARIOS: PreflopScenario[] = [
  ...POS_LIST.map((p) => ({
    id: `rfi-${p}`,
    label: `RFI — Open from ${p}`,
    short: `${p} Open`,
    facing: 'rfi' as Facing,
    heroPos: p,
    bluffFreq: 0.5,
    open: S(RFI[p]),
    mixOpen: S(MIX_OPEN[p] ?? []),
  })),
  {
    id: 'btn-vs-utg',
    label: 'BTN vs UTG open',
    short: 'BTN v UTG',
    facing: 'vsopen',
    heroPos: 'BTN',
    villainPos: 'UTG',
    bluffFreq: 0.5,
    value: S(['TT+', 'AQs+', 'AKo', 'AJs']),
    bluff: S(['A5s-A2s', 'KJs', 'QTs', 'J9s']),
    call: S(['22-99', 'AJo', 'KQs', 'KQo', 'ATs', 'KTs', 'QJs', 'JTs', 'T9s', '98s', 'AQo']),
  },
  {
    id: 'co-vs-utg',
    label: 'CO vs UTG open',
    short: 'CO v UTG',
    facing: 'vsopen',
    heroPos: 'CO',
    villainPos: 'UTG',
    bluffFreq: 0.4,
    value: S(['QQ+', 'AKs', 'AKo', 'AQs']),
    bluff: S(['A5s-A4s', 'KJs']),
    call: S(['22-JJ', 'AJs', 'ATs', 'KQs', 'AQo', 'QJs', 'JTs', 'T9s', 'AJo']),
  },
  {
    id: 'bb-vs-btn',
    label: 'BB vs BTN open (defense)',
    short: 'BB v BTN',
    facing: 'vsopen',
    heroPos: 'BB',
    villainPos: 'BTN',
    bluffFreq: 0.4,
    value: S(['TT+', 'AQs+', 'AKo', 'AJs', 'KQs']),
    bluff: S(['A9s-A2s', 'K9s', 'Q9s', 'J9s', '97s', '86s', '75s', '54s']),
    call: S([
      '22-99', 'A2s+', 'K2s+', 'Q4s+', 'J6s+', 'T6s+', '95s+', '85s+', '74s+', '64s+', '53s+', '43s',
      'A2o+', 'K7o+', 'Q8o+', 'J8o+', 'T8o+', '98o', '87o',
    ]),
  },
  {
    id: 'bb-vs-sb',
    label: 'BB vs SB open',
    short: 'BB v SB',
    facing: 'vsopen',
    heroPos: 'BB',
    villainPos: 'SB',
    bluffFreq: 0.45,
    value: S(['99+', 'AJs+', 'AQo+', 'KQs']),
    bluff: S(['A8s-A2s', 'K8s', 'Q8s', 'J8s', 'T8s', '97s', '86s', '75s', '64s']),
    call: S([
      '22-88', 'A2s+', 'K2s+', 'Q5s+', 'J7s+', 'T7s+', '96s+', '85s+', '74s+', '64s+', '53s+',
      'A2o+', 'K6o+', 'Q8o+', 'J8o+', 'T8o+', '98o',
    ]),
  },
  {
    id: 'btn-vs-3bet',
    label: 'BTN open vs a 3-bet',
    short: 'BTN v 3B',
    facing: 'vs3bet',
    heroPos: 'BTN',
    bluffFreq: 0.5,
    value: S(['QQ+', 'AKs', 'AKo']),
    bluff: S(['A5s', 'A4s', 'KQs']),
    call: S(['TT-77', 'AQs', 'AJs', 'KQo', 'AQo', 'JTs', 'T9s']),
  },
];

export function getScenario(id: string): PreflopScenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Per-cell strategy for a 169-code in a scenario. Frequencies sum to ~1. */
export function cellStrategy(sc: PreflopScenario, code: string): ActionOption[] {
  const opts: ActionOption[] = [];
  if (sc.facing === 'rfi') {
    if (sc.open?.has(code)) opts.push(mk('open', 'Open', 1, 'value'));
    else if (sc.mixOpen?.has(code)) {
      opts.push(mk('open', 'Open', 0.5, 'value'));
      opts.push(mk('fold', 'Fold', 0.5, 'fold'));
    } else opts.push(mk('fold', 'Fold', 1, 'fold'));
    return opts;
  }
  // vs open / vs 3bet
  const raiseLabel = sc.facing === 'vs3bet' ? '4-Bet' : '3-Bet';
  if (sc.value?.has(code)) {
    opts.push(mk('raise', `${raiseLabel} (value)`, 1, 'value'));
  } else if (sc.bluff?.has(code)) {
    const bf = sc.bluffFreq;
    opts.push(mk('raise', `${raiseLabel} (bluff)`, bf, 'bluff'));
    if (sc.call?.has(code)) opts.push(mk('call', 'Call', 1 - bf, 'call'));
    else opts.push(mk('fold', 'Fold', 1 - bf, 'fold'));
  } else if (sc.call?.has(code)) {
    opts.push(mk('call', 'Call', 1, 'call'));
  } else {
    opts.push(mk('fold', 'Fold', 1, 'fold'));
  }
  return opts;
}

function mk(id: ActionId, label: string, freq: number, kind: ActionOption['kind']): ActionOption {
  return { id, label, freq, ev: 0, kind };
}

/** Dominant action kind for grid coloring. */
export function dominantKind(opts: ActionOption[]): ActionOption['kind'] {
  return [...opts].sort((a, b) => b.freq - a.freq)[0]?.kind ?? 'fold';
}
