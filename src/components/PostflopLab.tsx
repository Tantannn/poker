// Postflop Lab — a training ground.
//  • Single mode: one decision on a chosen street; answer hidden until you pick.
//  • Play-it-out mode: play a spot flop→turn→river vs the model (you bet, villain
//    calls / checks back), graded each street with a cumulative EV-loss score.
// Pot-type (single-raised / 3-bet / 4-bet) sets the pot & effective stack (SPR),
// and position (IP/OOP) shifts equity realisation & fold equity in the model.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard } from '../engine/board';
import type { TextureFilter } from '../engine/board';
import { TEXTURE_LABELS } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import type { WeightedRange } from '../engine/range';
import { RFI_RANGES, BB_DEFEND_RANGE, THREEBET_RANGE } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { evLoss, rngPrescription } from '../strategy/types';
import type { ActionId } from '../strategy/types';
import { PlayingCard } from './PlayingCard';

const BB = 2;
type Street = 'flop' | 'turn' | 'river';
type Pos = 'ip' | 'oop';
type PotType = 'srp' | 'threebet' | 'fourbet';
type Mode = 'single' | 'playout';

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

const ACTION_ORDER: ActionId[] = ['fold', 'check', 'call', 'bet33', 'bet75', 'betpot', 'allin', 'raise', 'open'];
const orderRank = (id: ActionId) => {
  const i = ACTION_ORDER.indexOf(id);
  return i < 0 ? 99 : i;
};

const KIND_COLOR: Record<string, string> = {
  value: '#2ec27e',
  bluff: '#e0843a',
  passive: '#3aa0e0',
  fold: '#2a3a31',
  aggressive: '#2ec27e',
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
}

interface PlayState {
  hero: Card[];
  board: Card[];
  street: Street;
  pot: number;
  behind: number;
  vBehind: number;
  done: boolean;
  log: { street: Street; chosen: string; best: string; loss: number }[];
  total: number;
}

