// Session analytics + leak finder, persisted to localStorage.

import type { Street } from '../engine/table';
import type { ActionClass, Verdict } from '../analysis/feedback';

/** Preflop facing-action at the hero's decision: how many raises were already in
 *  when it was his turn. Lets the over-fold breakdown separate opens from 3-bets.
 *  Undefined on postflop decisions and on hands recorded before this was tracked. */
export type PreflopFacing = 'unopened' | 'raise' | '3bet' | '4bet+';

export interface DecisionRecord {
  street: Street;
  position: string;
  heroAction: ActionClass;
  recommended: ActionClass;
  verdict: Verdict;
  evLoss?: number; // bb lost vs the best action at this node
  chosenEv?: number; // EV (bb) of the action the hero took — its sign tiers wrong vs inaccuracy
  rngMatch?: boolean | null; // did hero follow the RNG-prescribed action?
  facing?: PreflopFacing; // preflop only — the action hero faced
}

export interface SessionStats {
  handsPlayed: number;
  netBB: number; // cumulative big blinds won/lost
  wonBB: number; // lifetime sum of winning-hand deltas (positive magnitude)
  lostBB: number; // lifetime sum of losing-hand deltas (positive magnitude)
  busts: number; // times the hero's stack hit 0 at hand end (rebuy / elimination)
  decisions: DecisionRecord[]; // capped rolling window (last MAX_DECISIONS) — scoring
  movesTotal: number; // lifetime decision count, never capped — the number that climbs
  handResults: number[]; // per-hand deltaBB series (capped) — for downswing/variance
  startedAt: number;
}

export interface LeakBreakdown {
  label: string;
  folded: number; // over-folds in this bucket
  spots: number; // play-spots (chart said play) in this bucket
  rate: number; // folded / spots
}

export interface Leak {
  label: string;
  severity: 'high' | 'medium' | 'low' | 'ok';
  detail: string;
  rate: number; // 0..1
  sample: number;
  breakdown?: LeakBreakdown[]; // optional per-category split (over-folding preflop)
}

const KEY = 'poker-trainer-stats-v1';
const MAX_DECISIONS = 2000;
const MAX_HAND_RESULTS = 2000;

export function emptyStats(): SessionStats {
  return { handsPlayed: 0, netBB: 0, wonBB: 0, lostBB: 0, busts: 0, decisions: [], movesTotal: 0, handResults: [], startedAt: stamp() };
}

function stamp(): number {
  // Date.now is fine in the browser runtime; guarded for SSR-less safety.
  return typeof Date !== 'undefined' ? Date.now() : 0;
}

export function loadStats(): SessionStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyStats();
    const parsed = JSON.parse(raw) as SessionStats;
    if (!parsed.decisions) parsed.decisions = [];
    if (!parsed.handResults) parsed.handResults = []; // migrate older saves
    // older saves have no lifetime counter — seed it from the rolling window so
    // the number doesn't reset to 0 on upgrade (it just resumes climbing).
    if (parsed.movesTotal == null) parsed.movesTotal = parsed.decisions.length;
    // seed lifetime won/lost from the (rolling) hand series — approximate for old
    // saves, then exact for every hand played after the upgrade.
    if (parsed.wonBB == null || parsed.lostBB == null) {
      parsed.wonBB = parsed.handResults.filter((x) => x > 0).reduce((a, b) => a + b, 0);
      parsed.lostBB = -parsed.handResults.filter((x) => x < 0).reduce((a, b) => a + b, 0);
    }
    if (parsed.busts == null) parsed.busts = 0; // can't reconstruct from history — start fresh
    return parsed;
  } catch {
    return emptyStats();
  }
}

export function saveStats(s: SessionStats): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore quota / private mode */
  }
}

export function resetStats(): SessionStats {
  const s = emptyStats();
  saveStats(s);
  return s;
}

export function recordDecision(s: SessionStats, d: DecisionRecord): SessionStats {
  const decisions = [...s.decisions, d];
  if (decisions.length > MAX_DECISIONS) decisions.splice(0, decisions.length - MAX_DECISIONS);
  // decisions is a capped rolling window (for scoring recent form); movesTotal
  // is the uncapped lifetime tally shown on the scorecard.
  return { ...s, decisions, movesTotal: (s.movesTotal ?? s.decisions.length) + 1 };
}

