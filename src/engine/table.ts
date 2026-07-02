// No-Limit Texas Hold'em state machine: blinds, betting rounds, all-ins,
// side pots and showdown. Engine functions mutate a passed-in state object;
// the React layer clones state before applying so reducers stay pure.

import type { Card } from './cards';
import { makeDeck, shuffle } from './cards';
import { evaluate7, describeHand } from './evaluator';

export type Position = 'BTN' | 'SB' | 'BB' | 'UTG' | 'MP' | 'CO';
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'post';

// how many recent hands of action log to retain. aggressionWarning reads the
// last 6; keep a margin. Older entries are trimmed each startHand.
const LOG_KEEP_HANDS = 10;

// Position labels by offset from the button (offset 0 = button), per table size.
// A position is really "how many players act behind you", so short tables keep
// BTN/SB/BB and trim the early seats (UTG/MP/CO) off the front. Heads-up: the
// button posts the small blind, so the two seats are BTN(=SB) and BB.
const POS_BY_OFFSET: Record<number, Position[]> = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'],
};

/** Ordered position labels for an n-handed table, indexed by offset from button. */
export function tablePositions(n: number): Position[] {
  return POS_BY_OFFSET[n] ?? POS_BY_OFFSET[6];
}

// Opening ranges scale with SEATS BEHIND (players still to act), so a seat at a
// short table borrows the 6-max range with the same behind-count: 5-max UTG (4
// behind) opens like 6-max MP, etc. HU button opens widest (BTN). Returns null
// for the BB (it never opens first-in). Single source for the solver
// (strategy) and the live position hint, so the two can never disagree.
const RFI_LADDER: Position[] = ['BB', 'SB', 'BTN', 'CO', 'MP', 'UTG']; // index = seats behind
export function sixMaxRfiEquivalent(pos: Position, n: number): Position | null {
  if (n === 2) return pos === 'BB' ? null : 'BTN';
  const off = tablePositions(n).indexOf(pos);
  if (off < 0) return null;
  const behind = (2 - off + n) % n; // BB sits at offset 2 (tables with blinds)
  if (behind === 0) return null; // BB — defends, never RFIs
  return RFI_LADDER[Math.min(behind, 5)];
}

export function positionLabel(seat: number, button: number, n: number): Position {
  const table = tablePositions(n);
  const off = (seat - button + n) % n;
  return table[off] ?? 'MP';
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
  startStack: number; // stack at the start of the current hand (for P/L this hand)
  buyIn: number; // standard buy-in (chips) — busted players rebuy to THIS, not to
  // the chip leader, so the table looks like a real cash game (most seats ~100bb).
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
  // The level-1 big blind a tournament started at. Escalation is computed as
  // baseBigBlind × levelMultiplier so it stays deterministic even after a refresh
  // (bigBlind itself is mutated up each level). Equals bigBlind in cash games.
  baseBigBlind: number;
  // Per-player ante posted each hand once a tournament reaches the ante level
  // (dead money in the pot, not a live bet). 0 in cash and early tournament.
  ante: number;
  handNumber: number;
  log: ActionRecord[];
  pots: SidePot[];
  winners: Winner[];
  message: string;
  lastAggressor: number;
  // Per-hand PRNG seed. Bots derive a deterministic random stream from this so a
  // repeated/replayed hand reproduces the SAME bot actions (given the same hero
  // line) instead of rolling fresh every time. Set fresh each startHand.
  seed: number;
  // Tournament (freezeout) mode: busted players are NOT rebought — they're
  // eliminated and play continues until one player holds all the chips. Default
  // (undefined/false) = cash-game behaviour with rebuys to the standard buy-in.
  tournament?: boolean;
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
  tournament = false,
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
      buyIn: startingStackBB * bigBlind,
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
    baseBigBlind: bigBlind,
    ante: 0,
    handNumber: 0,
    log: [],
    pots: [],
    winners: [],
    message: 'Press Deal to start.',
    lastAggressor: -1,
    seed: 0,
    tournament,
  };
}

// ---- Tournament blind escalation ----------------------------------------
// A freezeout ramps the blinds every few hands so deep stacks can't stall
// forever — the same pressure a real tournament clock applies. The big blind
// for a level is baseBigBlind × the level's multiplier; the small blind tracks
// at half. Multipliers follow the classic 1/2/3/5/8 chip progression, then keep
// roughly doubling, and clamp at the top so a long heads-up doesn't overflow.
export const TOURNEY_HANDS_PER_LEVEL = 5;
const BLIND_LEVEL_MULT = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200];
// Antes kick in from this level (0-based) — late enough that early play is pure
// blind-vs-blind, then dead money sweetens every pot and forces action, like a
// real mid/late tournament. Each live player antes ~1/8 of the big blind.
const ANTE_START_LEVEL = 3;
function anteFor(bigBlind: number): number {
  return Math.max(1, Math.round(bigBlind / 8));
}

/** Zero-based blind level for a given hand number (hand 1 = level 0). */
export function tournamentLevel(handNumber: number): number {
  return Math.floor(Math.max(0, handNumber - 1) / TOURNEY_HANDS_PER_LEVEL);
}

