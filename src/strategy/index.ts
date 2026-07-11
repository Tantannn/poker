// Live-node strategy dispatch: turns a GameState (at the hero's turn) into a
// NodeStrategy via the preflop charts or the postflop EV model, and provides
// helpers for EV-loss scoring and RNG prescriptions.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal, sixMaxRfiEquivalent } from '../engine/table';
import type { Card } from '../engine/cards';
import { sameCard } from '../engine/cards';
import type { WeightedRange, ComboWeight } from '../engine/range';
import { rangeFromSet, codeToCombos } from '../engine/range';
import { evaluate7 } from '../engine/evaluator';
import { countOuts } from '../engine/equity';
import { RFI_RANGES, BB_DEFEND_RANGE, THREEBET_RANGE, BLUFF_THREEBET_RANGE, handCode, preflopStrength } from '../ai/preflop';
import { getProfile } from '../ai/profiles';
import type { ActionId, ActionOption, NodeStrategy } from './types';
import { cellStrategy, getScenario, facingRaiseWord } from './preflopChart';
import type { PreflopScenario } from './preflopChart';
import { solveRiverNode, solveRiverVsBetNode, solveTurnNode } from './solver/riverAdapter';

// Tier-2 (Stage 0): route hero-first heads-up RIVER nodes through the range-vs-range
// CFR solver instead of the per-hand EV model. Flip to false to A/B against the old
// engine. Non-river / facing-a-bet / multiway nodes always use the per-hand model.
export const RIVER_SOLVER_ENABLED = true;
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

// EV (bb) for a LEGAL action the chart doesn't endorse for this hand (e.g.
// limping/opening a hand the chart folds). Fold is the 0 baseline; an off-range
// call/open is a small -EV leak. Below the "correct" tier (≤0.5bb loss) on
// purpose so it grades "Wrong", not "Best" — playing outside the range is a leak.
const OFF_CHART_EV = -0.75;

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
  const n = state.players.length;
  const heroPos = positionLabel(heroIdx, state.buttonIndex, n);
  const raises = state.log.filter((l) => l.handNumber === state.handNumber && (l.type === 'raise' || l.type === 'bet')).length;
  const facingRaise = state.currentBet > state.bigBlind;

  if (!facingRaise) {
    // Open range is a function of SEATS BEHIND, not table size — read one 6-max
    // ladder by behind-count instead of a chart per size (5-max UTG plays like
    // 6-max MP, etc.; at 6-max this is identity). sixMaxRfiEquivalent is the same
    // mapping the live position hint shows, so solver and hint never disagree.
    const equiv = sixMaxRfiEquivalent(heroPos, n) ?? 'BTN'; // BB never RFIs → harmless fallback
    return { sc: getScenario(`rfi-${equiv}`), level: 0 };
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
  // facing a single open — pick the chart matching BOTH the hero's seat AND the
  // ACTUAL opener, not always "vs UTG". Defence widens a lot vs a late (steal)
  // open, so grading a BTN/SB hand against the tight vs-UTG range wrongly folds
  // standard steal-defends. We only have a subset of pairings charted, so fall
  // back to the nearest existing one (vs-UTG = tightest baseline).
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
  // SB only has a vs-BTN (steal) defence chart — the 3-bet-or-fold shape is right
  // for any steal and far closer than the flat-heavy vs-UTG chart it used before.
  if (heroPos === 'SB') return { sc: getScenario('sb-vs-btn'), level: 1 };
  if (heroPos === 'BTN')
    return {
      sc: getScenario(raiserPos === 'CO' ? 'btn-vs-co' : raiserPos === 'MP' ? 'btn-vs-mp' : 'btn-vs-utg'),
      level: 1,
    };
  if (heroPos === 'CO') return { sc: getScenario(raiserPos === 'MP' ? 'co-vs-mp' : 'co-vs-utg'), level: 1 };
  // UTG/MP facing an open ahead of them — rare, and tight: keep the vs-UTG baseline.
  return { sc: getScenario('btn-vs-utg'), level: 1 };
}

/** Effective stack in big blinds: the shorter of the hero and the deepest live
 *  opponent. Matches the bot's measure (decide.ts) so feedback and bot play agree. */
