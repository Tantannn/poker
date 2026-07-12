// Central game hook: owns the GameState, steps the AI opponents on a timer,
// grades hero decisions with the heuristic strategy engine (EV loss + RNG),
// and feeds analytics + hand history.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, GameState } from '../engine/table';
import {
  applyAction,
  biasHoleCards,
  createGame,
  handResults,
  legalActions,
  liveSeatCount,
  positionLabel,
  potTotal,
  startHand,
  tablePositions,
} from '../engine/table';
import type { TableSize } from '../strategy/preflopChart';
import { scenariosForSize } from '../strategy/preflopChart';
import { pickBorderlineCode } from '../strategy/borderline';
import { decideAction, inPositionPostflop } from '../ai/decide';
import type { Difficulty, DifficultyParams, HeroReads } from '../ai/difficulty';
import { DIFFICULTIES, emptyReads } from '../ai/difficulty';
import type { NodeStrategy } from '../strategy';
import { getNodeStrategy, primaryVillainIdx } from '../strategy';
import { getProfile } from '../ai/profiles';
import { computeHudNode } from '../strategy/hudCompute';
import type { HudInfo, VillainInfo, HudNodeResult } from '../strategy/hudCompute';
import type { ActionId } from '../strategy/types';
import { rngPrescription } from '../strategy/types';
import type { NodeFeedback } from '../analysis/grade';
import { gradeNode, idToClass } from '../analysis/grade';
import { aggressionWarning } from '../analysis/aggression';
import { assessTilt } from '../analysis/tilt';
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
import { loadHistory, saveHistory, capHistory } from '../store/history';
import type { GameMode } from '../store/game';
import { loadGame, saveGame, loadSettings, saveSettings, loadDealt, saveDealt } from '../store/game';
import type { ObsCounters } from '../analysis/observed';
import { accumulateHand } from '../analysis/observed';

export type { HistoryHand } from '../store/history';

export const BIG_BLIND = 2;
export const SMALL_BLIND = 1;
export const NUM_PLAYERS = 6;
export const STARTING_BB = 100;

export type Speed = '1x' | '2x' | 'instant';
// When the graded answer appears. 'immediate' = drill mode (answer the moment
// you act). 'deferred' = exam mode (answers withheld until the hand ends, then
// shown as a per-decision review) so early-street feedback can't leak into the
// reads you make on later streets.
export type FeedbackMode = 'immediate' | 'deferred';
const SPEED_DELAY: Record<Speed, number> = { '1x': 750, '2x': 330, instant: 0 };

export type HeroPositionPref = 'random' | 'BTN' | 'CO' | 'MP' | 'UTG' | 'SB' | 'BB';

// ---- HUD compute worker (module-level singleton, shared by every table) ----
// undefined = not tried yet · null = Workers unavailable (fall back to sync).
let hudWorker: Worker | null | undefined;
function getHudWorker(): Worker | null {
  if (hudWorker !== undefined) return hudWorker;
  try {
    hudWorker = new Worker(new URL('../workers/hudWorker.ts', import.meta.url), { type: 'module' });
    hudWorker.onerror = () => {
      // a worker that can't load would swallow every request — disable it and
      // let the next compute take the synchronous fallback path.
      hudWorker?.terminate();
      hudWorker = null;
    };
  } catch {
    hudWorker = null;
  }
  return hudWorker;
}

// HUD/villain read types + the pure computation now live in strategy/hudCompute
// (so a Web Worker can run them off-thread); re-exported for existing importers.
export type { HudInfo, VillainInfo };

export interface RngInfo {
  roll: number;
  prescribed: ActionId;
}

// persisted table settings, read once at module load and used only as the
// initial mount defaults below (so a refresh resumes the same table/settings).
const SAVED = loadSettings();
// which session was last on screen — back-compat with the pre-split `tournament` flag.
const INITIAL_MODE: GameMode = SAVED?.activeMode ?? (SAVED?.tournament ? 'tourney' : 'cash');
// per-mode Hand Review session ids, computed once at load (the old single id maps
// to cash). Module-level so the state/ref initializers don't read a ref in render.
const INITIAL_SESSION_IDS: Record<GameMode, string> = {
  cash: SAVED?.cashSessionId ?? SAVED?.sessionId ?? crypto.randomUUID(),
  tourney: SAVED?.tourneySessionId ?? crypto.randomUUID(),
};
// persisted "repeat hand" snapshot for that mode, so Repeat Hand survives a refresh.
const SAVED_DEALT = loadDealt(INITIAL_MODE);

