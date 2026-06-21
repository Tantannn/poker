// No-Limit Texas Hold'em state machine: blinds, betting rounds, all-ins,
// side pots and showdown. Engine functions mutate a passed-in state object;
// the React layer clones state before applying so reducers stay pure.

import type { Card } from './cards';
import { makeDeck, shuffle } from './cards';
import { evaluate7, describeHand } from './evaluator';

export type Position = 'BTN' | 'SB' | 'BB' | 'UTG' | 'MP' | 'CO';
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'post';

// Position labels by offset from the button (6-max).
const POS_BY_OFFSET: Position[] = ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'];

export function positionLabel(seat: number, button: number, n: number): Position {
  const off = (seat - button + n) % n;
  return POS_BY_OFFSET[off] ?? 'MP';
}

export interface Player {
  id: number;
  name: string;
  isHero: boolean;
  profileId: string;
  stack: number;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  committed: number; // chips this street
  totalCommitted: number; // chips this hand
  hasActed: boolean; // acted since last aggression this street
  lastAction: string;
  startStack: number;
}

export interface ActionRecord {
  handNumber: number;
  playerId: number;
  playerName: string;
  position: Position;
  type: ActionType;
  amount: number;
  street: Street;
  potAfter: number;
}

export interface SidePot {
  amount: number;
  eligible: number[]; // player ids
}

export interface Winner {
  playerId: number;
  amount: number;
  potIndex: number;
  handDesc: string;
}

export interface GameState {
  players: Player[];
  buttonIndex: number;
  deck: Card[];
  board: Card[];
  street: Street;
  currentBet: number;
  lastRaiseSize: number;
  toAct: number; // index, -1 if nobody
  bigBlind: number;
  smallBlind: number;
  handNumber: number;
  log: ActionRecord[];
  pots: SidePot[];
  winners: Winner[];
  message: string;
  lastAggressor: number;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number; // chips needed to call
  canRaise: boolean;
  minRaiseTo: number; // total committed-this-street target for a min raise
  maxRaiseTo: number; // all-in target
  isAllInCall: boolean;
}

const HERO_NAMES = ['You'];
const BOT_NAMES = ['Alex', 'Bianca', 'Cole', 'Diana', 'Evan', 'Farah', 'Gus', 'Hana'];

export function createGame(
  numPlayers: number,
  startingStackBB: number,
  bigBlind: number,
  profileIds: string[],
): GameState {
  const players: Player[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const isHero = i === 0;
    players.push({
      id: i,
      name: isHero ? HERO_NAMES[0] : BOT_NAMES[(i - 1) % BOT_NAMES.length],
      isHero,
      profileId: isHero ? '' : profileIds[i - 1] ?? 'tag',
      stack: startingStackBB * bigBlind,
      holeCards: [],
      folded: false,
      allIn: false,
      committed: 0,
      totalCommitted: 0,
      hasActed: false,
      lastAction: '',
      startStack: startingStackBB * bigBlind,
    });
  }
  return {
    players,
    buttonIndex: numPlayers - 1, // so first startHand moves button to seat 0... we advance before deal
    deck: [],
    board: [],
    street: 'complete',
    currentBet: 0,
    lastRaiseSize: bigBlind,
    toAct: -1,
    bigBlind,
    smallBlind: Math.round(bigBlind / 2),
    handNumber: 0,
    log: [],
    pots: [],
    winners: [],
    message: 'Press Deal to start.',
    lastAggressor: -1,
  };
}

function activeForButton(state: GameState): number[] {
  // seats with chips to play
  return state.players.filter((p) => p.stack > 0).map((p) => p.id);
}

