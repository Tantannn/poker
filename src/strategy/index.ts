// Live-node strategy dispatch: turns a GameState (at the hero's turn) into a
// NodeStrategy via the preflop charts or the postflop EV model, and provides
// helpers for EV-loss scoring and RNG prescriptions.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import type { Card } from '../engine/cards';
import { sameCard } from '../engine/cards';
import type { WeightedRange, ComboWeight } from '../engine/range';
import { rangeFromSet, codeToCombos } from '../engine/range';
import { evaluate7 } from '../engine/evaluator';
import { countOuts } from '../engine/equity';
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

export function getNodeStrategy(
  state: GameState,
  heroIdx: number,
  iterations?: number,
  /** precomputed equity (0..1) to reuse instead of an independent MC run, so the
   *  HUD and the solver panel agree exactly. Postflop only; preflop uses charts. */
  equityOverride?: number,
): NodeStrategy {
  if (state.street === 'preflop') return preflopStrategy(state, heroIdx);
  return postflopStrategy(state, heroIdx, iterations, equityOverride);
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
  if (raises >= 3) {
    // facing a 4-bet (your re-raise got re-raised). Premium-only continue range,
    // matched to your position. Only UTG/CO/BTN charts exist → MP↦CO, blinds↦BTN.
    const fbId =
      heroPos === 'UTG' ? 'utg-vs-4bet'
      : heroPos === 'MP' || heroPos === 'CO' ? 'co-vs-4bet'
      : 'btn-vs-4bet';
    return { sc: getScenario(fbId), level: 3 };
  }
  if (raises === 2) {
    // facing a 3-bet (you opened, someone re-raised). Pick the chart matching
    // the position YOU opened from — not always BTN. Only UTG/CO/BTN vs-3bet
    // charts exist, so MP maps to CO (next-tightest) and the blinds to BTN.
    const tbId =
      heroPos === 'UTG' ? 'utg-vs-3bet'
      : heroPos === 'MP' || heroPos === 'CO' ? 'co-vs-3bet'
      : 'btn-vs-3bet';
    return { sc: getScenario(tbId), level: 2 };
  }
  // facing a single open
  const raiser = lastRaiser(state);
  const raiserPos = raiser >= 0 ? positionLabel(raiser, state.buttonIndex, state.players.length) : undefined;
  if (heroPos === 'BB') {
    // pick the defense chart matching the ACTUAL opener, not always BTN.
    const bbId =
      raiserPos === 'SB' ? 'bb-vs-sb'
      : raiserPos === 'BTN' ? 'bb-vs-btn'
      : raiserPos === 'CO' ? 'bb-vs-co'
      : raiserPos === 'MP' ? 'bb-vs-mp'
      : raiserPos === 'UTG' ? 'bb-vs-utg'
      : 'bb-vs-btn';
    return { sc: getScenario(bbId), level: 1 };
  }
  if (heroPos === 'CO') return { sc: getScenario('co-vs-utg'), level: 1 };
  return { sc: getScenario('btn-vs-utg'), level: 1 };
}

function preflopStrategy(state: GameState, heroIdx: number): NodeStrategy {
  const { sc, level } = pickPreflopScenario(state, heroIdx);
  const code = handCode(state.players[heroIdx].holeCards);
  // multiway = facing a raise AND 2+ opponents still live (opener + caller(s)).
  // Heads-up charts over-bluff and over-defend multiway: a 3-bet bluff has no
  // fold equity against a field, so squash bluff raises into call/fold.
  const liveOpps = state.players.filter((p) => !p.folded && p.id !== heroIdx).length;
  const multiway = level >= 1 && liveOpps >= 2;
  const charted = multiway ? squashBluffsMultiway(cellStrategy(sc, code)) : cellStrategy(sc, code);
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
    note: `${sc.label}.${multiway ? ` Multiway (${liveOpps} opponents) — 3-bet bluffs are dropped (no fold equity vs a field); continue mainly for value/equity.` : ''} Mixed frequencies from a teaching-baseline chart; EVs are relative estimates.`,
    rangeNote: `${sc.label}${multiway ? ' · multiway' : ''}`,
    heroCode: code,
    scenarioId: sc.id,
  };
}

