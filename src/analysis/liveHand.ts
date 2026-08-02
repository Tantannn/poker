// LIVE HAND CAPTURE — the path from "a hand I played at the casino" to the same
// grader, hand history and leak finder the in-app table already feeds.
//
// Everything downstream (Hand Review, findLeaks, bb/100, the SRS drills) consumes
// `HistoryHand` + `DecisionRecord`, so this module produces exactly those and nothing
// bespoke: a live hand and a played hand are indistinguishable to the analytics.
//
// The hand is REPLAYED THROUGH THE REAL ENGINE rather than hand-assembled. That is the
// whole point — `legalActions`, side pots, blind posting and `toAct` ordering are what
// make a graded node trustworthy, and an entry form that reimplements them would drift.
// The user supplies the action sequence in the order it happened; the engine decides
// whose turn each one is, which is also the validation (an action that isn't legal for
// the seat on turn is a typo in the entry, and it's reported with its index).

import type { Card } from '../engine/cards';
import { makeDeck, parseCard, cardToString } from '../engine/cards';
import type { GameState, Position, ActionType } from '../engine/table';
import { createGame, startHand, applyAction, legalActions, positionLabel, potTotal } from '../engine/table';
import type { RakeProfileId } from '../engine/rake';
import { getNodeStrategy } from '../strategy/index';
import { gradeNode, idToClass } from './grade';
import type { DecisionSnapshot, HistoryHand } from '../store/history';
import type { DecisionRecord, PreflopFacing } from '../store/stats';

export interface LiveActionInput {
  type: ActionType;
  /** bet/raise only: the TOTAL this street, in big blinds — the number a live player
   *  actually remembers ("he made it 15"), not a chip delta. */
  toBB?: number;
}

export interface LiveHandInput {
  tableSize: number;
  heroPosition: Position;
  /** Effective stack at the start of the hand, in big blinds. */
  stackBB: number;
  rake?: RakeProfileId;
  heroCards: Card[];
  /** 0, 3, 4 or 5 cards — as far as the hand actually got. */
  board: Card[];
  actions: LiveActionInput[];
}

export interface LiveHandResult {
  hand?: HistoryHand;
  records: DecisionRecord[];
  /** Fatal input problem — nothing was graded. */
  error?: string;
  /** How many of the entered actions were consumed before the hand ended. */
  consumed: number;
}

const BOARD_LEN: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 };
const BIG_BLIND = 2;
const key = (c: Card) => `${c.rank}${c.suit}`;

/** Seat 0 is always the hero, so hero's POSITION is chosen by moving the button. */
function buttonForPosition(pos: Position, n: number): number {
  for (let b = 0; b < n; b++) if (positionLabel(0, b, n) === pos) return b;
  return 0;
}

/** Give every non-hero seat cards that cannot collide with hero's hand or the board,
 *  and leave the deck free of them too. Villain holdings never enter a graded node
 *  (the engines work off ranges) — they only have to be legal for showdown. */
function dealAround(state: GameState, heroCards: Card[], board: Card[]): void {
  const used = new Set([...heroCards, ...board].map(key));
  const pool = makeDeck().filter((c) => !used.has(key(c)));
  state.players[0].holeCards = heroCards.slice();
  for (const p of state.players) {
    if (p.isHero || p.folded) continue;
    p.holeCards = [pool.pop()!, pool.pop()!];
  }
  state.deck = pool;
}

/** The engine deals its own board on every street change; overwrite it with the one
 *  the user actually saw. Cards dealt from the pool can't collide, so this only ever
 *  replaces cards nobody has looked at. */
function forceBoard(state: GameState, board: Card[]): void {
  const want = BOARD_LEN[state.street] ?? state.board.length;
  state.board = board.slice(0, want);
}

function facingFor(state: GameState): PreflopFacing | undefined {
  if (state.street !== 'preflop') return undefined;
  const raises = state.log.filter(
    (l) => l.handNumber === state.handNumber && l.street === 'preflop' && l.type === 'raise',
  ).length;
  return raises === 0 ? 'unopened' : raises === 1 ? 'raise' : raises === 2 ? '3bet' : '4bet+';
}

