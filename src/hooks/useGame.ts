// Central game hook: owns the GameState, steps the AI opponents on a timer,
// grades hero decisions with the heuristic strategy engine (EV loss + RNG),
// and feeds analytics + hand history.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, GameState } from '../engine/table';
import {
  applyAction,
  createGame,
  handResults,
  legalActions,
  positionLabel,
  potTotal,
  startHand,
} from '../engine/table';
import type { Card } from '../engine/cards';
import { countOuts, equityVsRange, ruleOf2and4 } from '../engine/equity';
import { potOdds } from '../engine/potOdds';
import { decideAction } from '../ai/decide';
import type { NodeStrategy } from '../strategy';
import { buildVillainRange, getNodeStrategy, primaryVillainIdx } from '../strategy';
import { getProfile } from '../ai/profiles';
import type { ActionId } from '../strategy/types';
import { rngPrescription } from '../strategy/types';
import type { NodeFeedback } from '../analysis/grade';
import { gradeNode, idToClass } from '../analysis/grade';
import type { SessionStats } from '../store/stats';
import {
  findLeaks,
  loadStats,
  recordDecision,
  recordHand,
  resetStats,
  saveStats,
} from '../store/stats';

export const BIG_BLIND = 2;
export const SMALL_BLIND = 1;
export const NUM_PLAYERS = 6;
export const STARTING_BB = 100;

export type Speed = '1x' | '2x' | 'instant';
const SPEED_DELAY: Record<Speed, number> = { '1x': 750, '2x': 330, instant: 0 };

export type HeroPositionPref = 'random' | 'BTN' | 'CO' | 'MP' | 'UTG' | 'SB' | 'BB';

export interface HudInfo {
  equity: number;
  win: number;
  tie: number;
  outs: number;
  outCards: Card[];
  toCall: number;
  pot: number;
  requiredEquity: number;
  oddsRatio: number;
  ruleEstimate: number;
  rangeNote: string;
}

export interface RngInfo {
  roll: number;
  prescribed: ActionId;
}

export interface VillainInfo {
  name: string;
  position: string;
  profileId: string;
  tag: string;
  wasAggressor: boolean;
  rangeNote: string;
}

export interface HistoryHand {
  handNumber: number;
  heroCards: Card[];
  board: Card[];
  log: { text: string }[];
  result: string;
  deltaBB: number;
  showdown: { name: string; cards: Card[]; folded: boolean }[];
}

const POS_TO_BUTTON: Record<Exclude<HeroPositionPref, 'random'>, number> = {
  BTN: 0,
  CO: 1,
  MP: 2,
  UTG: 3,
  BB: 4,
  SB: 5,
};

