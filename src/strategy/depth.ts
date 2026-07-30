// STACK-DEPTH ADJUSTMENT for preflop hand values.
//
// The charts (preflopChart.ts + the solverPreflop.json overrides) are built at ~100bb, and
// `pushFold.ts` takes over at ≤15bb. Everything between — a 25bb tournament stack, a 40bb
// short-buy live seat — and everything above ~150bb was reading the 100bb chart unchanged.
// Depth changes which hands are worth playing, and it moves along ONE axis:
//
//   IMPLIED-ODDS hands (small pairs, suited connectors, suited aces) need a deep stack to
//   pay off. Set-mining wants ~15–20× the call behind; a flush draw wants someone to stack
//   off into it. Short, that money isn't there, so those hands lose value.
//
//   HIGH-CARD hands (offsuit broadways, big aces, big pairs) realise their equity by flopping
//   top pair and getting to showdown, which needs no depth at all. Short they GAIN, because
//   the pot gets settled before implied odds matter. Deep they lose the other way: reverse
//   implied odds — AJo wins small pots and loses big ones to the hands that flopped a monster.
//
// So one signed tilt per hand, scaled by how far from 100bb we are, serves both directions.
// This is a teaching-standard approximation of that axis, not depth-specific solver output.
//
// Used by BOTH the trainer (strategy/index.ts shades the charted frequencies) and the bots
// (ai/decide.ts shades preflop strength), so the graded answer still matches how the table
// actually plays — the same requirement that keeps the charts and the bot ranges in sync.

const RANK_ORDER = '23456789TJQKA';
const rankOf = (ch: string) => RANK_ORDER.indexOf(ch) + 2;

/** Anchor depth the charts are authored at. */
export const CHART_DEPTH_BB = 100;
/** Below this, `pushFold.ts` owns the decision and this layer stays out of the way. */
export const SHORT_FLOOR_BB = 15;
/** Depth at which the short-stack shading is fully on / fully off. */
const SHORT_FULL_BB = 15;
const SHORT_NONE_BB = 45;
/** Depth at which the deep-stack shading starts / is fully on. */
const DEEP_NONE_BB = 150;
const DEEP_FULL_BB = 300;
/** Peak shading strength at each extreme. Short bites harder than deep: losing set-mine
 *  implied odds is a bigger swing than the reverse-implied-odds tax on offsuit broadways. */
const K_SHORT = 0.3;
const K_DEEP = 0.22;

interface HandShape {
  pair: boolean;
  suited: boolean;
  hi: number;
  lo: number;
  gap: number;
}

function shapeOf(code: string): HandShape | null {
  if (code.length < 2) return null;
  const hi = rankOf(code[0]);
  const lo = rankOf(code[1]);
  if (hi < 2 || lo < 2) return null;
  return { pair: hi === lo, suited: code.endsWith('s'), hi, lo, gap: hi - lo - 1 };
}

/** How much of this hand's value is IMPLIED ODDS — the part that needs a deep stack to
 *  collect. Small pairs set-mine, connectors and suited aces make the hands that get paid. */
function impliedOddsWeight(s: HandShape): number {
  if (s.pair) return s.hi <= 6 ? 1 : s.hi <= 10 ? 0.6 : 0.15; // 22-66 pure set-mine, JJ+ plays itself
  if (!s.suited) return s.gap <= 1 && s.hi <= 10 ? 0.35 : 0.05; // offsuit connectors barely qualify
  if (s.hi === 14) return s.lo <= 9 ? 0.7 : 0.3; // A2s-A9s nut-flush hands; AJs+ has high-card value too
  if (s.hi <= 11) return s.gap === 0 ? 1 : s.gap === 1 ? 0.7 : 0.4; // suited connectors / gappers
  return 0.35; // suited broadways (KQs, KJs, QJs) — some of both
}