export function startHand(state: GameState): GameState {
  const n = state.players.length;
  // top up any busted players to keep a full 6-handed practice table
  for (const p of state.players) {
    if (p.stack <= 0) p.stack = p.startStack;
  }

  // advance button to next seat with chips
  let b = (state.buttonIndex + 1) % n;
  const haveChips = activeForButton(state);
  while (!haveChips.includes(b)) b = (b + 1) % n;
  state.buttonIndex = b;

  state.handNumber += 1;
  state.deck = shuffle(makeDeck());
  state.board = [];
  state.street = 'preflop';
  state.pots = [];
  state.winners = [];
  state.lastAggressor = -1;
  state.message = '';

  for (const p of state.players) {
    p.holeCards = [];
    p.folded = p.stack <= 0;
    p.allIn = false;
    p.committed = 0;
    p.totalCommitted = 0;
    p.hasActed = false;
    p.lastAction = '';
    p.startStack = p.stack;
  }

  // deal two cards each, starting left of button
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) {
      const idx = (b + k) % n;
      const p = state.players[idx];
      if (!p.folded) p.holeCards.push(state.deck.pop()!);
    }
  }

  // post blinds
  const sbIdx = (b + 1) % n;
  const bbIdx = (b + 2) % n;
  postBlind(state, sbIdx, state.smallBlind, 'SB');
  postBlind(state, bbIdx, state.bigBlind, 'BB');
  state.currentBet = state.bigBlind;
  state.lastRaiseSize = state.bigBlind;

  // first to act preflop = left of BB (UTG)
  state.toAct = nextToAct(state, bbIdx);
  // blinds reset hasActed so they get to act
  state.players[sbIdx].hasActed = false;
  state.players[bbIdx].hasActed = false;
  state.message = `Hand #${state.handNumber} dealt. Blinds ${state.smallBlind}/${state.bigBlind}.`;
  return state;
}

function postBlind(state: GameState, idx: number, amount: number, label: string) {
  const p = state.players[idx];
  const amt = Math.min(amount, p.stack);
  p.stack -= amt;
  p.committed += amt;
  p.totalCommitted += amt;
  if (p.stack === 0) p.allIn = true;
  p.lastAction = `Post ${label}`;
  p.hasActed = true;
}

export function potTotal(state: GameState): number {
  return state.players.reduce((s, p) => s + p.totalCommitted, 0);
}

function contenders(state: GameState): Player[] {
  return state.players.filter((p) => !p.folded);
}

function canStillAct(p: Player): boolean {
  return !p.folded && !p.allIn && p.stack > 0;
}

export function nextToAct(state: GameState, fromIdx: number): number {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const idx = (fromIdx + k) % n;
    if (canStillAct(state.players[idx])) return idx;
  }
  return -1;
}

function firstToActPostflop(state: GameState): number {
  return nextToAct(state, state.buttonIndex); // left of button
}

export function legalActions(state: GameState): LegalActions {
  const i = state.toAct;
  if (i < 0) {
    return {
      canFold: false,
      canCheck: false,
      canCall: false,
      callAmount: 0,
      canRaise: false,
      minRaiseTo: 0,
      maxRaiseTo: 0,
      isAllInCall: false,
    };
  }
  const p = state.players[i];
  const toCall = state.currentBet - p.committed;
  const canCheck = toCall <= 0;
  const callAmount = Math.min(toCall, p.stack);
  const isAllInCall = toCall >= p.stack && toCall > 0;
  const maxRaiseTo = p.committed + p.stack; // shove
  let minRaiseTo = state.currentBet + state.lastRaiseSize;
  if (minRaiseTo > maxRaiseTo) minRaiseTo = maxRaiseTo;
  // can raise only if you have chips beyond a call
  const canRaise = p.stack > toCall;
  return {
    canFold: true,
    canCheck,
    canCall: toCall > 0,
    callAmount,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
    isAllInCall,
  };
}

export interface Action {
  type: ActionType;
  /** For raise/bet: total committed-this-street target. */
  amount?: number;
}