function effectiveStackBB(state: GameState, heroIdx: number): number {
  const me = state.players[heroIdx];
  const oppStacks = state.players
    .filter((p) => !p.folded && p.id !== heroIdx)
    .map((p) => p.stack + p.committed);
  return Math.min(me.stack + me.committed, Math.max(0, ...(oppStacks.length ? oppStacks : [me.stack + me.committed]))) / state.bigBlind;
}

// Short-stack push/fold (≤15bb effective). Too shallow to play postflop or realise
// implied odds, so the GTO-baseline line collapses to JAM or FOLD (free check in the
// BB), and the jam range widens as you shorten. This mirrors the bot's own short-stack
// logic in decide.ts (same strength + pushFloor), so the graded answer matches how the
// table actually plays — without it, a 6bb hero is told to min-open a cash range.
function pushFoldStrategy(state: GameState, heroIdx: number, effStackBB: number): NodeStrategy {
  const code = handCode(state.players[heroIdx].holeCards);
  const strength = preflopStrength(code);
  const heroPos = positionLabel(heroIdx, state.buttonIndex, state.players.length);
  const la = legalActions(state);
  const facingRaise = state.currentBet > state.bigBlind;
  const shortness = Math.max(0, Math.min(1, (15 - effStackBB) / 12));
  const pushFloor = (facingRaise ? 0.8 : 0.66) - shortness * 0.14;
  const inRange = strength >= pushFloor;
  const eff = effStackBB.toFixed(0);
  const floorPct = (pushFloor * 100).toFixed(0);
  const aggrId: ActionId = facingRaise ? 'raise' : 'open';
  const jamEv = round2(BASE_EV.value * (0.55 + 0.45 * strength));

  const options: ActionOption[] = [];
  if (la.canRaise) {
    options.push({
      id: aggrId,
      label: facingRaise ? 'Shove (re-jam)' : 'Open-jam',
      freq: inRange ? 1 : 0,
      ev: inRange ? jamEv : OFF_CHART_EV,
      kind: inRange ? (strength > 0.85 ? 'value' : 'aggressive') : 'aggressive',
      amount: la.maxRaiseTo,
      why: inRange
        ? `At ${eff}bb you're too short to play postflop — ${code} jams all-in for the fold equity plus the blinds/antes already out there.`
        : `${code} is below the ~${floorPct} jam threshold at ${eff}bb — too weak to get it in, and too short to flat for implied odds.`,
      math: `Push/fold: jam the top of your range, fold the rest; the range widens as you shorten. ${code} rates ${(strength * 100).toFixed(0)} vs a ${floorPct} floor.`,
    });
  }
  if (la.canCheck) {
    options.push({
      id: 'check',
      label: 'Check',
      freq: inRange ? 0 : 1,
      ev: 0.1,
      kind: 'passive',
      why: `Free flop — never fold the option. Jam the top of your range, check the rest back.`,
    });
  }
  if (la.callAmount > 0) {
    const pricedCall = la.isAllInCall && inRange;
    options.push({
      id: 'call',
      label: la.isAllInCall ? 'Call all-in' : 'Call',
      freq: pricedCall ? 1 : 0,
      ev: pricedCall ? jamEv : OFF_CHART_EV,
      kind: 'call',
      why: pricedCall
        ? `Already priced in — ${code} is strong enough at ${eff}bb to call off.`
        : `Too short to flat and play a pot postflop — the line is jam or fold, not call.`,
    });
    if (!options.some((o) => o.id === 'fold')) {
      options.push({
        id: 'fold',
        label: 'Fold',
        freq: inRange ? 0 : 1,
        ev: 0,
        kind: 'fold',
        why: `${code} is below the jam/continue threshold at ${eff}bb.`,
      });
    }
  }

  const best = options.reduce((a, b) => (b.ev > a.ev ? b : a), options[0]);
  return {
    options: options.sort((a, b) => b.freq - a.freq || b.ev - a.ev),
    bestEv: best.ev,
    bestId: best.id,
    source: 'preflop-chart',
    note: `${heroPos} · ${eff}bb effective — push/fold. Too shallow to play postflop, so it's jam-or-fold; the jam range widens the shorter you get. Teaching baseline, not a Nash solve.`,
    rangeNote: `${heroPos} · ${eff}bb push/fold`,
    heroCode: code,
    scenarioId: 'pushfold',
  };
}

