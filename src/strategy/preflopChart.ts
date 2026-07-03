// Scenario-based preflop strategy charts with mixed frequencies and action
// kinds (fold / call / 3-bet value / 3-bet bluff / 4-bet) for the 13x13 grid
// and for live preflop feedback.

import type { Position } from '../engine/table';
import { buildRange } from '../ai/preflop';
import type { ActionId, ActionOption } from './types';

export type Facing = 'rfi' | 'vsopen' | 'vs3bet' | 'vs4bet';
export type TableSize = 6 | 5 | 4 | 3 | 2;

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
  /** One-line "how to remember this range" hook, shown as a collapsible note on the chart. */
  mnemonic?: string;
  /** Restrict to specific table sizes. Default: derived from seats present —
   *  a spot survives at sizes 3-6 where both hero & villain are still seated.
   *  Heads-up (size 2) spots set this to [2] because their ranges differ. */
  sizes?: TableSize[];
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
  SB: ['22+', 'A2s+', 'K4s+', 'Q6s+', 'J7s+', 'T7s+', '96s+', '85s+', '75s+', '65s', '54s', 'A4o+', 'K8o+', 'Q9o+', 'J9o+', 'T9o'],
  BB: [],
};

const MIX_OPEN: Partial<Record<Position, string[]>> = {
  UTG: ['A8s', 'KJo', 'QJo', '87s'],
  MP: ['A7s', 'A9o', 'KTo', '76s'],
  CO: ['K7s', 'Q8s', 'A8o', 'J9o'],
  BTN: ['Q4s', 'J6s', 'K6o', 'Q8o', '53s'],
  SB: ['Q5s', 'J6s', 'K7o', 'Q8o', '64s'],
};