export function applyAction(state: GameState, action: Action): GameState {
  const i = state.toAct;
  if (i < 0) return state;
  const p = state.players[i];
  const la = legalActions(state);
  const pos = positionLabel(i, state.buttonIndex, state.players.length);

  let type: ActionType = action.type;
  let amount = 0;

  if (action.type === 'fold') {
    p.folded = true;
    p.lastAction = 'Fold';
  } else if (action.type === 'check') {
    p.lastAction = 'Check';
  } else if (action.type === 'call') {
    amount = la.callAmount;
    commit(p, amount);
    p.lastAction = amount > 0 ? `Call ${amount}` : 'Check';
    if (amount === 0) type = 'check';
  } else {
    // bet or raise -> treat as raise-to target
    let target = action.amount ?? la.minRaiseTo;
    target = Math.max(target, Math.min(la.minRaiseTo, la.maxRaiseTo));
    target = Math.min(target, la.maxRaiseTo);
    const delta = target - p.committed;
    const raiseIncrement = target - state.currentBet;
    commit(p, delta);
    // full raise reopens action; short all-in does not
    if (raiseIncrement >= state.lastRaiseSize) {
      state.lastRaiseSize = raiseIncrement;
      for (const other of state.players) {
        if (other.id !== p.id && canStillAct(other)) other.hasActed = false;
      }
    }
    state.currentBet = Math.max(state.currentBet, target);
    state.lastAggressor = i;
    const isBet = action.type === 'bet';
    p.lastAction = `${isBet ? 'Bet' : 'Raise'} to ${target}`;
    type = isBet ? 'bet' : 'raise';
    amount = target;
  }

  p.hasActed = true;

  state.log.push({
    handNumber: state.handNumber,
    playerId: p.id,
    playerName: p.name,
    position: pos,
    type,
    amount,
    street: state.street,
    potAfter: potTotal(state),
  });

  // hand over by folds?
  if (contenders(state).length === 1) {
    awardUncontested(state);
    return state;
  }

  if (bettingComplete(state)) {
    advanceStreet(state);
  } else {
    state.toAct = nextToAct(state, i);
  }
  return state;
}

function commit(p: Player, amount: number) {
  const amt = Math.min(amount, p.stack);
  p.stack -= amt;
  p.committed += amt;
  p.totalCommitted += amt;
  if (p.stack === 0) p.allIn = true;
}

function bettingComplete(state: GameState): boolean {
  const actable = state.players.filter((p) => !p.folded && !p.allIn);
  if (actable.length === 0) return true;
  return actable.every((p) => p.hasActed && p.committed === state.currentBet);
}

function advanceStreet(state: GameState) {
  // reset street betting
  const resetStreet = () => {
    state.currentBet = 0;
    state.lastRaiseSize = state.bigBlind;
    for (const p of state.players) {
      p.committed = 0;
      if (canStillAct(p)) p.hasActed = false;
    }
  };

  const dealNext = () => {
    if (state.street === 'preflop') {
      state.board.push(state.deck.pop()!, state.deck.pop()!, state.deck.pop()!);
      state.street = 'flop';
    } else if (state.street === 'flop') {
      state.board.push(state.deck.pop()!);
      state.street = 'turn';
    } else if (state.street === 'turn') {
      state.board.push(state.deck.pop()!);
      state.street = 'river';
    } else if (state.street === 'river') {
      state.street = 'showdown';
    }
  };

  dealNext();
  if (state.street === 'showdown') {
    doShowdown(state);
    return;
  }
  resetStreet();
  state.lastAggressor = -1;

  // if at most one player can still act, run remaining streets out (no betting)
  const actable = state.players.filter((p) => canStillAct(p));
  if (actable.length <= 1 && contenders(state).length >= 2) {
    // everyone (or all but one) is all-in: deal to showdown
    advanceStreet(state);
    return;
  }

  state.toAct = firstToActPostflop(state);
}

