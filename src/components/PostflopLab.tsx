// Postflop Lab — a training ground.
//  • Single mode: one decision on a chosen street; answer hidden until you pick.
//  • Play-it-out mode: play a FULL hand flop→turn→river vs a heuristic villain who
//    checks, bets, calls, raises AND folds — so you train both halves of postflop:
//    value-betting/pot-control when checked to, AND defending (fold / call / raise /
//    bluff-catch) when the villain leads or check-raises. Each of YOUR decisions is
//    graded by the solver (EV loss); the villain's line is a transparent range-
//    strength heuristic, not a solve.
// Pot-type (single-raised / 3-bet / 4-bet) sets the pot & effective stack (SPR),
// and position (IP/OOP) shifts equity realisation & fold equity in the model.
// Position AND villain range can each be set to 🎲 Random — rerolled to a concrete
// value per hand and stored IN the spot so the solver, equity, and explanation all
// read the SAME resolved value (never a stale label). Equity can be hidden until
// you answer, so you read the board instead of the solver.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard, describeTexture } from '../engine/board';
import type { TextureFilter } from '../engine/board';
import { TEXTURE_LABELS } from '../engine/board';
import { rangeFromSet, buildSampleTable, sampleCombo } from '../engine/range';
import type { WeightedRange } from '../engine/range';
import { equityVsRange } from '../engine/equity';
import { evaluate7 } from '../engine/evaluator';
import { RFI_RANGES, BB_DEFEND_RANGE, THREEBET_RANGE } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { classifyHandClass } from '../strategy/handClass';
import { evLoss, rngPrescription } from '../strategy/types';
import type { ActionId } from '../strategy/types';
import { actionRule, KIND_COLOR } from '../strategy/actionRules';
import { PlayingCard } from './PlayingCard';
import { playGrade } from '../sound';
import { SpotBoard } from './SpotBoard';

const BB = 2;
type Street = 'flop' | 'turn' | 'river';
type Pos = 'ip' | 'oop';
type PosSel = Pos | 'random';
type PotType = 'srp' | 'threebet' | 'fourbet';
type Mode = 'single' | 'playout';
type Actor = 'hero' | 'villain';

const STREET_LABEL: Record<Street, string> = {
  flop: 'Flop (3 cards)',
  turn: 'Turn (4 cards)',
  river: 'River (5 cards)',
};
const POT_LABEL: Record<PotType, string> = {
  srp: 'Single-raised pot',
  threebet: '3-bet pot',
  fourbet: '4-bet pot',
};
// preflop-derived flop pot + hero effective stack behind, in chips (BB=2).
const POT_BASE: Record<PotType, number> = { srp: 12, threebet: 36, fourbet: 90 };
const BEHIND_BASE: Record<PotType, number> = { srp: 188, threebet: 164, fourbet: 110 };

const POS_EXPLAIN: Record<Pos, string> = {
  ip: 'In position — you act AFTER the villain. You can check back for a free card, bluff-catch cheaply, and value bet thinly.',
  oop: 'Out of position — you act BEFORE the villain. You realise LESS equity, so bet/check-raise proactively and call tighter.',
};

const VILLAINS: { id: string; label: string; range: WeightedRange }[] = [
  { id: 'utg', label: 'UTG open (~14%, tight)', range: rangeFromSet(RFI_RANGES.UTG) },
  { id: 'mp', label: 'MP open (~18%)', range: rangeFromSet(RFI_RANGES.MP) },
  { id: 'co', label: 'CO open (~27%)', range: rangeFromSet(RFI_RANGES.CO) },
  { id: 'btn', label: 'BTN open (~45%, wide)', range: rangeFromSet(RFI_RANGES.BTN) },
  { id: 'sb', label: 'SB open (~40%)', range: rangeFromSet(RFI_RANGES.SB) },
  { id: 'bbdef', label: 'BB defend (very wide)', range: rangeFromSet(BB_DEFEND_RANGE) },
  { id: '3bet', label: '3-bet range (very tight)', range: rangeFromSet(THREEBET_RANGE) },
];
function villainById(id: string) {
  return VILLAINS.find((v) => v.id === id) ?? VILLAINS[0];
}
// Broad "typical opponent" range used only to score how STRONG the villain's own
// concrete hand is on the board (its equity vs an average holding). Drives the
// heuristic villain's bet/call/fold thresholds — a transparent stand-in for a
// solve, deliberately not the hero-facing solver.
const REF_RANGE = rangeFromSet(BB_DEFEND_RANGE);
const RAISE_CAP = 3; // max aggressive actions per street before it's call/fold only

