// Cold-Fold / Discipline Drill. Targets the exact leak: you sit bored waiting
// for a hand, finally get a strong-LOOKING one, then marry it and act on reflex.
// Two coupled mechanics fight that:
//   • TEMPO GATE — the action buttons stay locked for a few seconds while a
//     marriage checklist is shown, so you physically cannot snap. Acting the
//     instant it unlocks is flagged as a "snap" even when the read is right.
//   • MARRIAGE READ — you hold a real dealt hand (top pair / overpair / set /
//     better). A villain profile + betting line is shown; you choose fold /
//     flat / raise. The graded truth is (villain story shape) × (your hand tier)
//     using the SAME pure reader the live Think-First gate uses (bettingStory)
//     and the SAME 7-card evaluator the table uses — no parallel truth.
// It's a live-play gut trainer (heuristic reads, not a solver), matching how the
// other read drills grade.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../engine/cards';
import { makeDeck, shuffle } from '../engine/cards';
import { evaluateBest, describeHand } from '../engine/evaluator';
import { readVillainStory, type StreetMove, type VillainStory } from '../strategy/bettingStory';
import { modulateStory, tagToType } from '../strategy/storyModulation';
import { PROFILE_LIST } from '../ai/profiles';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys } from '../hooks/useDrillKeys';
import { playGrade } from '../sound';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

type PostStreet = 'flop' | 'turn' | 'river';
const STREETS: PostStreet[] = ['flop', 'turn', 'river'];
type Tier = 'marginal' | 'strong' | 'monster';
type Act = 'fold' | 'call' | 'raise';

// Tempo constants.
const SNAP_MS = 1200; // deciding faster than this = reflex, not a read.
const GATE_KEY = 'poker-discipline-gate';
const GATE_OPTIONS = [0, 3, 5]; // seconds the buttons stay locked (0 = off)

function loadGate(): number {
  try {
    const v = localStorage.getItem(GATE_KEY);
    if (v != null) {
      const n = parseInt(v, 10);
      if (GATE_OPTIONS.includes(n)) return n;
    }
  } catch {
    /* storage blocked */
  }
  return 3;
}
function saveGate(n: number): void {
  try {
    localStorage.setItem(GATE_KEY, String(n));
  } catch {
    /* ignore */
  }
}

// Table pace — three contexts, three failure modes:
//   • instant — pure decision reps, no timing pressure (the app's native speed).
//   • live    — minutes of folding between playable hands; the dead-time boredom
//     is where reckless splashing is born, so you sit through a muck-stream.
//   • online  — no boredom (multi-tabling fills it) but a shot clock + volume push
//     you into auto-pilot insta-clicks, and "call" is the lazy button under the
//     clock. So online runs a COUNTDOWN you must beat: snap-clicking AND letting
//     it time out are both flagged; the win is a real decision inside the clock.
type Pace = 'instant' | 'live' | 'online';
const PACES: Pace[] = ['instant', 'live', 'online'];
const PACE_KEY = 'poker-discipline-pace';
const MUCK_MS = 950; // one folded junk hand roughly per second
const CLOCK_KEY = 'poker-discipline-clock';
const CLOCK_OPTIONS = [15, 20, 30]; // online shot-clock seconds
function loadPace(): Pace {
  try {
    const v = localStorage.getItem(PACE_KEY);
    return PACES.includes(v as Pace) ? (v as Pace) : 'instant';
  } catch {
    return 'instant';
  }
}
function savePace(p: Pace): void {
  try {
    localStorage.setItem(PACE_KEY, p);
  } catch {
    /* ignore */
  }
}
function loadClock(): number {
  try {
    const n = parseInt(localStorage.getItem(CLOCK_KEY) ?? '', 10);
    if (CLOCK_OPTIONS.includes(n)) return n;
  } catch {
    /* ignore */
  }
  return 20;
}
function saveClock(n: number): void {
  try {
    localStorage.setItem(CLOCK_KEY, String(n));
  } catch {
    /* ignore */
  }
}
// A throwaway two-card hand to muck while you wait. Not a playable open, just
// texture — realism enough to feel the fold-fest tick by.
function dealJunk(rng: () => number = Math.random): Card[] {
  return shuffle(makeDeck(), rng).slice(0, 2);
}
const WAIT_TIPS = [
  'Dead time is data time — watch the players who are NOT in the hand.',
  'Note stacks and who just tilted. You fold cards; you never fold attention.',
  "You're not owed a hand. Fold, breathe, wait for YOUR spot.",
  'Boredom is the leak setting its trap. Stay in your seat mentally.',
];

