// Curriculum / learning path — the structure Upswing/RIO give and this app lacked:
// an ordered route through the existing tabs (foundations → preflop → math →
// postflop → exploit/review → mindset) with progress tracking, a "next up"
// pointer, live rep-counts pulled from each drill's saved score, and a rotating
// "focus of the day". Each step's "Go →" switches the app to the relevant tab via
// the onGo prop, so the path drives the whole trainer instead of being a static list.

import { useMemo, useState } from 'react';
import { loadCurriculum, toggleStep, type DoneMap } from '../store/curriculum';
import { loadDrillScore } from '../store/drillScore';

interface Step {
  id: string;
  title: string;
  blurb: string;
  tab: string; // App Tab id to navigate to
  scoreKey?: string; // store/drillScore key, if this step maps to a drill
}
interface Stage {
  name: string;
  icon: string;
  steps: Step[];
}

const PATH: Stage[] = [
  {
    name: 'Foundations',
    icon: '📚',
    steps: [
      { id: 'f-ref', title: 'Read the fundamentals', blurb: 'Positions, ranges, why the preflop aggressor is favoured. The vocabulary everything else uses.', tab: 'reference' },
      { id: 'f-odds', title: 'Pot odds & required equity', blurb: 'The price to continue. Learn the ratio before you learn what beats it.', tab: 'odds' },
      { id: 'f-eq', title: 'Equity vs a range', blurb: 'Estimate your share vs everything villain can hold — the number that actually wins money.', tab: 'eqdrill', scoreKey: 'rangedrill' },
    ],
  },
  {
    name: 'Preflop',
    icon: '🃏',
    steps: [
      { id: 'p-charts', title: 'Memorize opening ranges', blurb: 'Which hands open from each seat. Preflop mistakes compound on every later street.', tab: 'charts' },
      { id: 'p-trainer', title: 'Drill preflop decisions', blurb: 'Open / 3-bet / fold at typing speed until the charts are automatic.', tab: 'trainer' },
    ],
  },
  {
    name: 'The Math',
    icon: '🧮',
    steps: [
      { id: 'm-mdf', title: 'MDF & value:bluff ratios', blurb: 'How much to defend, and the value:bluff mix a bet needs. Pure numbers, drilled to instant.', tab: 'mathdrill', scoreKey: 'math-mdf' },
      { id: 'm-combos', title: 'Combos & blockers', blurb: '6 pairs, 16 unpaired — and how a card in your hand or on the board cuts villain’s combos.', tab: 'mathdrill', scoreKey: 'math-combos' },
      { id: 'm-blocker', title: 'Blocker call/fold/bluff decisions', blurb: 'Beyond counting: do the cards you hold turn this river into a call, a fold, or a bluff-raise?', tab: 'blocker', scoreKey: 'blocker' },
    ],
  },
  {
    name: 'Postflop',
    icon: '🎯',
    steps: [
      { id: 'q-sizing', title: 'Bet sizing by texture', blurb: 'Small on dry, big/polar on wet, check with no edge. The core sizing rule.', tab: 'sizing', scoreKey: 'bsd-sizing' },
      { id: 'q-heatmap', title: 'See the texture map', blurb: 'One hand across every board texture at once — read the pattern the sizing rule produces.', tab: 'heatmap' },
      { id: 'q-lab', title: 'Play full spots', blurb: 'Complete decisions graded by EV, multi-street play. Where the rules meet real spots.', tab: 'lab' },
      { id: 'q-plan', title: 'Plan the whole hand', blurb: 'Commit a flop-to-river line up front, then grade the plan vs the solver on the runout.', tab: 'plan', scoreKey: 'plancommit' },
    ],
  },
  {
    name: 'Exploit & Review',
    icon: '🔍',
    steps: [
      { id: 'e-handread', title: 'Put them on a range', blurb: 'Narrow villain’s range street-by-street from his betting story — the core hand-reading skill.', tab: 'handreading', scoreKey: 'handreading' },
      { id: 'e-tells', title: 'Tells, timing & table image', blurb: 'Read behavioral tells and table image, then pick the exploit. A cluster beats any single tell.', tab: 'tells', scoreKey: 'tells' },
      { id: 'e-exploit', title: 'Read & exploit opponents', blurb: 'Type the villain, then deviate to attack their leak. Where money is actually made.', tab: 'exploit' },
      { id: 'e-quiz', title: 'Find your own leaks', blurb: 'Targeted quiz on the spots people misplay most. Patch the biggest first.', tab: 'quiz' },
      { id: 'e-replay', title: 'Review your hands', blurb: 'After a session, walk your ✗ Wrong decisions. This is where learning compounds.', tab: 'replay' },
    ],
  },
  {
    name: 'Mindset & Bankroll',
    icon: '🧘',
    steps: [
      { id: 'x-mental', title: 'Warm up & plan for tilt', blurb: 'Pre-session checklist, A/C-game, trigger→logic. Vital when you play rarely & high-pressure.', tab: 'mental' },
      { id: 'x-bankroll', title: 'Understand variance', blurb: 'Why 2 sessions/year is pure noise on money — and why you judge decisions, not results.', tab: 'bankroll' },
    ],
  },
];