function preflopStrategy(state: GameState, heroIdx: number): NodeStrategy {
  // Short-stack spots collapse to push/fold — diverge before the cash charts.
  const effStackBB = effectiveStackBB(state, heroIdx);
  if (effStackBB <= 15) return pushFoldStrategy(state, heroIdx, effStackBB);

  const { sc, level } = pickPreflopScenario(state, heroIdx);
  const code = handCode(state.players[heroIdx].holeCards);
  const heroPos = positionLabel(heroIdx, state.buttonIndex, state.players.length);
  // On a short table the seat name can differ from the 6-max chart we read by
  // seats-behind (e.g. 5-max UTG uses the MP open range). Say so, don't mislabel.
  const remapped = sc.facing === 'rfi' && sc.heroPos !== heroPos;
  const seatLabel = remapped ? `${heroPos} open (plays like ${sc.short})` : sc.label;
  // "Multiway" means 2+ opponents are ALREADY in the pot for this bet — the opener
  // plus any callers/squeezers. Blinds still to act behind have only posted their
  // forced blind (committed < currentBet), so they don't count yet: facing a lone
  // open with the blinds still to act is a HEADS-UP spot where 3-bet bluffs keep
  // their fold equity. Counting yet-to-act blinds wrongly flagged it multiway and
  // squashed BTN's bluffs. Heads-up charts over-bluff/over-defend a real field, so
  // squash bluff raises into call/fold only when opponents are actually in.
  const liveOpps = state.players.filter(
    (p) => !p.folded && p.id !== heroIdx && (p.committed >= state.currentBet || p.stack === 0),
  ).length;
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

  const aggrId: ActionId = sc.facing === 'rfi' ? 'open' : 'raise';
  const raiseLabel = sc.facing === 'rfi' ? 'Open' : sc.facing === 'vs4bet' ? '5-Bet' : sc.facing === 'vs3bet' ? '4-Bet' : '3-Bet';
  const raiseWord = sc.facing === 'rfi' ? 'opening' : `${raiseLabel.toLowerCase()}ting`; // "4-bet" → "4-betting"
  const ensure = (id: ActionId, label: string, kind: ActionOption['kind'], ev: number, why: string) => {
    if (options.some((o) => o.id === id)) return;
    options.push({ id, label, freq: 0, ev, kind, why, amount: id === aggrId ? raiseSize(id) : undefined });
  };

  // Surface EVERY legal action so the panel never hides a line — e.g. the 4-bet
  // facing a 3-bet, or limping/opening a hand the chart folds. Charted actions
  // keep their EV; an action the chart OMITS is a deviation we still score:
  //   • playing a fold hand / over-aggression (4-betting a flat) → -EV leak.
  //   • flatting a hand the chart raises → fine-but-worse, a small +EV.
  // Without this, matchActionId resolves an off-chart action to an id missing
  // from `options`, its EV defaults to 0, and a clear leak can grade as "Best".
  const chartFolds = options.every((o) => o.id === 'fold');
  const flatEv = round2(BASE_EV.call * 0.5); // a worse-but-not-losing alternative
  if (la.canCheck) {
    ensure('check', 'Check', 'passive', 0.1, `${code} can check here for free — never fold a free flop.`);
  }
  if (la.callAmount > 0) {
    ensure('fold', 'Fold', 'fold', 0, `${code} is below the continue threshold here.`);
    ensure('call', 'Call', 'call', chartFolds ? OFF_CHART_EV : flatEv,
      chartFolds
        ? `${code} isn't in the continue range here — calling plays a hand below threshold, usually dominated and out of position.`
        : `${code} can flat, but the chart's line is to ${raiseLabel.toLowerCase()} or fold — flatting realizes less.`);
  }
  if (la.canRaise) {
    ensure(aggrId, raiseLabel, 'aggressive', OFF_CHART_EV,
      `${code} isn't in the ${raiseWord} range here — ${raiseWord} it is a loose, -EV play.`);
  }

  const best = options.reduce((a, b) => (b.ev > a.ev ? b : a), options[0]);
  return {
    options: options.sort((a, b) => b.freq - a.freq || b.ev - a.ev),
    bestEv: best.ev,
    bestId: best.id,
    source: 'preflop-chart',
    note: `${seatLabel}.${remapped ? ` ${heroPos} at this table size has the same players-behind as a 6-max ${sc.short}, so the open range matches.` : ''}${multiway ? ` Multiway (${liveOpps} opponents) — 3-bet bluffs are dropped (no fold equity vs a field); continue mainly for value/equity.` : ''} Mixed frequencies from a teaching-baseline chart; EVs are relative estimates.`,
    rangeNote: `${seatLabel}${multiway ? ' · multiway' : ''}`,
    heroCode: code,
    scenarioId: sc.id,
  };
}

