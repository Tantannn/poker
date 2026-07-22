// Trap-the-Aggressor drill. The app's one anti-aggression rep: you hold a
// near-nut hand and it's checked to you OUT OF POSITION against an opponent who
// bets when checked to (maniac / LAG). Leading folds out the bluffs that ARE
// your profit and only builds the pot with hands that beat nothing you fear;
// CHECKING hands the aggressor the lead so he barrels his air, and you
// check-raise / check-call to win more than a bet ever could. Protection is
// moot — the deal is gated to near-unbeatable hands, so a free card can't hurt.
//
// This is the concentrated version of the spew+strong branch the Read & Exploit
// trainer grades at random (~1 spot in 20); here EVERY spot is the trap, so the
// student drills the single skill. Graded on picking the trap (check); the
// reveal shows the solver's static line + EVs so any divergence is visible.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { classifyHandClass } from '../strategy/handClass';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { getProfile } from '../ai/profiles';
import { playGrade } from '../sound';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys } from '../hooks/useDrillKeys';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

const BB = 2;
// A wide opening range stands in for the aggressor's loose holdings — same range
// the Read & Exploit trainer uses, so equity reads can't drift between the two.
const VILLAIN = rangeFromSet(RFI_RANGES.BTN);

// Only aggressors belong here — the trap needs an opponent who BETS when checked
// to. A station / nit won't bet for you, so checking them just skips value.
const TRAPPABLE = ['maniac', 'lag'];

const ACTION_ORDER: ActionId[] = ['check', 'bet33', 'bet50', 'bet75', 'betpot', 'allin'];
const orderRank = (id: ActionId) => { const i = ACTION_ORDER.indexOf(id); return i < 0 ? 99 : i; };
const KIND_COLOR: Record<string, string> = { value: '#2ec27e', bluff: '#e0843a', passive: '#3aa0e0', aggressive: '#2ec27e' };

function randCard(): Card { return { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) }; }
function dealHero(): Card[] {
  const a = randCard();
  let b: Card;
  do { b = randCard(); } while (b.rank === a.rank && b.suit === a.suit);
  return [a, b];
}

interface Spot {
  hero: Card[];
  board: Card[];
  strategy: NodeStrategy;
  handLabel: string;
  equity: number;
}

// Deal a near-nut hand (straight / flush / set / full+), checked to hero OOP.
// Reject until it's genuinely near-unbeatable (equity ≥ 0.88) so protection is
// moot and the trap is unambiguous — no "bet to charge the draw" grey area. The
// first strength-passing deal is kept as a fallback in case the equity gate is
// never cleared inside the loop (astronomically unlikely at this bar).
function genSpot(): Spot {
  const pot = 12;
  let fallback: Spot | null = null;
  for (let i = 0; i < 200; i++) {
    const hero = dealHero();
    let board = randomFlop('any', hero);
    if (Math.random() < 0.5) board = [...board, randomCard([...hero, ...board])]; // sometimes a turn
    const cls = classifyHandClass(hero, board);
    if (cls.strength < 4) continue; // straight / flush / set / full+ only
    const strategy = solvePostflop({
      hero, board, oppRange: VILLAIN,
      pot, toCall: 0, heroCommitted: 0, currentBet: 0,
      minRaiseTo: BB, maxRaiseTo: 188, canCheck: true, canRaise: true,
      bigBlind: BB, iterations: 1600, rangeNote: 'aggressor range',
    });
    const equity = strategy.equity ?? 0;
    const spot: Spot = { hero, board, strategy, handLabel: cls.label, equity };
    if (equity >= 0.88) return spot; // near-unbeatable → a clean trap
    if (!fallback) fallback = spot;
  }
  // Fallback: the best strength-passing deal we saw, or one last forced deal.
  if (fallback) return fallback;
  const hero = dealHero();
  const board = randomFlop('any', hero);
  const strategy = solvePostflop({
    hero, board, oppRange: VILLAIN,
    pot, toCall: 0, heroCommitted: 0, currentBet: 0,
    minRaiseTo: BB, maxRaiseTo: 188, canCheck: true, canRaise: true,
    bigBlind: BB, iterations: 1600, rangeNote: 'aggressor range',
  });
  return { hero, board, strategy, handLabel: classifyHandClass(hero, board).label, equity: strategy.equity ?? 0 };
}

// First spot at module load — React forbids impure Math.random in render.
const FIRST_SPOT = genSpot();

