// Mental Game — the off-table module from The Mental Game of Poker, which this
// app had no home for (tilt.ts only *analyses* results after the fact). Three tools:
//   • Warmup   — a pre-session checklist; completing it stamps "warmed up" so a
//                rare, high-pressure session starts deliberate instead of cold.
//   • Profile  — your A-game vs C-game in your own words. Naming your tilt traits
//                is how you catch yourself sliding down the spectrum mid-session.
//   • Triggers — trigger → the logic you inject to stop the spiral (MGOP's core
//                technique). Editable, with common ones one click away.
// State lives in store/mental (one localStorage key, backed up automatically).

import { useState } from 'react';
import {
  loadMental,
  saveMental,
  warmupComplete,
  WARMUP_ITEMS,
  type MentalState,
  type TiltTrigger,
} from '../store/mental';

// suggested trigger→reframe pairs — one click to add, then editable. These are
// the classic tilt spots for a low-volume player who can't "run it out" often.
const SUGGESTED: { trigger: string; reframe: string }[] = [
  { trigger: 'Bad beat', reframe: 'Variance is exactly how weak players pay me. One hand ≠ my edge.' },
  { trigger: 'Lost to a fish', reframe: 'Their bad call is +EV for me over time. I WANT them calling.' },
  { trigger: 'Down a buy-in', reframe: "Chips already in the pot aren't mine. The next decision is independent." },
  { trigger: 'Card-dead / bored', reframe: 'Folding trash IS the correct play. Boredom is not a reason to spew.' },
  { trigger: 'Being needled', reframe: 'My tilt is their only edge. Silence + solid play beats them.' },
];

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function MentalGame() {
  const [state, setState] = useState<MentalState>(() => loadMental());
  const [trigInput, setTrigInput] = useState('');
  const [reframeInput, setReframeInput] = useState('');

  // one setter that persists every change so a reload never loses work.
  function update(next: Partial<MentalState>) {
    setState((prev) => saveMental({ ...prev, ...next }));
  }

  function toggleWarmup(id: string) {
    setState((prev) => {
      const warmup = { ...prev.warmup, [id]: !prev.warmup[id] };
      const nowComplete = WARMUP_ITEMS.every((it) => warmup[it.id]);
      // stamp the time only on the transition into "all ticked".
      const lastWarmupAt = nowComplete && !warmupComplete(prev) ? Date.now() : prev.lastWarmupAt;
      return saveMental({ ...prev, warmup, lastWarmupAt });
    });
  }

  function resetWarmup() {
    update({ warmup: {} });
  }

  function addTrigger(trigger: string, reframe: string) {
    const t = trigger.trim();
    const r = reframe.trim();
    if (!t || !r) return;
    // handler context → Date.now() is fine (not the render phase).
    const entry: TiltTrigger = { id: `t-${Date.now()}`, trigger: t, reframe: r };
    update({ triggers: [...state.triggers, entry] });
    setTrigInput('');
    setReframeInput('');
  }

  function removeTrigger(id: string) {
    update({ triggers: state.triggers.filter((t) => t.id !== id) });
  }

  const done = warmupComplete(state);
  const usedTriggers = new Set(state.triggers.map((t) => t.trigger.toLowerCase()));

  return (
    <div className="card">
      <h2>Mental Game</h2>
      <p className="sub">
        The off-table half of poker. Because you play rarely, each session is high-pressure and you arrive rusty —
        so <b>warm up</b> before you sit, know your <b>A-game vs C-game</b>, and pre-write the <b>logic</b>
        {' '}you'll inject when a trigger hits. Everything here saves locally and rides along in your backup.
      </p>

      {/* ---- warmup ---- */}
      <div className="mg-block">
        <div className="mg-head">
          <h3>🔥 Pre-session warmup</h3>
          {state.lastWarmupAt && <span className="mg-sub">last warmed up {formatAgo(state.lastWarmupAt)}</span>}
        </div>
        <div className="mg-checks">
          {WARMUP_ITEMS.map((it) => (
            <label key={it.id} className={`mg-check ${state.warmup[it.id] ? 'on' : ''}`}>
              <input type="checkbox" checked={!!state.warmup[it.id]} onChange={() => toggleWarmup(it.id)} />
              <span>{it.label}</span>
            </label>
          ))}
        </div>
        <div className={`lab-feedback ${done ? 'good' : 'bad'}`}>
          {done ? '✅ Warmed up — sit down deliberate. Judge decisions, not results.' : 'Tick all five before you sit.'}
          {done && <button className="btn btn-small mg-reset" onClick={resetWarmup}>New session ↺</button>}
        </div>
      </div>

      {/* ---- A/C game profile ---- */}
      <div className="mg-block">
        <h3>🎭 Your A-game vs C-game</h3>
        <p className="note" style={{ marginTop: 0 }}>
          Name them specifically. You can't catch a slide you haven't defined.
        </p>
        <div className="mg-notes">
          <div>
            <label className="mg-label good">A-game — my best self at the table</label>
            <textarea
              value={state.aGame}
              onChange={(e) => update({ aGame: e.target.value })}
              placeholder="e.g. Patient, folding face-up bluffs, value-betting thin, watching villains not my phone, breathing between decisions…"
              rows={4}
            />
          </div>
          <div>
            <label className="mg-label bad">C-game — how I look when I'm tilted</label>
            <textarea
              value={state.cGame}
              onChange={(e) => update({ cGame: e.target.value })}
              placeholder="e.g. Calling to 'see it', bluffing stations, playing fast, chasing losses, needling back, autopilot…"
              rows={4}
            />
          </div>
        </div>
      </div>

      {/* ---- tilt-trigger plan ---- */}
      <div className="mg-block">
        <h3>🧯 Tilt-trigger plan</h3>
        <p className="note" style={{ marginTop: 0 }}>
          For each trigger, pre-write the <b>logic you inject</b> in the moment. Reading it beats trying to
          think straight while tilted.
        </p>

        {state.triggers.length > 0 && (
          <ul className="mg-trigs">
            {state.triggers.map((t) => (
              <li key={t.id} className="mg-trig">
                <div className="mg-trig-body">
                  <span className="mg-trig-when">{t.trigger}</span>
                  <span className="mg-trig-arrow">→</span>
                  <span className="mg-trig-fix">{t.reframe}</span>
                </div>
                <button className="btn-small mg-trig-del" onClick={() => removeTrigger(t.id)} title="Remove">✕</button>
              </li>
            ))}
          </ul>
        )}

        <div className="mg-add">
          <input
            type="text"
            value={trigInput}
            onChange={(e) => setTrigInput(e.target.value)}
            placeholder="Trigger (e.g. bad beat)"
            className="mg-in-trig"
          />
          <input
            type="text"
            value={reframeInput}
            onChange={(e) => setReframeInput(e.target.value)}
            placeholder="The logic I'll inject…"
            className="mg-in-reframe"
            onKeyDown={(e) => { if (e.key === 'Enter') addTrigger(trigInput, reframeInput); }}
          />
          <button className="btn btn-small" onClick={() => addTrigger(trigInput, reframeInput)}>Add</button>
        </div>

        <div className="mg-suggest">
          <span className="note">Quick add:</span>
          {SUGGESTED.filter((s) => !usedTriggers.has(s.trigger.toLowerCase())).map((s) => (
            <button key={s.trigger} className="mg-chip" onClick={() => addTrigger(s.trigger, s.reframe)}>
              + {s.trigger}
            </button>
          ))}
        </div>
      </div>

      {/* ---- reference card ---- */}
      <div className="bsd-cheat">
        <h4>Mental-game essentials</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill small">Results ≠ skill</span> Over 2 sessions/year, money is <b>pure variance</b>. Track EV/decision quality (this app grades it), never your nightly net.</div>
          <div><span className="bsd-pill big">A→C spectrum</span> You don't tilt all at once — you slide. Catch the first C-game tell (playing fast, "just calling") and reset.</div>
          <div><span className="bsd-pill polar">Inject logic</span> Tilt is emotion overriding a known truth. Pre-writing the truth (above) lets you read it when you can't reason.</div>
          <div><span className="bsd-pill check">Have an exit</span> Stop-loss + time limit set BEFORE you sit. Leaving a −EV mental state is +EV. No shame in racking up.</div>
          <div><span className="bsd-pill pos">Breathe & slow down</span> One deep breath before every non-trivial decision. Rushing is the cheapest leak to fix.</div>
          <div><span className="bsd-pill polar">Rusty = simple</span> Low volume means no live reads early. Default to tight-solid, value-heavy, few bluffs until you settle.</div>
        </div>
      </div>
    </div>
  );
}