export function useGame(initialProfiles: string[]) {
  const [profiles, setProfiles] = useState<string[]>(initialProfiles);
  const [game, setGame] = useState<GameState>(() =>
    createGame(NUM_PLAYERS, STARTING_BB, BIG_BLIND, initialProfiles),
  );
  const [feedback, setFeedback] = useState<NodeFeedback | null>(null);
  const [hud, setHud] = useState<HudInfo | null>(null);
  const [strategy, setStrategy] = useState<NodeStrategy | null>(null);
  const [rng, setRng] = useState<RngInfo | null>(null);
  const [villain, setVillain] = useState<VillainInfo | null>(null);
  const [hudLoading, setHudLoading] = useState(false);
  const [history, setHistory] = useState<HistoryHand[]>([]);
  const [stats, setStats] = useState<SessionStats>(() => loadStats());
  const [scenario, setScenario] = useState<HeroPositionPref>('random');
  const [speed, setSpeed] = useState<Speed>('1x');

  const recordedHand = useRef<number>(-1);
  const strategyRef = useRef<NodeStrategy | null>(null);
  const rollRef = useRef<number>(50);

  const hero = game.players[0];
  const isHeroTurn = game.toAct === 0 && game.street !== 'complete' && game.street !== 'showdown';
  const handOver = game.street === 'complete';
  const legal = useMemo(() => legalActions(game), [game]);

  const applyProfiles = useCallback((next: string[]) => {
    setProfiles(next);
    setGame(createGame(NUM_PLAYERS, STARTING_BB, BIG_BLIND, next));
    setFeedback(null);
    setHud(null);
    setStrategy(null);
    setVillain(null);
  }, []);

  const deal = useCallback(() => {
    setGame((prev) => {
      const next = structuredClone(prev);
      if (scenario !== 'random') {
        next.buttonIndex = (POS_TO_BUTTON[scenario] - 1 + NUM_PLAYERS) % NUM_PLAYERS;
      }
      startHand(next);
      return next;
    });
    setFeedback(null);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
  }, [scenario]);

  // skip current hand immediately and deal a fresh scenario
  const skipHand = useCallback(() => {
    deal();
  }, [deal]);

  const heroAct = useCallback((action: Action) => {
    setGame((prev) => {
      if (prev.toAct !== 0) return prev;
      const la = legalActions(prev);
      const strat = strategyRef.current ?? getNodeStrategy(prev, 0, 900);
      const roll = rollRef.current;
      const fb = gradeNode(strat, action, la.callAmount, roll, { state: prev, heroIdx: 0 });
      setFeedback(fb);

      const pos = positionLabel(0, prev.buttonIndex, NUM_PLAYERS);
      setStats((s) => {
        const updated = recordDecision(s, {
          street: prev.street,
          position: pos,
          heroAction: idToClass(fb.chosen),
          recommended: idToClass(fb.best),
          verdict: fb.verdict === 'minor' ? 'ok' : fb.verdict,
          evLoss: fb.evLoss,
          rngMatch: fb.rngMatch,
        });
        saveStats(updated);
        return updated;
      });

      strategyRef.current = null;
      setStrategy(null);
      setHud(null);
      setRng(null);
      setVillain(null);

      const next = structuredClone(prev);
      applyAction(next, action);
      return next;
    });
  }, []);

  // ---- AI stepping ----
  useEffect(() => {
    if (game.street === 'complete' || game.street === 'showdown') return;
    if (game.toAct < 0 || game.toAct === 0) return;
    const timer = setTimeout(() => {
      setGame((prev) => {
        if (prev.toAct < 0 || prev.toAct === 0 || prev.street === 'complete') return prev;
        const next = structuredClone(prev);
        const action = decideAction(next);
        applyAction(next, action);
        return next;
      });
    }, SPEED_DELAY[speed]);
    return () => clearTimeout(timer);
  }, [game, speed]);

  // ---- HUD + strategy compute on hero's turn ----
  useEffect(() => {
    if (!isHeroTurn) return;
    setHudLoading(true);
    const id = setTimeout(() => {
      const { range, note } = buildVillainRange(game, 0);
      const strat = getNodeStrategy(game, 0, 1100);
      const eq =
        strat.equity != null
          ? { equity: strat.equity, win: strat.equity, tie: 0 }
          : equityVsRange(hero.holeCards, game.board, range, 1400);
      const outsInfo = countOuts(hero.holeCards, game.board);
      const pot = potTotal(game);
      const toCall = legal.callAmount;
      const po = potOdds(pot, toCall);
      const cardsToCome = game.street === 'flop' ? 2 : game.street === 'turn' ? 1 : 0;
      const roll = Math.floor(Math.random() * 100) + 1;

      strategyRef.current = strat;
      rollRef.current = roll;
      setStrategy(strat);
      setRng({ roll, prescribed: rngPrescription(strat, roll) });

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
        setVillain({
          name: vp.name,
          position: positionLabel(vIdx, game.buttonIndex, NUM_PLAYERS),
          profileId: vp.profileId,
          tag: getProfile(vp.profileId).tag,
          wasAggressor,
          rangeNote: note,
        });
      } else {
        setVillain(null);
      }
      setHud({
        equity: eq.equity,
        win: eq.win,
        tie: eq.tie,
        outs: outsInfo.outs,
        outCards: outsInfo.cards,
        toCall,
        pot,
        requiredEquity: po.requiredEquity,
        oddsRatio: po.oddsRatio,
        ruleEstimate: ruleOf2and4(outsInfo.outs, cardsToCome),
        rangeNote: note,
      });
      setHudLoading(false);
    }, 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.handNumber, game.street, game.toAct, game.board.length]);

  // ---- record hand result + history on completion ----
  useEffect(() => {
    if (game.street !== 'complete') return;
    if (recordedHand.current === game.handNumber) return;
    if (game.handNumber === 0) return;
    recordedHand.current = game.handNumber;

    const delta = handResults(game).find((r) => r.playerId === 0)?.deltaBB ?? 0;
    setStats((s) => {
      const updated = recordHand(s, delta);
      saveStats(updated);
      return updated;
    });

    const logTexts = game.log
      .filter((l) => l.handNumber === game.handNumber)
      .map((l) => ({
        text: `${l.playerName} (${l.position}) ${describeLog(l.type, l.amount)} — ${l.street}`,
      }));
    const showdown = game.players.map((p) => ({ name: p.name, cards: p.holeCards, folded: p.folded }));
    const hist: HistoryHand = {
      handNumber: game.handNumber,
      heroCards: hero.holeCards,
      board: game.board,
      log: logTexts,
      result: game.message,
      deltaBB: delta,
      showdown,
    };
    setHistory((h) => [hist, ...h].slice(0, 50));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.street, game.handNumber]);

  const leaks = useMemo(() => findLeaks(stats), [stats]);

  const doResetStats = useCallback(() => {
    setStats(resetStats());
    setHistory([]);
  }, []);

  return {
    game,
    hero,
    legal,
    isHeroTurn,
    handOver,
    feedback,
    hud,
    strategy,
    rng,
    villain,
    hudLoading,
    history,
    stats,
    leaks,
    profiles,
    scenario,
    speed,
    setSpeed,
    setScenario,
    deal,
    skipHand,
    heroAct,
    applyProfiles,
    doResetStats,
    pot: potTotal(game),
  };
}

function describeLog(type: string, amount: number): string {
  switch (type) {
    case 'fold':
      return 'folds';
    case 'check':
      return 'checks';
    case 'call':
      return `calls ${amount}`;
    case 'bet':
      return `bets to ${amount}`;
    case 'raise':
      return `raises to ${amount}`;
    case 'post':
      return `posts ${amount}`;
    default:
      return type;
  }
}