export function TrapDrill() {
  const [profileId, setProfileId] = useState<string>('maniac');
  const profile = getProfile(profileId);
  const [spot, setSpot] = useState<Spot>(FIRST_SPOT);
  const [pick, setPick] = useState<ActionId | null>(null);
  const [score, setScore] = useState(() => loadDrillScore('trap-maniac'));

  const revealed = pick != null;
  const best = spot.strategy.options.find((o) => o.id === spot.strategy.bestId);
  const ordered = useMemo(
    () => [...spot.strategy.options].sort((a, b) => orderRank(a.id) - orderRank(b.id)),
    [spot],
  );
  // The trap IS the check. Grading is on finding it — not on matching the solver
  // baseline, whose static model can't see that an aggressor bets for you (vs a
  // leaky bot the exploit is the max-EV line). See [[grader-best-highest-ev]].
  const solverAgrees = spot.strategy.bestId === 'check';

  const next = useCallback(() => { setSpot(genSpot()); setPick(null); }, []);

  const switchProfile = (id: string) => {
    setProfileId(id);
    setScore(loadDrillScore(`trap-${id}`));
    next();
  };

  const choose = (id: ActionId) => {
    if (revealed) return;
    setPick(id);
    const correct = id === 'check';
    setScore(recordDrillScore(`trap-${profileId}`, correct));
    playGrade(correct ? 'good' : 'bad');
  };

  useDrillKeys({
    choices: ordered.length,
    onPick: (i) => choose(ordered[i].id),
    onNext: next,
    revealed,
  });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const correct = revealed && pick === 'check';
  const pickLabel = spot.strategy.options.find((o) => o.id === pick)?.label ?? '—';

  return (
    <div className="card">
      <h2>🪤 Trap the Aggressor</h2>
      <p className="sub">
        You hold a <b>near-nut hand</b> out of position and it's <b>checked to you</b> against an opponent who
        <b> bets when you check</b> (maniac / LAG). The instinct is to bet — but a bet folds out the bluffs that are
        your profit and only builds the pot with the hands that beat nothing you fear. <b>Check</b> and let him barrel
        his air; then check-raise or check-call and win <i>more</i> than a lead ever could. Protection is moot — nothing
        outdraws you here. You're scored on finding the trap.
      </p>

      {/* archetype picker — aggressors only (a passive player won't bet for you) */}
      <div className="quiz-bar">
        <div className="quiz-drills" role="group" aria-label="Opponent archetype">
          {TRAPPABLE.map((id) => (
            <button key={id} className={profileId === id ? 'active' : ''} onClick={() => switchProfile(id)}>
              {getProfile(id).tag}
            </button>
          ))}
        </div>
        <div className="quiz-score">
          Traps found: <b>{score.correct}/{score.total}</b> ({pct}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore(`trap-${profileId}`))} title="Reset this archetype's saved score">
              ↺
            </button>
          )}
        </div>
      </div>

      <div className="et-arch">
        <span className={`opp-tag tag-${profile.tag.toLowerCase()}`}>{profile.tag}</span>
        <b>{profile.name}</b> — {profile.blurb}
      </div>

      {/* board (equity hidden until reveal — read the hand, don't lean on the number) */}
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
          {revealed
            ? <><div className="big-stat gold">{(spot.equity * 100).toFixed(1)}%</div><div className="stat-lbl">equity vs range</div></>
            : <><div className="big-stat dim">?? %</div><div className="stat-lbl">near-nut — read it</div></>}
        </div>
      </div>

      <div className="lab-prompt">
        Out of position, <b>checked to you</b> vs {profile.name}. Bet, or check and trap?
      </div>

      {/* choices — check is the trap; the bets are the mistake to expose */}
      <div className="lab-actions">
        {ordered.map((o) => (
          <button
            key={o.id}
            className={`lab-act ${pick === o.id ? 'chosen' : ''} ${revealed && o.id === spot.strategy.bestId ? 'is-best' : ''} ${revealed && o.id === 'check' ? 'is-exploit' : ''}`}
            onClick={() => choose(o.id)}
          >
            <span className="la-label">{o.label}</span>
            {revealed ? (
              <>
                <span className="la-freq" style={{ color: KIND_COLOR[o.kind ?? 'passive'] }}>{(o.freq * 100).toFixed(0)}%</span>
                <span className={`la-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>{o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb</span>
                <span className="la-bar" style={{ width: `${o.freq * 100}%`, background: KIND_COLOR[o.kind ?? 'passive'] }} />
              </>
            ) : (
              <span className="la-hint">choose</span>
            )}
          </button>
        ))}
      </div>

      {revealed && (
        <div className="et-reveal">
          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct
              ? `✓ Trap — you checked and let ${profile.tag} bet for you. His air keeps firing; you check-raise or check-call and stack him for more than a lead could.`
              : `✗ You bet (${pickLabel}). That folds out the bluffs that were your profit and caps your range. Check — ${profile.tag} bets when you check, so hand him the lead.`}
            <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
          </div>

          <div className="et-cols">
            <div className="gp-block">
              <div className="gp-h">GTO baseline</div>
              <p>Solver line: <b>{best?.label}</b>{best?.why ? ` — ${best.why}` : ''}</p>
              {best?.math && <div className="se-math">{best.math}</div>}
            </div>
            <div className="gp-block et-exploit">
              <div className="gp-h">💡 Exploit vs {profile.tag}</div>
              <p><b>Check — trap.</b></p>
              <p className="et-rationale">
                {solverAgrees
                  ? `The solver agrees here — even its static model checks this near-nut hand: a lead folds out worse and gets called only by better. Vs ${profile.tag} the check is worth even more, because he bets his whole air range when you show weakness.`
                  : `The solver's static model says ${best?.label?.toLowerCase()} — but it can't see that ${profile.tag} bets for you. Realized EV: checking lets him barrel his ~${Math.round(profile.bluffFreq * 100)}% air, and you take a bigger pot by check-raising / check-calling than a lead that only folds worse out. That gap is the money.`}
              </p>
            </div>
          </div>

          <p className="et-note">
            Slow-play needs <b>near-nut + an opponent who does the betting for you</b> — both are true here by design.
            On a wet board a bare set still <b>bets</b> (protection beats the trap), and you <b>never</b> slow-play a
            station (they won't bet, so you'd skip a street of value). See the 🎯 Equity anchors → "Slow-play (trap) —
            the 3 green lights."
          </p>
        </div>
      )}
    </div>
  );
}