export function recordHand(s: SessionStats, deltaBB: number, busted = false): SessionStats {
  const handResults = [...s.handResults, deltaBB];
  if (handResults.length > MAX_HAND_RESULTS) handResults.splice(0, handResults.length - MAX_HAND_RESULTS);
  return {
    ...s,
    handsPlayed: s.handsPlayed + 1,
    netBB: s.netBB + deltaBB,
    wonBB: (s.wonBB ?? 0) + Math.max(0, deltaBB),
    lostBB: (s.lostBB ?? 0) + Math.max(0, -deltaBB),
    busts: (s.busts ?? 0) + (busted ? 1 : 0),
    handResults,
  };
}

export interface MoneyStats {
  won: number; // lifetime bb won (positive)
  lost: number; // lifetime bb lost (positive magnitude)
  avgWin: number; // mean winning-hand size (recent window)
  avgLoss: number; // mean losing-hand size (recent window, positive)
  biggestLoss: number; // worst single hand (recent window, positive)
  biggestWin: number; // best single hand (recent window)
  winHands: number;
  lossHands: number;
  ratio: number; // avgLoss / avgWin — >1 means you lose bigger than you win
}

/** Won/lost totals (lifetime) plus the diagnostic that matters for the marry /
 *  station leak: average win size vs average loss size. Averages/extremes come
 *  from the rolling hand series; totals are lifetime accumulators. */
export function moneyStats(s: SessionStats): MoneyStats {
  const wins = s.handResults.filter((x) => x > 0);
  const losses = s.handResults.filter((x) => x < 0).map((x) => -x);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  return {
    won: s.wonBB ?? 0,
    lost: s.lostBB ?? 0,
    avgWin,
    avgLoss,
    biggestWin: wins.length ? Math.max(...wins) : 0,
    biggestLoss: losses.length ? Math.max(...losses) : 0,
    winHands: wins.length,
    lossHands: losses.length,
    ratio: avgWin > 0 ? avgLoss / avgWin : 0,
  };
}

export interface Downswing {
  net: number; // cumulative bb over the tracked series
  peak: number; // highest running total reached
  currentBB: number; // how far below that peak you are right now (≥ 0)
  maxBB: number; // worst peak-to-trough drop this session
  stdPer100: number; // std dev of results scaled to 100 hands — your swing size
  buyins: number; // currentBB expressed in 100bb buy-ins
}

/** Drawdown + variance over the per-hand result series — the "how big are my
 *  swings, how deep is this downswing" lens that net result alone hides. */
export function downswing(s: SessionStats): Downswing {
  const r = s.handResults ?? [];
  let run = 0;
  let peak = 0;
  let maxBB = 0;
  for (const d of r) {
    run += d;
    if (run > peak) peak = run;
    const dd = peak - run;
    if (dd > maxBB) maxBB = dd;
  }
  const n = r.length;
  let mean = 0;
  for (const d of r) mean += d;
  mean = n ? mean / n : 0;
  let varSum = 0;
  for (const d of r) varSum += (d - mean) * (d - mean);
  const std = n > 1 ? Math.sqrt(varSum / (n - 1)) : 0;
  const currentBB = peak - run;
  return { net: run, peak, currentBB, maxBB, stdPer100: std * 10, buyins: currentBB / 100 };
}

export function bbPer100(s: SessionStats): number {
  if (s.handsPlayed === 0) return 0;
  return (s.netBB / s.handsPlayed) * 100;
}

export function totalEvLoss(s: SessionStats): number {
  return s.decisions.reduce((a, d) => a + (d.evLoss ?? 0), 0);
}

export function evLossPer100(s: SessionStats): number {
  if (s.handsPlayed === 0) return 0;
  return (totalEvLoss(s) / s.handsPlayed) * 100;
}

export function rngAdherence(s: SessionStats): { followed: number; total: number } {
  const withRng = s.decisions.filter((d) => d.rngMatch === true || d.rngMatch === false);
  return { followed: withRng.filter((d) => d.rngMatch === true).length, total: withRng.length };
}

/** Biggest single-decision EV leaks, for the leak panel. */
export function topEvLeaks(s: SessionStats, n = 5): DecisionRecord[] {
  return [...s.decisions]
    .filter((d) => (d.evLoss ?? 0) > 0.05)
    .sort((a, b) => (b.evLoss ?? 0) - (a.evLoss ?? 0))
    .slice(0, n);
}

export interface ScoreBuckets {
  best: number;
  correct: number;
  inaccuracy: number;
  wrong: number;
  blunder: number;
  moves: number;
}

