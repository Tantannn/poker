// Leak-targeted quiz. Reads your REAL leaks (from the session leak-finder) and
// drills postflop spots where the solver genuinely recommends the discipline
// you're leaking — value betting, bluff give-ups, or folding. Each spot is
// re-dealt until the solver's best line matches the drill's goal, so the
// "correct" answer is real solver output, not a script. Tracks a session streak.

import { useCallback, useMemo, useState } from 'react';
import type { useGame } from '../hooks/useGame';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { classifyHandClass } from '../strategy/handClass';
import { evLoss } from '../strategy/types';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { playGrade } from '../sound';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

type G = ReturnType<typeof useGame>;
type DrillId = 'value' | 'bluff' | 'fold';

const BB = 2;
const VILLAIN = rangeFromSet(RFI_RANGES.BTN);

const DRILLS: Record<DrillId, { label: string; leak: string; goal: string; mistake: string }> = {
  value: { label: 'Value betting', leak: 'Too passive (missing value/aggression)', goal: 'Bet your strong hands for value', mistake: 'checking strong hands' },
  bluff: { label: 'Bluff discipline', leak: 'Over-bluffing / spewing', goal: 'Give up when you have no equity', mistake: 'bluffing with air' },
  fold: { label: 'Fold discipline', leak: 'Calling too much (station)', goal: 'Fold when you are beat', mistake: 'calling too light' },
};
// map a leak label to the drill that counters it
const LEAK_TO_DRILL: Record<string, DrillId> = {
  'Too passive (missing value/aggression)': 'value',
  'Over-bluffing / spewing': 'bluff',
  'Calling too much (station)': 'fold',
};
// A richer dedicated tab beats the inline mini-drill for some leaks — route there
// instead of switching the in-quiz drill. Passivity → the Bet-Sizing Drill (when &
// how big to bet, now vs opponent types); over-calling → Blockers (river call/fold/
// bluff-raise). Leaks without a better home fall back to the inline drill above.
const LEAK_TO_TAB: Record<string, { tab: string; label: string }> = {
  'Too passive (missing value/aggression)': { tab: 'sizing', label: 'Bet-Sizing Drill' },
  'Calling too much (station)': { tab: 'blocker', label: 'Blockers' },
  // spew = incoherent bluffs → learn to fire only lines that tell a value story.
  'Over-bluffing / spewing': { tab: 'story', label: 'Betting-Story Trainer' },
};

const KIND_COLOR: Record<string, string> = { value: '#2ec27e', bluff: '#e0843a', passive: '#3aa0e0', fold: '#2a3a31', aggressive: '#2ec27e' };

// fixed action order so the "best" line isn't always the first button (giveaway)
const ACTION_ORDER: ActionId[] = ['fold', 'check', 'call', 'bet33', 'bet50', 'bet75', 'betpot', 'allin', 'raise', 'open'];
const orderRank = (id: ActionId) => { const i = ACTION_ORDER.indexOf(id); return i < 0 ? 99 : i; };

interface Spot {
  hero: Card[];
  board: Card[];
  strategy: NodeStrategy;
  handLabel: string;
}