function whyPreflop(kind: ActionOption['kind'], sc: PreflopScenario, code: string, freq: number): string {
  const raiseWord = facingRaiseWord(sc.facing);
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
const unionSet = (a: Set<string>, b: Set<string>): Set<string> => {
  const s = new Set(a);
  b.forEach((x) => s.add(x));
  return s;
};
const diffSet = (a: Set<string>, b: Set<string>): Set<string> => {
  const s = new Set(a);
  b.forEach((x) => s.delete(x));
  return s;
};

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
    // No single villain (a field). Use a neutral, CAPPED continue range — tighter
    // than BTN's ~45% opener, since a random continuer isn't opening the button.
    return {
      range: rangeFromSet(diffSet(RFI_RANGES.CO, THREEBET_RANGE)),
      note: 'a generic continuing range',
      comboWeight,
    };
  }
  const { baseSet, note } = roleBaseRange(state, villain);
  const range = rangeFromSet(baseSet);
  const facingBet = state.currentBet > state.players[heroIdx].committed;
  let noteOut = note;
  if (comboWeight && facingBet && state.board.length >= 3) {
    noteOut += ' · narrowed to the hands that bet this board (flushes/straights/sets up, air down)';
  }
  return { range, note: noteOut, comboWeight };
}

/** A player's realistic preflop base range from their action-log role. Shared by
 *  the villain-range builder AND the range-vs-range solver's HERO range, so both
 *  players get a 3-bettor / opener / flat-caller / BB range instead of a flat RFI.
 *  Weighted board-conditioning (villainActionWeight) is layered on top by callers
 *  that need it; the solver's hero side uses the base set uniformly. */