// One-line memory hook per RFI seat — surfaced as a collapsible note on the chart.
const RFI_MNEMONIC: Record<Position, string> = {
  UTG: 'Tightest seat. Base = pairs + strong suited aces + suited Broadways/connectors, plus AJo+/KQo. Not a pair, a strong ace, or two Broadway cards? Fold.',
  MP: 'UTG plus one rung wider: A8s+, K9s+, add 87s and ATo+/KJo+/QJo. Same shape, a touch looser.',
  CO: 'Steal seat opens up: every suited ace (A2s+), suited kings K8s+, suited connectors down to 54s, plus offsuit A9o+/KTo+/QTo+/JTo.',
  BTN: 'Widest — open about half your hands. Any suited ace or king opens; offsuit needs two working cards (A2o+, K7o+, Q9o+, J9o+, T8o+, 98o, 87o).',
  SB: 'Only the BB is behind, so steal wide like the button — but open or 3-bet, never limp. Offsuit down to A4o+/K8o+/Q9o+.',
  BB: '',
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
    mnemonic: RFI_MNEMONIC[p],
  })),
  {
    id: 'btn-vs-utg',
    label: 'BTN vs UTG open',
    short: 'BTN v UTG',
    mnemonic: 'Vs the tightest open: 3-bet only premiums (QQ+/AK/AQs) plus A5s-A4s/KJs bluffs; flat pairs and suited Broadways to set-mine in position.',
    facing: 'vsopen',
    heroPos: 'BTN',
    villainPos: 'UTG',
    bluffFreq: 0.5,
    value: S(['QQ+', 'AKs', 'AKo', 'AQs']),
    bluff: S(['A5s-A4s', 'KJs']),
    call: S(['22-JJ', 'AJs', 'ATs', 'KQs', 'KJs', 'KTs', 'QJs', 'JTs', 'T9s', '98s', 'AQo', 'KQo', 'AJo']),
  },
  {
    id: 'co-vs-utg',
    label: 'CO vs UTG open',
    short: 'CO v UTG',
    mnemonic: 'Like BTN-vs-UTG but flat tighter — you have position on UTG, but the blinds are still behind you.',
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
    mnemonic: 'BTN opens wide, so defend widest (~40%). You already have 1bb in — mostly call with the price; 3-bet TT+/AQs+ value plus suited-wheel and suited-connector bluffs.',
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
    mnemonic: 'You close the action with a great price vs a wide SB open — defend the most of any spot. 3-bet 99+/AJs+ value + suited bluffs, call the rest.',
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
    mnemonic: 'Tightest open means tightest defense: narrow 3-bet (QQ+/AK/AQs + A5s-A4s), flat pairs and suited Broadways/connectors; fold offsuit junk even at the BB price.',
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
    mnemonic: 'A notch wider than vs UTG — MP opens slightly looser, so defend slightly wider.',
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
    mnemonic: 'Position on MP, so 3-bet polar (JJ+/AQs+ value, A5s-A4s/KJs/QTs bluffs) and flat pairs + suited Broadways.',
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
    mnemonic: 'Loose late opener and you have the button, so attack wide: 3-bet TT+/AQs+ value with more suited bluffs, flat everything playable in position.',
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
    mnemonic: 'A true middle: MP sits between UTG and CO, so value is JJ+ (vs-UTG is QQ+, vs-CO is TT+). Flat wide in position.',
    facing: 'vsopen',
    heroPos: 'BTN',
    villainPos: 'MP',
    bluffFreq: 0.5,
    // MP opens looser than UTG, tighter than CO — BTN sits in position and can
    // flat wide / 3-bet a polarized bluff range. A true middle: value JJ+ (vs-UTG
    // is QQ+, vs-CO is TT+), one extra suited-wheel bluff + QTs over vs-UTG, but
    // narrower than the vs-CO bluff fan (no J9s/T9s).
    value: S(['JJ+', 'AQs+', 'AKo', 'AJs']),
    bluff: S(['A5s-A3s', 'KJs', 'QTs']),
    call: S(['22-TT', 'ATs', 'KQs', 'KJs', 'KTs', 'QJs', 'JTs', 'T9s', '98s', 'AQo', 'KQo', 'AJo']),
  },
  {
    id: 'bb-vs-co',
    label: 'BB vs CO open (defense)',
    short: 'BB v CO',
    mnemonic: 'CO opens ~25%, so defend wide from the BB price: 3-bet TT+/AQs+ value + suited bluffs, call the rest.',
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
    mnemonic: 'Out of position vs a steal, so 3-bet or fold — no flatting. Value 99+/ATs+/AQo+ plus suited bluffs; flatting OOP just bleeds.',
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
    mnemonic: 'In position, so flat wide (JJ-77/AQs/AJs). 4-bet only premiums (QQ+/AK) plus A5s/A4s wheel-ace bluffs.',
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
    mnemonic: 'Same as BTN-vs-3bet but flat a touch tighter — not on the button.',
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
    mnemonic: 'Your UTG open is already strong, so mostly continue: 4-bet KK+/AKs, flat QQ-TT/AKo/AQs/AJs/KQs; A5s the lone bluff.',
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
    mnemonic: 'Vs a 4-bet stacks are committing, so it is premiums or fold: 5-bet/jam QQ+/AKs, flat a sliver (JJ/AKo/AQs), A5s the only bluff.',
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
    mnemonic: 'Premiums or fold: 5-bet KK+/AKs, flat QQ/AKo, A5s bluff — tighter than the button.',
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
    mnemonic: 'Tightest 4-bet-facing spot: only KK+ jams for value; AK/QQ/AKs just call, everything else folds.',
    facing: 'vs4bet',
    heroPos: 'UTG',
    bluffFreq: 0.3,
    value: S(['KK+']),
    bluff: S([]),
    call: S(['QQ', 'AKs', 'AKo']),
  },
  // ---- Heads-up (2 players). The SB IS the button: acts first preflop but in
  // position postflop, and opens a huge range. The "lop the top, reuse 6-max"
  // rule can't reach here — HU dynamics need their own ranges. Simplified
  // ~100bb teaching ranges.
  {
    id: 'hu-sb-rfi',
    label: 'Heads-up — SB (button) open',
    short: 'HU Open',
    mnemonic: 'You are the button heads-up: open ~82%. Every suited hand and every pair opens; fold only the worst offsuit junk. Suited = raise.',
    facing: 'rfi',
    heroPos: 'SB',
    bluffFreq: 0.5,
    sizes: [2],
    // open ~82%: every suited hand, all pairs, most offsuit. Fold only the
    // worst offsuit junk — the mixOpen tier is the marginal limp/fold edge.
    open: S([
      '22+', 'A2s+', 'K2s+', 'Q2s+', 'J2s+', 'T2s+', '92s+', '82s+', '72s+', '62s+', '52s+', '42s+', '32s',
      'A2o+', 'K2o+', 'Q3o+', 'J5o+', 'T6o+', '96o+', '86o+', '75o+', '64o+', '54o',
    ]),
    mixOpen: S(['Q2o', 'J4o', 'T5o', '95o', '85o', '74o', '63o', '53o', '43o']),
  },
  {
    id: 'hu-bb-vs-sb',
    label: 'Heads-up — BB vs SB open',
    short: 'HU Defend',
    mnemonic: 'Vs an ~82% SB open, defend ~65%. 3-bet a polar value+bluff set, flat the rest — overfolding just hands the blind back.',
    facing: 'vsopen',
    heroPos: 'BB',
    villainPos: 'SB',
    bluffFreq: 0.5,
    sizes: [2],
    // vs an ~82% open you defend ~65%: 3-bet a polar value+bluff set, flat the
    // rest. Over-folding here just bleeds the blind back to the button.
    value: S(['99+', 'ATs+', 'KQs', 'AQo+', 'AJs']),
    bluff: S(['A2s-A9s', 'K9s', 'KTs', 'Q9s', 'J9s', 'T8s', '97s', '86s', '75s', 'A2o-A5o', 'KJo']),
    call: S([
      '22-88', 'A2s+', 'K2s+', 'Q4s+', 'J6s+', 'T6s+', '95s+', '85s+', '74s+', '64s+', '53s+', '43s',
      'A2o+', 'K6o+', 'Q8o+', 'J8o+', 'T8o+', '98o', '87o', '76o',
    ]),
  },
  {
    id: 'hu-sb-vs-3bet',
    label: 'Heads-up — SB open vs a 3-bet',
    short: 'HU v 3B',
    mnemonic: 'You opened huge and got 3-bet, so keep continuing wide: 4-bet TT+/AK/AQs value + suited-wheel bluffs, flat the rest.',
    facing: 'vs3bet',
    heroPos: 'SB',
    bluffFreq: 0.5,
    sizes: [2],
    value: S(['TT+', 'AKs', 'AKo', 'AQs']),
    bluff: S(['A5s', 'A4s', 'A3s', 'K9s']),
    call: S(['77-99', 'AJs', 'ATs', 'KQs', 'KJs', 'QJs', 'JTs', 'T9s', 'AQo', 'KQo', 'AJo']),
  },
];

const SEAT_ORDER: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

/** Seats present at an N-handed table. Blinds + button are fixed anchors, so a
 *  table shrinks by lopping the EARLIEST positions off the front of the list. */
export function seatsForSize(n: TableSize): Position[] {
  return SEAT_ORDER.slice(SEAT_ORDER.length - n);
}

/** Scenarios playable at table size N. 6-max charts are reused via the
 *  lop-the-top rule (a spot survives if both hero & villain are still seated);
 *  heads-up (size 2) uses its own `sizes`-tagged scenarios. */
export function scenariosForSize(n: TableSize): PreflopScenario[] {
  return SCENARIOS.filter((s) => {
    if (s.sizes) return s.sizes.includes(n);
    if (n < 3) return false; // sub-3-handed handled only by tagged scenarios
    const seats = seatsForSize(n);
    if (!seats.includes(s.heroPos)) return false;
    if (s.villainPos && !seats.includes(s.villainPos)) return false;
    return true;
  });
}

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