// ── Villain line synthesis (mirrors the Betting-Story trainer's patterns, minus
// the 'none' shape). Build a line from a pattern, then let the pure reader label
// it — the reader is the source of truth, so the shown story is self-consistent.
type Spec = [StreetMove['kind'], number, number];
const VILLAIN_PATTERNS: Record<2 | 3, Record<'value' | 'polar' | 'bluffy', Spec[][]>> = {
  2: {
    value: [[['bet', 0.5, 0.6], ['bet', 0.65, 0.8]]],
    polar: [[['check', 0, 0], ['bet', 0.95, 1.3]], [['bet', 0.45, 0.6], ['raise', 0.6, 0.9]]],
    bluffy: [[['check', 0, 0], ['bet', 0.2, 0.32]], [['bet', 0.45, 0.6], ['check', 0, 0]]],
  },
  3: {
    value: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['bet', 0.72, 0.9]]],
    polar: [[['check', 0, 0], ['check', 0, 0], ['bet', 1.0, 1.4]], [['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['raise', 0.7, 1.0]]],
    bluffy: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['check', 0, 0]], [['check', 0, 0], ['check', 0, 0], ['bet', 0.2, 0.35]]],
  },
};

const pick = <T,>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];
const fr = (lo: number, hi: number, rng: () => number): number => lo + rng() * (hi - lo);

function buildLine(specs: Spec[], rng: () => number): StreetMove[] {
  const line: StreetMove[] = STREETS.map((s) => ({ street: s, kind: 'none', frac: 0 }));
  specs.forEach(([kind, lo, hi], i) => {
    line[i] = { street: STREETS[i], kind, frac: kind === 'bet' || kind === 'raise' ? fr(lo, hi, rng) : 0 };
  });
  return line;
}

// ── Hero hand tier. Classify the REAL evaluated hand relative to the board so
// "strong-looking but beatable" (one pair) is separated from a genuine bluff-
// catcher (two pair / set) and a hand that's ahead of the value range (straight+).
function classify(hole: Card[], board: Card[]): Tier | 'weak' {
  const res = evaluateBest(hole, board);
  const r = res.categoryRank;
  if (r >= 4) return 'monster'; // straight, flush, full+, quads, SF
  if (r === 2 || r === 3) return 'strong'; // two pair / set
  if (r === 1) {
    const maxBoard = Math.max(...board.map((c) => c.rank));
    // top pair or overpair only — a low/second pair isn't the "looks strong" trap.
    return res.tiebreakers[0] >= maxBoard ? 'marginal' : 'weak';
  }
  return 'weak';
}

// ── The graded truth: what the disciplined line is, given (story × tier).
// Tuned for the PASSIVE-MARRIAGE leak: with a good hand, a flat call is almost
// always the worst of the three — it neither wins value/denies equity (raise)
// nor cuts losses (fold). So CALL is correct in exactly ONE spot — the polar
// bluff-catch — and everywhere else the disciplined line is raise or fold.
// Every lesson names the flat when the flat is the trap.
function decide(story: VillainStory, tier: Tier): { act: Act; lesson: string } {
  if (story === 'value') {
    if (tier === 'marginal')
      return { act: 'fold', lesson: 'A believable multi-street value line beats top pair / overpair far more than it bluffs. Flatting here is the leak — you just pay him off one street at a time. Fold and move on; do NOT call to "see one more".' };
    if (tier === 'strong')
      return { act: 'raise', lesson: "Two pair / a set is a RAISE, not a call. Flatting lets draws peel free and lets him check back the river you'd have charged — you leave value and give up protection. Get the money in while you're ahead." };
    return { act: 'raise', lesson: "You're ahead of his value range. Raise for value — flatting a monster to 'trap' just freezes the pot small and lets scare cards kill your action." };
  }
  if (story === 'polar') {
    if (tier === 'marginal')
      return { act: 'fold', lesson: 'A raise / big delayed fire is nuts-or-bluff and you block none of his nuts with one pair. You beat only the bluffs — calling every jam bleeds chips. Fold.' };
    if (tier === 'strong')
      return { act: 'call', lesson: 'THIS is the one spot a call beats a raise: against a polarized range you crush the bluffs and raising only folds them out (he continues just with the nuts). Flat and catch. Learn this exception so calling stays rare, not automatic.' };
    return { act: 'raise', lesson: 'You beat his value too, so raise for max value — his bluffs stay in and pay you. No reason to just call the nuts.' };
  }
  // bluffy / capped — weak range, so BET/RAISE, don't flat and let him off.
  if (tier === 'marginal')
    return { act: 'raise', lesson: "He's capped / gave up — a flat lets him check behind and realize free equity. Turn your pair into a bet/raise for thin value and to deny his outs. Passive-calling a weak range wins the least." };
  if (tier === 'strong')
    return { act: 'raise', lesson: 'You crush a capped range — RAISE for value. Flatting only wins his one stab; raising lets his weak calls and floats pay you off. This is the money you leave behind by calling.' };
  return { act: 'raise', lesson: 'Capped villain and you have it — bet/raise thin for value. He can still call with the weak range he just repped.' };
}

