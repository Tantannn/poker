// Tiny WebAudio sound engine — synthesised tones, no asset files, 100% local.
// The AudioContext is created lazily on the first call (which happens inside a
// user gesture: clicking an action button), so browsers allow it to play.

// Decision quality as graded by the strategy engine (see analysis/grade.ts).
type Verdict = 'best' | 'correct' | 'inaccuracy' | 'wrong' | 'blunder';

const KEY = 'poker-trainer-sound-v1';

let ctx: AudioContext | null = null;
let enabled = load();

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(v: boolean): void {
  enabled = v;
  try {
    localStorage.setItem(KEY, v ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  if (v) blip(660, 0.06, 'sine', 0.05); // confirmation tick
}

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** One short note. `when` is an offset in seconds from now. */
function blip(freq: number, dur: number, type: OscillatorType, gain: number, when = 0): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + when;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  // quick attack, smooth decay — avoids clicks
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Soft click when the hero commits an action. */
export function playAction(): void {
  blip(420, 0.05, 'triangle', 0.05);
}

/** Card-riffle-ish tick when a new hand is dealt. */
export function playDeal(): void {
  blip(300, 0.04, 'square', 0.035);
  blip(380, 0.04, 'square', 0.03, 0.05);
}

/** Outcome cue keyed to how good the graded decision was. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function playResult(verdict: Verdict, _evLoss: number): void {
  if (verdict === 'best' || verdict === 'correct') {
    // rising major third — pleasant "on the line"
    blip(660, 0.12, 'sine', 0.06);
    blip(880, 0.16, 'sine', 0.06, 0.1);
  } else if (verdict === 'inaccuracy') {
    // neutral single note — "meh, inaccuracy"
    blip(440, 0.14, 'sine', 0.05);
  } else {
    // descending buzz — "wrong / blunder"
    blip(240, 0.18, 'sawtooth', 0.06);
    blip(170, 0.22, 'sawtooth', 0.06, 0.12);
  }
}