export function roleBaseRange(state: GameState, seatIdx: number): { baseSet: Set<string>; note: string } {
  const pos = positionLabel(seatIdx, state.buttonIndex, state.players.length);
  const seatId = state.players[seatIdx].id;
  // 'post' = blinds, not a raise, so the raise count is never inflated by blinds.
  const pre = state.log.filter((l) => l.handNumber === state.handNumber && l.street === 'preflop');
  const preRaises = pre.filter((l) => l.type === 'raise' || l.type === 'bet');
  const raiseRank = preRaises.findIndex((l) => l.playerId === seatId);
  const called = pre.some((l) => l.playerId === seatId && l.type === 'call');

  let baseSet: Set<string>;
  let note: string;
  if (raiseRank > 0) {
    // re-raised OVER an open → tight, polar 3-bet range (value + suited bluffs)
    baseSet = unionSet(THREEBET_RANGE, BLUFF_THREEBET_RANGE);
    note = `${pos}'s 3-bet range — tight value + suited bluffs`;
  } else if (raiseRank === 0) {
    // first (only) raiser → standard opening range
    baseSet = RFI_RANGES[pos] ?? RFI_RANGES.BTN;
    note = `${pos}'s ~${pctOf(baseSet)}% opening range`;
  } else if (pos === 'BB') {
    // BB called/checked its option → wide defend range
    baseSet = BB_DEFEND_RANGE;
    note = `BB's wide defend range`;
  } else if (called) {
    // cold-called an open → CAPPED flat range (premiums would 3-bet), conditioned
    // on the OPENER's seat: you continue TIGHTER vs an early raiser's strong range
    // than vs a wide CO/BTN steal. vs UTG/MP drop the weakest flats (weak offsuit /
    // loose suited); pairs (strength ≥0.76) always survive the floor.
    const openerIdx = state.players.findIndex((p) => p.id === preRaises[0]?.playerId);
    const openerPos = openerIdx >= 0 ? positionLabel(openerIdx, state.buttonIndex, state.players.length) : pos;
    const earlyOpener = openerPos === 'UTG' || openerPos === 'MP';
    let flat = diffSet(RFI_RANGES[pos] ?? RFI_RANGES.BTN, THREEBET_RANGE);
    if (earlyOpener) flat = new Set([...flat].filter((code) => preflopStrength(code) >= 0.5));
    baseSet = flat;
    note = `${pos}'s flat-call range vs a ${openerPos} open (capped${earlyOpener ? ' + tightened vs the early raiser' : ' — premiums 3-bet'})`;
  } else {
    // limped / no clear preflop action → a capped continue range
    baseSet = diffSet(RFI_RANGES[pos] ?? RFI_RANGES.BTN, THREEBET_RANGE);
    note = `${pos}'s continuing range`;
  }
  // Safety: never return an empty range (e.g. RFI_RANGES.BB is empty by design).
  if (baseSet.size === 0) baseSet = pos === 'BB' ? BB_DEFEND_RANGE : RFI_RANGES.BTN;
  return { baseSet, note };
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
  // bet size as a fraction of the pot BEFORE the bet (pot includes the villain's
  // bet, so strip it back out). This is the conventional "% of pot" number, and
  // it drives how POLARIZED the conditioned range becomes — dividing by the
  // bet-inclusive pot understated every size (a real ¾-pot barrel read as ~43%),
  // so big bets never polarized fully and junk kept too much weight.
  const betFrac = pot - toCall > 0 ? toCall / (pot - toCall) : 1;
  // ARCHETYPE-AWARE BLUFF WEIGHT. How value-heavy a villain's BET range is depends
  // on how often he bluffs, not just his position. A loose-passive calling station
  // (bluffFreq ~0.08) barrels almost only value; a maniac (0.7) fires tons of air.
  // Position-only conditioning modelled everyone as a balanced barreler, so it kept
  // phantom bluffs/semi-bluffs in a station's range — and a bluff-catcher like
  // ace-high then showed inflated equity (it "beats" bluffs that a station never
  // has), turning a clear fold into a +EV call. Scale the non-made (bluff/semi-bluff/
  // air) part of the bet range by the villain's bluff tendency vs a ~0.33 GTO
  // baseline; made value is untouched. Human hero / unknown → 1 (balanced).
  const vIdx = primaryVillain(state, heroIdx);
  const vp = vIdx >= 0 ? state.players[vIdx] : null;
  const bluffFreq = vp && !vp.isHero ? getProfile(vp.profileId).bluffFreq : 0.33;
  const bluffMult = Math.max(0.12, Math.min(1.6, bluffFreq / 0.33));
  return (a: Card, b: Card) => betConditionedWeight(a, b, board, facingBet, betFrac, bluffMult);
}

/** Likelihood (relative weight) that a villain holding this concrete combo would
 *  take the action they took, given the board. Value/strong-draw hands bet; air
 *  mostly gives up — and a bigger bet thins the weak end harder (polarization). */
