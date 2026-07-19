import { useMemo, useState } from 'react';
import { PlayingCard } from './PlayingCard';
import { makeDeck, shuffle } from '../engine/cards';
import type { Card } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import type { PostflopInput } from '../strategy/postflopModel';
import type { ActionId } from '../strategy/types';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';
import {
  DEFAULT_PLAN,
  FLOP_LABEL,
  POLICY_LABEL,
  isScareCard,
  heroImproved,
  policyActionId,
  type Plan,
  type FlopAction,
  type BarrelPolicy,
} from '../strategy/planCommit';

const DRILL_ID = 'plancommit';
const BB = 1;
const POT_FLOP = 6; // ~single-raised-pot flop, in bb
const START_BEHIND = 100; // effective stack behind on the flop, in bb
const OPP_RANGE = rangeFromSet(RFI_RANGES.CO); // a reasonable single-raised-pot caller

interface Spot {
  hero: Card[];
  flop: Card[];
  turn: Card;
  river: Card;
}

function deal(): Spot {
  const d = shuffle(makeDeck());
  return { hero: [d[0], d[1]], flop: [d[2], d[3], d[4]], turn: d[5], river: d[6] };
}

function heroFirstInput(hero: Card[], board: Card[], pot: number, behind: number): PostflopInput {
  return {
    hero,
    board,
    oppRange: OPP_RANGE,
    pot,
    toCall: 0,
    heroCommitted: 0,
    currentBet: 0,
    minRaiseTo: 1,
    maxRaiseTo: behind, // all-in target (hero started this street having committed 0)
    canCheck: true,
    canRaise: true,
    bigBlind: BB,
    iterations: 800,
    position: 'ip',
    effStack: behind,
  };
}

interface StreetGrade {
  name: string;
  board: Card[];
  trigger?: string; // why the policy fired/checked (turn/river only)
  plannedLabel: string;
  plannedEv: number;
  bestLabel: string;
  bestId: ActionId;
  bestEv: number;
  evLoss: number;
  why?: string;
}

interface Result {
  streets: StreetGrade[];
  totalLoss: number;
  pass: boolean;
}

function gradeStreet(hero: Card[], board: Card[], pot: number, behind: number, plannedId: ActionId, trigger?: string): { grade: StreetGrade; betAmount: number } {
  const strat = solvePostflop(heroFirstInput(hero, board, pot, behind));
  const opts = strat.options;
  const best = opts.reduce((a, b) => (b.ev > a.ev ? b : a), opts[0]);
  // Pot-sized plans can clamp to all-in at low SPR, so the exact id may be absent —
  // fall back to all-in, else the best line, so grading never crashes on a missing id.
  const planned = opts.find((o) => o.id === plannedId) ?? opts.find((o) => o.id === 'allin') ?? best;
  const evLoss = Math.max(0, best.ev - planned.ev);
  const isBet = planned.id.startsWith('bet') || planned.id === 'allin';
  const betAmount = isBet ? Math.min(planned.amount ?? 0, behind) : 0;
  return {
    grade: {
      name: board.length === 3 ? 'Flop' : board.length === 4 ? 'Turn' : 'River',
      board: [...board],
      trigger,
      plannedLabel: planned.label,
      plannedEv: planned.ev,
      bestLabel: best.label,
      bestId: best.id as ActionId,
      bestEv: best.ev,
      evLoss,
      why: best.why,
    },
    betAmount,
  };
}

