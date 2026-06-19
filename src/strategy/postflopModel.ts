// Heuristic postflop "solver-model". For a node it estimates each action's EV
// (in bb) from equity-vs-range + a fold-equity model, then derives a mixed
// strategy. NOT a Nash solve — a fast, transparent approximation.

import type { Card } from '../engine/cards';
import type { WeightedRange } from '../engine/range';
import { equityVsRange } from '../engine/equity';
import { classifyFlop } from '../engine/board';
import type { ActionId, ActionOption, NodeStrategy } from './types';
import { mixFromEv } from './types';

export interface PostflopInput {
  hero: Card[];
  board: Card[];
  oppRange: WeightedRange;
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
  const eqRes = equityVsRange(inp.hero, inp.board, inp.oppRange, inp.iterations ?? 1200);
  const e = eqRes.equity;
  const P = inp.pot;
  const C = inp.toCall;
  const bb = inp.bigBlind;

  const tex = inp.board.length >= 3 ? classifyFlop(inp.board) : null;
  const wetness =
    tex == null
      ? 0
      : (tex.connected ? 0.06 : 0) + (tex.suitPattern !== 'rainbow' ? 0.05 : 0) + (tex.paired ? -0.03 : 0);

  const cands: Candidate[] = [];

  // passive line
  if (inp.canCheck) {
    cands.push({
      id: 'check',
      label: 'Check',
      ev: (e * P) / bb,
      kind: 'passive',
      why: `Realize your ~${pct(e)} equity in a ${P}-chip pot without risking more. Best when you're not ahead enough to bet for value or to profitably pressure.`,
      math: `EV = equity × pot = ${pct1(e)} × ${P} = ${(e * P).toFixed(1)} chips ≈ ${((e * P) / bb).toFixed(2)} bb`,
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
      math: `EV(fold) = 0 bb (you put in nothing more).`,
    });
    cands.push({
      id: 'call',
      label: `Call ${C}`,
      ev: (e * (P + C) - C) / bb,
      kind: 'passive',
      why: `Pot odds require ${pct(need)}; you have ~${pct(e)}, so calling is ${e >= need ? 'profitable' : 'marginal/-EV'}.`,
      math: `EV = equity × (pot + call) − call = ${pct1(e)} × ${P + C} − ${C} = ${(e * (P + C) - C).toFixed(1)} chips ≈ ${((e * (P + C) - C) / bb).toFixed(2)} bb`,
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
    const d = computeAggro(e, P, C, target, inp.currentBet, inp.heroCommitted, wetness, false);
    const isValue = e >= 0.55;
    cands.push({
      id,
      label,
      ev: d.ev / bb,
      amount: target,
      sizePct: Math.round((100 * (target - inp.currentBet)) / Math.max(1, potForSize)),
      kind: isValue ? 'value' : 'bluff',
      why: isValue
        ? `Bet for value: you're ahead (~${pct(e)}). Worse hands call and you build a bigger pot; ~${pct(d.fe)} of the time better hands fold too.`
        : `Pressure/semi-bluff: villain folds ~${pct(d.fe)} (you take the ${P} pot); when called you still carry ~${pct(d.e2)} equity.`,
      math: `EV = fold% × pot + called% × (eq-when-called × final pot − you invest)\n   = ${pct1(d.fe)} × ${P} + ${pct1(1 - d.fe)} × (${pct1(d.e2)} × ${d.calledPot} − ${d.A})\n   = ${d.ev.toFixed(1)} chips ≈ ${(d.ev / bb).toFixed(2)} bb`,
    });
  };

  addBet('bet33', 0.33, C === 0 ? 'Bet 33%' : 'Raise 33%');
  addBet('bet75', 0.75, C === 0 ? 'Bet 75%' : 'Raise 75%');
  addBet('betpot', 1.0, C === 0 ? 'Bet pot' : 'Raise pot');

  if (inp.canRaise && inp.maxRaiseTo > inp.currentBet) {
    const d = computeAggro(e, P, C, inp.maxRaiseTo, inp.currentBet, inp.heroCommitted, wetness, true);
    const isValue = e >= 0.55;
    cands.push({
      id: 'allin',
      label: 'All-in',
      ev: d.ev / bb,
      amount: inp.maxRaiseTo,
      sizePct: Math.round((100 * (inp.maxRaiseTo - inp.currentBet)) / Math.max(1, potForSize)),
      kind: isValue ? 'value' : 'bluff',
      why: isValue
        ? `Max value/protection: you're ahead (~${pct(e)}) and put maximum chips in while you hold the edge.`
        : `High-variance shove: only profitable via fold equity (~${pct(d.fe)}); when called you have ~${pct(d.e2)}.`,
      math: `EV = ${pct1(d.fe)} × ${P} + ${pct1(1 - d.fe)} × (${pct1(d.e2)} × ${d.calledPot} − ${d.A}) = ${d.ev.toFixed(1)} chips ≈ ${(d.ev / bb).toFixed(2)} bb`,
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
    note: `Equity ${(e * 100).toFixed(1)}% vs villain range. EVs are heuristic estimates (fold-equity model), not a solver.`,
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
): AggroDetail {
  const R = target - currentBet; // pressure on top of a call
  const A = target - heroCommitted; // total hero invests now
  const s = R / Math.max(1, P + C);
  let fe = 0.12 + 0.42 * Math.min(s, 1.6) - wetness;
  fe = Math.max(0.04, Math.min(0.82, fe));
  const e2 = Math.max(0, e - (isAllIn ? 0.06 : 0.1)); // villain continues with a stronger range
  const calledPot = P + A + R;
  const ev = fe * P + (1 - fe) * (e2 * calledPot - A);
  return { ev, fe, e2, calledPot, A };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