function betConditionedWeight(a: Card, b: Card, board: Card[], facingBet: boolean, betFrac: number, bluffMult = 1): number {
  const held = evaluate7([a, b, ...board]);
  const cat = held.categoryRank; // 0 high card .. 8 straight flush
  const outs = board.length < 5 ? countOuts([a, b], board).outs : 0; // draws (flop/turn)
  if (!facingBet) {
    // Villain CHECKED to us → capped range: the strongest hands usually would have
    // bet, so down-weight them slightly. (Hero is the aggressor in this branch.)
    return cat >= 6 ? 0.6 : cat >= 4 ? 0.85 : 1;
  }
  // Villain BET → value-weighted, polarized. Strength must be measured as the LIFT
  // over the bare board, not the absolute category: on a paired board (say AAQT)
  // every combo "has" at least the board's pair, so absolute category rated any K5
  // as "one pair — bets some" and any Qx as value two pair. The betting range came
  // out far too weak and inflated a bluff-catcher's equity. A hand whose category
  // equals what the board plays by itself is bluffing when it bets (a same-category
  // hand that only out-kicks the board — e.g. the higher straight on a straight
  // board — still counts as improvement via the score check, river only, where the
  // board's 5 cards make the scores comparable).
  const boardEval = evaluate7(board);
  const lift = cat - boardEval.categoryRank;
  const improves = lift > 0 || (lift === 0 && board.length === 5 && held.score > boardEval.score);
  let w: number;
  if (!improves) w = 0.18; // plays the board / no real improvement — mostly gives up (a few bluffs)
  else if (cat >= 5) w = 1.3; // flush / full house / quads / straight flush
  else if (cat === 4) w = 1.2; // straight
  else if (cat === 3) w = 1.15; // trips / set
  else if (cat === 2) w = lift === 1 ? 0.55 : 1.0; // own pair + BOARD pair plays like one pair; true two pair is value
  else w = 0.55; // one pair above the board — bets some, checks some
  // strong draws semi-bluff too (flop/turn only; the river has no draws)
  if (outs >= 8) w = Math.max(w, 0.85);
  else if (outs >= 4) w = Math.max(w, 0.45);
  // A bigger bet polarizes: it thins the weak/air part of the range harder, so the
  // value (and the flushes) become a LARGER share — exactly why a big bet on a
  // 3-flush board should tank a bluff-catcher's equity.
  const polar = Math.min(1, betFrac / 0.75); // 0 (tiny) .. 1 (¾-pot or bigger)
  if (w < 0.7) w *= 1 - 0.55 * polar;
  // Archetype bluff scaling: only the NON-made part (bluffs / semi-bluffs / air).
  // A low-bluff villain (LP/NIT) collapses these toward 0, leaving a value-heavy
  // barrel; a maniac inflates them. Made value (improves) is never scaled.
  if (!improves) w *= bluffMult;
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

  // Hero's position vs the primary villain. Postflop order starts left of the
  // button, so the higher order-rank acts LATER (= in position). Drives equity
  // realisation and fold equity in the model — omitting it made the BB realise
  // OOP equity at 100% and rated thin bluff-catches as clear calls.
  const vIdx = primaryVillain(state, heroIdx);
  let position: 'ip' | 'oop' | undefined;
  if (vIdx >= 0) {
    const np = state.players.length;
    const orderRank = (seat: number) => (seat - (state.buttonIndex + 1) + np) % np;
    position = orderRank(heroIdx) > orderRank(vIdx) ? 'ip' : 'oop';
  }

  // Tier-2 Stage 0: a hero-FIRST heads-up river node (hero can check or bet, not
  // facing a bet) goes through the range-vs-range CFR solver. Everything else —
  // facing a bet, multiway, earlier streets — stays on the per-hand model below.
  if (
    RIVER_SOLVER_ENABLED &&
    state.street === 'river' &&
    la.callAmount === 0 &&
    la.canCheck &&
    la.canRaise &&
    liveOpps === 1
  ) {
    // Hero's range from the SAME role-based builder the villain uses (3-bettor /
    // opener / flat-caller / BB), not a flat position RFI — a big accuracy lift.
    const heroRange = rangeFromSet(roleBaseRange(state, heroIdx).baseSet);
    const solved = solveRiverNode({
      heroCards: hero.holeCards,
      board: state.board,
      pot,
      effStack,
      heroRange,
      villainRange: range,
      villainComboWeight: comboWeight,
      bigBlind: state.bigBlind,
      rangeNote: note,
    });
    if (solved) return solved;
  }

  // Tier-2 Stage 2: a hero-FIRST heads-up TURN node → range-vs-range solve with the
  // river runouts enumerated for showdown equity (captures value / protection / air).
  if (
    RIVER_SOLVER_ENABLED &&
    state.street === 'turn' &&
    la.callAmount === 0 &&
    la.canCheck &&
    la.canRaise &&
    liveOpps === 1
  ) {
    const heroRange = rangeFromSet(roleBaseRange(state, heroIdx).baseSet);
    const solved = solveTurnNode({
      heroCards: hero.holeCards,
      board: state.board,
      pot,
      effStack,
      heroRange,
      villainRange: range,
      villainComboWeight: comboWeight,
      bigBlind: state.bigBlind,
      rangeNote: note,
    });
    if (solved) return solved;
  }

  // Tier-2: a hero-FACING-A-BET heads-up river node (villain led, hero's first
  // decision this street) → fold / call / raise range-vs-range solve.
  if (
    RIVER_SOLVER_ENABLED &&
    state.street === 'river' &&
    la.callAmount > 0 &&
    la.canRaise &&
    liveOpps === 1 &&
    hero.committed === 0
  ) {
    const heroRange = rangeFromSet(roleBaseRange(state, heroIdx).baseSet);
    const b = la.callAmount;
    const raiseTo = Math.min(la.maxRaiseTo, Math.round(pot + b)); // ~pot-sized raise
    if (raiseTo > b) {
      const solved = solveRiverVsBetNode({
        heroCards: hero.holeCards,
        board: state.board,
        potBeforeBet: pot - b,
        bet: b,
        raiseTo,
        heroRange,
        villainRange: range,
        villainComboWeight: comboWeight,
        bigBlind: state.bigBlind,
        rangeNote: note,
      });
      if (solved) return solved;
    }
  }

  const strat = solvePostflop({
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
    position,
  });

  // Villain-read overlay: name how THIS opponent's tendencies shift the baseline
  // (balanced) line — the "normally X, vs this villain Y" the user asked for. The
  // EV numbers already bake the archetype in (via bluffMult); this just says WHY in
  // words, so no second solve is needed. Only added when the read is meaningfully
  // off-balanced (a station / a heavy bluffer); a balanced villain gets nothing.
  const vnote = villainReadNote(state, heroIdx, la.callAmount);
  if (vnote) {
    return { ...strat, note: `${strat.note} ${vnote}`, notes: [...(strat.notes ?? []), vnote] };
  }
  return strat;
}