// EV-loss thresholds (in bb) that split each move into a GTOW-style tier.
//   best       — you played the top-EV line (loss ≈ 0).
//   correct    — a SOUND alternative: a mixed-strategy line or a slightly-off
//                bet size the solver still plays. This band is wide (≤0.5bb) on
//                purpose — most good-but-not-perfect plays belong here, not in
//                "inaccuracy". A narrow band starved this tier so it never ticked.
//   inaccuracy — clearly suboptimal but not a real punt.
//   wrong      — a meaningful error. blunder — a punt.
export const TIER = { best: 0.05, correct: 0.5, inaccuracy: 1.5, wrong: 4.0 };
const POINTS = { best: 100, correct: 90, inaccuracy: 55, wrong: 25, blunder: 0 };

/** The five GTOW-style move tiers. Single source of truth for both the live
 *  per-decision grade (analysis/grade.ts) and the session scorecard. */
export type MoveTier = 'best' | 'correct' | 'inaccuracy' | 'wrong' | 'blunder';

// A deeply -EV line (bb) is a blunder; a +EV line that still leaves more than
// this much on the table (e.g. folding a monster) is treated as a real error.
const BLUNDER_EV = -3;
const CATASTROPHE_LOSS = 6;

/** Classify a decision by EV. The SIGN of the chosen action's EV decides
 *  wrong-vs-inaccuracy: a +EV line is never worse than an inaccuracy, a -EV line
 *  is a mistake, a deeply -EV line is a blunder. `chosenEv` is the EV (bb) of the
 *  action the hero actually took; `evLoss` is its gap below the best line. */
export function moveTier(evLoss: number, chosenEv = 0): MoveTier {
  const loss = Math.max(0, evLoss);
  if (loss <= TIER.best) return 'best';
  if (loss <= TIER.correct) return 'correct';
  if (chosenEv <= BLUNDER_EV || loss > CATASTROPHE_LOSS) return 'blunder';
  if (chosenEv < 0 || loss > TIER.wrong) return 'wrong';
  // magnitude backstop: even a +EV line that leaves > TIER.inaccuracy (1.5bb) on the
  // table is a real error, not a mere inaccuracy. Without this the inaccuracy tier
  // silently swallowed every +EV loss from 0.5 up to 4.0bb (the 1.5 constant was dead).
  if (loss > TIER.inaccuracy) return 'wrong';
  return 'inaccuracy';
}

/** Classify every recorded decision into the five GTOW-style tiers. */
export function scoreBuckets(s: SessionStats): ScoreBuckets {
  const b: ScoreBuckets = { best: 0, correct: 0, inaccuracy: 0, wrong: 0, blunder: 0, moves: 0 };
  for (const d of s.decisions) {
    b.moves++;
    b[moveTier(d.evLoss ?? 0, d.chosenEv ?? 0)]++;
  }
  return b;
}

/** Weighted accuracy score 0..100 — best moves score 100, blunders 0. */
export function gtowScore(s: SessionStats): number {
  const b = scoreBuckets(s);
  if (b.moves === 0) return 0;
  const pts =
    b.best * POINTS.best +
    b.correct * POINTS.correct +
    b.inaccuracy * POINTS.inaccuracy +
    b.wrong * POINTS.wrong +
    b.blunder * POINTS.blunder;
  return Math.round(pts / b.moves);
}

export function avgEvLossPerHand(s: SessionStats): number {
  if (s.handsPlayed === 0) return 0;
  return totalEvLoss(s) / s.handsPlayed;
}

export function accuracy(s: SessionStats): { correct: number; ok: number; mistake: number; total: number } {
  let correct = 0;
  let ok = 0;
  let mistake = 0;
  for (const d of s.decisions) {
    if (d.verdict === 'correct') correct++;
    else if (d.verdict === 'ok') ok++;
    else mistake++;
  }
  return { correct, ok, mistake, total: s.decisions.length };
}

