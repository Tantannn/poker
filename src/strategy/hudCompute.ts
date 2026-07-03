// The hero-turn HUD/strategy computation, extracted pure so it can run OFF the
// main thread (workers/hudWorker.ts). Everything here is derived from the
// GameState alone — no closures, no DOM — so the state can be postMessage'd to
// a worker and the result posted back (Maps survive structured clone).
// useGame falls back to calling this directly if Workers are unavailable.

import type { GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import type { Card } from '../engine/cards';
import { makeRng } from '../engine/cards';
import { countOuts, equityVsRange, equityVsField, ruleOf2and4, exactOutsEquity } from '../engine/equity';
import { potOdds } from '../engine/potOdds';
import { getProfile } from '../ai/profiles';
import { buildVillainRange, getNodeStrategy, primaryVillainIdx, summarizeRange } from './index';
import type { NodeStrategy } from './types';

export interface HudInfo {
  equity: number;
  win: number;
  tie: number;
  // raw Monte-Carlo tally behind win/tie (wins + ties + losses === trials)
  trials: number;
  wins: number;
  ties: number;
  losses: number;
  outs: number;
  outCards: Card[];
  outsBreakdown: { category: string; cards: Card[] }[];
  toCall: number;
  pot: number;
  requiredEquity: number;
  oddsRatio: number;
  ruleEstimate: number; // outs × 2/4 shortcut
  trueEstimate: number; // exact hypergeometric hit %, what the shortcut approximates
  rangeNote: string;
  // ---- villain range read (board + action aware) ----
  equityRaw: number; // equity vs his UNconditioned opening/continuing range
  conditioned: boolean; // true when facing a bet postflop → "betting range" applies
  villainShape: { label: string; pct: number }[]; // what he's repping on this board
  villainAhead: number; // mass-fraction of his range that beats you right now
  // ---- risk / commitment lens ----
  effStackBB: number; // effective stack (min of you vs live opponents), in bb
  spr: number; // stack-to-pot ratio (effective stack ÷ pot)
  callStackPct: number; // fraction of your remaining stack a call would cost (0..1)
}

export interface VillainInfo {
  name: string;
  position: string;
  profileId: string;
  tag: string;
  wasAggressor: boolean;
  rangeNote: string;
  /** is the hero in position (acts after this villain) postflop? */
  heroInPosition: boolean;
}

export interface HudNodeResult {
  strategy: NodeStrategy;
  hud: HudInfo;
  villain: VillainInfo | null;
}

/** Full hero-node read: seeded shared equity, solver strategy, villain info and
 *  every HUD number — the body of useGame's hero-turn effect, minus setState. */
export function computeHudNode(game: GameState): HudNodeResult {
  const hero = game.players[0];
  const legal = legalActions(game);
  const { range, note, comboWeight } = buildVillainRange(game, 0);
  // count opponents still live — in a multiway pot you must beat ALL of them,
  // so equity is materially lower than the heads-up (single-villain) number.
  const liveOpps = game.players.filter((p) => !p.isHero && !p.folded).length;
  // ONE Monte-Carlo equity, SEEDED and SHARED by both the HUD pot-odds panel
  // and the solver strategy panel (see useGame for the full history of why).
  const eqSeed =
    (((game.seed ?? 0) >>> 0) ^
      Math.imul(game.board.length + 1, 0x9e3779b1) ^
      Math.imul(Math.round(potTotal(game)) + 1, 0x85ebca6b)) >>>
    0;
  const eqRng = makeRng(eqSeed);
  const sim =
    liveOpps > 1
      ? equityVsField(hero.holeCards, game.board, Array.from({ length: liveOpps }, () => range), 1400, eqRng, comboWeight)
      : equityVsRange(hero.holeCards, game.board, range, 1400, eqRng, comboWeight);
  const trials = sim.trials;
  const win = trials > 0 ? sim.wins / trials : 0;
  const tie = trials > 0 ? sim.ties / trials : 0;
  // decomposition shown in the HUD tooltip matches this exactly
  const eq = { equity: win + tie / 2, win, tie };
  // solver reads the SAME equity number — no second, independent MC run.
  const strategy = getNodeStrategy(game, 0, 1100, eq.equity);
  // Raw equity vs his UNconditioned opening range — for the side-by-side
  // "vs opening range → vs betting range" read. Same seed → the gap is the
  // conditioning (he bet this board), not Monte-Carlo noise.
  const rawSim =
    liveOpps > 1
      ? equityVsField(hero.holeCards, game.board, Array.from({ length: liveOpps }, () => range), 1400, makeRng(eqSeed))
      : equityVsRange(hero.holeCards, game.board, range, 1400, makeRng(eqSeed));
  const equityRaw = rawSim.equity;
  const shape = summarizeRange(hero.holeCards, range, game.board, comboWeight);
  const conditioned = !!comboWeight && game.board.length >= 3 && legal.callAmount > 0;
  const multiwayNote = liveOpps > 1 ? ` · vs ${liveOpps} opponents (multiway)` : '';
  const outsInfo = countOuts(hero.holeCards, game.board);
  const pot = potTotal(game);
  const toCall = legal.callAmount;
  const po = potOdds(pot, toCall);
  // risk lens: effective stack = min of your behind-stack and the live
  // opponents' (you can only win/lose the smaller).
  const oppStacks = game.players.filter((p) => !p.isHero && !p.folded).map((p) => p.stack);
  const effStack = Math.min(hero.stack, ...(oppStacks.length ? oppStacks : [hero.stack]));
  const spr = pot > 0 ? effStack / pot : 0;
  const callStackPct = hero.stack > 0 ? Math.min(1, toCall / hero.stack) : 0;
  const cardsToCome = game.street === 'flop' ? 2 : game.street === 'turn' ? 1 : 0;

  let villain: VillainInfo | null = null;
  const vIdx = primaryVillainIdx(game, 0);
  if (vIdx >= 0 && !game.players[vIdx].isHero) {
    const vp = game.players[vIdx];
    const wasAggressor = game.log.some(
      (l) =>
        l.handNumber === game.handNumber &&
        l.street === 'preflop' &&
        l.playerId === vIdx &&
        (l.type === 'raise' || l.type === 'bet'),
    );
    // postflop action runs from left-of-button (first/most OOP) to the
    // button (last/most IP); hero is IP if they act after this villain.
    const np = game.players.length;
    const orderRank = (seat: number) => (seat - (game.buttonIndex + 1) + np) % np;
    const heroInPosition = orderRank(0) > orderRank(vIdx);
    villain = {
      name: vp.name,
      position: positionLabel(vIdx, game.buttonIndex, np),
      profileId: vp.profileId,
      tag: getProfile(vp.profileId).tag,
      wasAggressor,
      rangeNote: note,
      heroInPosition,
    };
  }

  const hud: HudInfo = {
    equity: eq.equity,
    win: eq.win,
    tie: eq.tie,
    trials: sim.trials,
    wins: sim.wins,
    ties: Math.round(sim.ties),
    losses: sim.losses,
    outs: outsInfo.outs,
    outCards: outsInfo.cards,
    outsBreakdown: outsInfo.byCategory,
    toCall,
    pot,
    requiredEquity: po.requiredEquity,
    oddsRatio: po.oddsRatio,
    ruleEstimate: ruleOf2and4(outsInfo.outs, cardsToCome),
    trueEstimate: exactOutsEquity(outsInfo.outs, cardsToCome),
    rangeNote: note + multiwayNote,
    equityRaw,
    conditioned,
    villainShape: shape.buckets,
    villainAhead: shape.aheadPct,
    effStackBB: effStack / game.bigBlind,
    spr,
    callStackPct,
  };

  return { strategy, hud, villain };
}
