// Session analytics + leak finder, persisted to localStorage.

import type { Street } from '../engine/table';
import type { ActionClass, Verdict } from '../analysis/feedback';

export interface DecisionRecord {
  street: Street;
  position: string;
  heroAction: ActionClass;
  recommended: ActionClass;
  verdict: Verdict;
  evLoss?: number; // bb lost vs the best action at this node
  rngMatch?: boolean | null; // did hero follow the RNG-prescribed action?
}

export interface SessionStats {
  handsPlayed: number;
  netBB: number; // cumulative big blinds won/lost
  decisions: DecisionRecord[]; // capped
  startedAt: number;
}

export interface Leak {
  label: string;
  severity: 'high' | 'medium' | 'low' | 'ok';
  detail: string;
  rate: number; // 0..1
  sample: number;
}

const KEY = 'poker-trainer-stats-v1';
const MAX_DECISIONS = 2000;

export function emptyStats(): SessionStats {
  return { handsPlayed: 0, netBB: 0, decisions: [], startedAt: stamp() };
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
  return { ...s, decisions };
}

export function recordHand(s: SessionStats, deltaBB: number): SessionStats {
  return { ...s, handsPlayed: s.handsPlayed + 1, netBB: s.netBB + deltaBB };
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
) {
  if (sample < 4) return; // not enough data
  const rate = hits / sample;
  let severity: Leak['severity'] = 'ok';
  if (rate >= thresholds[0]) severity = 'high';
  else if (rate >= thresholds[1]) severity = 'medium';
  else if (rate > 0) severity = 'low';
  out.push({ label, severity, detail, rate, sample });
}

function severityRank(s: Leak['severity']): number {
  return { high: 3, medium: 2, low: 1, ok: 0 }[s];
}
