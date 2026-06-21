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
import { countOuts, equityVsRange, equityVsField, ruleOf2and4 } from '../engine/equity';
import { potOdds } from '../engine/potOdds';
import { decideAction } from '../ai/decide';
import type { Difficulty, DifficultyParams, HeroReads } from '../ai/difficulty';
import { DIFFICULTIES, emptyReads } from '../ai/difficulty';
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
import { playAction, playDeal, playResult } from '../sound';
import type { JournalEntry } from '../store/journal';
import { addEntry, isTagged, loadJournal, removeEntry, saveJournal, setTakeaway } from '../store/journal';
import type { HistoryHand, DecisionSnapshot } from '../store/history';
import { loadHistory, saveHistory } from '../store/history';
import { loadGame, saveGame, loadSettings, saveSettings } from '../store/game';

export type { HistoryHand } from '../store/history';

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
  /** is the hero in position (acts after this villain) postflop? */
  heroInPosition: boolean;
}

const POS_TO_BUTTON: Record<Exclude<HeroPositionPref, 'random'>, number> = {
  BTN: 0,
  CO: 1,
  MP: 2,
  UTG: 3,
  BB: 4,
  SB: 5,
};

// persisted table settings, read once at module load and used only as the
// initial mount defaults below (so a refresh resumes the same table/settings).
const SAVED = loadSettings();