/** One-line, spot-specific villain read for the Explain panel: how this opponent's
 *  tendencies shift the baseline (balanced) recommendation. Text only — no second
 *  solve — it names the DIRECTION the archetype implies (value-heavy vs air-heavy
 *  bet; station vs bluffer). Returns null for a balanced/unknown villain. */
function villainReadNote(state: GameState, heroIdx: number, callAmount: number): string | null {
  if (state.board.length < 3) return null;
  const vIdx = primaryVillain(state, heroIdx);
  if (vIdx < 0 || state.players[vIdx].isHero) return null;
  const p = getProfile(state.players[vIdx].profileId);
  const name = state.players[vIdx].name;
  const bluffPct = Math.round(p.bluffFreq * 100);
  if (callAmount > 0) {
    // facing a bet → the read is about bluff-catching
    if (p.bluffFreq <= 0.18)
      return `Villain read: ${name} (${p.tag}) rarely bluffs (~${bluffPct}%), so this bet is value-heavy. Vs a balanced player you'd defend more here — against ${name} bluff-catch tighter and fold marginal hands; there's little to catch.`;
    if (p.bluffFreq >= 0.42)
      return `Villain read: ${name} (${p.tag}) bluffs a lot (~${bluffPct}%), so this bet range is wide and air-heavy. Vs a balanced player you'd fold more — against ${name} call down lighter and don't overfold your bluff-catchers.`;
    return null;
  }
  // not facing a bet → the read is about how to value/pressure this villain
  if (p.callStation >= 0.6)
    return `Villain read: ${name} (${p.tag}) is a calling station — pays off too much, rarely folds. Value bet thin and BIG with made hands, and check back air instead of bluffing (his bluff-catches don't fold).`;
  if (p.aggression >= 0.8)
    return `Villain read: ${name} (${p.tag}) is hyper-aggressive — let him do the betting. Check-call / trap strong hands and avoid bluffing into a player who won't fold and barrels for you.`;
  return null;
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