function randCard(): Card {
  return { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
}
function dealHero(): Card[] {
  const a = randCard();
  let b: Card;
  do { b = randCard(); } while (b.rank === a.rank && b.suit === a.suit);
  return [a, b];
}

/** Deal + solve until the solver's best line matches the drill's goal. */
function genSpot(drill: DrillId): Spot {
  const pot = 12;
  for (let attempt = 0; attempt < 400; attempt++) {
    const hero = dealHero();
    let board = randomFlop('any', hero);
    if (Math.random() < 0.5) board = [...board, randomCard([...hero, ...board])]; // sometimes a turn
    const cls = classifyHandClass(hero, board);

    // cheap pre-filter by hand strength before the (costlier) solve
    if (drill === 'value' && cls.strength < 4) continue;
    if (drill === 'bluff' && cls.strength !== 0) continue;
    if (drill === 'fold' && cls.strength > 2) continue;

    const facingBet = drill === 'fold';
    const villainBet = facingBet ? Math.round(pot * 0.66) : 0;
    const strategy = solvePostflop({
      hero,
      board,
      oppRange: VILLAIN,
      pot: pot + villainBet,
      toCall: villainBet,
      heroCommitted: 0,
      currentBet: villainBet,
      minRaiseTo: BB,
      maxRaiseTo: 188,
      canCheck: !facingBet,
      canRaise: true,
      bigBlind: BB,
      iterations: 1600,
      rangeNote: 'BTN range',
    });
    const best = strategy.bestId;
    const isBet = best === 'bet33' || best === 'bet50' || best === 'bet75' || best === 'betpot' || best === 'allin';
    const matches =
      (drill === 'value' && isBet) || (drill === 'bluff' && best === 'check') || (drill === 'fold' && best === 'fold');
    if (matches) return { hero, board, strategy, handLabel: cls.label };
  }
  // fallback: just return a solved spot (rare)
  const hero = dealHero();
  const board = randomFlop('any', hero);
  const strategy = solvePostflop({
    hero, board, oppRange: VILLAIN, pot, toCall: 0, heroCommitted: 0, currentBet: 0,
    minRaiseTo: BB, maxRaiseTo: 188, canCheck: true, canRaise: true, bigBlind: BB, iterations: 1600, rangeNote: 'BTN range',
  });
  return { hero, board, strategy, handLabel: classifyHandClass(hero, board).label };
}

// First spot generated at module load, not during render (React forbids impure
// Math.random in the render phase / useState initializer). Uses the 'value'
// drill (the suggested-drill default); the first "Next" rerolls to the picked one.
const FIRST_SPOT = genSpot('value');

export function LeakQuiz({ g, onGo }: { g: G; onGo?: (tab: string) => void }) {
  // worst real leak (highest severity, then rate) that maps to a drill
  const ranked = useMemo(
    () => [...g.leaks].filter((l) => l.severity !== 'ok').sort((a, b) => b.rate - a.rate),
    [g.leaks],
  );
  const suggested = useMemo(() => {
    for (const l of ranked) if (LEAK_TO_DRILL[l.label]) return LEAK_TO_DRILL[l.label];
    return 'value' as DrillId;
  }, [ranked]);

  const [drill, setDrill] = useState<DrillId>(suggested);
  const [spot, setSpot] = useState<Spot>(FIRST_SPOT);
  const [chosen, setChosen] = useState<ActionId | null>(null);
  // lifetime score per drill goal, persisted across sessions (store/drillScore).
  const [score, setScore] = useState(() => loadDrillScore(`lq-${suggested}`));

  const next = useCallback((d: DrillId) => { setSpot(genSpot(d)); setChosen(null); }, []);
  const switchDrill = (d: DrillId) => { setDrill(d); setScore(loadDrillScore(`lq-${d}`)); next(d); };

  const revealed = chosen != null;
  const loss = chosen ? evLoss(spot.strategy, chosen) : 0;
  const best = spot.strategy.options.find((o) => o.id === spot.strategy.bestId);
  const ordered = [...spot.strategy.options].sort((a, b) => orderRank(a.id) - orderRank(b.id));

  const pick = (id: ActionId) => {
    if (revealed) return;
    setChosen(id);
    const l = evLoss(spot.strategy, id);
    setScore(recordDrillScore(`lq-${drill}`, l <= 0.1));
    playGrade(l <= 0.1 ? 'good' : l <= 0.5 ? 'ok' : 'bad');
  };

  // keyboard: 1..N picks the Nth action, Space/Enter deals the next spot.
  useDrillKeys({
    choices: ordered.length,
    onPick: (i) => pick(ordered[i].id),
    onNext: () => next(drill),
    revealed,
  });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  return (
    <div className="card">
      <h2>Leak Quiz</h2>
      <p className="sub">
        Targeted reps on the exact discipline you're leaking. Spots are re-dealt until the solver's best
        line really is the goal action — so getting it right means beating your leak.
      </p>

      <div className="leak-list">
        {ranked.length === 0 ? (
          <div className="leak-empty">No strong leaks detected yet — play more hands in <b>Play vs Bots</b> and they'll show here. Meanwhile, drill any skill below.</div>
        ) : (
          ranked.slice(0, 4).map((l) => (
            <div key={l.label} className={`leak-item sev-${l.severity}`}>
              <span className="leak-name">{l.label}</span>
              <span className="leak-rate">{(l.rate * 100).toFixed(0)}% · n={l.sample}</span>
              {LEAK_TO_TAB[l.label] && onGo ? (
                <button className="leak-drill-btn" onClick={() => onGo(LEAK_TO_TAB[l.label].tab)}>
                  Practice · {LEAK_TO_TAB[l.label].label} →
                </button>
              ) : LEAK_TO_DRILL[l.label] ? (
                <button className="leak-drill-btn" onClick={() => switchDrill(LEAK_TO_DRILL[l.label])}>Drill this →</button>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="quiz-bar">
        <div className="quiz-drills">
          {(Object.keys(DRILLS) as DrillId[]).map((d) => (
            <button key={d} className={drill === d ? 'active' : ''} onClick={() => switchDrill(d)}>{DRILLS[d].label}</button>
          ))}
        </div>
        <div className="quiz-score">
          Score: <b>{score.correct}/{score.total}</b> ({pct}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore(`lq-${drill}`))} title="Reset this drill's saved score">↺</button>
          )}
        </div>
      </div>

      <div className="quiz-goal">🎯 Goal: <b>{DRILLS[drill].goal}</b> — avoid {DRILLS[drill].mistake}. <span className="muted">{drillKeysHint(ordered.length)}</span></div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand · {spot.handLabel}</span>
          <div className="lab-cards">{spot.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">Board</span>
          <div className="lab-cards">{spot.board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-eq">
          <div className="big-stat gold">{((spot.strategy.equity ?? 0) * 100).toFixed(1)}%</div>
          <div className="stat-lbl">equity vs range</div>
        </div>
      </div>

      {!revealed && <div className="lab-prompt">{drill === 'fold' ? 'Villain bets. Your move?' : 'First to act. Your move?'}</div>}

      <div className="lab-actions">
        {ordered.map((o) => (
          <button
            key={o.id}
            className={`lab-act ${chosen === o.id ? 'chosen' : ''} ${revealed && o.id === spot.strategy.bestId ? 'is-best' : ''}`}
            onClick={() => pick(o.id)}
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
          {best?.why && (
            <div className="lab-why">
              <div className="lab-why-row">
                <span className="lab-why-tag best">Best · {best.label}</span>
                <p>{best.why}</p>
                {best.math && <div className="se-math">{best.math}</div>}
              </div>
            </div>
          )}
          <div className={`lab-feedback ${loss <= 0.1 ? 'good' : loss <= 0.5 ? 'okv' : 'bad'}`}>
            {loss <= 0.1 ? `✓ Beat the leak — ${best?.label} is the line.` : `✗ That's the leak. Best was ${best?.label} — EV loss −${loss.toFixed(2)} bb.`}
            <button className="btn btn-deal lab-next" onClick={() => next(drill)}>Next spot →</button>
          </div>
        </>
      )}
    </div>
  );
}
