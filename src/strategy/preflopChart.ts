// Scenario-based preflop strategy charts with mixed frequencies and action
// kinds (fold / call / 3-bet value / 3-bet bluff / 4-bet) for the 13x13 grid
// and for live preflop feedback.

import type { Position } from '../engine/table';
import { buildRange } from '../ai/preflop';
import type { ActionId, ActionOption } from './types';

export type Facing = 'rfi' | 'vsopen' | 'vs3bet' | 'vs4bet';

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
  MP: ['A7s', 'A9o', 'KTo', '65s'],
  CO: ['K7s', 'Q8s', 'A8o', 'J9o'],
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
    call: S(['22-99', 'AJo', 'KQs', 'KQo', 'ATs', 'KJs', 'KTs', 'QJs', 'JTs', 'T9s', '98s', 'AQo']),
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
    id: 'bb-vs-utg',
    label: 'BB vs UTG open (defense)',
    short: 'BB v UTG',
    facing: 'vsopen',
    heroPos: 'BB',
    villainPos: 'UTG',
    bluffFreq: 0.35,
    // vs the tightest open you defend tightest: 3-bet a narrow value range,
    // a sprinkle of suited-ace bluffs, flat pairs + suited broadways for set/
    // equity value. Trashy offsuit hands fold even at the BB price.
    value: S(['QQ+', 'AKs', 'AKo', 'AQs']),
    bluff: S(['A5s-A4s', 'KJs']),
    call: S([
      '22-JJ', 'ATs+', 'KTs+', 'QTs+', 'JTs', 'T9s', '98s', '87s', '76s', '65s',
      'AJo+', 'KQo', 'KQs',
    ]),
  },
  {
    id: 'bb-vs-mp',
    label: 'BB vs MP open (defense)',
    short: 'BB v MP',
    facing: 'vsopen',
    heroPos: 'BB',
    villainPos: 'MP',
    bluffFreq: 0.4,
    // a touch wider than vs UTG — MP opens a slightly looser range.
    value: S(['TT+', 'AQs+', 'AKo', 'AJs']),
    bluff: S(['A5s-A4s', 'KJs', 'KTs', '76s']),
    call: S([
      '22-99', 'A2s+', 'K9s+', 'Q9s+', 'J9s+', 'T9s', '98s', '87s', '76s', '65s', '54s',
      'ATo+', 'KJo+', 'QJo', 'KQs',
    ]),
  },
  {
    id: 'co-vs-mp',
    label: 'CO vs MP open',
    short: 'CO v MP',
    facing: 'vsopen',
    heroPos: 'CO',
    villainPos: 'MP',
    bluffFreq: 0.45,
    value: S(['JJ+', 'AQs+', 'AKo', 'AJs']),
    bluff: S(['A5s-A4s', 'KJs', 'QTs']),
    call: S(['22-TT', 'ATs', 'KQs', 'KQo', 'AQo', 'QJs', 'JTs', 'T9s', 'AJo', 'KJs']),
  },
  {
    id: 'btn-vs-co',
    label: 'BTN vs CO open',
    short: 'BTN v CO',
    facing: 'vsopen',
    heroPos: 'BTN',
    villainPos: 'CO',
    bluffFreq: 0.5,
    value: S(['TT+', 'AQs+', 'AKo', 'AJs', 'KQs']),
    bluff: S(['A5s-A2s', 'KJs', 'QTs', 'J9s', 'T9s']),
    call: S(['22-99', 'ATs', 'KJs', 'KTs', 'QJs', 'JTs', '98s', 'AQo', 'KQo', 'AJo']),
  },
  {
    id: 'btn-vs-mp',
    label: 'BTN vs MP open',
    short: 'BTN v MP',
    facing: 'vsopen',
    heroPos: 'BTN',
    villainPos: 'MP',
    bluffFreq: 0.5,
    // MP opens looser than UTG, tighter than CO — BTN sits in position and can
    // flat wide / 3-bet a polarized bluff range. Between the vs-UTG and vs-CO charts.
    value: S(['TT+', 'AQs+', 'AKo', 'AJs', 'KQs']),
    bluff: S(['A5s-A2s', 'KJs', 'QTs', 'J9s']),
    call: S(['22-99', 'ATs', 'KJs', 'KTs', 'QJs', 'JTs', 'T9s', '98s', 'AQo', 'KQo', 'AJo']),
  },
  {
    id: 'bb-vs-co',
    label: 'BB vs CO open (defense)',
    short: 'BB v CO',
    facing: 'vsopen',
    heroPos: 'BB',
    villainPos: 'CO',
    bluffFreq: 0.4,
    value: S(['TT+', 'AQs+', 'AKo', 'AJs', 'KQs']),
    bluff: S(['A9s-A2s', 'K9s', 'Q9s', 'J9s', 'T9s', '86s', '75s']),
    call: S([
      '22-99', 'A2s+', 'K5s+', 'Q7s+', 'J8s+', 'T8s+', '97s+', '86s+', '75s+', '64s+', '54s',
      'A7o+', 'K9o+', 'Q9o+', 'J9o+', 'T9o', '98o',
    ]),
  },
  {
    id: 'sb-vs-btn',
    label: 'SB vs BTN open (3-bet or fold)',
    short: 'SB v BTN',
    facing: 'vsopen',
    heroPos: 'SB',
    villainPos: 'BTN',
    bluffFreq: 0.55,
    value: S(['99+', 'ATs+', 'KQs', 'AQo+']),
    bluff: S(['A9s-A2s', 'KTs', 'K9s', 'QTs', 'Q9s', 'J9s', 'T9s', '98s']),
    call: S(['88-22', 'AJo', 'KQo', 'KJs', 'QJs', 'JTs']),
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
    call: S(['JJ-77', 'AQs', 'AJs', 'KQs', 'KQo', 'AQo', 'JTs', 'T9s']),
  },
  {
    id: 'co-vs-3bet',
    label: 'CO open vs a 3-bet',
    short: 'CO v 3B',
    facing: 'vs3bet',
    heroPos: 'CO',
    bluffFreq: 0.45,
    value: S(['QQ+', 'AKs', 'AKo']),
    bluff: S(['A5s', 'A4s']),
    call: S(['JJ-99', 'AQs', 'AJs', 'KQs', 'AQo', 'KQo']),
  },
  {
    id: 'utg-vs-3bet',
    label: 'UTG open vs a 3-bet',
    short: 'UTG v 3B',
    facing: 'vs3bet',
    heroPos: 'UTG',
    bluffFreq: 0.4,
    value: S(['KK+', 'AKs']),
    bluff: S(['A5s']),
    call: S(['QQ-TT', 'AKo', 'AQs', 'AJs', 'KQs']),
  },
  // ---- vs a 4-bet (you opened, got 3-bet, you 3-bet... i.e. you re-raised and
  // now face a 4-bet). Stacks get committed fast — ranges collapse to premiums:
  // 5-bet/jam the nuts, flat a sliver, fold everything else. Near position-
  // independent at 100bb, so the three charts share almost the same range.
  {
    id: 'btn-vs-4bet',
    label: 'BTN vs a 4-bet',
    short: 'BTN v 4B',
    facing: 'vs4bet',
    heroPos: 'BTN',
    bluffFreq: 0.5,
    value: S(['QQ+', 'AKs']),
    bluff: S(['A5s']),
    call: S(['JJ', 'AKo', 'AQs']),
  },
  {
    id: 'co-vs-4bet',
    label: 'CO vs a 4-bet',
    short: 'CO v 4B',
    facing: 'vs4bet',
    heroPos: 'CO',
    bluffFreq: 0.4,
    value: S(['KK+', 'AKs']),
    bluff: S(['A5s']),
    call: S(['QQ', 'AKo']),
  },
  {
    id: 'utg-vs-4bet',
    label: 'UTG vs a 4-bet',
    short: 'UTG v 4B',
    facing: 'vs4bet',
    heroPos: 'UTG',
    bluffFreq: 0.3,
    value: S(['KK+']),
    bluff: S([]),
    call: S(['QQ', 'AKs', 'AKo']),
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
  const raiseLabel = sc.facing === 'vs4bet' ? '5-Bet' : sc.facing === 'vs3bet' ? '4-Bet' : '3-Bet';
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