export function PlanCommitDrill() {
  const [spot, setSpot] = useState<Spot>(() => deal());
  const [plan, setPlan] = useState<Plan>(DEFAULT_PLAN);
  const [result, setResult] = useState<Result | null>(null);
  const [score, setScore] = useState(() => loadDrillScore(DRILL_ID));

  const flopStrat = useMemo(
    () => solvePostflop(heroFirstInput(spot.hero, spot.flop, POT_FLOP, START_BEHIND)),
    [spot],
  );

  const grade = () => {
    const { hero, flop, turn, river } = spot;
    const streets: StreetGrade[] = [];
    let pot = POT_FLOP;
    let behind = START_BEHIND;

    // Flop — the committed concrete action.
    const f = gradeStreet(hero, flop, pot, behind, plan.flop as ActionId);
    streets.push(f.grade);
    if (f.betAmount > 0) {
      pot += 2 * f.betAmount; // villain calls (simplified hero-leads line)
      behind -= f.betAmount;
    }

    // Turn — policy resolves on the actual card.
    const turnBoard = [...flop, turn];
    const tScare = isScareCard(turn, flop);
    const tImproved = heroImproved(hero, flop, turnBoard);
    const tId = policyActionId(plan.turn, { scare: tScare, improved: tImproved });
    const tTrigger = tId === 'check' ? 'no scare card and no improvement → plan checks' : `${tScare ? 'scare card' : ''}${tScare && tImproved ? ' + ' : ''}${tImproved ? 'you improved' : ''} → plan barrels`;
    const t = gradeStreet(hero, turnBoard, pot, behind, tId, tTrigger);
    streets.push(t.grade);
    if (t.betAmount > 0) {
      pot += 2 * t.betAmount;
      behind -= t.betAmount;
    }

    // River — policy resolves on the actual card.
    const riverBoard = [...turnBoard, river];
    const rScare = isScareCard(river, turnBoard);
    const rImproved = heroImproved(hero, turnBoard, riverBoard);
    const rId = policyActionId(plan.river, { scare: rScare, improved: rImproved });
    const rTrigger = rId === 'check' ? 'no scare card and no improvement → plan checks' : `${rScare ? 'scare card' : ''}${rScare && rImproved ? ' + ' : ''}${rImproved ? 'you improved' : ''} → plan barrels`;
    const r = gradeStreet(hero, riverBoard, pot, behind, rId, rTrigger);
    streets.push(r.grade);

    const totalLoss = streets.reduce((a, s) => a + s.evLoss, 0);
    const pass = totalLoss <= 1.0;
    setResult({ streets, totalLoss, pass });
    setScore(recordDrillScore(DRILL_ID, pass));
  };

  const newHand = () => {
    setSpot(deal());
    setResult(null);
  };

  const pct = score.total ? Math.round((score.correct / score.total) * 100) : 0;

  return (
    <div className="card">
      <div className="analytics-head">
        <h2>🗺 Plan the Hand</h2>
        <div className="hr-streak">
          <span>
            Sound plans: <b>{score.correct}</b>/{score.total} ({pct}%)
          </span>
          <button className="btn-small" onClick={() => setScore(resetDrillScore(DRILL_ID))}>
            Reset streak
          </button>
        </div>
      </div>

      <p className="note">
        Commit your whole line on the flop — size now, plus a conditional barrel plan for the turn and river — then
        see how it holds up against the solver on the runout. Real edge is planning ahead, not reacting one card at
        a time.
      </p>

      <div className="hr-board">
        {spot.hero.map((c, i) => (
          <PlayingCard key={`h${i}`} card={c} size="md" />
        ))}
        <span className="pc-sep">on</span>
        {spot.flop.map((c, i) => (
          <PlayingCard key={`f${i}`} card={c} size="md" />
        ))}
        {!result && <span className="sub">turn &amp; river hidden until you commit</span>}
      </div>

      {!result && (
        <div className="pc-plan">
          <label className="pc-field">
            <span>Flop</span>
            <select value={plan.flop} onChange={(e) => setPlan({ ...plan, flop: e.target.value as FlopAction })}>
              {(Object.keys(FLOP_LABEL) as FlopAction[]).map((k) => (
                <option key={k} value={k}>
                  {FLOP_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="pc-field">
            <span>Turn plan</span>
            <select value={plan.turn} onChange={(e) => setPlan({ ...plan, turn: e.target.value as BarrelPolicy })}>
              {(Object.keys(POLICY_LABEL) as BarrelPolicy[]).map((k) => (
                <option key={k} value={k}>
                  {POLICY_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="pc-field">
            <span>River plan</span>
            <select value={plan.river} onChange={(e) => setPlan({ ...plan, river: e.target.value as BarrelPolicy })}>
              {(Object.keys(POLICY_LABEL) as BarrelPolicy[]).map((k) => (
                <option key={k} value={k}>
                  {POLICY_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="hr-controls">
        {!result && (
          <button className="btn primary" onClick={grade}>
            Commit &amp; run it out ▶
          </button>
        )}
        <button className="btn btn-deal" onClick={newHand}>
          New hand ⟳
        </button>
      </div>

      {!result && (
        <p className="note">
          Solver's read on the flop right now: best line is <b>{flopStrat.bestId}</b>. (Don't peek if you want the
          rep — commit your own plan first.)
        </p>
      )}

      {result && (
        <div className="hr-result">
          <div className={`hr-grade ${result.pass ? 'pos' : 'neg'}`}>
            {result.pass ? '✓ Sound plan' : '✗ Leaky plan'} — total EV lost vs the solver line:{' '}
            <b>{result.totalLoss.toFixed(2)} bb</b>
          </div>
          <div className="pc-streets">
            {result.streets.map((s) => (
              <div key={s.name} className={`pc-street ${s.evLoss > 0.5 ? 'leak' : ''}`}>
                <div className="pc-street-head">
                  <span className="pc-street-name">{s.name}</span>
                  <span className="pc-street-cards">
                    {s.board.map((c, i) => (
                      <PlayingCard key={i} card={c} size="sm" />
                    ))}
                  </span>
                </div>
                {s.trigger && <div className="sub pc-trigger">{s.trigger}</div>}
                <div className="pc-street-cmp">
                  <span>
                    You: <b>{s.plannedLabel}</b> ({s.plannedEv.toFixed(2)} bb)
                  </span>
                  <span>
                    Solver: <b>{s.bestLabel}</b> ({s.bestEv.toFixed(2)} bb)
                  </span>
                  <span className={s.evLoss > 0.5 ? 'neg' : 'pos'}>−{s.evLoss.toFixed(2)} bb</span>
                </div>
                {s.evLoss > 0.5 && s.why && <div className="pc-why sub">{s.why}</div>}
              </div>
            ))}
          </div>
          <p className="note">
            The plan is graded street-by-street on this exact runout, assuming villain calls your bets (a
            hero-leads line). Where you lost EV, the solver's reasoning is shown — fold that lesson into your next
            plan.
          </p>
        </div>
      )}
    </div>
  );
}