interface Spot {
  revealed: 2 | 3;
  pendingStreet: PostStreet;
  board: Card[];
  hole: Card[];
  handName: string;
  tier: Tier;
  line: StreetMove[];
  story: VillainStory;
  why: string;
  profileTag: string;
  profileName: string;
  readId: string;
  opps: number;
  decision: { act: Act; lesson: string };
}

function genSpot(rng: () => number = Math.random): Spot {
  const revealed: 2 | 3 = rng() < 0.6 ? 3 : 2;
  const pendingStreet = STREETS[revealed - 1];

  // Villain line + its reader verdict (the graded story truth).
  const target = pick(['value', 'polar', 'bluffy'] as const, rng);
  const line = buildLine(pick(VILLAIN_PATTERNS[revealed][target], rng), rng);
  const v = readVillainStory(line, revealed);
  const story: VillainStory = v.read === 'none' ? 'value' : v.read; // patterns avoid 'none'; guard anyway

  // Deal a real board + hero hand; reject until hero holds a strong-LOOKING hand
  // (the leak scenario). Evaluate honestly — the shown tier is the real hand.
  const N = revealed + 2;
  let board: Card[] = [];
  let hole: Card[] = [];
  let tier: Tier | 'weak' = 'weak';
  for (let i = 0; i < 300; i++) {
    const d = shuffle(makeDeck(), rng);
    const b = d.slice(0, N);
    const h = d.slice(N, N + 2);
    const t = classify(h, b);
    if (t === 'weak') continue;
    board = b;
    hole = h;
    tier = t;
    break;
  }
  if (tier === 'weak') {
    // Astronomically unlikely fallback: keep the last deal, treat as marginal.
    const d = shuffle(makeDeck(), rng);
    board = d.slice(0, N);
    hole = d.slice(N, N + 2);
    tier = 'marginal';
  }

  const handName = describeHand(evaluateBest(hole, board));
  const profile = pick(PROFILE_LIST, rng);
  const opps = rng() < 0.3 ? (rng() < 0.5 ? 2 : 3) : 1;

  return {
    revealed,
    pendingStreet,
    board,
    hole,
    handName,
    tier: tier as Tier,
    line,
    story,
    why: v.why,
    profileTag: profile.tag,
    profileName: profile.name,
    readId: tagToType(profile.tag),
    opps,
    decision: decide(story, tier as Tier),
  };
}

// First spot at module load — React forbids impure Math.random in render.
const FIRST = genSpot();

const TIER_META: Record<Tier, { emoji: string; label: string }> = {
  marginal: { emoji: '⚠', label: 'One pair — strong-looking, thin. Fold or bet, not flat' },
  strong: { emoji: '💪', label: 'Two pair / set — raise for value, not a call' },
  monster: { emoji: '🚀', label: 'Straight+ — you have it, get money in' },
};

interface Choice {
  id: Act;
  label: string;
  hint: string;
}
const CHOICES: Choice[] = [
  { id: 'fold', label: 'Fold', hint: 'Beat — cut it. Do not call to "see one more".' },
  { id: 'call', label: 'Call / flat', hint: 'Rarely right — only the polar bluff-catch.' },
  { id: 'raise', label: 'Raise / commit', hint: 'Value + protection — make him pay or fold.' },
];