/** How much of it is HIGH-CARD value — the part that cashes without depth. */
function highCardWeight(s: HandShape): number {
  if (s.pair) return s.hi >= 11 ? 0.8 : s.hi >= 7 ? 0.35 : 0.1;
  const broadway = s.lo >= 10;
  if (s.hi === 14) return s.lo >= 12 ? 0.9 : broadway ? 0.8 : 0.45; // AK/AQ, then AJ/AT
  if (broadway) return 0.75; // KQ, KJ, QJ, JT
  return s.lo >= 8 ? 0.4 : 0.15;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Multiplier on a hand's preflop aggressive/continue frequency for the actual effective
 * stack. 1 = play the chart as written (≈60–150bb, and always at or below the push/fold
 * floor, where `pushFold.ts` owns the decision instead).
 *
 * >1 short with a high-card hand, <1 short with a speculative one, and the reverse deep.
 */
export function depthValueMult(code: string, effStackBB: number): number {
  const s = shapeOf(code);
  if (!s || effStackBB <= SHORT_FLOOR_BB) return 1;
  const shortness = clamp01((SHORT_NONE_BB - effStackBB) / (SHORT_NONE_BB - SHORT_FULL_BB));
  const deepness = clamp01((effStackBB - DEEP_NONE_BB) / (DEEP_FULL_BB - DEEP_NONE_BB));
  if (shortness === 0 && deepness === 0) return 1;
  const tilt = highCardWeight(s) - impliedOddsWeight(s); // + = wants it short, − = wants it deep
  const shift = tilt * (K_SHORT * shortness - K_DEEP * deepness);
  return Math.max(0.6, Math.min(1.4, 1 + shift));
}

/**
 * Apply a depth multiplier to a charted mix: scale every non-fold frequency and give the
 * slack (or take it) from FOLD, so the mix still sums to 1. Fold is the residual because it
 * is the only action that is always available and always the alternative to playing — and
 * because scaling it directly would double-count (a hand that plays worse short should fold
 * more BECAUSE its playing frequencies dropped, not on top of it).
 */
export function shadeForDepth<T extends { id: string; freq: number }>(options: T[], mult: number): T[] {
  if (mult === 1 || options.length === 0) return options;
  const fold = options.find((o) => o.id === 'fold');
  if (!fold) return options; // nothing to absorb the change (e.g. a free check) — leave it
  const playedBefore = options.reduce((a, o) => a + (o.id === 'fold' ? 0 : o.freq), 0);
  if (playedBefore <= 0) return options;
  const scale = Math.min(mult, 1 / playedBefore); // can't play more than 100% of the time
  const shaded = options.map((o) => (o.id === 'fold' ? o : { ...o, freq: o.freq * scale }));
  const playedAfter = playedBefore * scale;
  return shaded.map((o) => (o.id === 'fold' ? { ...o, freq: Math.max(0, 1 - playedAfter) } : o));
}

/** One line explaining a depth adjustment, or undefined when the chart stands as written. */
export function depthNote(code: string, effStackBB: number): string | undefined {
  const mult = depthValueMult(code, effStackBB);
  if (Math.abs(mult - 1) < 0.03) return undefined;
  const eff = Math.round(effStackBB);
  const short = effStackBB < CHART_DEPTH_BB;
  const up = mult > 1;
  if (short) {
    return up
      ? `Depth: at ${eff}bb this plays BETTER than the ~100bb chart — it makes top pair and gets to showdown, which needs no stack behind. Lean into it.`
      : `Depth: at ${eff}bb this plays WORSE than the ~100bb chart — set-mining and flush draws need ~15–20× the call behind to pay off, and that money isn't there. Tighten up.`;
  }
  return up
    ? `Depth: at ${eff}bb this gains — deep stacks pay off the big hands it flops, so its implied odds are worth more than the chart's ~100bb assumption.`
    : `Depth: at ${eff}bb this loses value — reverse implied odds. It wins small pots and loses big ones to the hands that flop a monster deep. Play it more cautiously.`;
}