function buildPots(state: GameState): SidePot[] {
  const contribs = state.players
    .map((p) => ({ id: p.id, amt: p.totalCommitted, folded: p.folded }))
    .filter((c) => c.amt > 0);
  const pots: SidePot[] = [];
  let live = contribs.slice();
  while (live.length > 0) {
    const min = Math.min(...live.map((c) => c.amt));
    let amount = 0;
    const eligible: number[] = [];
    for (const c of live) {
      amount += min;
      c.amt -= min;
      if (!c.folded) eligible.push(c.id);
    }
    // merge with previous if same eligibility (cleaner display)
    const prev = pots[pots.length - 1];
    if (prev && sameSet(prev.eligible, eligible)) prev.amount += amount;
    else pots.push({ amount, eligible });
    live = live.filter((c) => c.amt > 0);
  }
  return pots;
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function doShowdown(state: GameState) {
  state.pots = buildPots(state);
  state.winners = [];

  state.pots.forEach((pot, potIndex) => {
    const eligible = pot.eligible.filter((id) => !state.players[id].folded);
    if (eligible.length === 0) return;
    // best hand among eligible
    let bestScore = -1;
    const scored = eligible.map((id) => {
      const p = state.players[id];
      const res = evaluate7([...p.holeCards, ...state.board]);
      if (res.score > bestScore) bestScore = res.score;
      return { id, res };
    });
    const winners = scored.filter((s) => s.res.score === bestScore);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const w of winners) {
      let amt = share;
      if (remainder > 0) {
        amt += 1;
        remainder--;
      }
      state.players[w.id].stack += amt;
      state.winners.push({
        playerId: w.id,
        amount: amt,
        potIndex,
        handDesc: describeHand(w.res),
      });
    }
  });

  state.street = 'complete';
  state.toAct = -1;

  // Explain the win: name each winner's hand (and which pot, when an all-in made
  // side pots — that's the only way two *different* hands can both win).
  const allScored = state.players
    .filter((p) => !p.folded && p.holeCards.length === 2)
    .map((p) => ({ id: p.id, res: evaluate7([...p.holeCards, ...state.board]) }));
  const top = allScored.reduce((best, s) => (s.res.score > best.res.score ? s : best), allScored[0]);
  const winDesc = describeHand(top.res);
  const losers = allScored.filter((s) => s.res.score < top.res.score);
  const bestLoser = losers.reduce<(typeof allScored)[number] | undefined>(
    (best, s) => (!best || s.res.score > best.res.score ? s : best),
    undefined,
  );
  const kickerWin =
    bestLoser !== undefined &&
    bestLoser.res.categoryRank === top.res.categoryRank &&
    describeHand(bestLoser.res) === winDesc;

  const potCount = state.pots.length;
  const potLabel = (idx: number) => (potCount <= 1 ? 'the pot' : idx === 0 ? 'the main pot' : `side pot ${idx}`);

  // collapse the per-pot winner rows into one entry per player (a player can
  // scoop more than one pot), keeping their hand + which pots they took.
  const perPlayer = new Map<number, { name: string; desc: string; pots: number[] }>();
  for (const w of state.winners) {
    const e = perPlayer.get(w.playerId) ?? { name: state.players[w.playerId].name, desc: w.handDesc, pots: [] };
    e.pots.push(w.potIndex);
    perPlayer.set(w.playerId, e);
  }
  const entries = [...perPlayer.values()];

  if (entries.length === 1) {
    state.message = `Showdown — ${entries[0].name} wins the pot with ${entries[0].desc}${kickerWin ? ' (better kicker)' : ''}.`;
  } else if (potCount <= 1 && entries.every((e) => e.desc === entries[0].desc)) {
    // genuine chop: same single pot, identical hands
    state.message = `Showdown — ${entries.map((e) => e.name).join(' & ')} split the pot with ${entries[0].desc}.`;
  } else {
    // side pots: each winner took a different pot — name the pot and the hand
    const parts = entries.map((e) => `${e.name} wins ${potLabel(Math.min(...e.pots))} with ${e.desc}`);
    state.message = `Showdown — ${parts.join('; ')}.`;
  }
}

function awardUncontested(state: GameState) {
  const winner = contenders(state)[0];
  const pot = potTotal(state);
  winner.stack += pot;
  state.pots = [{ amount: pot, eligible: [winner.id] }];
  state.winners = [{ playerId: winner.id, amount: pot, potIndex: 0, handDesc: 'uncontested' }];
  state.street = 'complete';
  state.toAct = -1;
  state.message = `${winner.name} wins ${pot} uncontested.`;
}

/** Snapshot of bb won/lost this hand for each player (call after a hand completes). */
export function handResults(state: GameState): { playerId: number; deltaBB: number }[] {
  return state.players.map((p) => ({
    playerId: p.id,
    deltaBB: (p.stack - p.startStack) / state.bigBlind,
  }));
}