function whyPreflop(kind: ActionOption['kind'], sc: PreflopScenario, code: string, freq: number): string {
  const raiseWord = sc.facing === 'vs4bet' ? '5-bet' : sc.facing === 'vs3bet' ? '4-bet' : sc.facing === 'rfi' ? 'open' : '3-bet';
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
export function buildVillainRange(
  state: GameState,
  heroIdx: number,
): { range: WeightedRange; note: string; comboWeight?: ComboWeight } {
  // The preflop range is the STARTING set; comboWeight then conditions it on the
  // board + this street's action (see villainActionWeight). Both panels and the
  // bots run their equity through it, so "he bet a 3-flush board" actually shifts
  // his range toward flushes instead of treating every preflop combo as a bettor.
  const comboWeight = villainActionWeight(state, heroIdx);
  const villain = primaryVillain(state, heroIdx);
  if (villain < 0) {
    return { range: rangeFromSet(RFI_RANGES.BTN), note: 'a generic continuing range', comboWeight };
  }
  const pos = positionLabel(villain, state.buttonIndex, state.players.length);
  // was this villain the preflop aggressor?
  const wasAggressor = state.log.some(
    (l) => l.handNumber === state.handNumber && l.street === 'preflop' && l.playerId === villain && (l.type === 'raise' || l.type === 'bet'),
  );
  let range: WeightedRange;
  let note: string;
  if (pos === 'BB' && !wasAggressor) {
    range = rangeFromSet(BB_DEFEND_RANGE);
    note = `${pos}'s wide defend range`;
  } else {
    const set = RFI_RANGES[pos] ?? RFI_RANGES.BTN;
    range = rangeFromSet(set);
    note = `${pos}'s ~${pctOf(set)}% ${wasAggressor ? 'raising' : 'continuing'} range`;
  }
  const facingBet = state.currentBet > state.players[heroIdx].committed;
  if (comboWeight && facingBet && state.board.length >= 3) {
    note += ' · narrowed to the hands that bet this board (flushes/straights/sets up, air down)';
  }
  return { range, note, comboWeight };
}

export interface RangeShapeBucket {
  label: string;
  pct: number; // mass fraction 0..1
}

/** What the villain is "repping": the composition of his (conditioned) range on
 *  the current board, plus the share of that range currently AHEAD of the hero.
 *  Mass-weighted by code weight × comboWeight, blocker-aware. Used by the HUD so
 *  the player can SEE why their bluff-catcher is good or bad here. */
export function summarizeRange(
  hero: Card[],
  range: WeightedRange,
  board: Card[],
  comboWeight?: ComboWeight,
): { buckets: RangeShapeBucket[]; aheadPct: number } {
  if (board.length < 3 || hero.length < 2) return { buckets: [], aheadPct: 0 };
  const dead = [...hero, ...board];
  const heroScore = evaluate7([...hero, ...board]).score;
  const mass = new Map<string, number>();
  let total = 0;
  let ahead = 0;
  range.forEach((w, code) => {
    if (w <= 0) return;
    for (const [a, b] of codeToCombos(code)) {
      if (dead.some((d) => sameCard(d, a) || sameCard(d, b))) continue;
      const m = w * (comboWeight ? comboWeight(a, b) : 1);
      if (m <= 0) continue;
      const res = evaluate7([a, b, ...board]);
      const outs = board.length < 5 ? countOuts([a, b], board).outs : 0;
      let label: string;
      if (res.categoryRank >= 5) label = 'Flush+';
      else if (res.categoryRank === 4) label = 'Straight';
      else if (res.categoryRank === 3) label = 'Set / trips';
      else if (res.categoryRank === 2) label = 'Two pair';
      else if (res.categoryRank === 1) label = 'One pair';
      else if (outs >= 4) label = 'Draw';
      else label = 'Air';
      mass.set(label, (mass.get(label) ?? 0) + m);
      total += m;
      if (res.score > heroScore) ahead += m;
    }
  });
  if (total <= 0) return { buckets: [], aheadPct: 0 };
  const order = ['Flush+', 'Straight', 'Set / trips', 'Two pair', 'One pair', 'Draw', 'Air'];
  const buckets = order.filter((l) => mass.has(l)).map((l) => ({ label: l, pct: (mass.get(l) as number) / total }));
  return { buckets, aheadPct: ahead / total };
}

/** Builds the per-combo multiplier that conditions a villain's preflop range on
 *  the current board + the action they just took. Returns undefined preflop (the
 *  charts already model that). */
function villainActionWeight(state: GameState, heroIdx: number): ComboWeight | undefined {
  const board = state.board;
  if (board.length < 3) return undefined;
  const hero = state.players[heroIdx];
  const pot = potTotal(state);
  const toCall = Math.max(0, state.currentBet - hero.committed);
  const facingBet = toCall > 0;
  // bet size as a fraction of the pot (pot already includes the villain's bet) —
  // a size proxy that drives how POLARIZED the conditioned range becomes.
  const betFrac = pot > 0 ? toCall / pot : 0;
  return (a: Card, b: Card) => betConditionedWeight(a, b, board, facingBet, betFrac);
}

/** Likelihood (relative weight) that a villain holding this concrete combo would
 *  take the action they took, given the board. Value/strong-draw hands bet; air
 *  mostly gives up — and a bigger bet thins the weak end harder (polarization). */
function betConditionedWeight(a: Card, b: Card, board: Card[], facingBet: boolean, betFrac: number): number {
  const cat = evaluate7([a, b, ...board]).categoryRank; // 0 high card .. 8 straight flush
  const outs = board.length < 5 ? countOuts([a, b], board).outs : 0; // draws (flop/turn)
  if (!facingBet) {
    // Villain CHECKED to us → capped range: the strongest hands usually would have
    // bet, so down-weight them slightly. (Hero is the aggressor in this branch.)
    return cat >= 6 ? 0.6 : cat >= 4 ? 0.85 : 1;
  }
  // Villain BET → value-weighted, polarized. Made-hand strength sets the base.
  let w: number;
  if (cat >= 5) w = 1.3; // flush / full house / quads / straight flush
  else if (cat === 4) w = 1.2; // straight
  else if (cat === 3) w = 1.15; // trips / set
  else if (cat === 2) w = 1.0; // two pair
  else if (cat === 1) w = 0.55; // one pair — bets some, checks some
  else w = 0.18; // high card / air — mostly gives up (a few bluffs)
  // strong draws semi-bluff too (flop/turn only; the river has no draws)
  if (outs >= 8) w = Math.max(w, 0.85);
  else if (outs >= 4) w = Math.max(w, 0.45);
  // A bigger bet polarizes: it thins the weak/air part of the range harder, so the
  // value (and the flushes) become a LARGER share — exactly why a big bet on a
  // 3-flush board should tank a bluff-catcher's equity.
  const polar = Math.min(1, betFrac / 0.75); // 0 (tiny) .. 1 (¾-pot or bigger)
  if (w < 0.7) w *= 1 - 0.55 * polar;
  return w;
}

function postflopStrategy(
  state: GameState,
  heroIdx: number,
  iterations?: number,
  equityOverride?: number,
): NodeStrategy {
  const hero = state.players[heroIdx];
  const la = legalActions(state);
  const pot = potTotal(state);
  const { range, note, comboWeight } = buildVillainRange(state, heroIdx);

  // every still-live opponent — in a multiway pot hero must beat all of them, so
  // the EV model gets the whole field (approximated as each holding `range`).
  const liveOpps = state.players.filter((p) => !p.folded && p.id !== heroIdx).length;
  const oppRanges = Array.from({ length: Math.max(1, liveOpps) }, () => range);

  // Effective stack BEHIND = min(hero's remaining, the live opponents'). You can
  // only win/lose the smaller, so a deep hero vs a short villain is a SHORT game.
  // Feeds implied odds + the SPR risk premium so the model is depth-aware.
  const oppStacks = state.players.filter((p) => !p.folded && p.id !== heroIdx).map((p) => p.stack);
  const effStack = Math.min(hero.stack, ...(oppStacks.length ? oppStacks : [hero.stack]));

  return solvePostflop({
    hero: hero.holeCards,
    board: state.board,
    oppRange: range,
    oppRanges,
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
    effStack,
    precomputedEquity: equityOverride,
    comboWeight,
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

/** Multiway correction: a 3-bet bluff has no fold equity against a field, so
 *  reassign bluff-raise weight to call (if the hand also flats) or fold. Value
 *  raises and flats are kept — set-mining / equity calls still play multiway. */
function squashBluffsMultiway(opts: ActionOption[]): ActionOption[] {
  const canCall = opts.some((o) => o.id === 'call');
  let foldAdd = 0;
  let callAdd = 0;
  const kept: ActionOption[] = [];
  for (const o of opts) {
    if (o.kind === 'bluff') {
      if (canCall) callAdd += o.freq;
      else foldAdd += o.freq;
      continue;
    }
    kept.push({ ...o });
  }
  if (callAdd > 0) {
    const c = kept.find((o) => o.id === 'call');
    if (c) c.freq += callAdd;
    else kept.push({ id: 'call', label: 'Call', freq: callAdd, ev: 0, kind: 'call' });
  }
  if (foldAdd > 0) {
    const f = kept.find((o) => o.id === 'fold');
    if (f) f.freq += foldAdd;
    else kept.push({ id: 'fold', label: 'Fold', freq: foldAdd, ev: 0, kind: 'fold' });
  }
  return kept;
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
