// Live-node strategy dispatch: turns a GameState (at the hero's turn) into a
// NodeStrategy via the preflop charts or the postflop EV model, and provides
// helpers for EV-loss scoring and RNG prescriptions.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import type { WeightedRange } from '../engine/range';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES, BB_DEFEND_RANGE, handCode } from '../ai/preflop';
import type { ActionId, ActionOption, NodeStrategy } from './types';
import { cellStrategy, getScenario, SCENARIOS } from './preflopChart';
import type { PreflopScenario } from './preflopChart';
import { solvePostflop } from './postflopModel';

export type { NodeStrategy } from './types';
export { evLoss, rngPrescription } from './types';

const BASE_EV: Record<NonNullable<ActionOption['kind']>, number> = {
  value: 0.8,
  call: 0.35,
  bluff: 0.25,
  passive: 0.1,
  fold: 0,
  aggressive: 0.6,
};

export function getNodeStrategy(state: GameState, heroIdx: number, iterations?: number): NodeStrategy {
  if (state.street === 'preflop') return preflopStrategy(state, heroIdx);
  return postflopStrategy(state, heroIdx, iterations);
}

// ----------------- preflop -----------------
function pickPreflopScenario(state: GameState, heroIdx: number): { sc: PreflopScenario; level: number } {
  const heroPos = positionLabel(heroIdx, state.buttonIndex, state.players.length);
  const raises = state.log.filter((l) => l.handNumber === state.handNumber && (l.type === 'raise' || l.type === 'bet')).length;
  const facingRaise = state.currentBet > state.bigBlind;

  if (!facingRaise) {
    const sc = SCENARIOS.find((s) => s.id === `rfi-${heroPos}`) ?? getScenario('rfi-BTN');
    return { sc, level: 0 };
  }
  if (raises >= 2) {
    return { sc: getScenario('btn-vs-3bet'), level: 2 };
  }
  // facing a single open
  const raiser = lastRaiser(state);
  const raiserPos = raiser >= 0 ? positionLabel(raiser, state.buttonIndex, state.players.length) : undefined;
  if (heroPos === 'BB') {
    return { sc: getScenario(raiserPos === 'SB' ? 'bb-vs-sb' : 'bb-vs-btn'), level: 1 };
  }
  if (heroPos === 'CO') return { sc: getScenario('co-vs-utg'), level: 1 };
  return { sc: getScenario('btn-vs-utg'), level: 1 };
}

function preflopStrategy(state: GameState, heroIdx: number): NodeStrategy {
  const { sc, level } = pickPreflopScenario(state, heroIdx);
  const code = handCode(state.players[heroIdx].holeCards);
  const charted = cellStrategy(sc, code);
  const la = legalActions(state);
  const bb = state.bigBlind;

  // standard raise-to size (total chips) for an aggressive preflop action:
  // RFI opens ~2.5bb; a 3-bet ~3× the open; a 4-bet ~2.3× the 3-bet.
  const raiseSize = (id: ActionOption['id']): number | undefined => {
    if (id !== 'open' && id !== 'raise') return undefined;
    const target = level >= 2 ? Math.round(2.3 * state.currentBet)
      : level === 1 ? Math.round(3 * state.currentBet)
      : Math.round(2.5 * bb);
    return Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, target));
  };

  // map charted options to concrete EVs (relative, heuristic) + explanations
  const options: ActionOption[] = charted.map((o) => {
    const amount = raiseSize(o.id);
    return {
      ...o,
      amount, // raise-to in chips; StrategyPanel renders the bb conversion
      ev: round2(BASE_EV[o.kind ?? 'fold'] * (0.5 + 0.5 * o.freq)),
      why: whyPreflop(o.kind, sc, code, o.freq),
      math: `Preflop chart: ${(o.freq * 100).toFixed(0)}% is the baseline frequency for ${code} in "${sc.short}". EV is a relative estimate (charts aren't EV-solved).`,
    };
  });

  if (la.callAmount > 0 && !options.some((o) => o.id === 'fold')) {
    options.push({ id: 'fold', label: 'Fold', freq: 0, ev: 0, kind: 'fold', why: `${code} is below the continue threshold here.` });
  }

  const best = options.reduce((a, b) => (b.ev > a.ev ? b : a), options[0]);
  return {
    options: options.sort((a, b) => b.freq - a.freq || b.ev - a.ev),
    bestEv: best.ev,
    bestId: best.id,
    source: 'preflop-chart',
    note: `${sc.label}. Mixed frequencies from a teaching-baseline chart; EVs are relative estimates.`,
    rangeNote: sc.label,
    heroCode: code,
    scenarioId: sc.id,
  };
}