/** Heuristic leak detection over the recorded decisions. */
export function findLeaks(s: SessionStats): Leak[] {
  const d = s.decisions;
  const leaks: Leak[] = [];

  const preflop = d.filter((x) => x.street === 'preflop');
  const postflop = d.filter((x) => x.street !== 'preflop');

  // 1. Folding too much preflop (rec was to play, hero folded)
  pushRate(
    leaks,
    'Over-folding preflop',
    preflop.filter((x) => x.recommended !== 'fold' && x.heroAction === 'fold').length,
    preflop.filter((x) => x.recommended !== 'fold').length,
    'You are folding hands that the charts say to play. Open and defend wider.',
    [0.25, 0.12],
    preflopFoldBreakdown(s),
  );

  // 2. Playing too loose preflop (rec fold, hero played)
  pushRate(
    leaks,
    'Playing too loose preflop',
    preflop.filter((x) => x.recommended === 'fold' && x.heroAction !== 'fold').length,
    preflop.filter((x) => x.recommended === 'fold').length,
    'You are entering pots with hands outside a solid range. Tighten up.',
    [0.3, 0.15],
  );

  // 3. Too passive overall (rec raise, hero called/checked)
  pushRate(
    leaks,
    'Too passive (missing value/aggression)',
    d.filter((x) => x.recommended === 'raise' && (x.heroAction === 'call' || x.heroAction === 'check')).length,
    d.filter((x) => x.recommended === 'raise').length,
    'When you are ahead you should bet/raise more — calling leaves money on the table.',
    [0.4, 0.2],
  );

  // 4. Calling station (rec fold postflop, hero called)
  pushRate(
    leaks,
    'Calling too much (station)',
    postflop.filter((x) => x.recommended === 'fold' && x.heroAction === 'call').length,
    postflop.filter((x) => x.recommended === 'fold').length,
    'You are calling bets when folding is correct. Respect bets without the equity to continue.',
    [0.3, 0.15],
  );

  // 5. Over-bluffing (rec check/fold, hero raised)
  pushRate(
    leaks,
    'Over-bluffing / spewing',
    d.filter((x) => (x.recommended === 'check' || x.recommended === 'fold') && x.heroAction === 'raise').length,
    d.filter((x) => x.recommended === 'check' || x.recommended === 'fold').length,
    'You are raising as a bluff too often. Pick spots with equity or fold equity.',
    [0.35, 0.18],
  );

  return leaks.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function pushRate(
  out: Leak[],
  label: string,
  hits: number,
  sample: number,
  detail: string,
  thresholds: [number, number],
  breakdown?: LeakBreakdown[],
) {
  if (sample < 4) return; // not enough data
  const rate = hits / sample;
  let severity: Leak['severity'] = 'ok';
  if (rate >= thresholds[0]) severity = 'high';
  else if (rate >= thresholds[1]) severity = 'medium';
  else if (rate > 0) severity = 'low';
  out.push({ label, severity, detail, rate, sample, breakdown: breakdown?.length ? breakdown : undefined });
}

// Split preflop over-folds by spot type. Blinds are bucketed by position (any
// defend); non-blind play-spots split by the action hero faced (from `facing`)
// so an open you skipped reads separately from a 3-bet you passed on. Hands
// recorded before `facing` was tracked fall into an "older hands" bucket.
type FoldBucket = 'blinds' | 'open' | 'threebet' | 'fourbet' | 'flat' | 'legacy';
function preflopFoldCategory(x: DecisionRecord): FoldBucket {
  if (x.position === 'BB' || x.position === 'SB') return 'blinds';
  if (x.recommended === 'call') return 'flat';
  // recommended is a raise (open / 3-bet / 4-bet) — split by what hero faced.
  if (x.facing === 'unopened') return 'open';
  if (x.facing === 'raise') return 'threebet';
  if (x.facing === '3bet' || x.facing === '4bet+') return 'fourbet';
  return 'legacy'; // no facing recorded (older hand)
}

export function preflopFoldBreakdown(s: SessionStats): LeakBreakdown[] {
  const play = s.decisions.filter((x) => x.street === 'preflop' && x.recommended !== 'fold');
  const defs: { key: FoldBucket; label: string }[] = [
    { key: 'blinds', label: 'Blind defense (SB/BB)' },
    { key: 'open', label: 'Should open (RFI)' },
    { key: 'threebet', label: 'Should 3-bet (vs open)' },
    { key: 'fourbet', label: 'Should 4-bet (vs 3-bet)' },
    { key: 'flat', label: 'Should flat an open' },
    { key: 'legacy', label: 'Open / 3-bet (older hands)' },
  ];
  return defs
    .map(({ key, label }) => {
      const spotsArr = play.filter((x) => preflopFoldCategory(x) === key);
      const folded = spotsArr.filter((x) => x.heroAction === 'fold').length;
      return { label, folded, spots: spotsArr.length, rate: spotsArr.length ? folded / spotsArr.length : 0 };
    })
    .filter((b) => b.spots > 0);
}

function severityRank(s: Leak['severity']): number {
  return { high: 3, medium: 2, low: 1, ok: 0 }[s];
}
