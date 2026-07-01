// Tilt guard. Tilt = playing emotionally after a swing — chasing losses,
// forcing action, sizing up to "get unstuck". It's the leak the per-decision EV
// grade can't see directly, so we read it from the SHAPE of recent results +
// the quality of recent decisions:
//   1. a fresh big single-hand loss (you just got stacked / punted),
//   2. a losing streak (frustration building),
//   3. a deep drawdown below your session peak (you're "stuck"),
//   4. your decision quality dropping right after the loss (the real tilt tell).
// The fix is never strategic — it's behavioural: stop, breathe, play the NEXT
// hand on its own merits. The cool-off gate in the table enforces the pause.

import type { SessionStats } from '../store/stats';
import { downswing, moveTier } from '../store/stats';

export interface TiltState {
  level: 'high' | 'medium';
  score: number; // 0..100 tilt pressure — drives the meter
  headline: string;
  detail: string;
  signals: string[]; // why we flagged it
  steps: string[]; // grounding checklist — what to actually do
  bigLossBB: number; // worst single recent hand (bb, negative)
  lossStreak: number; // consecutive losing hands right now
  drawdownBuyins: number; // how far below peak, in 100bb buy-ins
  gate: boolean; // true → force a cool-off before the next hand
}

const RECENT_HANDS = 6; // window for "just now" loss + streak
const BIG_LOSS_BB = 35; // a single hand losing ≥ this = a stack-off / punt
const STACKED_BB = 60; // losing ≥ this in one hand always trips high tilt
const STREAK_TRIGGER = 4; // consecutive losing hands before it counts
const RECENT_DECISIONS = 8; // window for the decision-quality (spew) read

/**
 * Read the session's recent results + decisions for tilt pressure. Returns null
 * when you're calm — only surfaces once a real swing or a quality drop shows up.
 */
export function assessTilt(stats: SessionStats): TiltState | null {
  const results = stats.handResults ?? [];
  if (results.length < 2) return null;

  // 1. worst single hand in the recent window (the "just got stacked" signal)
  const recent = results.slice(-RECENT_HANDS);
  const worst = Math.min(0, ...recent);

  // the hand you JUST played. A win relieves the acute chase impulse — the
  // dangerous moment is right after a punt, not after you've dragged a pot — so
  // it caps the alarm below the cool-off gate even if the window still looks rough.
  const lastResult = results[results.length - 1];
  const lastWasWin = lastResult > 0;

  // 2. trailing losing streak
  let lossStreak = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i] < 0) lossStreak++;
    else break;
  }

  // 3. drawdown below session peak
  const ds = downswing(stats);

  // 4. decision quality slipping: error rate over the last N decisions vs the
  //    baseline before them. A spike after a loss is spew — the behavioural tell.
  const decs = stats.decisions ?? [];
  const isError = (d: { evLoss?: number; chosenEv?: number }) => {
    const t = moveTier(d.evLoss ?? 0, d.chosenEv ?? 0);
    return t === 'wrong' || t === 'blunder';
  };
  const recentDecs = decs.slice(-RECENT_DECISIONS);
  const baseDecs = decs.slice(0, -RECENT_DECISIONS);
  const recentErr = recentDecs.length ? recentDecs.filter(isError).length / recentDecs.length : 0;
  const baseErr = baseDecs.length ? baseDecs.filter(isError).length / baseDecs.length : 0;

  let score = 0;
  const signals: string[] = [];

  if (worst <= -BIG_LOSS_BB) {
    score += Math.min(55, (-worst / 100) * 55); // -100bb (full stack) ≈ +55
    signals.push(
      lastWasWin
        ? `You dropped ${(-worst).toFixed(0)} bb in a single hand earlier — still in the window.`
        : `You just dropped ${(-worst).toFixed(0)} bb in a single hand.`,
    );
  }
  if (lossStreak >= STREAK_TRIGGER) {
    score += Math.min(25, (lossStreak - STREAK_TRIGGER + 1) * 8);
    signals.push(`${lossStreak} losing hands in a row.`);
  }
  if (ds.buyins >= 0.75) {
    score += Math.min(20, ds.buyins * 12);
    signals.push(
      `You're ${ds.currentBB.toFixed(0)} bb (${ds.buyins.toFixed(1)} buy-in${ds.buyins >= 1.5 ? 's' : ''}) below your session peak.`,
    );
  }
  if (recentDecs.length >= 4 && recentErr >= 0.3 && recentErr > baseErr + 0.15) {
    score += Math.min(25, (recentErr - baseErr) * 80);
    signals.push(
      `Your error rate jumped to ${Math.round(recentErr * 100)}% on recent decisions (was ${Math.round(baseErr * 100)}%) — quality is slipping.`,
    );
  }

  score = Math.round(Math.min(100, score));

  // a full-stack-ish loss in one hand always means high tilt risk, regardless of
  // the additive score — BUT only when it's the hand you just took. Once you've
  // played on and won a pot, that acute moment has passed, so a stale big loss in
  // the window shouldn't force the alarm.
  const stacked = !lastWasWin && worst <= -STACKED_BB;
  let level: TiltState['level'];
  if (score >= 60 || stacked) level = 'high';
  else if (score >= 30) level = 'medium';
  else return null;

  // A win this hand caps the alarm at 'medium': no 🛑 headline and — since the
  // cool-off gate only fires on 'high' — no forced pause right after dragging a
  // pot. Drawdown is still real, so we keep surfacing it, just calmly.
  if (lastWasWin && level === 'high') level = 'medium';

  const headline =
    level === 'high' ? '🛑 Tilt warning — take a breath before the next hand' : '⚠ Watch your tilt';

  const detail = lastWasWin
    ? `You just won a pot — good. But you're still below your session peak, and right after a win is when players loosen up and give it back. Bank it; keep playing tight.`
    : level === 'high'
      ? `That swing is exactly when players chase losses and spew off another stack. The last result is gone — it can't be won back this hand. Reset before you deal again.`
      : `Pressure is building. Stay deliberate — don't speed up or size up to get even.`;

  const steps = lastWasWin
    ? [
        "Don't let a win loosen you up — keep opening the same range you would cold.",
        'Keep bet sizing standard. One pot back is not a reason to start punting.',
        'Read the solver mix and equity before you act — let the math drive, not relief.',
        "You're still down on the session; bank the win, don't gamble it back.",
      ]
    : [
        'Stand up. 30–60 seconds away from the table resets the impulse.',
        "Last hand's result is sunk — you can't win it back. Play THIS hand on its own merits.",
        "Keep bet sizing standard. Don't fire bigger to force action or get unstuck.",
        'Read the solver mix and equity before you act — let the math drive, not the gut.',
        "If you're only still playing to get even, stop the session. The money doesn't know you're stuck.",
      ];

  return {
    level,
    score,
    headline,
    detail,
    signals,
    steps,
    bigLossBB: worst,
    lossStreak,
    drawdownBuyins: ds.buyins,
    gate: level === 'high',
  };
}
