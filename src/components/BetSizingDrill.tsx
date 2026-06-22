// Bet-sizing drill — teaches WHEN to bet ⅓ vs ¾ vs pot. The size buttons in the
// game don't explain themselves; this does. A real board + hand is solved, you
// pick a size, and it reveals the solver's EV for every size plus WHY that size
// fits the texture. A persistent cheat-sheet maps texture → size so the rule
// sticks even when you're wrong.

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { classifyHandClass } from '../strategy/handClass';
import { evLoss } from '../strategy/types';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { PlayingCard } from './PlayingCard';

const BB = 2;
const POT = 12;
const VILLAIN = rangeFromSet(RFI_RANGES.BTN);

// the three sizes we drill, in order. all-in is excluded — this is about
// reading texture for a normal bet, not stack-off math.
const SIZES: { id: ActionId; label: string; tag: string; pct: string }[] = [
  { id: 'bet33', label: '⅓ pot', tag: 'Small', pct: '~33%' },
  { id: 'bet75', label: '¾ pot', tag: 'Big', pct: '~75%' },
  { id: 'betpot', label: 'Pot', tag: 'Polar', pct: '100%' },
];
const SIZE_IDS = SIZES.map((s) => s.id);

const KIND_COLOR: Record<string, string> = { value: '#2ec27e', bluff: '#e0843a', passive: '#3aa0e0', aggressive: '#2ec27e', call: '#3aa0e0', fold: '#2a3a31' };

interface Spot { hero: Card[]; board: Card[]; strategy: NodeStrategy; label: string }

function dealHero(): Card[] {
  const a = randomCard([]);
  let b = randomCard([a]);
  while (b.rank === a.rank && b.suit === a.suit) b = randomCard([a]);
  return [a, b];
}

function solve(hero: Card[], board: Card[]): NodeStrategy {
  return solvePostflop({
    hero, board, oppRange: VILLAIN, pot: POT, toCall: 0, heroCommitted: 0, currentBet: 0,
    minRaiseTo: BB, maxRaiseTo: 188, canCheck: true, canRaise: true, bigBlind: BB,
    iterations: 1500, rangeNote: 'BTN range',
  });
}

// Deal + solve until the solver's best line is one of the three bet sizes — so
// the question is always "which size", never "should I even bet".
function genSpot(): Spot {
  for (let a = 0; a < 700; a++) {
    const hero = dealHero();
    let board = randomFlop('any', hero);
    if (Math.random() < 0.45) board = [...board, randomCard([...hero, ...board])];
    const strategy = solve(hero, board);
    if (SIZE_IDS.includes(strategy.bestId)) {
      return { hero, board, strategy, label: classifyHandClass(hero, board).label };
    }
  }
  const hero = dealHero();
  const board = randomFlop('any', hero);
  return { hero, board, strategy: solve(hero, board), label: classifyHandClass(hero, board).label };
}

export function BetSizingDrill() {
  const [spot, setSpot] = useState<Spot>(genSpot);
  const [chosen, setChosen] = useState<ActionId | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });

  const best = spot.strategy.options.find((o) => o.id === spot.strategy.bestId);
  const optById = useMemo(() => {
    const m = new Map<ActionId, NodeStrategy['options'][number]>();
    for (const o of spot.strategy.options) m.set(o.id, o);
    return m;
  }, [spot]);

  const revealed = chosen != null;
  const loss = chosen ? evLoss(spot.strategy, chosen) : 0;
  const good = revealed && loss <= 0.15; // within 0.15bb of best = a fine size
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const street = spot.board.length === 3 ? 'Flop' : 'Turn';

  function pick(id: ActionId) {
    if (revealed) return;
    setChosen(id);
    setScore((s) => ({ correct: s.correct + (evLoss(spot.strategy, id) <= 0.15 ? 1 : 0), total: s.total + 1 }));
  }
  function next() { setSpot(genSpot()); setChosen(null); }

  return (
    <div className="card">
      <h2>Bet-Sizing Drill</h2>
      <p className="sub">
        The game's ⅓ / ¾ / Pot buttons don't tell you which to press. This does. Read the board, pick a
        size, then see the solver's EV for each — and <b>why</b> the texture wants that size.
      </p>

      <div className="quiz-score rd-score">Streak: <b>{score.correct}/{score.total}</b> ({pctScore}%)</div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand · {spot.label}</span>
          <div className="lab-cards">{spot.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">{street} · pot {POT}bb · you're first to act</span>
          <div className="lab-cards">{spot.board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        {spot.strategy.equity != null && (
          <div className="lab-eq">
            <div className="big-stat gold">{(spot.strategy.equity * 100).toFixed(1)}%</div>
            <div className="stat-lbl">equity vs range</div>
          </div>
        )}
      </div>

      {!revealed && <div className="lab-prompt">You're betting — how big?</div>}

      <div className="rd-bands bsd-sizes">
        {SIZES.map((s) => {
          const o = optById.get(s.id);
          const isBest = s.id === spot.strategy.bestId;
          return (
            <button
              key={s.id}
              className={`rd-band ${chosen === s.id ? 'chosen' : ''} ${revealed && isBest ? 'is-best' : ''} ${revealed && chosen === s.id && !isBest && loss > 0.15 ? 'is-wrong' : ''}`}
              onClick={() => pick(s.id)}
            >
              <span className="rd-band-lbl">{s.label}</span>
              <span className="rd-band-sub">{s.tag} · {s.pct}</span>
              {revealed && o && (
                <span className={`la-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>{o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb</span>
              )}
              {revealed && o && (
                <span className="la-bar" style={{ width: `${Math.round(o.freq * 100)}%`, background: KIND_COLOR[o.kind ?? 'value'] }} />
              )}
            </button>
          );
        })}
      </div>

      {revealed && (
        <>
          {best?.why && (
            <div className="lab-why">
              <div className="lab-why-row">
                <span className="lab-why-tag best">Best · {best.label}</span>
                <p>{best.why}</p>
                {best.math && <div className="se-math">{best.math}</div>}
              </div>
            </div>
          )}
          <div className={`lab-feedback ${good ? 'good' : 'bad'}`}>
            {good
              ? `✓ Good size — ${best?.label} is the solver's pick (within 0.15bb).`
              : `✗ Too ${chosen === 'bet33' ? 'small' : 'big'} here. Best was ${best?.label} — EV loss −${loss.toFixed(2)} bb.`}
            <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
          </div>
        </>
      )}

      <div className="bsd-cheat">
        <h4>When each size — the rule</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill small">⅓ Small</span> Dry/static boards (K72r, A84r), range bets, thin value. You bet often, deny little equity, keep worse hands in.</div>
          <div><span className="bsd-pill big">¾ Big</span> Wet/dynamic boards (T98ss, 654), value + draws. Charge their equity, build the pot, polarize.</div>
          <div><span className="bsd-pill polar">Pot</span> You have the nut advantage — strong, polar range. Max value / max fold equity. Also low SPR / commitment spots.</div>
        </div>
        <p className="bsd-note">
          Core idea: <b>size follows board advantage</b>. Range advantage → small &amp; often · nut advantage →
          big &amp; polar · neither → check (not drilled here). Value and bluffs use the <i>same</i> size so
          villain can't tell them apart.
        </p>
      </div>
    </div>
  );
}