export function PostflopLab() {
  const [mode, setMode] = useState<Mode>('single');
  const [villainId, setVillainId] = useState('btn');
  const [texture, setTexture] = useState<TextureFilter>('any');
  const [street, setStreet] = useState<Street>('flop');
  const [position, setPosition] = useState<Pos>('ip');
  const [potType, setPotType] = useState<PotType>('srp');

  const villain = VILLAINS.find((v) => v.id === villainId) ?? VILLAINS[0];

  // ---------------- single-decision mode ----------------
  const [spot, setSpot] = useState<Spot>(() => ({ hero: dealHero(), board: dealBoard('any', 'flop', []), roll: 1 }));
  const [chosen, setChosen] = useState<ActionId | null>(null);

  const sizing = sizingFor(potType, street);
  const strategy = useMemo(
    () =>
      solvePostflop({
        hero: spot.hero,
        board: spot.board,
        oppRange: villain.range,
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
        rangeNote: villain.label,
        position,
      }),
    [spot, villain, sizing.pot, sizing.behind, position],
  );
  const prescribed = rngPrescription(strategy, spot.roll);
  const newSpot = useCallback(
    (tx?: TextureFilter, st?: Street) => {
      const t = tx ?? texture;
      const s = st ?? street;
      const hero = dealHero();
      setSpot({ hero, board: dealBoard(t, s, hero), roll: Math.floor(Math.random() * 100) + 1 });
      setChosen(null);
    },
    [texture, street],
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
  const startPlay = useCallback((): PlayState => {
    const hero = dealHero();
    return {
      hero,
      board: dealBoard(texture, 'flop', hero),
      street: 'flop',
      pot: POT_BASE[potType],
      behind: BEHIND_BASE[potType],
      vBehind: BEHIND_BASE[potType],
      done: false,
      log: [],
      total: 0,
    };
  }, [texture, potType]);
  const [po, setPo] = useState<PlayState>(startPlay);

  const poStrategy = useMemo(
    () =>
      po.done
        ? null
        : solvePostflop({
            hero: po.hero,
            board: po.board,
            oppRange: villain.range,
            pot: po.pot,
            toCall: 0,
            heroCommitted: 0,
            currentBet: 0,
            minRaiseTo: BB,
            maxRaiseTo: po.behind,
            canCheck: true,
            canRaise: po.behind > BB,
            bigBlind: BB,
            iterations: 2500,
            rangeNote: villain.label,
            position,
          }),
    [po, villain, position],
  );
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
      const bestLabel = poStrategy.options.find((o) => o.id === poStrategy.bestId)?.label ?? '';
      const log = [...po.log, { street: po.street, chosen: opt.label, best: bestLabel, loss: l }];

      let { pot, behind, vBehind, board, street: st } = po;
      let done = false;
      if (opt.amount != null) {
        // hero bets/raises; villain calls the smaller of the bet and their stack
        const a = Math.min(opt.amount, behind);
        const call = Math.min(a, vBehind);
        pot += a + call;
        behind -= a;
        vBehind -= call;
        if (behind <= 0 || vBehind <= 0) {
          while (board.length < 5) board = [...board, randomCard([...po.hero, ...board])];
          done = true; // all-in: run it out
        }
      }
      if (!done) {
        if (st === 'river') done = true;
        else {
          board = [...board, randomCard([...po.hero, ...board])];
          st = st === 'flop' ? 'turn' : 'river';
        }
      }
      setPo({ ...po, board, street: st, pot, behind, vBehind, done, log, total: po.total + l });
    },
    [po, poStrategy],
  );

  const newPlay = useCallback(() => setPo(startPlay()), [startPlay]);

  // ---------------- shared controls ----------------
  const onChangeVillain = (id: string) => { setVillainId(id); setChosen(null); setPo(startPlay()); };
  const onChangePotType = (pt: PotType) => { setPotType(pt); setChosen(null); };
  const onChangePosition = (p: Pos) => { setPosition(p); setChosen(null); };
  const onChangeMode = (m: Mode) => { setMode(m); setChosen(null); setPo(startPlay()); };

  return (
    <div className="card">
      <h2>Postflop Lab — Training</h2>
      <p className="sub">
        Pick a spot, then choose your action <b>before the answer shows</b>. Set pot type (SPR) and your
        position; drill a single decision or <b>play the hand out</b> flop→turn→river vs the model.
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
          <select value={texture} onChange={(e) => { const tx = e.target.value as TextureFilter; setTexture(tx); if (mode === 'single') newSpot(tx); else setPo(startPlay()); }}>
            {(Object.keys(TEXTURE_LABELS) as TextureFilter[]).map((t) => <option key={t} value={t}>{TEXTURE_LABELS[t]}</option>)}
          </select>
        </div>
        <button className="btn btn-deal lab-deal" onClick={() => (mode === 'single' ? newSpot() : newPlay())}>New hand</button>
      </div>

      <div className={`pos-explain ${position}`}>
        <b>{position === 'ip' ? '▸ In position' : '◂ Out of position'}:</b> {POS_EXPLAIN[position]}
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
          onPick={(id) => setChosen(id)}
          onNext={() => newSpot()}
        />
      ) : (
        <PlayoutMode po={po} strategy={poStrategy} ordered={poOrdered} potLabel={POT_LABEL[potType]} onPick={playPick} onNew={newPlay} />
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
  onPick: (id: ActionId) => void;
  onNext: () => void;
}) {
  const { spot, strategy, ordered, chosen, revealed, loss, prescribed, bestOpt, chosenOpt, potLabel, pot, spr, onPick, onNext } = props;
  const chosenLabel = chosenOpt?.label;
  const bestLabel = bestOpt?.label;
  return (
    <>
      <div className="lab-meta">{potLabel} · pot {pot} ({(pot / BB).toFixed(1)}bb) · SPR {spr}</div>
      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand</span>
          <div className="lab-cards">{spot.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">Board</span>
          <div className="lab-cards">{spot.board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-eq">
          <div className="big-stat gold">{((strategy.equity ?? 0) * 100).toFixed(1)}%</div>
          <div className="stat-lbl">equity vs range</div>
        </div>
      </div>

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
              {bestOpt?.math && <div className="se-math">{bestOpt.math}</div>}
            </div>
            {chosen !== strategy.bestId && chosenOpt && (
              <div className="lab-why-row">
                <span className="lab-why-tag you">Your pick · {chosenOpt.label}</span>
                {chosenOpt.why && <p>{chosenOpt.why}</p>}
                {chosenOpt.math && <div className="se-math">{chosenOpt.math}</div>}
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
  onPick: (id: ActionId) => void;
  onNew: () => void;
}) {
  const { po, strategy, ordered, potLabel, onPick, onNew } = props;
  const spr = (po.behind / Math.max(1, po.pot)).toFixed(1);
  const grade = po.total <= 0.08 ? 'good' : po.total <= 0.8 ? 'okv' : 'bad';
  return (
    <>
      <div className="lab-meta">
        {potLabel} · {po.street.toUpperCase()} · pot {po.pot} ({(po.pot / BB).toFixed(1)}bb) · your stack {po.behind} · SPR {spr}
      </div>
      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand</span>
          <div className="lab-cards">{po.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">Board</span>
          <div className="lab-cards">{po.board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-eq">
          <div className="big-stat gold">{((strategy?.equity ?? 0) * 100).toFixed(1)}%</div>
          <div className="stat-lbl">equity vs range</div>
        </div>
      </div>

      {po.log.length > 0 && (
        <div className="play-log">
          {po.log.map((e, i) => (
            <div key={i} className={`play-log-row ${e.loss <= 0.04 ? 'good' : e.loss <= 0.4 ? 'okv' : 'bad'}`}>
              <span className="pl-street">{e.street}</span>
              <span className="pl-act">you {e.chosen}{e.chosen !== e.best ? ` · best ${e.best}` : ' ✓'}</span>
              <span className="pl-loss">{e.loss <= 0.04 ? 'on line' : `−${e.loss.toFixed(2)} bb`}</span>
            </div>
          ))}
        </div>
      )}

      {!po.done && strategy ? (
        <>
          <div className="lab-prompt">Your action on the {po.street} — villain checks to you (calls if you bet).</div>
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
          Hand complete — total EV loss <b>−{po.total.toFixed(2)} bb</b> across {po.log.length} decision{po.log.length === 1 ? '' : 's'}.
          {po.total <= 0.08 ? ' Clean line. ✓' : po.total <= 0.8 ? ' Minor leaks.' : ' Big leaks — review the streets above.'}
          <button className="btn btn-deal lab-next" onClick={onNew}>New hand →</button>
        </div>
      )}
      <p className="note">Play-it-out models you betting and the villain calling/checking back — a value-betting & pot-control drill, not a full solver.</p>
    </>
  );
}