function whyPreflop(kind: ActionOption['kind'], sc: PreflopScenario, code: string, freq: number): string {
  const raiseWord = sc.facing === 'vs3bet' ? '4-bet' : sc.facing === 'rfi' ? 'open' : '3-bet';
  switch (kind) {
    case 'value':
      return `${code} is a value ${raiseWord} in "${sc.short}" — strong enough to build the pot and get called by worse.`;
    case 'bluff':
      return `${code} is a mixed ${raiseWord} bluff (~${Math.round(freq * 100)}%) — it balances your value hands so you're not only raising the nuts.`;
    case 'call':
      return `${code} flats: good enough to continue but not to raise. ${sc.heroPos === 'BB' ? 'Closes the action and sees a flop.' : 'Keeps villain’s range wide and realizes equity in position.'}`;
    case 'fold':
      return `${code} is below the continue threshold for "${sc.short}".`;
    default:
      return `${code}: standard play for "${sc.short}".`;
  }
}

// ----------------- postflop -----------------
export function buildVillainRange(state: GameState, heroIdx: number): { range: WeightedRange; note: string } {
  const villain = primaryVillain(state, heroIdx);
  if (villain < 0) {
    return { range: rangeFromSet(RFI_RANGES.BTN), note: 'a generic continuing range' };
  }
  const pos = positionLabel(villain, state.buttonIndex, state.players.length);
  // was this villain the preflop aggressor?
  const wasAggressor = state.log.some(
    (l) => l.handNumber === state.handNumber && l.street === 'preflop' && l.playerId === villain && (l.type === 'raise' || l.type === 'bet'),
  );
  if (pos === 'BB' && !wasAggressor) {
    return { range: rangeFromSet(BB_DEFEND_RANGE), note: `${pos}'s wide defend range` };
  }
  const set = RFI_RANGES[pos] ?? RFI_RANGES.BTN;
  return { range: rangeFromSet(set), note: `${pos}'s ~${pctOf(set)}% ${wasAggressor ? 'raising' : 'continuing'} range` };
}

function postflopStrategy(state: GameState, heroIdx: number, iterations?: number): NodeStrategy {
  const hero = state.players[heroIdx];
  const la = legalActions(state);
  const pot = potTotal(state);
  const { range, note } = buildVillainRange(state, heroIdx);

  return solvePostflop({
    hero: hero.holeCards,
    board: state.board,
    oppRange: range,
    pot,
    toCall: la.callAmount,
    heroCommitted: hero.committed,
    currentBet: state.currentBet,
    minRaiseTo: la.minRaiseTo,
    maxRaiseTo: la.maxRaiseTo,
    canCheck: la.canCheck,
    canRaise: la.canRaise,
    bigBlind: state.bigBlind,
    iterations,
    rangeNote: note,
    heroCode: handCode(hero.holeCards),
  });
}

// ----------------- helpers -----------------
/** Index of the opponent the hero is primarily up against at this node (-1 if none). */
export function primaryVillainIdx(state: GameState, heroIdx: number): number {
  return primaryVillain(state, heroIdx);
}

function primaryVillain(state: GameState, heroIdx: number): number {
  if (
    state.lastAggressor >= 0 &&
    state.lastAggressor !== heroIdx &&
    !state.players[state.lastAggressor].folded
  )
    return state.lastAggressor;
  for (let k = 1; k < state.players.length; k++) {
    const idx = (heroIdx + k) % state.players.length;
    if (!state.players[idx].folded) return idx;
  }
  return -1;
}

function lastRaiser(state: GameState): number {
  const raises = state.log.filter(
    (l) => l.handNumber === state.handNumber && l.street === 'preflop' && (l.type === 'raise' || l.type === 'bet'),
  );
  return raises.length ? raises[raises.length - 1].playerId : -1;
}

function pctOf(set: Set<string>): number {
  let combos = 0;
  set.forEach((h) => (combos += h.length === 2 ? 6 : h.endsWith('s') ? 4 : 12));
  return Math.round((combos / 1326) * 100);
}

/** Map an executed hero action to the closest strategy option id (for EV loss). */
export function matchActionId(strategy: NodeStrategy, action: Action, callAmount: number): ActionId {
  if (action.type === 'fold') return 'fold';
  if (action.type === 'check') return strategy.options.some((o) => o.id === 'check') ? 'check' : 'call';
  if (action.type === 'call') return callAmount > 0 ? 'call' : 'check';
  // bet / raise — match by amount to the nearest sized option, else generic
  const sized = strategy.options.filter((o) => o.amount != null);
  if (sized.length && action.amount != null) {
    let best = sized[0];
    let bestD = Infinity;
    for (const o of sized) {
      const d = Math.abs((o.amount as number) - action.amount);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best.id;
  }
  // preflop aggressive
  if (strategy.options.some((o) => o.id === 'raise')) return 'raise';
  if (strategy.options.some((o) => o.id === 'open')) return 'open';
  return 'raise';
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