function moveText(m: StreetMove): string {
  switch (m.kind) {
    case 'bet':
      return `bets ${Math.round(m.frac * 100)}% pot`;
    case 'raise':
      return 'raises';
    case 'call':
      return 'calls';
    case 'check':
      return 'checks';
    default:
      return '—';
  }
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function DisciplineDrill() {
  const [spot, setSpot] = useState<Spot>(FIRST);
  const [pickId, setPickId] = useState<Act | null>(null);
  const [gate, setGate] = useState<number>(loadGate);
  const [unlockAt, setUnlockAt] = useState<number>(() => {
    const g = loadGate();
    return g > 0 ? Date.now() + g * 1000 : Date.now();
  });
  const [now, setNow] = useState<number>(() => Date.now());
  const [reaction, setReaction] = useState(0);
  const [snapped, setSnapped] = useState(false);
  const [score, setScore] = useState(() => loadDrillScore('discipline'));
  const [snaps, setSnaps] = useState(0);
  // Live-pace / dead-time state.
  const [pace, setPace] = useState<Pace>(loadPace);
  const [waiting, setWaiting] = useState(false);
  const [waitCount, setWaitCount] = useState(0); // hands mucked in THIS wait
  const [waitTarget, setWaitTarget] = useState(0); // hidden — you don't know when your hand comes
  const [muck, setMuck] = useState<Card[]>([]);
  const [lastWait, setLastWait] = useState(0); // hands folded before the current spot
  const [folded, setFolded] = useState(0); // cumulative this session
  const [longest, setLongest] = useState(0);
  const waitRef = useRef(0); // live muck counter for the async timer tick
  // Online-pace / shot-clock state.
  const [clockSecs, setClockSecs] = useState<number>(loadClock);
  const [deadline, setDeadline] = useState<number>(0); // online: act-by timestamp
  const [timedOut, setTimedOut] = useState(false);

  const revealed = pickId !== null;
  // A min-pause lock applies to instant/live; online uses a shot clock instead.
  const locked = !revealed && !waiting && pace !== 'online' && gate > 0 && now < unlockAt;

  // Tick for the instant/live min-pause countdown.
  useEffect(() => {
    if (revealed || waiting || pace === 'online' || gate <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(id);
  }, [revealed, waiting, pace, gate, unlockAt]);

  // Arm a fresh graded spot (after the wait in live pace, or immediately).
  const startSpot = useCallback(() => {
    const t = Date.now();
    setSpot(genSpot());
    setPickId(null);
    setReaction(0);
    setSnapped(false);
    setTimedOut(false);
    if (pace === 'online') {
      setUnlockAt(t); // no floor online — insta-clicking IS the leak to expose
      setDeadline(t + clockSecs * 1000);
    } else {
      setUnlockAt(gate > 0 ? t + gate * 1000 : t);
      setDeadline(0);
    }
    setNow(t);
  }, [gate, pace, clockSecs]);

  // Begin the dead-time muck-stream (live pace only). Target is random and
  // hidden so the wait feels open-ended, like a real table.
  const beginWait = useCallback(() => {
    waitRef.current = 0;
    setWaitCount(0);
    setWaitTarget(5 + Math.floor(Math.random() * 12)); // 5–16 junk hands
    setMuck(dealJunk());
    setWaiting(true);
  }, []);

  const next = useCallback(() => {
    if (pace === 'live') beginWait();
    else {
      setLastWait(0);
      startSpot();
    }
  }, [pace, beginWait, startSpot]);

  // Leave the wait: bank the fold count and arm the playable spot.
  const endWait = useCallback(() => {
    const n = waitRef.current;
    setFolded((f) => f + n);
    setLongest((w) => Math.max(w, n));
    setLastWait(n);
    setWaiting(false);
    startSpot();
  }, [startSpot]);

  // Drive the muck-stream off a timer (the "external system"): one folded hand
  // per MUCK_MS, and when the hidden target is hit the playable hand arrives.
  // A ref carries the count so the async tick sets state plainly (no cascade).
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => {
      const n = waitRef.current + 1;
      waitRef.current = n;
      if (n >= waitTarget) {
        clearInterval(id);
        endWait();
      } else {
        setWaitCount(n);
        setMuck(dealJunk());
      }
    }, MUCK_MS);
    return () => clearInterval(id);
  }, [waiting, waitTarget, endWait]);

  const skipWait = useCallback(() => endWait(), [endWait]);

  const changePace = useCallback((p: Pace) => {
    setPace(p);
    savePace(p);
  }, []);

  const changeClock = useCallback((n: number) => {
    setClockSecs(n);
    saveClock(n);
  }, []);

  const changeGate = useCallback(
    (g: number) => {
      setGate(g);
      saveGate(g);
      if (!revealed) {
        const t = Date.now();
        setUnlockAt(g > 0 ? t + g * 1000 : t);
        setNow(t);
      }
    },
    [revealed],
  );

  const choose = useCallback(
    (id: Act) => {
      if (revealed || locked || waiting) return;
      const react = Math.max(0, Date.now() - unlockAt); // time since you were allowed to act
      const snap = react < SNAP_MS;
      setReaction(react);
      setSnapped(snap);
      if (snap) setSnaps((s) => s + 1);
      setPickId(id);
      const correct = id === spot.decision.act;
      setScore(recordDrillScore('discipline', correct));
      playGrade(correct ? 'good' : 'bad');
    },
    [revealed, locked, waiting, unlockAt, spot],
  );

  // Online shot clock: tick down, and auto-fold when it expires. Letting the
  // clock run out online mucks the hand AND leaks info (away / weak) — a fail
  // mode of its own, distinct from a snap.
  const timeoutFold = useCallback(() => {
    if (revealed || waiting) return;
    setReaction(clockSecs * 1000);
    setSnapped(false);
    setTimedOut(true);
    setPickId('fold');
    const correct = spot.decision.act === 'fold';
    setScore(recordDrillScore('discipline', correct));
    playGrade(correct ? 'good' : 'bad');
  }, [revealed, waiting, clockSecs, spot]);

  useEffect(() => {
    if (pace !== 'online' || revealed || waiting || deadline <= 0) return;
    const id = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(id);
        timeoutFold();
      } else {
        setNow(Date.now());
      }
    }, 150);
    return () => clearInterval(id);
  }, [pace, revealed, waiting, deadline, timeoutFold]);

  useDrillKeys({
    choices: CHOICES.length,
    onPick: (i) => choose(CHOICES[i].id),
    onNext: next,
    revealed,
    enabled: !waiting,
  });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const correct = revealed && pickId === spot.decision.act;
  const shownMoves = useMemo(
    () => spot.line.slice(0, spot.revealed).filter((m) => m.kind !== 'none'),
    [spot],
  );
  const countdown = Math.max(0, Math.ceil((unlockAt - now) / 1000));
  const clockLeft = Math.max(0, (deadline - now) / 1000); // online seconds remaining
  const clockPct = deadline > 0 ? Math.max(0, Math.min(100, (clockLeft / clockSecs) * 100)) : 0;
  const onlineLive = pace === 'online' && !revealed && !waiting;
  const answerLabel = CHOICES.find((c) => c.id === spot.decision.act)?.label ?? '';

  return (
    <div className="card">
      <h2>🧊 Cold-Fold Discipline</h2>
      <p className="sub">
        Your leak: you marry a good hand and just <em>call</em> it down — never raising, rarely folding. But a flat
        is usually the worst of the three: it wins no value and cuts no losses. Here you hold a real strong hand
        and face a line — the disciplined answer is almost always <b>raise or fold</b>. Calling is right in exactly
        one spot (the polar bluff-catch); pick it wrong and the drill calls out the flat. Graded by the same story
        reader &amp; hand evaluator the live table uses.
      </p>
      <p className="sub cf-pace-note">
        Pick the pace that matches where you leak: <b>Instant</b> = pure reps · <b>Live</b> = sit through the
        boredom, then execute · <b>Online</b> = beat a shot clock without auto-pilot insta-clicking.
      </p>

      <div className="quiz-bar">
        {pace === 'online' ? (
          <div className="quiz-drills" role="group" aria-label="Shot clock length">
            <span className="cf-gate-lbl">Shot clock:</span>
            {CLOCK_OPTIONS.map((c) => (
              <button key={c} className={clockSecs === c ? 'active' : ''} onClick={() => changeClock(c)} disabled={waiting}>
                {c}s
              </button>
            ))}
          </div>
        ) : (
          <div className="quiz-drills" role="group" aria-label="Force a pause before acting">
            <span className="cf-gate-lbl">Force pause:</span>
            {GATE_OPTIONS.map((g) => (
              <button key={g} className={gate === g ? 'active' : ''} onClick={() => changeGate(g)} disabled={waiting}>
                {g === 0 ? 'Off' : `${g}s`}
              </button>
            ))}
          </div>
        )}
        <div className="quiz-drills" role="group" aria-label="Table pace">
          <span className="cf-gate-lbl">Table pace:</span>
          <button className={pace === 'instant' ? 'active' : ''} onClick={() => changePace('instant')} disabled={waiting}>
            Instant
          </button>
          <button className={pace === 'live' ? 'active' : ''} onClick={() => changePace('live')} disabled={waiting} title="Sit through the fold-fest between playable hands, like a real table">
            Live
          </button>
          <button className={pace === 'online' ? 'active' : ''} onClick={() => changePace('online')} disabled={waiting} title="Shot clock + multi-table pressure — beat the clock, don't auto-pilot">
            Online
          </button>
        </div>
        <div className="quiz-score">
          Reads: <b>{score.correct}/{score.total}</b> ({pct}%) · snaps: <b>{snaps}</b>
          {pace === 'live' && <> · folded: <b>{folded}</b> (longest <b>{longest}</b>)</>}
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore('discipline'))} title="Reset saved score">
              ↺
            </button>
          )}
        </div>
      </div>

      {/* dead time — the live-table wait you have to sit through */}
      {waiting && (
        <div className="cf-wait">
          <div className="cf-muck" aria-hidden="true">
            {muck.map((c, i) => (
              <PlayingCard key={i} card={c} size="md" dim />
            ))}
          </div>
          <div className="cf-wait-count">You muck. Folded {waitCount} hand{waitCount === 1 ? '' : 's'} — still waiting for yours…</div>
          <div className="cf-wait-tip">{WAIT_TIPS[waitCount % WAIT_TIPS.length]}</div>
          <button className="btn-small cf-wait-skip" onClick={skipWait}>
            ⏩ Skip the wait (the wait is the rep)
          </button>
        </div>
      )}

      {!waiting && (
      <>


      {/* your hand */}
      <div className="cf-hero">
        <span className="cf-hero-lbl">You hold</span>
        {spot.hole.map((c, i) => (
          <PlayingCard key={i} card={c} size="md" />
        ))}
        <span className="cf-hand">{spot.handName}</span>
        <span className={`cf-tier t-${spot.tier}`}>
          {TIER_META[spot.tier].emoji} {TIER_META[spot.tier].label}
        </span>
      </div>

      {/* board + villain line */}
      <div className="hr-board">
        {spot.board.map((c, i) => (
          <PlayingCard key={i} card={c} size="md" />
        ))}
        <div className="hr-actions">
          {shownMoves.map((m) => (
            <span key={m.street} className={`hr-streetbadge ${m.kind === 'check' || m.kind === 'call' ? 'check' : 'bet'}`}>
              {cap(m.street)}: he {moveText(m)}
            </span>
          ))}
        </div>
      </div>

      <div className="st-context">
        <span className={`opp-tag tag-${spot.profileTag.toLowerCase()}`}>{spot.profileTag}</span>
        <span className="sub">{spot.profileName}</span>
        <span className={`st-way ${spot.opps > 1 ? 'multi' : ''}`}>
          {spot.opps > 1 ? `${spot.opps + 1}-way pot` : 'heads-up'}
        </span>
      </div>

      <div className="lab-prompt">
        {spot.profileTag} {moveText(spot.line[spot.revealed - 1])} the {spot.pendingStreet} into you.
        You have {spot.handName}. Raise, or fold — and only flat if you can justify it.
      </div>

      {/* online shot clock — beat it, but use it; don't insta-click, don't stall out */}
      {onlineLive && (
        <div className={`cf-clock ${clockLeft <= 5 ? 'low' : ''}`}>
          <div className="cf-clock-row">
            <span className="cf-clock-num">⏱ {clockLeft.toFixed(1)}s</span>
            {clockPct < 55 && <span className="cf-nag">⚠ 2 other tables ticking — decide, don't stall</span>}
          </div>
          <div className="cf-clock-bar">
            <div className="cf-clock-fill" style={{ width: `${clockPct}%` }} />
          </div>
        </div>
      )}

      {/* the pause: checklist you must sit through */}
      {locked ? (
        <div className="cf-lock">
          <div className="cf-count" aria-live="polite">Read… {countdown}s</div>
          <div className="cf-check">
            <div className="gp-h">Before you touch a button</div>
            <ol>
              <li>What hands actually beat me right now? Is calling just paying those off?</li>
              <li>If I'm ahead / he's capped — why am I flatting instead of <em>raising</em> for value + protection?</li>
              <li>"Call" needs a reason a raise and a fold both fail. If I can't name it, it's the leak.</li>
            </ol>
          </div>
        </div>
      ) : (
        !revealed && (
          <p className="sub cf-check-hint">
            Name what beats you and whether his line fits it — <em>then</em> pick.
          </p>
        )
      )}

      {/* choices */}
      <div className="et-reads">
        {CHOICES.map((c) => {
          const isPicked = pickId === c.id;
          const isAnswer = revealed && c.id === spot.decision.act;
          const isWrong = revealed && isPicked && c.id !== spot.decision.act;
          return (
            <button
              key={c.id}
              className={`et-read ${isPicked ? 'picked' : ''} ${isAnswer ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
              onClick={() => choose(c.id)}
              disabled={revealed || locked}
            >
              <span className="et-read-label">{c.label}</span>
              {revealed && <span className="et-read-hint">{c.hint}</span>}
            </button>
          );
        })}
      </div>

      {revealed && (
        <div className="et-reveal">
          <div className={`et-readres ${correct ? 'good' : 'bad'}`}>
            {correct ? '✓ Disciplined.' : `✗ Off — the play is "${answerLabel}".`}
          </div>

          {/* name the leak when the wrong pick was the flat (not a timeout) */}
          {!correct && pickId === 'call' && !timedOut && (
            <div className="cf-tempo snap">
              🪢 There's the flat. You married a good hand and called — the exact leak. This spot wanted a{' '}
              <b>{answerLabel.toLowerCase()}</b>. Calling only feels safe; it wins no value and cuts no losses.
            </div>
          )}

          {/* timing verdict — timeout / snap / good, depending on pace */}
          {timedOut ? (
            <div className="cf-tempo snap">
              ⏰ Timed out — auto-folded. Online, letting the clock run leaks info (away / weak) and mucks a hand you
              hadn't even decided. The clock is thinking time: use it, then act. {!correct && `This one wanted a ${answerLabel.toLowerCase()}.`}
            </div>
          ) : (
            <div className={`cf-tempo ${snapped ? 'snap' : 'ok'}`}>
              {snapped
                ? `⏱ Snap decision (${(reaction / 1000).toFixed(1)}s). ${correct ? 'Right read, wrong tempo — that reflex is exactly what stacks you when the big hand finally comes. Sit on every decision.' : pace === 'online' ? 'Insta-click on auto-pilot — the multi-table reflex. The clock gave you seconds; a good hand deserves a few of them.' : 'You slammed it. Slow down; the pause is where the read happens.'}`
                : `⏱ Good tempo (${(reaction / 1000).toFixed(1)}s) — you took a beat.`}
            </div>
          )}

          {/* boredom verdict — did the long live wait rattle you? */}
          {lastWait > 0 && (
            <div className={`cf-tempo ${correct && !snapped ? 'ok' : 'snap'}`}>
              {correct && !snapped
                ? `😌 You folded ${lastWait} hands, then made a clean decision. That's the discipline live poker actually asks for — the wait didn't rattle you.`
                : `😴 You folded ${lastWait} hands, then this. Live, that's minutes of nothing — exactly where boredom turns into a reckless splash. Sitting present through the wait IS the rep.`}
            </div>
          )}

          <div className="gp-block">
            <div className="gp-h">His story — the line shape</div>
            <p>{spot.why}</p>
          </div>
          <div className="gp-block">
            <div className="gp-h">Your hand — {spot.handName} · {TIER_META[spot.tier].label}</div>
            <p>{spot.decision.lesson}</p>
          </div>
          {spot.readId && (
            <div className="gp-block">
              <div className="gp-h">
                💡 Adjust for {spot.profileTag}
                {spot.opps > 1 ? ` · ${spot.opps + 1}-way` : ''}
              </div>
              <p>{modulateStory(spot.story, spot.readId, spot.opps).note}</p>
            </div>
          )}

          <button className="btn btn-deal" onClick={next}>
            {pace === 'live' ? 'Back to the grind →' : pace === 'online' ? 'Next table →' : 'Next spot →'}
          </button>
        </div>
      )}
      </>
      )}
    </div>
  );
}
