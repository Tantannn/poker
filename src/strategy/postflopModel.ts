// Heuristic postflop "solver-model". For a node it estimates each action's EV
// (in bb) from equity-vs-range + a fold-equity model, then derives a mixed
// strategy. NOT a Nash solve — a fast, transparent approximation.

import type { Card } from '../engine/cards';
import type { WeightedRange } from '../engine/range';
import { equityVsRange, equityVsField, countOuts } from '../engine/equity';
import { requiredEquityForBet } from '../engine/potOdds';
import { classifyFlop } from '../engine/board';
import type { ActionId, ActionOption, NodeStrategy } from './types';
import { mixFromEv } from './types';

// Four-way classification of an aggressive line by hero equity (+ draw), so the
// explanation distinguishes a real bluff from thin value / a semi-bluff.
type BetClass = 'value' | 'thin' | 'semibluff' | 'bluff';
function classifyBet(e: number, outs: number): BetClass {
  if (e >= 0.62) return 'value';
  if (e >= 0.5) return 'thin';
  if (e >= 0.3 || outs >= 4) return 'semibluff';
  return 'bluff';
}
// kind drives grid/bar color; we keep the existing 2-tone (value vs bluff).
const classKind = (c: BetClass): ActionOption['kind'] => (c === 'value' || c === 'thin' ? 'value' : 'bluff');

/** GTO bluff frequency for a bet of `frac`×pot on the river, and value:bluff ratio.
 *  Memo: the bluff fraction equals the equity a caller needs at this size — same
 *  number, so `requiredEquityForBet` is the single source for both. */
function riverBalance(frac: number): string {
  const bluffFrac = requiredEquityForBet(frac);
  const ratio = (1 - bluffFrac) / Math.max(0.001, bluffFrac);
  return ` River balance: this size wants ~${Math.round(bluffFrac * 100)}% bluffs (≈ ${ratio.toFixed(1)} : 1 value-to-bluff).`;
}

function whyBet(
  c: BetClass,
  e: number,
  d: { fe: number; e2: number },
  outs: number,
  isAllIn: boolean,
  river: boolean,
  frac: number,
): string {
  const fe = `${Math.round(d.fe * 100)}%`;
  const eq = `${Math.round(e * 100)}%`;
  const e2 = `${Math.round(d.e2 * 100)}%`;
  let base: string;
  switch (c) {
    case 'value':
      base = isAllIn
        ? `Value shove: you're well ahead (~${eq}) — get max chips in while you hold the edge.`
        : `Value bet: you're ahead (~${eq}). Worse hands call and build the pot; ~${fe} of the time better hands fold too.`;
      break;
    case 'thin':
      base = `Thin value / merge: only a slight favourite (~${eq}). Bet to get called by worse — but size down, you're not strong enough to bloat the pot.`;
      break;
    case 'semibluff':
      base = `Semi-bluff: ~${eq} equity now${outs > 0 ? ` with ~${outs} outs` : ''}. Two ways to win — villain folds ~${fe}, and when called you still hit ~${e2} of the time. Keep barreling cards that complete your draw.`;
      break;
    default:
      base = `Pure bluff: ~${eq} equity — essentially drawing thin. Only profitable via fold equity (~${fe}); pick good blocker cards and a believable story, otherwise just give up.`;
  }
  return river ? base + riverBalance(frac) : base;
}

export interface PostflopInput {
  hero: Card[];
  board: Card[];
  oppRange: WeightedRange;
  /** ranges of EVERY live opponent (for multiway equity). Falls back to [oppRange]
   *  when omitted. >1 entry → hero must beat the whole field, so equity/EV drop. */
  oppRanges?: WeightedRange[];
  pot: number; // chips in middle before hero acts (incl. villain bet)
  toCall: number; // chips to call (0 if can check)
  heroCommitted: number; // chips hero already put this street
  currentBet: number; // highest committed this street
  minRaiseTo: number;
  maxRaiseTo: number; // all-in target
  canCheck: boolean;
  canRaise: boolean;
  bigBlind: number;
  iterations?: number;
  rangeNote?: string;
  heroCode?: string;
  /** hero's position vs the villain — affects equity realisation & fold equity. */
  position?: 'ip' | 'oop';
}