/** Hands remaining until the blinds next go up. */
export function handsToNextLevel(handNumber: number): number {
  return TOURNEY_HANDS_PER_LEVEL - (Math.max(0, handNumber - 1) % TOURNEY_HANDS_PER_LEVEL);
}

/** Set bigBlind/smallBlind for the current hand's tournament level. */
function applyBlindLevel(state: GameState) {
  const base = state.baseBigBlind || state.bigBlind;
  const level = tournamentLevel(state.handNumber);
  const mult = BLIND_LEVEL_MULT[Math.min(level, BLIND_LEVEL_MULT.length - 1)];
  state.bigBlind = base * mult;
  state.smallBlind = Math.max(1, Math.round(state.bigBlind / 2));
  state.ante = level >= ANTE_START_LEVEL ? anteFor(state.bigBlind) : 0;
}

/** Players who still have chips (i.e. not eliminated). In a tournament, when this
 *  drops to one the freezeout is over and that player is the champion. */
export function liveSeatCount(state: GameState): number {
  return state.players.filter((p) => p.stack > 0).length;
}

function activeForButton(state: GameState): number[] {
  // seats with chips to play
  return state.players.filter((p) => p.stack > 0).map((p) => p.id);
}

export function startHand(state: GameState): GameState {
  const n = state.players.length;
  // CASH mode: rebuy busted players to their STANDARD buy-in (~100bb), exactly like
  // a real cash game — a busted player tops up a normal stack, they do NOT auto-match
  // the chip leader. So a hero who has run up to 800bb stays deep, but most seats sit
  // ~100bb, the effective stack vs them is ~100bb, and you never get your whole 800bb
  // in against a short stack. Deep pots happen only vs a bot that itself ran up.
  // Falls back to 100bb for games persisted before `buyIn` existed.
  // TOURNAMENT mode: no rebuys — a busted player (stack 0) is eliminated and sits out
  // every future hand (dealt no cards, skipped for blinds/button) until one remains.
  if (!state.tournament) {
    for (const p of state.players) {
      if (p.stack <= 0) p.stack = p.buyIn || state.bigBlind * 100;
    }
  }

  // advance button to next seat with chips
  let b = (state.buttonIndex + 1) % n;
  const haveChips = activeForButton(state);
  while (!haveChips.includes(b)) b = (b + 1) % n;
  state.buttonIndex = b;

  state.handNumber += 1;
  // keep the action log bounded. Only recent hands are ever read — the hand
  // record filters to the current hand, aggressionWarning scans the last 6.
  // Without this the log grows unbounded across a session (heap + the localStorage
  // blob saveGame writes every state change).
  const cutoff = state.handNumber - LOG_KEEP_HANDS;
  if (cutoff > 0) state.log = state.log.filter((l) => l.handNumber > cutoff);
  // tournament: step blinds up on the schedule before posting them this hand.
  if (state.tournament) applyBlindLevel(state);
  // fresh seed per hand — captured in the "repeat hand" snapshot so a replay
  // reproduces the bots' exact decisions.
  state.seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
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

  // post blinds. Heads-up: the BUTTON posts the small blind (and acts first
  // preflop, last postflop), so SB == button and BB is the other seat.
  // Blinds walk to the next seats WITH CHIPS, so a tournament that's lost players
  // still posts on live seats. With a full table everyone is live, so this reduces
  // to the usual b+1 / b+2 — and once only two players remain it correctly switches
  // to heads-up rules even at a 6-seat table.
  const nextLiveSeat = (from: number) => {
    for (let k = 1; k <= n; k++) {
      const idx = (from + k) % n;
      if (state.players[idx].stack > 0) return idx;
    }
    return from;
  };
  const heads = liveSeatCount(state) === 2;
  const sbIdx = heads ? b : nextLiveSeat(b);
  const bbIdx = heads ? nextLiveSeat(b) : nextLiveSeat(sbIdx);
  postBlind(state, sbIdx, state.smallBlind, 'SB');
  postBlind(state, bbIdx, state.bigBlind, 'BB');
  // antes are dead money: every live seat contributes to the pot but it isn't a
  // live bet, so currentBet stays at the big blind.
  if (state.ante > 0) {
    for (let i = 0; i < n; i++) postAnte(state, i);
  }
  state.currentBet = state.bigBlind;
  state.lastRaiseSize = state.bigBlind;

  // first to act preflop = left of BB (UTG)
  state.toAct = nextToAct(state, bbIdx);
  // blinds reset hasActed so they get to act
  state.players[sbIdx].hasActed = false;
  state.players[bbIdx].hasActed = false;
  const anteNote = state.ante > 0 ? ` (ante ${state.ante})` : '';
  state.message = `Hand #${state.handNumber} dealt. Blinds ${state.smallBlind}/${state.bigBlind}${anteNote}.`;
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

// Ante: dead money into the pot. Goes to totalCommitted (so it's in the pot and
// won at showdown, forfeited on a fold) but NOT to committed — it's not a live
// bet, doesn't change the facing-bet, and doesn't count as the player's action.
function postAnte(state: GameState, idx: number) {
  const p = state.players[idx];
  if (state.ante <= 0 || p.stack <= 0) return;
  const amt = Math.min(state.ante, p.stack);
  p.stack -= amt;
  p.totalCommitted += amt;
  if (p.stack === 0) p.allIn = true;
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
