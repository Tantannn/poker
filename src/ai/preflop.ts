// Preflop hand notation, range parsing, RFI charts, and a 0..1 hand-strength
// score used by both the AI and the decision-feedback engine.

import type { Card } from '../engine/cards';
import type { Position } from '../engine/table';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const rankVal = (r: string) => RANKS.indexOf(r); // 0 = Ace (strongest)

const RANK_TO_CHAR: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8',
  7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};

/** Two cards -> canonical 169 notation like "AKs", "QQ", "T9o". */
export function handCode(cards: Card[]): string {
  const toChar = (n: number): string => RANK_TO_CHAR[n] ?? '?';
  const [a, b] = cards;
  const hi = a.rank >= b.rank ? a : b;
  const lo = a.rank >= b.rank ? b : a;
  if (hi.rank === lo.rank) return toChar(hi.rank) + toChar(lo.rank);
  const suited = hi.suit === lo.suit ? 's' : 'o';
  return toChar(hi.rank) + toChar(lo.rank) + suited;
}

// ---- range token expansion (e.g. "A9s+", "22+", "KTs+", "A5s-A4s") ----
function expandPlusOffsuitSuited(tok: string): string[] {
  // e.g. "A9s+" -> A9s,ATs,AJs,AQs,AKs ; "KTo+" -> KTo,KJo,KQo
  const hi = tok[0];
  const lo = tok[1];
  const suf = tok[2];
  const res: string[] = [];
  const hiV = rankVal(hi);
  for (let lv = rankVal(lo); lv > hiV; lv--) res.push(hi + RANKS[lv] + suf);
  return res;
}

function expandRange(a: string, b: string): string[] {
  // pairs "TT-22" or suited "A5s-A2s"
  if (a[0] === a[1]) {
    const hi = Math.min(rankVal(a[0]), rankVal(b[0]));
    const lo = Math.max(rankVal(a[0]), rankVal(b[0]));
    const res: string[] = [];
    for (let i = hi; i <= lo; i++) res.push(RANKS[i] + RANKS[i]);
    return res;
  }
  const suf = a[2];
  const hi = a[0];
  const top = Math.min(rankVal(a[1]), rankVal(b[1]));
  const bot = Math.max(rankVal(a[1]), rankVal(b[1]));
  const res: string[] = [];
  for (let i = top; i <= bot; i++) res.push(hi + RANKS[i] + suf);
  return res;
}

function expandToken(tok: string): string[] {
  tok = tok.trim();
  if (tok.includes('-')) {
    const [a, b] = tok.split('-');
    return expandRange(a, b);
  }
  let plus = tok.endsWith('+');
  if (plus) tok = tok.slice(0, -1);
  if (tok.length === 2 && tok[0] === tok[1]) {
    if (plus) {
      const res: string[] = [];
      for (let i = rankVal(tok[0]); i >= 0; i--) res.push(RANKS[i] + RANKS[i]);
      return res;
    }
    return [tok];
  }
  if (plus) return expandPlusOffsuitSuited(tok);
  return [tok];
}

export function buildRange(tokens: string[]): Set<string> {
  const s = new Set<string>();
  for (const t of tokens) for (const h of expandToken(t)) s.add(h);
  return s;
}