const ACTION_ORDER: ActionId[] = ['fold', 'check', 'call', 'bet33', 'bet75', 'betpot', 'allin', 'raise', 'open'];
const orderRank = (id: ActionId) => {
  const i = ACTION_ORDER.indexOf(id);
  return i < 0 ? 99 : i;
};

function randCard(): Card {
  return { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
}
function dealHero(): Card[] {
  const a = randCard();
  let b: Card;
  do {
    b = randCard();
  } while (b.rank === a.rank && b.suit === a.suit);
  return [a, b];
}
function dealBoard(texture: TextureFilter, street: Street, hero: Card[]): Card[] {
  let board = randomFlop(texture, hero);
  if (street === 'turn' || street === 'river') board = [...board, randomCard([...hero, ...board])];
  if (street === 'river') board = [...board, randomCard([...hero, ...board])];
  return board;
}
// Resolve a position / villain selector to a CONCRETE value. 🎲 Random rolls a
// fresh pick; a specific selection passes through. Math.random lives here (module
// scope / handlers), never in render — the react-hooks purity rule forbids it there.
function pickPos(sel: PosSel): Pos {
  return sel === 'random' ? (Math.random() < 0.5 ? 'ip' : 'oop') : sel;
}
function pickVillainId(sel: string): string {
  return sel === 'random' ? VILLAINS[Math.floor(Math.random() * VILLAINS.length)].id : sel;
}
// flop pot + behind grow/shrink across streets as bets go in (≈0.6-pot bets).
function sizingFor(pt: PotType, street: Street): { pot: number; behind: number } {
  let pot = POT_BASE[pt];
  let behind = BEHIND_BASE[pt];
  const n = street === 'flop' ? 0 : street === 'turn' ? 1 : 2;
  for (let i = 0; i < n; i++) {
    const bet = Math.round(pot * 0.6);
    pot += 2 * bet;
    behind = Math.max(BB, behind - bet);
  }
  return { pot, behind };
}

interface Spot {
  hero: Card[];
  board: Card[];
  roll: number;
  pos: Pos; // resolved position for THIS hand (concrete even when selector is random)
  vId: string; // resolved villain id for THIS hand
}

interface LogEntry {
  street: Street;
  chosen: string;
  best: string;
  bestId: ActionId;
  loss: number;
  board: Card[];
  faced: string; // villain action hero was responding to ('' when checked to)
}
type Result =
  | { kind: 'fold'; winner: Actor }
  | { kind: 'showdown'; winner: Actor | 'split' };

interface PlayState {
  hero: Card[];
  vHand: Card[]; // villain's concrete cards, sampled from range; revealed at showdown
  board: Card[];
  street: Street;
  pot: number; // total chips in the middle now (incl. this-street commits)
  heroCommit: number; // chips hero put in on the CURRENT street
  villCommit: number; // chips villain put in on the CURRENT street
  behind: number; // hero stack remaining
  vBehind: number; // villain stack remaining
  raises: number; // aggressive actions on the current street (bet/raise), for the cap
  actor: Actor; // whose turn it is (meaningful only while !done)
  done: boolean;
  result: Result | null;
  villMsg: string; // last villain action, shown in the prompt / as `faced`
  pos: Pos; // hero position for this hand
  vId: string; // resolved villain id
  log: LogEntry[];
  total: number; // cumulative hero EV loss (bb)
}

// villain acts first postflop iff hero is OUT of position.
const heroIsFirst = (s: PlayState) => s.pos === 'oop';

/** Draw a concrete villain hand from its range, excluding dead cards. */
function sampleVillainHand(vId: string, dead: Card[]): Card[] {
  const table = buildSampleTable(villainById(vId).range, dead);
  const combo = sampleCombo(table);
  if (combo) return [combo[0], combo[1]];
  const a = randomCard(dead);
  const b = randomCard([...dead, a]);
  return [a, b];
}
/** How strong the villain's concrete hand is on this board — equity vs a broad
 *  reference range. 0.5 preflop (no board yet). */
function villStrength(vHand: Card[], board: Card[]): number {
  if (board.length < 3) return 0.5;
  return equityVsRange(vHand, board, REF_RANGE, 200).equity;
}

/** Fill the board to 5 and resolve the winner at showdown. */
function showdown(s: PlayState): PlayState {
  let board = s.board;
  while (board.length < 5) board = [...board, randomCard([...s.hero, ...s.vHand, ...board])];
  const hs = evaluate7([...s.hero, ...board]).score;
  const vs = evaluate7([...s.vHand, ...board]).score;
  const winner: Actor | 'split' = hs > vs ? 'hero' : hs < vs ? 'villain' : 'split';
  return { ...s, board, done: true, result: { kind: 'showdown', winner } };
}
/** Both players' commits are matched → close the street: run out to showdown if
 *  anyone is all-in or we're on the river, else deal the next card and reset. */
function closeStreet(s: PlayState): PlayState {
  if (s.behind <= 0 || s.vBehind <= 0 || s.street === 'river') return showdown(s);
  const board = [...s.board, randomCard([...s.hero, ...s.vHand, ...s.board])];
  const street: Street = s.street === 'flop' ? 'turn' : 'river';
  const next: PlayState = { ...s, board, street, heroCommit: 0, villCommit: 0, raises: 0, villMsg: '' };
  next.actor = heroIsFirst(next) ? 'hero' : 'villain';
  return next;
}

/** ONE villain decision, then either pass to hero, close the street, or end. */
function villainDecision(s: PlayState): PlayState {
  const toCall = Math.max(0, s.heroCommit - s.villCommit);
  const str = villStrength(s.vHand, s.board);
  const r = Math.random();
  const P = s.pot;

  if (toCall === 0) {
    // no bet in front — villain checks or leads
    const value = str >= 0.62;
    const bluff = str < 0.4 && r < 0.22;
    if ((value || bluff) && s.vBehind > 0) {
      const size = Math.min(s.vBehind, Math.max(BB, Math.round(0.66 * P)));
      return {
        ...s,
        pot: P + size,
        villCommit: s.villCommit + size,
        vBehind: s.vBehind - size,
        raises: s.raises + 1,
        actor: 'hero',
        villMsg: `Villain ${value ? 'bets' : 'bluffs'} ${size} (~⅔ pot).`,
      };
    }
    // check: pass to hero if villain acts first, else both checked → close
    if (heroIsFirst(s)) return closeStreet({ ...s, villMsg: 'Villain checks behind.' });
    return { ...s, actor: 'hero', villMsg: 'Villain checks.' };
  }

  // villain faces a bet/raise
  const need = toCall / (P + toCall);
  const canRaise = s.vBehind > 0 && s.raises < RAISE_CAP;
  if (canRaise && str >= 0.8 && r < 0.55) {
    const target = Math.min(s.villCommit + s.vBehind, Math.round(s.heroCommit + 0.9 * (P + toCall)));
    const delta = Math.max(0, target - s.villCommit);
    return {
      ...s,
      pot: P + delta,
      villCommit: s.villCommit + delta,
      vBehind: s.vBehind - delta,
      raises: s.raises + 1,
      actor: 'hero',
      villMsg: `Villain raises to ${s.villCommit + delta}.`,
    };
  }
  if (str >= need + 0.06 || (str >= 0.35 && r < 0.15)) {
    const delta = Math.min(toCall, s.vBehind);
    return closeStreet({ ...s, pot: P + delta, villCommit: s.villCommit + delta, vBehind: s.vBehind - delta });
  }
  return { ...s, done: true, result: { kind: 'fold', winner: 'hero' }, villMsg: 'Villain folds.' };
}

/** Run villain decisions until it's hero's turn (a node hero must decide) or the
 *  hand ends. Guarded against a runaway raise war. */
function drive(s: PlayState): PlayState {
  let cur = s;
  let guard = 0;
  while (!cur.done && cur.actor === 'villain' && guard++ < 40) cur = villainDecision(cur);
  return cur;
}

/** Apply hero's chosen action, then let the villain respond. */
function applyHeroAction(s: PlayState, opt: { id: ActionId; amount?: number }): PlayState {
  const toCall = Math.max(0, s.villCommit - s.heroCommit);
  if (opt.id === 'fold') return { ...s, done: true, result: { kind: 'fold', winner: 'villain' }, villMsg: '' };
  if (opt.amount != null) {
    // bet or raise — amount is a "to" target for hero this street
    const target = Math.min(opt.amount, s.heroCommit + s.behind);
    const delta = Math.max(0, target - s.heroCommit);
    return drive({
      ...s,
      pot: s.pot + delta,
      heroCommit: s.heroCommit + delta,
      behind: s.behind - delta,
      raises: s.raises + 1,
      actor: 'villain',
      villMsg: '',
    });
  }
  if (toCall > 0) {
    // call — matches villain, closes the street
    const delta = Math.min(toCall, s.behind);
    return closeStreet({ ...s, pot: s.pot + delta, heroCommit: s.heroCommit + delta, behind: s.behind - delta });
  }
  // check: pass to villain if hero acts first, else hero checked behind → close
  if (heroIsFirst(s)) return drive({ ...s, actor: 'villain', villMsg: '' });
  return closeStreet(s);
}

function makeStartPlay(texture: TextureFilter, potType: PotType, pos: Pos, vId: string): PlayState {
  const hero = dealHero();
  const board = dealBoard(texture, 'flop', hero);
  const vHand = sampleVillainHand(vId, [...hero, ...board]);
  const base: PlayState = {
    hero,
    vHand,
    board,
    street: 'flop',
    pot: POT_BASE[potType],
    heroCommit: 0,
    villCommit: 0,
    behind: BEHIND_BASE[potType],
    vBehind: BEHIND_BASE[potType],
    raises: 0,
    actor: pos === 'oop' ? 'hero' : 'villain',
    done: false,
    result: null,
    villMsg: '',
    pos,
    vId,
    log: [],
    total: 0,
  };
  return drive(base); // if villain acts first, run up to hero's first decision
}

// Build the solver node for hero's CURRENT decision from the play state — carries
// toCall / currentBet so fold·call·raise appear when hero is facing a bet.
function heroNode(s: PlayState) {
  const toCall = Math.max(0, s.villCommit - s.heroCommit);
  const currentBet = Math.max(s.heroCommit, s.villCommit);
  const v = villainById(s.vId);
  return solvePostflop({
    hero: s.hero,
    board: s.board,
    oppRange: v.range,
    pot: s.pot,
    toCall,
    heroCommitted: s.heroCommit,
    currentBet,
    minRaiseTo: currentBet + Math.max(BB, toCall),
    maxRaiseTo: s.heroCommit + s.behind,
    canCheck: toCall === 0,
    canRaise: s.behind > 0 && s.raises < RAISE_CAP,
    bigBlind: BB,
    iterations: 2500,
    rangeNote: v.label,
    position: s.pos,
  });
}

// RNG mix roll (1–100) for the prescribed-action branch. Module scope: the
// react-hooks purity rule forbids Math.random inside component-scope functions.
function randomRoll(): number {
  return Math.floor(Math.random() * 100) + 1;
}

// Initial spots generated at module load — NOT during render. React forbids
// impure Math.random in the render phase, and a useState lazy initializer runs
// there; module scope runs once at import, so it's safe. Handlers reroll after.
const FIRST_SINGLE: Spot = { hero: dealHero(), board: dealBoard('any', 'flop', []), roll: 1, pos: 'ip', vId: 'btn' };
const FIRST_PLAY: PlayState = makeStartPlay('any', 'srp', 'ip', 'btn');

export function PostflopLab() {
  const [mode, setMode] = useState<Mode>('single');
  const [villainId, setVillainId] = useState('btn'); // selector: a villain id or 'random'
  const [texture, setTexture] = useState<TextureFilter>('any');
  const [street, setStreet] = useState<Street>('flop');
  const [position, setPosition] = useState<PosSel>('ip'); // selector: 'ip' | 'oop' | 'random'
  const [potType, setPotType] = useState<PotType>('srp');
  // hide the equity number so you read the BOARD, not the solver. Revealed after
  // you answer (single) / when the hand completes (playout), so it stays a
  // teaching aid rather than a pre-answer spoiler.
  const [hideEq, setHideEq] = useState(false);

  // ---------------- single-decision mode ----------------
  const [spot, setSpot] = useState<Spot>(FIRST_SINGLE);
  const [chosen, setChosen] = useState<ActionId | null>(null);

  const sizing = sizingFor(potType, street);
  const strategy = useMemo(() => {
    const v = villainById(spot.vId);
    return solvePostflop({
      hero: spot.hero,
      board: spot.board,
      oppRange: v.range,
      pot: sizing.pot,
      toCall: 0,
      heroCommitted: 0,
      currentBet: 0,
      minRaiseTo: BB,
      maxRaiseTo: sizing.behind,
      canCheck: true,
      canRaise: sizing.behind > BB,
      bigBlind: BB,
      iterations: 2500,
      rangeNote: v.label,
      position: spot.pos,
    });
  }, [spot, sizing.pot, sizing.behind]);
  const prescribed = rngPrescription(strategy, spot.roll);
  const newSpot = useCallback(
    (tx?: TextureFilter, st?: Street) => {
      const t = tx ?? texture;
      const s = st ?? street;
      const hero = dealHero();
      setSpot({ hero, board: dealBoard(t, s, hero), roll: randomRoll(), pos: pickPos(position), vId: pickVillainId(villainId) });
      setChosen(null);
    },
    [texture, street, position, villainId],
  );
  const revealed = chosen != null;
  const loss = chosen ? evLoss(strategy, chosen) : 0;
  const orderedOptions = useMemo(
    () => [...strategy.options].sort((a, b) => orderRank(a.id) - orderRank(b.id)),
    [strategy],
  );
  const bestOpt = strategy.options.find((o) => o.id === strategy.bestId);
  const chosenOpt = chosen ? strategy.options.find((o) => o.id === chosen) : null;
  const spr = (sizing.behind / sizing.pot).toFixed(1);

  // ---------------- play-it-out mode ----------------
  const [po, setPo] = useState<PlayState>(FIRST_PLAY);

  const poStrategy = useMemo(() => (po.done ? null : heroNode(po)), [po]);
  const poOrdered = useMemo(
    () => (poStrategy ? [...poStrategy.options].sort((a, b) => orderRank(a.id) - orderRank(b.id)) : []),
    [poStrategy],
  );

  const playPick = useCallback(
    (id: ActionId) => {
      if (!poStrategy) return;
      const opt = poStrategy.options.find((o) => o.id === id);
      if (!opt) return;
      const l = evLoss(poStrategy, id);
      playGrade(l <= 0.04 ? 'good' : l <= 0.4 ? 'ok' : 'bad');
      const bestLabel = poStrategy.options.find((o) => o.id === poStrategy.bestId)?.label ?? '';
      const entry: LogEntry = { street: po.street, chosen: opt.label, best: bestLabel, bestId: poStrategy.bestId, loss: l, board: po.board, faced: po.villMsg };
      const next = applyHeroAction(po, opt);
      setPo({ ...next, log: [...po.log, entry], total: po.total + l });
    },
    [po, poStrategy],
  );

  const newPlay = useCallback(
    () => setPo(makeStartPlay(texture, potType, pickPos(position), pickVillainId(villainId))),
    [texture, potType, position, villainId],
  );

  // ---------------- shared controls ----------------
  // Villain change: single rerolls only the villain on the same board; playout
  // restarts the hand with the new villain (keeping the current position).
  const onChangeVillain = (sel: string) => {
    setVillainId(sel);
    const vId = pickVillainId(sel);
    setSpot((s) => ({ ...s, vId }));
    setPo((p) => makeStartPlay(texture, potType, p.pos, vId));
    setChosen(null);
  };
  // Pot-type change: single recomputes via `sizing`; playout restarts (new pot)
  // keeping the current position + villain.
  const onChangePotType = (pt: PotType) => {
    setPotType(pt);
    setPo((p) => makeStartPlay(texture, pt, p.pos, p.vId));
    setChosen(null);
  };
  // Position change: reroll to a concrete value; single applies in place, playout
  // restarts (position decides who acts first, so mid-hand swaps make no sense).
  const onChangePosition = (sel: PosSel) => {
    setPosition(sel);
    const pos = pickPos(sel);
    setSpot((s) => ({ ...s, pos }));
    setPo((p) => makeStartPlay(texture, potType, pos, p.vId));
    setChosen(null);
  };
  const onChangeMode = (m: Mode) => {
    setMode(m);
    setChosen(null);
    setPo(makeStartPlay(texture, potType, pickPos(position), pickVillainId(villainId)));
  };

  // resolved (concrete) position + villain for the active mode — drives display,
  // the position read, and the villain label so they can never disagree with the
  // solver, which reads the SAME spot.pos / spot.vId.
  const activePos: Pos = mode === 'single' ? spot.pos : po.pos;
  const activeVillain = villainById(mode === 'single' ? spot.vId : po.vId);

  return (
    <div className="card">
      <h2>Postflop Lab — Training</h2>
      <p className="sub">
        The open sandbox: <b>any</b> action, any villain, any SPR, and <b>play the hand out</b>
        {' '}flop→turn→river vs a villain who bets, raises &amp; folds — so you drill defending too. Pick
        before the answer shows. Set position or villain to <b>🎲 Random</b> to train reads you can't
        pre-plan, and hide equity to read the board. To drill bet <i>size</i> alone (⅓ / ¾ / pot) with a
        cheat-sheet, use the <b>Bet Sizing</b> tab.
      </p>

      <div className="lab-controls">
        <div className="lab-field">
          <label className="inline-label">Mode</label>
          <div className="pos-toggle">
            <button className={mode === 'single' ? 'active' : ''} onClick={() => onChangeMode('single')}>Single decision</button>
            <button className={mode === 'playout' ? 'active' : ''} onClick={() => onChangeMode('playout')}>Play it out</button>
          </div>
        </div>
        <div className="lab-field">
          <label className="inline-label">Villain range</label>
          <select value={villainId} onChange={(e) => onChangeVillain(e.target.value)}>
            <option value="random">🎲 Random villain</option>
            {VILLAINS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
        <div className="lab-field">
          <label className="inline-label">Pot type (SPR)</label>
          <select value={potType} onChange={(e) => onChangePotType(e.target.value as PotType)}>
            {(Object.keys(POT_LABEL) as PotType[]).map((p) => <option key={p} value={p}>{POT_LABEL[p]}</option>)}
          </select>
        </div>
        <div className="lab-field">
          <label className="inline-label">Position</label>
          <div className="pos-toggle">
            <button className={position === 'ip' ? 'active' : ''} onClick={() => onChangePosition('ip')}>In position</button>
            <button className={position === 'oop' ? 'active' : ''} onClick={() => onChangePosition('oop')}>Out of position</button>
            <button className={position === 'random' ? 'active' : ''} onClick={() => onChangePosition('random')}>🎲 Random</button>
          </div>
        </div>
        {mode === 'single' && (
          <div className="lab-field">
            <label className="inline-label">Street</label>
            <select value={street} onChange={(e) => { const st = e.target.value as Street; setStreet(st); newSpot(undefined, st); }}>
              {(Object.keys(STREET_LABEL) as Street[]).map((s) => <option key={s} value={s}>{STREET_LABEL[s]}</option>)}
            </select>
          </div>
        )}
        <div className="lab-field">
          <label className="inline-label">Board texture</label>
          <select value={texture} onChange={(e) => { const tx = e.target.value as TextureFilter; setTexture(tx); if (mode === 'single') newSpot(tx); else setPo((p) => makeStartPlay(tx, potType, p.pos, p.vId)); }}>
            {(Object.keys(TEXTURE_LABELS) as TextureFilter[]).map((t) => <option key={t} value={t}>{TEXTURE_LABELS[t]}</option>)}
          </select>
        </div>
        <div className="lab-field">
          <label className="inline-label">Equity</label>
          <button
            className={`bsd-eqtoggle ${hideEq ? 'on' : ''}`}
            onClick={() => setHideEq((v) => !v)}
            title="Hide the equity-vs-range number before you answer, so you read the board — not the solver. Revealed after."
          >
            {hideEq ? '🙈 Hidden' : '👁 Shown'}
          </button>
        </div>
        <button className="btn btn-deal lab-deal" onClick={() => (mode === 'single' ? newSpot() : newPlay())}>New hand</button>
      </div>

      <div className={`pos-explain ${activePos}`}>
        <b>{activePos === 'ip' ? '▸ In position' : '◂ Out of position'}{position === 'random' ? ' 🎲' : ''}:</b> {POS_EXPLAIN[activePos]}
        {' '}<span className="pe-villain">vs {activeVillain.label}{villainId === 'random' ? ' 🎲' : ''}.</span>
      </div>

      {mode === 'single' ? (
        <SingleMode
          spot={spot}
          strategy={strategy}
          ordered={orderedOptions}
          chosen={chosen}
          revealed={revealed}
          loss={loss}
          prescribed={prescribed}
          bestOpt={bestOpt}
          chosenOpt={chosenOpt}
          potLabel={POT_LABEL[potType]}
          pot={sizing.pot}
          spr={spr}
          posNote={activePos}
          villainLabel={activeVillain.label}
          equityHidden={hideEq && !revealed}
          onPick={(id) => { const l = evLoss(strategy, id); playGrade(l <= 0.04 ? 'good' : l <= 0.4 ? 'ok' : 'bad'); setChosen(id); }}
          onNext={() => newSpot()}
        />
      ) : (
        <PlayoutMode
          po={po}
          strategy={poStrategy}
          ordered={poOrdered}
          potLabel={POT_LABEL[potType]}
          posNote={activePos}
          villainLabel={activeVillain.label}
          equityHidden={hideEq}
          onPick={playPick}
          onNew={newPlay}
        />
      )}
    </div>
  );
}

// ---------------- single decision view ----------------
function SingleMode(props: {
  spot: Spot;
  strategy: ReturnType<typeof solvePostflop>;
  ordered: ReturnType<typeof solvePostflop>['options'];
  chosen: ActionId | null;
  revealed: boolean;
  loss: number;
  prescribed: ActionId;
  bestOpt?: ReturnType<typeof solvePostflop>['options'][number];
  chosenOpt?: ReturnType<typeof solvePostflop>['options'][number] | null;
  potLabel: string;
  pot: number;
  spr: string;
  posNote: Pos;
  villainLabel: string;
  equityHidden: boolean;
  onPick: (id: ActionId) => void;
  onNext: () => void;
}) {
  const { spot, strategy, ordered, chosen, revealed, loss, prescribed, bestOpt, chosenOpt, potLabel, pot, spr, posNote, villainLabel, equityHidden, onPick, onNext } = props;
  const chosenLabel = chosenOpt?.label;
  const bestLabel = bestOpt?.label;
  return (
    <>
      <div className="lab-meta">vs {villainLabel} · {potLabel} · pot {pot} ({(pot / BB).toFixed(1)}bb) · SPR {spr}</div>
      <SpotBoard
        hero={spot.hero}
        board={spot.board}
        handLabel={classifyHandClass(spot.hero, spot.board).label}
        boardTag={<>Board · {describeTexture(spot.board).label}</>}
        equity={strategy.equity ?? 0}
        equityHidden={equityHidden}
        posNote={posNote}
      />

      {!revealed ? (
        <div className="lab-prompt">What's your play? Pick an action to lock it in and see the solution.</div>
      ) : (
        <div className="lab-rng">🎲 RNG <b>{spot.roll}</b> → prescribed <b>{strategy.options.find((o) => o.id === prescribed)?.label ?? prescribed}</b></div>
      )}

      <div className="lab-actions">
        {ordered.map((o) => (
          <button
            key={o.id}
            className={`lab-act ${chosen === o.id ? 'chosen' : ''} ${revealed && o.id === strategy.bestId ? 'is-best' : ''}`}
            onClick={() => !revealed && onPick(o.id)}
          >
            <span className="la-label">{o.label}</span>
            {revealed ? (
              <>
                <span className="la-freq" style={{ color: KIND_COLOR[o.kind ?? 'fold'] }}>{(o.freq * 100).toFixed(0)}%</span>
                <span className={`la-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>{o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb</span>
                <span className="la-bar" style={{ width: `${o.freq * 100}%`, background: KIND_COLOR[o.kind ?? 'fold'] }} />
              </>
            ) : (
              <span className="la-hint">choose</span>
            )}
          </button>
        ))}
      </div>

      {revealed && (
        <>
          <div className="lab-why">
            <div className="lab-why-row">
              <span className="lab-why-tag best">Best · {bestLabel}</span>
              {bestOpt?.why && <p>{bestOpt.why}</p>}
              {actionRule(strategy.bestId, spot.board) && (
                <div className="bsd-rule"><b>💡 Rule:</b> {actionRule(strategy.bestId, spot.board)}</div>
              )}
            </div>
            {chosen !== strategy.bestId && chosenOpt && (
              <div className="lab-why-row">
                <span className="lab-why-tag you">Your pick · {chosenOpt.label}</span>
                {chosenOpt.why && <p>{chosenOpt.why}</p>}
              </div>
            )}
          </div>
          <div className={`lab-feedback ${loss <= 0.04 ? 'good' : loss <= 0.4 ? 'okv' : 'bad'}`}>
            {loss <= 0.04 ? `✓ ${chosenLabel} is on the solver line.` : `You picked ${chosenLabel}. Best was ${bestLabel} — EV loss −${loss.toFixed(2)} bb.`}
            {chosen === prescribed ? ' 🎲 You also matched the RNG branch.' : ` 🎲 RNG said ${strategy.options.find((o) => o.id === prescribed)?.label}.`}
            <button className="btn btn-deal lab-next" onClick={onNext}>Next spot →</button>
          </div>
        </>
      )}
      <p className="note">{strategy.note}</p>
    </>
  );
}

// ---------------- play-it-out view ----------------
function PlayoutMode(props: {
  po: PlayState;
  strategy: ReturnType<typeof solvePostflop> | null;
  ordered: ReturnType<typeof solvePostflop>['options'];
  potLabel: string;
  posNote: Pos;
  villainLabel: string;
  equityHidden: boolean;
  onPick: (id: ActionId) => void;
  onNew: () => void;
}) {
  const { po, strategy, ordered, potLabel, posNote, villainLabel, equityHidden, onPick, onNew } = props;
  const spr = (po.behind / Math.max(1, po.pot)).toFixed(1);
  const grade = po.total <= 0.08 ? 'good' : po.total <= 0.8 ? 'okv' : 'bad';
  const toCall = Math.max(0, po.villCommit - po.heroCommit);
  const need = toCall > 0 ? Math.round((100 * toCall) / (po.pot + toCall)) : 0;
  const resultLine = (() => {
    if (!po.result) return '';
    if (po.result.kind === 'fold')
      return po.result.winner === 'hero' ? 'Villain folded — you take it. ✓' : 'You folded.';
    return po.result.winner === 'hero'
      ? 'Showdown — you win the pot. ✓'
      : po.result.winner === 'villain'
        ? 'Showdown — villain wins.'
        : 'Showdown — split pot.';
  })();
  return (
    <>
      <div className="lab-meta">
        vs {villainLabel} · {potLabel} · {po.street.toUpperCase()} · pot {po.pot} ({(po.pot / BB).toFixed(1)}bb) · your stack {po.behind} · SPR {spr}
      </div>
      <SpotBoard
        hero={po.hero}
        board={po.board}
        handLabel={classifyHandClass(po.hero, po.board).label}
        boardTag={<>Board · {describeTexture(po.board).label}</>}
        equity={strategy ? strategy.equity : null}
        equityHidden={equityHidden && !po.done}
        posNote={posNote}
      />

      {po.log.length > 0 && (
        <div className="play-log">
          {po.log.map((e, i) => (
            <div key={i} className={`play-log-row ${e.loss <= 0.04 ? 'good' : e.loss <= 0.4 ? 'okv' : 'bad'}`}>
              <span className="pl-street">{e.street}</span>
              <span className="pl-act">{e.faced ? `${e.faced} ` : ''}you {e.chosen}{e.chosen !== e.best ? ` · best ${e.best}` : ' ✓'}</span>
              <span className="pl-loss">{e.loss <= 0.04 ? 'on line' : `−${e.loss.toFixed(2)} bb`}</span>
              {e.loss > 0.04 && actionRule(e.bestId, e.board) && <span className="pl-hook">💡 {actionRule(e.bestId, e.board)}</span>}
            </div>
          ))}
        </div>
      )}

      {!po.done && strategy ? (
        <>
          <div className="lab-prompt">
            {toCall > 0 ? (
              <><b>{po.villMsg}</b> You're facing {toCall} into {po.pot} — need {need}% to call. Fold, call, or raise?</>
            ) : (
              <>{po.villMsg ? <b>{po.villMsg} </b> : ''}Your action on the {po.street}{po.villMsg ? '' : " — you're first to act"}.</>
            )}
          </div>
          <div className="lab-actions">
            {ordered.map((o) => (
              <button key={o.id} className="lab-act" onClick={() => onPick(o.id)}>
                <span className="la-label">{o.label}</span>
                <span className="la-hint">choose</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className={`lab-feedback ${grade}`}>
          {po.villMsg && po.result?.kind === 'fold' && po.result.winner === 'hero' ? <><b>{po.villMsg}</b> </> : ''}
          {resultLine} Total EV loss <b>−{po.total.toFixed(2)} bb</b> across {po.log.length} decision{po.log.length === 1 ? '' : 's'}.
          {po.total <= 0.08 ? ' Clean line. ✓' : po.total <= 0.8 ? ' Minor leaks.' : ' Big leaks — review the streets above.'}
          <span className="po-reveal">Villain had <PlayingCard card={po.vHand[0]} size="sm" /> <PlayingCard card={po.vHand[1]} size="sm" /></span>
          <button className="btn btn-deal lab-next" onClick={onNew}>New hand →</button>
        </div>
      )}
      <p className="note">Play-it-out models a full hand: you AND the villain bet, raise, call &amp; fold. Your decisions are graded by the solver (EV loss); the villain follows a transparent range-strength heuristic (bets strong, bluffs some, defends by pot odds) — realistic reps, not a Nash solve.</p>
    </>
  );
}