export function useGame(initialProfiles: string[]) {
  const initProfiles = SAVED?.profiles ?? initialProfiles;

  const [profiles, setProfiles] = useState<string[]>(initProfiles);
  const [game, setGame] = useState<GameState>(
    () => loadGame() ?? createGame(NUM_PLAYERS, SAVED?.stackDepth ?? STARTING_BB, BIG_BLIND, initProfiles),
  );
  const [feedback, setFeedback] = useState<NodeFeedback | null>(null);
  const [hud, setHud] = useState<HudInfo | null>(null);
  const [strategy, setStrategy] = useState<NodeStrategy | null>(null);
  const [rng, setRng] = useState<RngInfo | null>(null);
  const [villain, setVillain] = useState<VillainInfo | null>(null);
  const [history, setHistory] = useState<HistoryHand[]>(() => loadHistory());
  const [stats, setStats] = useState<SessionStats>(() => loadStats());
  const [journal, setJournal] = useState<JournalEntry[]>(() => loadJournal());
  const [scenario, setScenario] = useState<HeroPositionPref>((SAVED?.scenario as HeroPositionPref) ?? 'random');
  const [speed, setSpeed] = useState<Speed>((SAVED?.speed as Speed) ?? '1x');
  const [stackDepth, setStackDepth] = useState<number>(SAVED?.stackDepth ?? STARTING_BB);
  const [watchAfterFold, setWatchAfterFold] = useState<boolean>(SAVED?.watchAfterFold ?? false);
  const [difficulty, setDifficulty] = useState<Difficulty>((SAVED?.difficulty as Difficulty) ?? 'normal');

  // running read on how the hero plays, fed to hard/extreme bots so they adapt.
  const heroReadsRef = useRef<HeroReads>(emptyReads());

  const recordedHand = useRef<number>(-1);
  const strategyRef = useRef<NodeStrategy | null>(null);
  const rollRef = useRef<number>(50);
  const lastDealtRef = useRef<GameState | null>(null);
  // buffer of the real solved nodes the hero faced this hand; flushed onto the
  // HistoryHand at completion so Hand Review shows the actual decisions.
  const decisionsRef = useRef<DecisionSnapshot[]>([]);

  const hero = game.players[0];
  const isHeroTurn = game.toAct === 0 && game.street !== 'complete' && game.street !== 'showdown';
  const handOver = game.street === 'complete';
  const legal = useMemo(() => legalActions(game), [game]);
  // derived loading flag (no setState-in-effect needed): we're "loading" while
  // it's the hero's turn but the HUD/strategy hasn't been computed yet.
  const hudLoading = isHeroTurn && !hud;

  const applyProfiles = useCallback((next: string[]) => {
    setProfiles(next);
    setGame(createGame(NUM_PLAYERS, stackDepth, BIG_BLIND, next));
    setFeedback(null);
    setHud(null);
    setStrategy(null);
    setVillain(null);
    lastDealtRef.current = null;
  }, [stackDepth]);

  // change starting stack depth (bb); rebuilds the table with fresh stacks
  const applyStackDepth = useCallback((bb: number) => {
    setStackDepth(bb);
    setGame(createGame(NUM_PLAYERS, bb, BIG_BLIND, profiles));
    setFeedback(null);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    lastDealtRef.current = null;
  }, [profiles]);

  const deal = useCallback(() => {
    setGame((prev) => {
      const next = structuredClone(prev);
      if (scenario !== 'random') {
        next.buttonIndex = (POS_TO_BUTTON[scenario] - 1 + NUM_PLAYERS) % NUM_PLAYERS;
      }
      startHand(next);
      // snapshot the freshly-dealt hand (same hole cards + deck) so "Repeat
      // hand" can replay the exact same spot.
      lastDealtRef.current = structuredClone(next);
      return next;
    });
    setFeedback(null);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    decisionsRef.current = [];
    playDeal();
  }, [scenario]);

  // skip current hand immediately and deal a fresh scenario
  const skipHand = useCallback(() => {
    deal();
  }, [deal]);

  // replay the exact same hand (identical hole cards + board run-out)
  const repeatHand = useCallback(() => {
    const snap = lastDealtRef.current;
    if (!snap) return;
    setGame(structuredClone(snap));
    setFeedback(null);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    decisionsRef.current = [];
    playDeal();
  }, []);

  // full reset: fresh 100bb stacks, hand 0 (stats kept — reset those separately)
  const resetGame = useCallback(() => {
    setGame(createGame(NUM_PLAYERS, stackDepth, BIG_BLIND, profiles));
    setFeedback(null);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    lastDealtRef.current = null;
  }, [profiles, stackDepth]);

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
          verdict: fb.verdict === 'best' || fb.verdict === 'correct' ? 'correct' : fb.verdict === 'inaccuracy' ? 'ok' : 'mistake',
          evLoss: fb.evLoss,
          chosenEv: fb.chosenEv,
          rngMatch: fb.rngMatch,
        });
        saveStats(updated);
        return updated;
      });

      // capture the real solved node for Hand Review (strat already reflects the
      // true villain range / pot / facing-bet at this decision).
      const vIdx = primaryVillainIdx(prev, 0);
      const vp = vIdx >= 0 && !prev.players[vIdx].isHero ? prev.players[vIdx] : null;
      decisionsRef.current.push({
        street: prev.street,
        boardLen: prev.board.length,
        pot: potTotal(prev),
        toCall: la.callAmount,
        position: pos,
        villainName: vp ? vp.name : 'the field',
        villainTag: vp ? getProfile(vp.profileId).tag : '',
        chosenId: fb.chosen,
        chosenLabel: fb.chosenLabel,
        bestId: fb.best,
        bestLabel: fb.bestLabel,
        evLoss: fb.evLoss,
        equity: strat.equity,
        rngMatch: fb.rngMatch,
        note: strat.note,
        rangeNote: strat.rangeNote,
        options: strat.options.map((o) => ({
          id: o.id, label: o.label, freq: o.freq, ev: o.ev, kind: o.kind, amount: o.amount, sizePct: o.sizePct,
        })),
        villainRange: strat.villainRange ? Array.from(strat.villainRange.entries()) : [],
      });

      // update the running read on how the hero plays (for adaptive bots)
      const rd = heroReadsRef.current;
      rd.decisions++;
      if (prev.street === 'preflop') {
        rd.preflopActions++;
        if (action.type === 'call' || action.type === 'raise' || action.type === 'bet') rd.vpipActions++;
      }
      if (action.type === 'bet' || action.type === 'raise') rd.aggrActions++;
      else if (action.type === 'call') rd.passiveActions++;
      if (la.callAmount > 0) {
        rd.betsFaced++;
        if (action.type === 'fold') rd.foldToBet++;
      }

      strategyRef.current = null;
      setStrategy(null);
      setHud(null);
      setRng(null);
      setVillain(null);

      const next = structuredClone(prev);
      applyAction(next, action);
      // If the hero folded and "watch after fold" is off, fast-forward the bots
      // to the end immediately. When watch is on, leave it — the AI-stepping
      // effect plays the runout out at the normal speed so the user can see it.
      if (next.players[0].folded && !watchAfterFold) {
        runoutToEnd(next, DIFFICULTIES[difficulty]);
      }
      return next;
    });
  }, [watchAfterFold, difficulty]);

  // instantly finish the current hand (bots play to the end) — used by the
  // "skip to end" button while watching a folded hand run out.
  const finishHand = useCallback(() => {
    setGame((prev) => {
      if (prev.street === 'complete' || prev.toAct === 0) return prev;
      const next = structuredClone(prev);
      runoutToEnd(next, DIFFICULTIES[difficulty]);
      return next;
    });
  }, [difficulty]);

  // ---- AI stepping ----
  useEffect(() => {
    if (game.street === 'complete' || game.street === 'showdown') return;
    if (game.toAct < 0 || game.toAct === 0) return;
    const timer = setTimeout(() => {
      setGame((prev) => {
        if (prev.toAct < 0 || prev.toAct === 0 || prev.street === 'complete') return prev;
        const next = structuredClone(prev);
        const action = decideAction(next, { diff: DIFFICULTIES[difficulty], reads: heroReadsRef.current });
        applyAction(next, action);
        return next;
      });
    }, SPEED_DELAY[speed]);
    return () => clearTimeout(timer);
  }, [game, speed, difficulty]);

  // if we restored a finished hand, mark it recorded so the result effect below
  // doesn't double-count it into stats/history after a refresh. Runs once on mount.
  useEffect(() => {
    if (game.street === 'complete' && game.handNumber > 0) recordedHand.current = game.handNumber;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- persist game + settings so a refresh resumes the table ----
  useEffect(() => {
    saveGame(game);
  }, [game]);
  useEffect(() => {
    saveSettings({ profiles, stackDepth, scenario, speed, watchAfterFold, difficulty });
  }, [profiles, stackDepth, scenario, speed, watchAfterFold, difficulty]);

  // ---- HUD + strategy compute on hero's turn ----
  useEffect(() => {
    if (!isHeroTurn) return;
    const id = setTimeout(() => {
      const { range, note } = buildVillainRange(game, 0);
      const strat = getNodeStrategy(game, 0, 1100);
      // count opponents still live — in a multiway pot you must beat ALL of them,
      // so equity is materially lower than the heads-up (single-villain) number.
      const liveOpps = game.players.filter((p) => !p.isHero && !p.folded).length;
      // Always run a real Monte-Carlo so the HUD's win/tie/equity have a concrete,
      // explainable source (the raw won/tied/lost tally) — not a solver number with
      // a faked tie=0. Multiway sims against the whole live field.
      const sim =
        liveOpps > 1
          ? equityVsField(hero.holeCards, game.board, Array.from({ length: liveOpps }, () => range), 1400)
          : equityVsRange(hero.holeCards, game.board, range, 1400);
      const trials = sim.trials;
      const win = trials > 0 ? sim.wins / trials : 0;
      const tie = trials > 0 ? sim.ties / trials : 0;
      // decomposition shown in the HUD tooltip matches this exactly
      const eq = { equity: win + tie / 2, win, tie };
      const multiwayNote = liveOpps > 1 ? ` · vs ${liveOpps} opponents (multiway)` : '';
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
        // postflop action runs from left-of-button (first/most OOP) to the
        // button (last/most IP); hero is IP if they act after this villain.
        const orderRank = (seat: number) => (seat - (game.buttonIndex + 1) + NUM_PLAYERS) % NUM_PLAYERS;
        const heroInPosition = orderRank(0) > orderRank(vIdx);
        setVillain({
          name: vp.name,
          position: positionLabel(vIdx, game.buttonIndex, NUM_PLAYERS),
          profileId: vp.profileId,
          tag: getProfile(vp.profileId).tag,
          wasAggressor,
          rangeNote: note,
          heroInPosition,
        });
      } else {
        setVillain(null);
      }
      setHud({
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
        rangeNote: note + multiwayNote,
      });
    }, 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.handNumber, game.street, game.toAct, game.board.length]);

  // ---- record hand result + history on completion ----
  // This effect reacts to a one-shot terminal transition (street → 'complete')
  // and persists the result to localStorage + analytics state. It is guarded by
  // `recordedHand` so it runs exactly once per hand and can't cascade. The
  // set-state-in-effect lint rule targets derived-state loops, which this is
  // not — so it's disabled for these two legitimate, guarded writes.
  /* eslint-disable react-hooks/set-state-in-effect */
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
      id: crypto.randomUUID(),
      handNumber: game.handNumber,
      heroCards: hero.holeCards,
      board: game.board,
      log: logTexts,
      result: game.message,
      deltaBB: delta,
      showdown,
      decisions: decisionsRef.current.slice(),
    };
    setHistory((h) => {
      const next = [hist, ...h].slice(0, 50);
      saveHistory(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.street, game.handNumber]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // play the outcome cue once per graded decision (effect, not the state
  // updater — keeps it from double-firing under StrictMode in dev).
  useEffect(() => {
    if (!feedback) return;
    playAction();
    playResult(feedback.verdict, feedback.evLoss);
  }, [feedback]);

  const leaks = useMemo(() => findLeaks(stats), [stats]);

  const doResetStats = useCallback(() => {
    setStats(resetStats());
    setHistory([]);
    saveHistory([]);
    heroReadsRef.current = emptyReads(); // forget the hero read on a fresh start
  }, []);

  // delete specific hands from the reviewable history (multi-select in Hand Review)
  const removeHistoryHands = useCallback((ids: string[]) => {
    const set = new Set(ids);
    setHistory((h) => {
      const next = h.filter((x) => !set.has(x.id));
      saveHistory(next);
      return next;
    });
  }, []);

  // clear the reviewable hand history but KEEP tagged hands (and stats). Tagged
  // hands stay in the list so they're still reviewable; everything else is dropped.
  const clearHistory = useCallback(() => {
    setHistory((h) => {
      const next = h.filter((x) => isTagged(journal, x.id));
      saveHistory(next);
      return next;
    });
  }, [journal]);

  // ---- review journal (durable "tag for review" + written takeaways) ----
  // Toggle a finished hand into/out of the journal. Snapshots the cards/board/
  // result so the note survives reload even after the in-memory history rolls off.
  const toggleTag = useCallback((hand: HistoryHand) => {
    setJournal((j) => {
      const next = isTagged(j, hand.id)
        ? removeEntry(j, hand.id)
        : addEntry(j, {
            id: hand.id,
            handNumber: hand.handNumber,
            heroCards: hand.heroCards,
            board: hand.board,
            result: hand.result,
            deltaBB: hand.deltaBB,
          });
      saveJournal(next);
      return next;
    });
  }, []);

  const setHandTakeaway = useCallback((id: string, text: string) => {
    setJournal((j) => {
      const next = setTakeaway(j, id, text);
      saveJournal(next);
      return next;
    });
  }, []);

  // Write a takeaway, auto-tagging the hand first if it isn't already — done in a
  // single journal update so there's no add-then-set race.
  const upsertTakeaway = useCallback((hand: HistoryHand, text: string) => {
    setJournal((j) => {
      const withEntry = isTagged(j, hand.id)
        ? j
        : addEntry(j, {
            id: hand.id,
            handNumber: hand.handNumber,
            heroCards: hand.heroCards,
            board: hand.board,
            result: hand.result,
            deltaBB: hand.deltaBB,
          });
      const next = setTakeaway(withEntry, hand.id, text);
      saveJournal(next);
      return next;
    });
  }, []);

  const removeJournalEntry = useCallback((id: string) => {
    setJournal((j) => {
      const next = removeEntry(j, id);
      saveJournal(next);
      return next;
    });
  }, []);

  const removeJournalEntries = useCallback((ids: string[]) => {
    const set = new Set(ids);
    setJournal((j) => {
      const next = j.filter((e) => !set.has(e.id));
      saveJournal(next);
      return next;
    });
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
    journal,
    toggleTag,
    setHandTakeaway,
    upsertTakeaway,
    removeJournalEntry,
    removeJournalEntries,
    leaks,
    clearHistory,
    removeHistoryHands,
    profiles,
    scenario,
    speed,
    stackDepth,
    applyStackDepth,
    watchAfterFold,
    setWatchAfterFold,
    difficulty,
    setDifficulty,
    finishHand,
    setSpeed,
    setScenario,
    deal,
    skipHand,
    repeatHand,
    resetGame,
    heroAct,
    applyProfiles,
    doResetStats,
    pot: potTotal(game),
  };
}

// Run the bots to the end of the hand in place (hero is out / not to act).
function runoutToEnd(state: GameState, diff?: DifficultyParams): void {
  let guard = 0;
  while (
    state.street !== 'complete' &&
    state.street !== 'showdown' &&
    state.toAct >= 0 &&
    state.toAct !== 0 &&
    guard++ < 400
  ) {
    applyAction(state, decideAction(state, { diff }));
  }
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