export function useGame(initialProfiles: string[]) {
  const initProfiles = SAVED?.profiles ?? initialProfiles;

  const [profiles, setProfiles] = useState<string[]>(initProfiles);
  // Cash and tournament are separate persisted sessions; `mode` says which one is
  // live right now (swapped by the active tab via setActiveMode). `tournament` is
  // just the derived flag the engine/UI already keyed off.
  const [mode, setMode] = useState<GameMode>(INITIAL_MODE);
  const tournament = mode === 'tourney';
  // Hand Review groups by session id. Each MODE keeps its OWN id so a freezeout
  // reads as one arc even if you tab over to cash mid-tournament and back (rather
  // than the two modes merging into one mislabeled group). A fresh id is minted
  // per mode on a table rebuild (reset / size / stack). Both persisted.
  const sessionIdsRef = useRef<Record<GameMode, string>>({ ...INITIAL_SESSION_IDS });
  const [sessionId, setSessionId] = useState<string>(INITIAL_SESSION_IDS[INITIAL_MODE]);
  // mint a fresh session id for the CURRENT mode (a genuine new run on this table)
  const newSession = (m: GameMode) => {
    const id = crypto.randomUUID();
    sessionIdsRef.current[m] = id;
    setSessionId(id);
  };
  const [game, setGame] = useState<GameState>(
    () => loadGame(INITIAL_MODE) ?? createGame(SAVED?.tableSize ?? NUM_PLAYERS, SAVED?.stackDepth ?? STARTING_BB, BIG_BLIND, initProfiles, INITIAL_MODE === 'tourney'),
  );
  const [feedback, setFeedback] = useState<NodeFeedback | null>(null);
  // deferred (exam) mode: the per-decision graded answers, revealed as one
  // end-of-hand review only after the hand completes. Empty in immediate mode.
  const [feedbackLog, setFeedbackLog] = useState<NodeFeedback[]>([]);
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
  const [tableSize, setTableSize] = useState<number>(SAVED?.tableSize ?? NUM_PLAYERS);
  const [watchAfterFold, setWatchAfterFold] = useState<boolean>(SAVED?.watchAfterFold ?? false);
  const [tiltWarnings, setTiltWarnings] = useState<boolean>(SAVED?.tiltWarnings ?? true);
  // when the graded answer surfaces — 'immediate' (drill) or 'deferred' (exam).
  const [feedbackMode, setFeedbackMode] = useState<FeedbackMode>((SAVED?.feedbackMode as FeedbackMode) ?? 'immediate');
  const [difficulty, setDifficulty] = useState<Difficulty>((SAVED?.difficulty as Difficulty) ?? 'normal');
  // per-seat difficulty overrides aligned with `profiles` (index 0 = seat 1);
  // '' = follow the table-wide difficulty. Lets the table mix a fish, regs and a
  // shark like a real game — the hero must adjust per villain, not per table.
  const [seatDiffs, setSeatDiffs] = useState<string[]>(SAVED?.seatDiffs ?? []);
  // anonymous villains: hide bot archetypes/exploit plans — the hero must build
  // reads from observed behavior (VPIP/PFR/AF) and GUESS each villain's type.
  const [anonymousVillains, setAnonymousVillains] = useState<boolean>(SAVED?.anonymousVillains ?? false);
  // focus borderline hands: bias the hero's dealt hole cards toward mixed /
  // range-edge preflop hands so reps land on close decisions, not obvious spots.
  const [edgeFocus, setEdgeFocus] = useState<boolean>(SAVED?.edgeFocus ?? false);
  // cash only: when any seat busts to 0, the next deal resets to fresh equal
  // stacks instead of the standard cash rebuy — keeps a drill table even.
  const [autoResetOnBust, setAutoResetOnBust] = useState<boolean>(SAVED?.autoResetOnBust ?? false);
  // seat → guessed profileId. A guess reveals the truth for that seat (the
  // pedagogic payoff). Cleared when the lineup changes; not persisted (a fresh
  // session is a fresh read exercise).
  const [villainGuesses, setVillainGuesses] = useState<Record<number, string>>({});
  const guessVillain = useCallback((seat: number, profileId: string) => {
    setVillainGuesses((m) => ({ ...m, [seat]: profileId }));
  }, []);
  // per-seat observed stats (VPIP/PFR/AF), accumulated hand-by-hand because the
  // engine's action log only keeps the last ~10 hands. Session-scoped like guesses.
  const [obsCounters, setObsCounters] = useState<Record<number, ObsCounters>>({});

  // resolve which difficulty drives a given seat's bot
  const diffFor = useCallback(
    (seat: number): DifficultyParams =>
      DIFFICULTIES[(seatDiffs[seat - 1] as Difficulty) || difficulty] ?? DIFFICULTIES[difficulty],
    [seatDiffs, difficulty],
  );

  // running read on how the hero plays, fed to hard/extreme bots so they adapt.
  const heroReadsRef = useRef<HeroReads>(emptyReads());

  const recordedHand = useRef<number>(-1);
  const strategyRef = useRef<NodeStrategy | null>(null);
  const rollRef = useRef<number>(50);
  // monotone request id for the HUD worker — replies for an older node are dropped.
  const hudSeqRef = useRef(0);
  const lastDealtRef = useRef<GameState | null>(SAVED_DEALT);
  // buffer of the real solved nodes the hero faced this hand; flushed onto the
  // HistoryHand at completion so Hand Review shows the actual decisions.
  const decisionsRef = useRef<DecisionSnapshot[]>([]);
  // deferred-mode buffer: each decision's graded feedback, held during the hand
  // and surfaced (via the derived `feedbackLog` below) only once it's complete.
  const pendingFbRef = useRef<NodeFeedback[]>([]);

  const hero = game.players[0];
  const isHeroTurn = game.toAct === 0 && game.street !== 'complete' && game.street !== 'showdown';
  const handOver = game.street === 'complete';
  const legal = useMemo(() => legalActions(game), [game]);
  // derived loading flag (no setState-in-effect needed): we're "loading" while
  // it's the hero's turn but the HUD/strategy hasn't been computed yet.
  const hudLoading = isHeroTurn && !hud;

  const applyProfiles = useCallback((next: string[]) => {
    setProfiles(next);
    setVillainGuesses({}); // new lineup — old archetype guesses no longer apply
    setObsCounters({}); // …and old observed stats describe the old lineup
    setGame(createGame(tableSize, stackDepth, BIG_BLIND, next, mode === 'tourney'));
    newSession(mode);
    recordedHand.current = -1; // new session: don't let a reused handNumber skip its first hand
    setFeedback(null);
    pendingFbRef.current = [];
    setFeedbackLog([]);
    setHud(null);
    setStrategy(null);
    setVillain(null);
    lastDealtRef.current = null;
    saveDealt(null, mode);
  }, [stackDepth, tableSize, mode]);

  // change the number of seats (2–6); rebuilds the table. Bots auto-fill from the
  // profile list (createGame pads with 'tag'), so no profile resize is needed.
  const applyTableSize = useCallback((size: number) => {
    setTableSize(size);
    setVillainGuesses({}); // seats moved — old archetype guesses no longer apply
    setObsCounters({});
    setGame(createGame(size, stackDepth, BIG_BLIND, profiles, mode === 'tourney'));
    newSession(mode);
    recordedHand.current = -1; // new session: don't let a reused handNumber skip its first hand
    setFeedback(null);
    pendingFbRef.current = [];
    setFeedbackLog([]);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    lastDealtRef.current = null;
    saveDealt(null, mode);
  }, [stackDepth, profiles, mode]);

  // change starting stack depth (bb); rebuilds the table with fresh stacks
  const applyStackDepth = useCallback((bb: number) => {
    setStackDepth(bb);
    setGame(createGame(tableSize, bb, BIG_BLIND, profiles, mode === 'tourney'));
    newSession(mode);
    recordedHand.current = -1; // new session: don't let a reused handNumber skip its first hand
    setFeedback(null);
    pendingFbRef.current = [];
    setFeedbackLog([]);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    lastDealtRef.current = null;
    saveDealt(null, mode);
  }, [profiles, tableSize, mode]);

  // Swap the live table between the cash and tournament sessions WITHOUT
  // destroying either: stash the current slot, restore the target's saved game
  // (or start a fresh one if it has none yet). Driven by the active tab, so cash
  // and tournament each persist independently and resume where they left off.
  const setActiveMode = useCallback((next: GameMode) => {
    if (next === mode) return;
    // stash the current slot before leaving it
    saveGame(game, mode);
    saveDealt(lastDealtRef.current, mode);
    // restore the target slot, or create a fresh table for it (tournament starts
    // everyone even; pure-play watch-after-fold so busted/folded hands run out).
    const restored = loadGame(next) ?? createGame(tableSize, stackDepth, BIG_BLIND, profiles, next === 'tourney');
    setMode(next);
    setGame(restored);
    lastDealtRef.current = loadDealt(next);
    // swap to the target mode's Hand Review session so its hands group on their
    // own arc, not the mode we just left.
    sessionIdsRef.current[mode] = sessionId;
    setSessionId(sessionIdsRef.current[next]);
    // don't re-record a hand that was already complete when we left this slot
    recordedHand.current = restored.street === 'complete' ? restored.handNumber : -1;
    if (next === 'tourney') setWatchAfterFold(true);
    setFeedback(null);
    pendingFbRef.current = [];
    setFeedbackLog([]);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
  }, [mode, sessionId, game, profiles, stackDepth, tableSize]);

  const deal = useCallback(() => {
    // tournament freezeout: stop dealing once the hero is eliminated or only one
    // player has chips left (champion decided). Cash mode never blocks.
    if (game.tournament && (liveSeatCount(game) <= 1 || game.players[0].stack <= 0)) return;
    // cash "reset on bust": if the last hand left any seat at 0, start the next
    // hand on fresh equal stacks instead of the standard rebuy. Reset the session
    // bookkeeping up-front (side effects belong outside the setGame updater).
    const bustReset =
      autoResetOnBust && !game.tournament && game.handNumber > 0 && game.players.some((p) => p.stack <= 0);
    if (bustReset) {
      newSession(mode);
      recordedHand.current = -1; // new session: don't let a reused handNumber skip its first hand
    }
    setGame((prev) => {
      const base = bustReset
        ? createGame(tableSize, stackDepth, BIG_BLIND, profiles, mode === 'tourney')
        : prev;
      const next = structuredClone(base);
      if (scenario !== 'random') {
        // place the button so the hero (seat 0) lands on the requested seat — only
        // if that position exists at this table size, else just deal random.
        const n = next.players.length;
        const off = tablePositions(n).indexOf(scenario);
        if (off >= 0) {
          const desiredButton = (n - off) % n;
          next.buttonIndex = (desiredButton - 1 + n) % n;
        }
      }
      startHand(next);
      // focus borderline hands: after the deal, swap the hero's hole cards for a
      // borderline-weighted hand class read off the RFI chart for the seat the
      // hero landed on. Weights the PREFLOP spot only (BB / heads-up BB have no
      // open chart, so those hands stay as dealt).
      if (edgeFocus && next.players[0].holeCards.length === 2) {
        const pos = positionLabel(0, next.buttonIndex, next.players.length);
        const sc = scenariosForSize(next.players.length as TableSize).find(
          (s) => s.facing === 'rfi' && s.heroPos === pos,
        );
        if (sc) biasHoleCards(next, 0, pickBorderlineCode(sc));
      }
      // snapshot the freshly-dealt hand (same hole cards + deck) so "Repeat
      // hand" can replay the exact same spot — persisted so it survives a refresh.
      lastDealtRef.current = structuredClone(next);
      saveDealt(lastDealtRef.current, mode);
      return next;
    });
    setFeedback(null);
    pendingFbRef.current = [];
    setFeedbackLog([]);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    decisionsRef.current = [];
    playDeal();
  }, [scenario, game, mode, edgeFocus, autoResetOnBust, tableSize, stackDepth, profiles]);

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
    pendingFbRef.current = [];
    setFeedbackLog([]);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    decisionsRef.current = [];
    playDeal();
  }, []);

  // full reset: fresh equal stacks, hand 0 (stats kept — reset those separately).
  // In tournament mode this is "start a new freezeout".
  const resetGame = useCallback(() => {
    setGame(createGame(tableSize, stackDepth, BIG_BLIND, profiles, mode === 'tourney'));
    newSession(mode);
    recordedHand.current = -1; // new session: don't let a reused handNumber skip its first hand
    setFeedback(null);
    pendingFbRef.current = [];
    setFeedbackLog([]);
    setHud(null);
    setStrategy(null);
    setRng(null);
    setVillain(null);
    strategyRef.current = null;
    lastDealtRef.current = null;
    saveDealt(null, mode);
  }, [profiles, stackDepth, tableSize, mode]);

  const heroAct = useCallback((action: Action) => {
    // Grade the decision + all the bookkeeping OUTSIDE the setGame updater. The
    // updater must be pure (StrictMode double-invokes it in dev), so anything that
    // mutates a ref or appends to a buffer has to run here, exactly once. `game`
    // at call time is the pre-action state (heroAct only fires on the hero's turn
    // with no update pending), so it's the right node to grade against.
    const prev = game;
    if (prev.toAct !== 0) return;
    const la = legalActions(prev);
    const strat = strategyRef.current ?? getNodeStrategy(prev, 0, 900);
    const roll = rollRef.current;
    const fb = gradeNode(strat, action, la.callAmount, roll, { state: prev, heroIdx: 0 });
    // immediate (drill): reveal the answer now. deferred (exam): withhold it —
    // buffer for the end-of-hand review and keep the live box empty so the grade
    // can't leak into the reads you make on later streets (+ a neutral click, no
    // verdict tone — that would leak the answer the mode is meant to withhold).
    if (feedbackMode === 'immediate') setFeedback(fb);
    else { pendingFbRef.current.push(fb); playAction(); }

    const pos = positionLabel(0, prev.buttonIndex, prev.players.length);
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
        id: o.id, label: o.label, freq: o.freq, ev: o.ev, kind: o.kind, amount: o.amount, sizePct: o.sizePct, calledEq: o.calledEq,
      })),
      opponents: prev.players.filter((p, i) => i !== 0 && !p.folded).length,
      villainRange: strat.villainRange ? Array.from(strat.villainRange.entries()) : [],
    });

    // update the running read on how the hero plays (for adaptive bots)
    const rd = heroReadsRef.current;
    rd.decisions++;
    if (prev.street === 'preflop') {
      rd.preflopActions++;
      if (action.type === 'call' || action.type === 'raise' || action.type === 'bet') rd.vpipActions++;
    }
    const isFold = action.type === 'fold';
    if (action.type === 'bet' || action.type === 'raise') rd.aggrActions++;
    else if (action.type === 'call') rd.passiveActions++;
    const postflop = prev.street !== 'preflop';
    if (la.callAmount > 0) {
      rd.betsFaced++;
      if (isFold) rd.foldToBet++;
      if (postflop) {
        // bet size as a fraction of the pot BEFORE the bet (subtract the call, which
        // is already in potTotal) → split the hero's fold tendency by big vs small.
        const potBeforeBet = Math.max(1, potTotal(prev) - la.callAmount);
        const betFrac = la.callAmount / potBeforeBet;
        if (betFrac >= 0.66) { rd.bigBetsFaced++; if (isFold) rd.foldToBig++; }
        else { rd.smallBetsFaced++; if (isFold) rd.foldToSmall++; }
        if (prev.street === 'flop') { rd.flopBetsFaced++; if (isFold) rd.foldToFlopBet++; }
        if (prev.street === 'river') { rd.riverBetsFaced++; if (action.type === 'call') rd.riverCalls++; }
      }
    }
    // positional passivity: checked or folded while OUT of position postflop
    if (postflop && !inPositionPostflop(prev, 0)) {
      rd.oopActions++;
      if (action.type === 'check' || isFold) rd.oopPassive++;
    }

    strategyRef.current = null;
    setStrategy(null);
    setHud(null);
    setRng(null);
    setVillain(null);

    // Pure state transition — apply the action (and fast-forward the runout when
    // the hero folds and "watch after fold" is off). The toAct guard defends
    // against a stale double-fire; the graded side effects above already ran once.
    setGame((cur) => {
      if (cur.toAct !== 0) return cur;
      const next = structuredClone(cur);
      applyAction(next, action);
      if (next.players[0].folded && !watchAfterFold) {
        runoutToEnd(next, diffFor);
      }
      return next;
    });
  }, [game, watchAfterFold, diffFor, feedbackMode]);

  // instantly finish the current hand (bots play to the end) — used by the
  // "skip to end" button while watching a folded hand run out.
  const finishHand = useCallback(() => {
    setGame((prev) => {
      if (prev.street === 'complete' || prev.toAct === 0) return prev;
      const next = structuredClone(prev);
      runoutToEnd(next, diffFor);
      return next;
    });
  }, [diffFor]);

  // ---- AI stepping ----
  useEffect(() => {
    if (game.street === 'complete' || game.street === 'showdown') return;
    if (game.toAct < 0 || game.toAct === 0) return;
    const timer = setTimeout(() => {
      setGame((prev) => {
        if (prev.toAct < 0 || prev.toAct === 0 || prev.street === 'complete') return prev;
        const next = structuredClone(prev);
        const action = decideAction(next, { diff: diffFor(next.toAct), reads: heroReadsRef.current });
        applyAction(next, action);
        return next;
      });
    }, SPEED_DELAY[speed]);
    return () => clearTimeout(timer);
  }, [game, speed, diffFor]);

  // if we restored a finished hand, mark it recorded so the result effect below
  // doesn't double-count it into stats/history after a refresh. Runs once on mount.
  useEffect(() => {
    if (game.street === 'complete' && game.handNumber > 0) recordedHand.current = game.handNumber;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- persist game + settings so a refresh resumes the table ----
  useEffect(() => {
    saveGame(game, mode);
  }, [game, mode]);
  useEffect(() => {
    saveSettings({
      profiles, stackDepth, scenario, speed, watchAfterFold, tiltWarnings, difficulty, seatDiffs, tableSize,
      anonymousVillains, edgeFocus, autoResetOnBust, feedbackMode,
      tournament, activeMode: mode, sessionId,
      cashSessionId: sessionIdsRef.current.cash,
      tourneySessionId: sessionIdsRef.current.tourney,
    });
  }, [profiles, stackDepth, scenario, speed, watchAfterFold, tiltWarnings, difficulty, seatDiffs, tableSize, anonymousVillains, edgeFocus, autoResetOnBust, feedbackMode, tournament, mode, sessionId]);

  // ---- HUD + strategy compute on hero's turn ----
  // The heavy work (2×1400-trial Monte-Carlo + range summary + solver) runs in a
  // Web Worker (workers/hudWorker.ts) so the UI never hitches on a hero turn;
  // computeHudNode is the same pure function either way, and a seq counter drops
  // stale replies if the state advances mid-compute. Falls back to a synchronous
  // main-thread call where Workers are unavailable (e.g. jsdom).
  useEffect(() => {
    if (!isHeroTurn) return;
    const seq = ++hudSeqRef.current;
    const id = setTimeout(() => {
      // RNG roll stays on the main thread (Math.random is fine here; the worker
      // must stay deterministic given the state).
      const roll = Math.floor(Math.random() * 100) + 1;
      const apply = (r: HudNodeResult) => {
        if (seq !== hudSeqRef.current) return; // a newer node superseded this one
        strategyRef.current = r.strategy;
        rollRef.current = roll;
        setStrategy(r.strategy);
        setRng({ roll, prescribed: rngPrescription(r.strategy, roll) });
        setVillain(r.villain);
        setHud(r.hud);
      };
      const w = getHudWorker();
      if (w) {
        const onMsg = (ev: MessageEvent<{ seq: number; result: HudNodeResult }>) => {
          if (ev.data?.seq !== seq) return;
          w.removeEventListener('message', onMsg);
          apply(ev.data.result);
        };
        w.addEventListener('message', onMsg);
        w.postMessage({ seq, state: game });
      } else {
        apply(computeHudNode(game));
      }
    }, 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.handNumber, game.street, game.toAct, game.board.length]);

  // ---- record hand result + history on completion ----
  // This effect reacts to a one-shot terminal transition (street → 'complete')
  // and persists the result to localStorage + analytics state. It is guarded by
  // `recordedHand` so it runs exactly once per hand and can't cascade.
  useEffect(() => {
    if (game.street !== 'complete') return;
    if (game.handNumber === 0) return;

    // deferred (exam) mode: the hand is over — reveal every decision's graded
    // answer at once as the end-of-hand review. This must run on EVERY
    // completion, including a Repeat Hand replay (which reuses the same
    // handNumber), so it sits ABOVE the record-once guard below. Immediate mode
    // showed each answer live, so its buffer is empty and this is a no-op.
    if (feedbackMode === 'deferred') setFeedbackLog(pendingFbRef.current.slice());

    // record the result into stats / history / observed-stats exactly once per
    // hand. A Repeat Hand replays the same handNumber, so this guard also stops
    // the replay from double-counting into the session.
    if (recordedHand.current === game.handNumber) return;
    recordedHand.current = game.handNumber;

    // fold this hand's actions into the per-seat observed stats (anonymous mode)
    setObsCounters((m) => accumulateHand(m, game.log, game.handNumber));

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
    // tournament finishing place — only meaningful on the terminal hand: hero
    // busts (place = survivors + 1) or hero is the lone survivor (champion = 1).
    const isTourney = !!game.tournament;
    const survivors = game.players.filter((p) => p.stack > 0).length;
    let place: number | undefined;
    if (isTourney) {
      if (hero.stack <= 0) place = game.players.filter((p) => !p.isHero && p.stack > 0).length + 1;
      else if (survivors === 1) place = 1;
    }
    const hist: HistoryHand = {
      id: crypto.randomUUID(),
      sessionId,
      tournament: isTourney,
      place,
      bigBlind: game.bigBlind,
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
      const next = capHistory([hist, ...h]);
      saveHistory(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.street, game.handNumber]);

  // play the outcome cue once per graded decision (effect, not the state
  // updater — keeps it from double-firing under StrictMode in dev).
  useEffect(() => {
    if (!feedback) return;
    playAction();
    playResult(feedback.verdict, feedback.evLoss);
  }, [feedback]);

  const leaks = useMemo(() => findLeaks(stats), [stats]);

  // rolling "your big bets keep getting called/raised and losing" warning,
  // recomputed as the log + per-hand results grow.
  const aggroWarning = useMemo(
    () => aggressionWarning(game.log, new Map(history.map((h) => [h.handNumber, h.deltaBB]))),
    [game.log, history],
  );

  // tilt pressure read off the recent result shape + decision quality — drives
  // the cool-off gate on the deal button after a big swing. Null when the user
  // has switched tilt warnings off, which also removes the gate that would
  // otherwise hide the Repeat Hand button after a swing.
  const tilt = useMemo(() => (tiltWarnings ? assessTilt(stats) : null), [stats, tiltWarnings]);

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

  // ---- tournament (freezeout) status, derived from the live state so it's also
  // correct after a refresh (game.tournament is persisted on the state itself) ----
  const isTournament = !!game.tournament;
  const playersLeft = liveSeatCount(game);
  const heroBusted = isTournament && hero.stack <= 0;
  // champion = the sole player still holding chips (could be the hero or a bot).
  const championName = isTournament && playersLeft === 1 ? (game.players.find((p) => p.stack > 0)?.name ?? null) : null;
  const tournamentOver = isTournament && handOver && playersLeft <= 1;
  // finishing place when the hero busts: everyone still holding chips outlasted you.
  const heroPlace = heroBusted ? game.players.filter((p) => !p.isHero && p.stack > 0).length + 1 : 0;
  // show the freezeout end screen (instead of "Next Hand") once the hero is out or
  // the title is decided.
  const tournamentEnd = isTournament && handOver && (heroBusted || tournamentOver);

  return {
    game,
    hero,
    legal,
    isHeroTurn,
    handOver,
    isTournament,
    mode,
    setActiveMode,
    playersLeft,
    fieldSize: game.players.length,
    championName,
    tournamentOver,
    heroBusted,
    heroPlace,
    tournamentEnd,
    feedback,
    feedbackMode,
    setFeedbackMode,
    feedbackLog,
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
    aggroWarning,
    tilt,
    clearHistory,
    removeHistoryHands,
    profiles,
    scenario,
    speed,
    stackDepth,
    applyStackDepth,
    tableSize,
    applyTableSize,
    watchAfterFold,
    setWatchAfterFold,
    tiltWarnings,
    setTiltWarnings,
    difficulty,
    setDifficulty,
    seatDiffs,
    setSeatDiffs,
    anonymousVillains,
    setAnonymousVillains,
    edgeFocus,
    setEdgeFocus,
    autoResetOnBust,
    setAutoResetOnBust,
    villainGuesses,
    guessVillain,
    obsCounters,
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
// `diffFor` resolves each seat's difficulty so a mixed table stays mixed here too.
function runoutToEnd(state: GameState, diffFor?: (seat: number) => DifficultyParams): void {
  let guard = 0;
  while (
    state.street !== 'complete' &&
    state.street !== 'showdown' &&
    state.toAct >= 0 &&
    state.toAct !== 0 &&
    guard++ < 400
  ) {
    applyAction(state, decideAction(state, { diff: diffFor?.(state.toAct) }));
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