const ALL_STEPS = PATH.flatMap((s) => s.steps);
// Focus of the day: deterministic rotation. Day number computed once at module
// load (never Date in render). Points at a practice step to give a daily nudge.
const DAY = Math.floor(Date.now() / 86_400_000);
const FOCUS = ALL_STEPS[DAY % ALL_STEPS.length];

export function Curriculum({ onGo }: { onGo: (tab: string) => void }) {
  const [done, setDone] = useState<DoneMap>(() => loadCurriculum());

  const total = ALL_STEPS.length;
  const completed = ALL_STEPS.filter((s) => done[s.id]).length;
  const pct = Math.round((100 * completed) / total);
  // "next up" = first step not yet checked off, in path order.
  const nextUp = useMemo(() => ALL_STEPS.find((s) => !done[s.id]), [done]);

  function repHint(scoreKey?: string): string | null {
    if (!scoreKey) return null;
    const sc = loadDrillScore(scoreKey);
    if (!sc.total) return null;
    return `${sc.correct}/${sc.total} reps · ${Math.round((100 * sc.correct) / sc.total)}%`;
  }

  return (
    <div className="card">
      <h2>Learning Path</h2>
      <p className="sub">
        A route through every tab, in order. Do it top to bottom, or jump to <b>Next up</b>. Each step opens
        the right tab; check it off when it's solid. Progress saves locally.
      </p>

      <div className="cur-progress">
        <div className="cur-bar"><span style={{ width: `${pct}%` }} /></div>
        <span className="cur-pct">{completed}/{total} done ({pct}%)</span>
      </div>

      <div className="cur-highlights">
        {nextUp && (
          <div className="cur-hl next">
            <span className="cur-hl-tag">▶ Next up</span>
            <div className="cur-hl-body">
              <b>{nextUp.title}</b>
              <p>{nextUp.blurb}</p>
            </div>
            <button className="btn btn-deal" onClick={() => onGo(nextUp.tab)}>Go →</button>
          </div>
        )}
        <div className="cur-hl focus">
          <span className="cur-hl-tag">📅 Focus of the day</span>
          <div className="cur-hl-body">
            <b>{FOCUS.title}</b>
            <p>{FOCUS.blurb}</p>
          </div>
          <button className="btn btn-deal" onClick={() => onGo(FOCUS.tab)}>Go →</button>
        </div>
      </div>

      {PATH.map((stage) => {
        const sDone = stage.steps.filter((s) => done[s.id]).length;
        return (
          <div key={stage.name} className="cur-stage">
            <div className="cur-stage-head">
              <span>{stage.icon} {stage.name}</span>
              <span className="cur-stage-count">{sDone}/{stage.steps.length}</span>
            </div>
            <ul className="cur-steps">
              {stage.steps.map((step) => {
                const isDone = !!done[step.id];
                const reps = repHint(step.scoreKey);
                return (
                  <li key={step.id} className={`cur-step ${isDone ? 'done' : ''} ${step.id === nextUp?.id ? 'is-next' : ''}`}>
                    <button
                      className={`cur-check ${isDone ? 'on' : ''}`}
                      onClick={() => setDone((m) => toggleStep(m, step.id))}
                      title={isDone ? 'Mark not done' : 'Mark done'}
                      aria-label={isDone ? 'Mark not done' : 'Mark done'}
                    >
                      {isDone ? '✓' : ''}
                    </button>
                    <div className="cur-step-body">
                      <div className="cur-step-title">
                        {step.title}
                        {reps && <span className="cur-reps">{reps}</span>}
                      </div>
                      <p>{step.blurb}</p>
                    </div>
                    <button className="btn btn-small cur-go" onClick={() => onGo(step.tab)}>Go →</button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