// ---- 6-max RFI (open-raise) charts, ~100bb cash baseline ----
export const RFI_TOKENS: Record<Position, string[]> = {
  UTG: ['22+', 'A9s+', 'A5s-A4s', 'KTs+', 'QTs+', 'JTs', 'T9s', '98s', 'AJo+', 'KQo'],
  MP: ['22+', 'A8s+', 'A5s-A4s', 'K9s+', 'QTs+', 'JTs', 'T9s', '98s', '87s', 'ATo+', 'KJo+', 'QJo'],
  CO: [
    '22+', 'A2s+', 'K8s+', 'Q9s+', 'J9s+', 'T8s+', '97s+', '86s+', '76s', '65s', '54s',
    'A9o+', 'KTo+', 'QTo+', 'JTo',
  ],
  BTN: [
    '22+', 'A2s+', 'K2s+', 'Q5s+', 'J7s+', 'T7s+', '96s+', '86s+', '75s+', '64s+', '54s', '43s',
    'A2o+', 'K7o+', 'Q9o+', 'J9o+', 'T8o+', '98o', '87o',
  ],
  SB: [
    '22+', 'A2s+', 'K4s+', 'Q6s+', 'J7s+', 'T7s+', '96s+', '85s+', '75s+', '64s+', '54s',
    'A4o+', 'K8o+', 'Q9o+', 'J9o+', 'T9o',
  ],
  BB: [], // BB defends rather than opens; handled separately
};

export const RFI_RANGES: Record<Position, Set<string>> = {
  UTG: buildRange(RFI_TOKENS.UTG),
  MP: buildRange(RFI_TOKENS.MP),
  CO: buildRange(RFI_TOKENS.CO),
  BTN: buildRange(RFI_TOKENS.BTN),
  SB: buildRange(RFI_TOKENS.SB),
  BB: new Set<string>(),
};

export const POSITION_NOTES: Record<Position, string> = {
  UTG: 'Earliest seat, 4 players left to act. Open tight — only hands that fare well multiway.',
  MP: 'Middle position. Slightly wider than UTG as fewer players remain behind.',
  CO: 'Cutoff — open wide; you often take the betting lead with position on most.',
  BTN: 'Button — best seat, last to act postflop. Open very wide to steal blinds.',
  SB: 'Small blind — raise-or-fold vs the BB; you are out of position postflop.',
  BB: 'Big blind — you already have 1bb invested, so defend wide by calling and 3-betting.',
};

/** 3-bet (re-raise) value range vs a typical open. */
export const THREEBET_TOKENS = ['QQ+', 'AKs', 'AKo', 'A5s', 'A4s', 'KQs'];
export const THREEBET_RANGE = buildRange(THREEBET_TOKENS);

/** BB defend (call) range vs a button open — wide. */
export const BB_DEFEND_TOKENS = [
  '22+', 'A2s+', 'K2s+', 'Q4s+', 'J6s+', 'T6s+', '95s+', '85s+', '74s+', '64s+', '53s+', '43s',
  'A2o+', 'K7o+', 'Q8o+', 'J8o+', 'T8o+', '98o', '87o',
];
export const BB_DEFEND_RANGE = buildRange(BB_DEFEND_TOKENS);

/**
 * Heuristic 0..1 preflop strength for a 169-code, roughly proportional to
 * all-in equity vs a random hand. Used by AI postflop fallback & feedback.
 */
export function preflopStrength(code: string): number {
  const isPair = code.length === 2;
  if (isPair) {
    const v = rankVal(code[0]); // 0=AA
    return 0.999 - v * 0.02; // AA ~1.0 down to 22 ~0.76
  }
  const hiV = rankVal(code[0]);
  const loV = rankVal(code[1]);
  const suited = code[2] === 's';
  const gap = loV - hiV; // bigger = farther apart
  let s = 0.74 - (hiV + loV) * 0.018;
  s -= Math.max(0, gap - 1) * 0.012; // connectedness penalty
  if (suited) s += 0.04;
  if (code[0] === 'A') s += 0.04;
  if (code[0] === 'K') s += 0.015;
  // connectors get a small bump
  if (gap === 1) s += 0.02;
  return Math.max(0.18, Math.min(0.95, s));
}

export function handCombos(code: string): number {
  if (code.length === 2) return 6;
  return code.endsWith('s') ? 4 : 12;
}

export function rangePct(set: Set<string>): { combos: number; pct: number } {
  let combos = 0;
  set.forEach((h) => (combos += handCombos(h)));
  return { combos, pct: (combos / 1326) * 100 };
}