interface Candidate {
  id: ActionId;
  label: string;
  ev: number; // bb
  amount?: number;
  sizePct?: number;
  kind: ActionOption['kind'];
  why?: string;
  math?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

export function solvePostflop(inp: PostflopInput): NodeStrategy {
  const ranges = inp.oppRanges && inp.oppRanges.length ? inp.oppRanges : [inp.oppRange];
  const nOpp = ranges.length;
  const iters = inp.iterations ?? 1200;
  // multiway: hero must beat the whole field, so equity is lower than heads-up.
  const eqRes = nOpp > 1
    ? equityVsField(inp.hero, inp.board, ranges, iters)
    : equityVsRange(inp.hero, inp.board, inp.oppRange, iters);
  const e = eqRes.equity;
  const P = inp.pot;
  const C = inp.toCall;
  const bb = inp.bigBlind;

  // outs for semi-bluff vs pure-bluff labelling (meaningful flop/turn only)
  const outs = inp.board.length >= 3 && inp.board.length < 5 ? countOuts(inp.hero, inp.board).outs : 0;
  const isRiver = inp.board.length === 5;

  const tex = inp.board.length >= 3 ? classifyFlop(inp.board) : null;
  const wetness =
    tex == null
      ? 0
      : (tex.connected ? 0.06 : 0) + (tex.suitPattern !== 'rainbow' ? 0.05 : 0) + (tex.paired ? -0.03 : 0);

  // position: in position you act last, so you realise more of your equity
  // (free cards, pot control) and your bets carry a touch more fold equity;
  // out of position the opposite. 1.0 = neutral when position is unknown.
  const oop = inp.position === 'oop';
  const ip = inp.position === 'ip';
  const realize = ip ? 1.06 : oop ? 0.9 : 1.0;
  const feMult = ip ? 1.1 : oop ? 0.9 : 1.0;
  const eReal = Math.min(1, e * realize);

  const cands: Candidate[] = [];

  // passive line
  if (inp.canCheck) {
    cands.push({
      id: 'check',
      label: 'Check',
      ev: (eReal * P) / bb,
      kind: 'passive',
      why: `Realize your ~${pct(e)} equity in a ${P}-chip pot without risking more${
        inp.position ? ` (${ip ? 'in position you realise it well — you can check back and take a free card' : 'out of position you realise less — villain can barrel you off it'})` : ''
      }. Best when you're not ahead enough to bet for value or to profitably pressure.`,
      math: `EV = equity × pot${inp.position ? ` × realise(${realize})` : ''} = ${pct1(eReal)} × ${P} = ${(eReal * P).toFixed(1)} chips ≈ ${((eReal * P) / bb).toFixed(2)} bb`,
    });
  }
  if (C > 0) {
    const need = C / (P + C);
    cands.push({
      id: 'fold',
      label: 'Fold',
      ev: 0,
      kind: 'fold',
      why: `You need ${pct(need)} equity to call but only have ~${pct(e)}. Folding forfeits the pot but loses the least.`,
      math: `Pot odds: need = call ÷ (pot + call) = ${C} ÷ ${P + C} = ${pct(need)}; you have ~${pct(e)}.\nEV(fold) = 0 bb (you put in nothing more).`,
    });
    cands.push({
      id: 'call',
      label: `Call ${C}`,
      ev: (eReal * (P + C) - C) / bb,
      kind: 'passive',
      why: `Pot odds require ${pct(need)}; you have ~${pct(e)}, so calling is ${eReal >= need ? 'profitable' : 'marginal/-EV'}.${
        oop ? ' Out of position you realise less of that equity, so call tighter.' : ip ? ' In position you realise it well.' : ''
      }`,
      math: `Pot odds: need = call ÷ (pot + call) = ${C} ÷ ${P + C} = ${pct(need)} (you have ~${pct(e)}).\nEV = equity × (pot + call) − call = ${pct1(eReal)} × ${P + C} − ${C} = ${(eReal * (P + C) - C).toFixed(1)} chips ≈ ${((eReal * (P + C) - C) / bb).toFixed(2)} bb`,
    });
  }

  // aggressive lines
  const potForSize = P + C; // pot if hero just calls
  const addBet = (id: ActionId, frac: number, label: string) => {
    if (!inp.canRaise) return;
    let target: number;
    if (C === 0) target = Math.round(inp.heroCommitted + frac * P);
    else target = Math.round(inp.currentBet + frac * potForSize);
    target = Math.max(target, inp.minRaiseTo);
    target = Math.min(target, inp.maxRaiseTo);
    if (target >= inp.maxRaiseTo) return; // becomes all-in; handled separately
    const d = computeAggro(e, P, C, target, inp.currentBet, inp.heroCommitted, wetness, false, realize, feMult, nOpp);
    const cls = classifyBet(e, outs);
    cands.push({
      id,
      label,
      ev: d.ev / bb,
      amount: target,
      sizePct: Math.round((100 * (target - inp.currentBet)) / Math.max(1, potForSize)),
      kind: classKind(cls),
      why: whyBet(cls, e, d, outs, false, isRiver, frac),
      math: `EV = fold% × pot + called% × (eq-when-called × final pot − you invest)\n   = ${pct1(d.fe)} × ${P} + ${pct1(1 - d.fe)} × (${pct1(d.e2)} × ${d.calledPot} − ${d.A})\n   = ${d.ev.toFixed(1)} chips ≈ ${(d.ev / bb).toFixed(2)} bb`,
    });
  };

  addBet('bet33', 0.33, C === 0 ? 'Bet 33%' : 'Raise 33%');
  addBet('bet75', 0.75, C === 0 ? 'Bet 75%' : 'Raise 75%');
  addBet('betpot', 1.0, C === 0 ? 'Bet pot' : 'Raise pot');

  if (inp.canRaise && inp.maxRaiseTo > inp.currentBet) {
    const d = computeAggro(e, P, C, inp.maxRaiseTo, inp.currentBet, inp.heroCommitted, wetness, true, realize, feMult, nOpp);
    const cls = classifyBet(e, outs);
    const allinFrac = (inp.maxRaiseTo - inp.currentBet) / Math.max(1, potForSize);
    // shoving your whole stack is high-variance and hard to recover from IRL, so
    // apply a small risk premium — all-in only "wins" when it's clearly best.
    const RISK = 0.5;
    const rawEv = d.ev / bb;
    const adjEv = rawEv - RISK;
    cands.push({
      id: 'allin',
      label: 'All-in',
      ev: adjEv,
      amount: inp.maxRaiseTo,
      sizePct: Math.round((100 * (inp.maxRaiseTo - inp.currentBet)) / Math.max(1, potForSize)),
      kind: classKind(cls),
      why:
        whyBet(cls, e, d, outs, true, isRiver, allinFrac) +
        ` Note: a ${RISK}bb risk premium is applied — shoving your whole stack is high-variance and hard to recover from, so prefer a sized bet unless all-in is clearly best.`,
      math: `EV = ${pct1(d.fe)} × ${P} + ${pct1(1 - d.fe)} × (${pct1(d.e2)} × ${d.calledPot} − ${d.A}) = ${rawEv.toFixed(2)} bb\n   − ${RISK} bb high-variance risk premium → ${adjEv.toFixed(2)} bb`,
    });
  }

  // ---- mix ----
  const evs = cands.map((c) => ({ id: c.id, ev: c.ev }));
  const mix = mixFromEv(evs, 0.5, 1.4);
  const bestEv = Math.max(...cands.map((c) => c.ev));
  // don't fold a +EV spot
  if (bestEv > 0.001) mix.set('fold', 0);
  // renormalise
  let sum = 0;
  mix.forEach((v) => (sum += v));
  if (sum > 0) mix.forEach((v, k) => mix.set(k, v / sum));

  const options: ActionOption[] = cands
    .map((c) => ({
      id: c.id,
      label: c.label,
      freq: mix.get(c.id) ?? 0,
      ev: round2(c.ev),
      amount: c.amount,
      sizePct: c.sizePct,
      kind: c.kind,
      why: c.why,
      math: c.math,
    }))
    .sort((a, b) => b.freq - a.freq || b.ev - a.ev);

  const best = options.reduce((a, b) => (b.ev > a.ev ? b : a), options[0]);

  return {
    options,
    bestEv: round2(bestEv),
    bestId: best.id,
    source: 'postflop-model',
    note: `Equity ${(e * 100).toFixed(1)}% ${nOpp > 1 ? `vs the ${nOpp}-way field (you must beat all)` : 'vs villain range'}. EVs are heuristic estimates (fold-equity model), not a solver.`,
    equity: e,
    rangeNote: inp.rangeNote,
    heroCode: inp.heroCode,
    villainRange: inp.oppRange,
  };
}

interface AggroDetail {
  ev: number;
  fe: number;
  e2: number;
  calledPot: number;
  A: number;
}

function computeAggro(
  e: number,
  P: number,
  C: number,
  target: number,
  currentBet: number,
  heroCommitted: number,
  wetness: number,
  isAllIn: boolean,
  realize = 1.0,
  feMult = 1.0,
  oppCount = 1,
): AggroDetail {
  const R = target - currentBet; // pressure on top of a call
  const A = target - heroCommitted; // total hero invests now
  const s = R / Math.max(1, P + C); // raise size relative to the pot
  // Fold equity rises with size but SATURATES fast and never folds everything.
  // A pot-sized bet already buys most of the folds; over-betting/shoving buys
  // almost none more — so a 10x-pot shove is not "free money". Position nudges
  // it (in position bets earn a touch more folds).
  let fe = (0.1 + 0.3 * Math.min(s, 1.2) - wetness) * feMult;
  fe = Math.max(0.04, Math.min(0.6, fe));
  // MULTIWAY: EVERY opponent has to fold for the bet to take it down. Treating
  // their folds as roughly independent, the chance they ALL fold is fe^oppCount —
  // so fold equity collapses fast as the field grows.
  if (oppCount > 1) fe = Math.max(0.02, Math.pow(fe, oppCount));
  // When called, villain's continuing range is stronger — and the bigger the
  // bet, the tighter (and stronger) that range, so hero's realised equity drops
  // more the larger the size. This is what kills the over-betting/shove EV.
  const sizePenalty = 0.1 * Math.min(Math.max(0, s - 0.5), 2);
  // ALL-IN calling range is tighter still: only strong hands stack off, so the
  // equity hero realises WHEN CALLED is lower than vs the wider continuing range.
  // Each extra opponent tightens the range that continues, dropping it further.
  const callTightness = (isAllIn ? 0.12 : 0.08) + 0.04 * (oppCount - 1);
  const e2 = Math.max(0, Math.min(1, e * realize) - callTightness - sizePenalty);
  const calledPot = P + A + R;
  const ev = fe * P + (1 - fe) * (e2 * calledPot - A);
  return { ev, fe, e2, calledPot, A };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