function illegal(state: GameState, a: LiveActionInput, amount: number): string | null {
  const la = legalActions(state);
  if (a.type === 'fold' && !la.canFold) return 'fold is not legal here';
  if (a.type === 'check' && !la.canCheck) return `check is not legal — there is ${la.callAmount} to call`;
  if (a.type === 'call' && !la.canCall) return 'call is not legal — nothing is bet';
  if ((a.type === 'bet' || a.type === 'raise') && !la.canRaise) return 'no raise is available here';
  if (a.type === 'bet' || a.type === 'raise') {
    if (!Number.isFinite(amount)) return 'bet/raise needs an amount';
    if (amount < la.minRaiseTo && amount < la.maxRaiseTo)
      return `${amount / BIG_BLIND}bb is under the minimum raise of ${la.minRaiseTo / BIG_BLIND}bb`;
  }
  return null;
}

/**
 * Replay an entered hand and grade every decision the hero made in it.
 *
 * Returns a `HistoryHand` whose `decisions` are real solved nodes — the same shape the
 * live table captures — plus the `DecisionRecord`s the leak finder aggregates.
 */
export function replayLiveHand(input: LiveHandInput): LiveHandResult {
  const { tableSize, heroPosition, stackBB, heroCards, board, actions } = input;
  if (heroCards.length !== 2) return { records: [], consumed: 0, error: 'Enter both of your hole cards.' };
  if (![0, 3, 4, 5].includes(board.length))
    return { records: [], consumed: 0, error: 'The board must be 0, 3, 4 or 5 cards.' };
  const dupes = new Set<string>();
  for (const c of [...heroCards, ...board]) {
    if (dupes.has(key(c))) return { records: [], consumed: 0, error: `${cardToString(c)} is entered twice.` };
    dupes.add(key(c));
  }
  if (!actions.length) return { records: [], consumed: 0, error: 'Enter the action, in the order it happened.' };

  const profiles = Array.from({ length: Math.max(0, tableSize - 1) }, () => 'tag');
  let state = createGame(tableSize, stackBB, BIG_BLIND, profiles, false);
  state.rake = input.rake;
  state.buttonIndex = (buttonForPosition(heroPosition, tableSize) - 1 + tableSize) % tableSize; // startHand advances it
  state = startHand(state);
  dealAround(state, heroCards, board);
  forceBoard(state, board);

  const snapshots: DecisionSnapshot[] = [];
  const records: DecisionRecord[] = [];
  const startStack = state.players[0].stack + state.players[0].committed;
  let consumed = 0;

  for (const a of actions) {
    if (state.toAct < 0) break; // the hand ended before the entry did
    if (state.board.length < (BOARD_LEN[state.street] ?? 0))
      return { records, consumed, error: `The hand reached the ${state.street} but only ${board.length} board cards were entered.` };

    const amount = a.toBB != null ? Math.round(a.toBB * BIG_BLIND) : NaN;
    const bad = illegal(state, a, amount);
    if (bad) return { records, consumed, error: `Action ${consumed + 1} (${a.type}): ${bad}.` };

    if (state.toAct === 0) {
      const la = legalActions(state);
      const strat = getNodeStrategy(state, 0);
      // roll = 1 makes the RNG prescription deterministic; a replayed hand has no live
      // roll to honour, so rngMatch is not meaningful and is dropped from the record.
      const fb = gradeNode(strat, { type: a.type, amount }, la.callAmount, 1, { state, heroIdx: 0 });
      const pos = positionLabel(0, state.buttonIndex, state.players.length);
      const live = state.players.filter((p, i) => i !== 0 && !p.folded);
      snapshots.push({
        street: state.street,
        boardLen: state.board.length,
        pot: potTotal(state),
        toCall: la.callAmount,
        position: pos,
        villainName: live.length === 1 ? live[0].name : 'the field',
        villainTag: '',
        chosenId: fb.chosen,
        chosenLabel: fb.chosenLabel,
        bestId: fb.best,
        bestLabel: fb.bestLabel,
        evLoss: fb.evLoss,
        equity: strat.equity,
        rngMatch: null,
        note: strat.note,
        rangeNote: strat.rangeNote,
        options: strat.options.map((o) => ({
          id: o.id, label: o.label, freq: o.freq, ev: o.ev, kind: o.kind, amount: o.amount, sizePct: o.sizePct, calledEq: o.calledEq,
        })),
        opponents: live.length,
        villainStory: fb.context?.villainStory,
        blocker: fb.context?.blocker,
        villainRange: strat.villainRange ? Array.from(strat.villainRange.entries()) : [],
      });
      records.push({
        street: state.street,
        position: pos,
        heroAction: idToClass(fb.chosen),
        recommended: idToClass(fb.best),
        verdict: fb.verdict === 'best' || fb.verdict === 'correct' ? 'correct'
          : fb.verdict === 'inaccuracy' ? 'ok' : 'mistake',
        evLoss: fb.evLoss,
        chosenEv: fb.chosenEv,
        rngMatch: null,
        facing: facingFor(state),
      });
    }

    state = applyAction(state, { type: a.type, amount });
    forceBoard(state, board);
    consumed++;
  }

  const hero = state.players[0];
  const deltaBB = (hero.stack + hero.committed - startStack) / BIG_BLIND;
  const hand: HistoryHand = {
    id: crypto.randomUUID(),
    sessionId: 'live',
    tournament: false,
    bigBlind: BIG_BLIND,
    handNumber: state.handNumber,
    heroCards,
    board: state.board,
    log: state.log
      .filter((l) => l.handNumber === state.handNumber)
      .map((l) => ({ text: `${l.position} ${l.playerName} ${l.type}${l.amount ? ` ${l.amount / BIG_BLIND}bb` : ''}`.trim() })),
    result: state.message || 'Entered from a live session.',
    deltaBB,
    showdown: [],
    decisions: snapshots,
    live: true,
  };
  return { hand, records, consumed };
}

// ---- entry parsing ----

/** "Ah Kd" / "AhKd" / "ah, kd" → cards. Throws nothing; bad input yields fewer cards. */
export function parseCards(text: string): Card[] {
  const out: Card[] = [];
  for (const tok of text.toUpperCase().match(/[2-9TJQKA][CDHS]/g) ?? []) {
    try {
      out.push(parseCard(tok[0] + tok[1].toLowerCase()));
    } catch {
      /* skip an unparseable token — the caller reports the count */
    }
  }
  return out;
}

const VERBS: Record<string, ActionType> = {
  f: 'fold', fold: 'fold',
  x: 'check', check: 'check',
  c: 'call', call: 'call',
  b: 'bet', bet: 'bet',
  r: 'raise', raise: 'raise', raises: 'raise',
};

/**
 * Action script → actions. One action per line or comma, in the order they happened:
 * `fold`, `check`, `call`, `bet 6`, `raise 15`. Amounts are TOTALS this street, in bb —
 * the number that gets said out loud at the table.
 */
export function parseActionScript(text: string): { actions: LiveActionInput[]; error?: string } {
  const toks = text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  const actions: LiveActionInput[] = [];
  for (let i = 0; i < toks.length; i++) {
    const [verb, num] = toks[i].toLowerCase().split(/\s+/);
    const type = VERBS[verb];
    if (!type) return { actions, error: `Action ${i + 1}: "${toks[i]}" — use fold / check / call / bet N / raise N.` };
    if (type === 'bet' || type === 'raise') {
      const toBB = Number(num);
      if (!Number.isFinite(toBB) || toBB <= 0)
        return { actions, error: `Action ${i + 1}: "${toks[i]}" needs a size in bb, e.g. "raise 7.5".` };
      actions.push({ type, toBB });
    } else {
      actions.push({ type });
    }
  }
  return { actions };
}
