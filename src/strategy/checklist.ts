// "Think-first" checklist — the pure logic behind the optional gate on postflop
// bets/raises at the live table. Before an aggressive action commits, the hero
// answers a short quiz (what do I have, what's the board, my equity, WHY am I
// betting, what's my plan if raised). Answers are graded against the app's own
// reads (handClass, boardWetness, the HUD's equity-vs-range) so sloppy clicks
// get caught before the chips go in. UI lives in components/DecisionChecklist.

import type { Card } from '../engine/cards';
import { boardWetness } from '../engine/board';
import { classifyHandClass } from './handClass';

export type HeroCategory = 'value' | 'marginal' | 'draw' | 'air';

export interface ChecklistOption {
  id: string;
  label: string;
}

export interface ChecklistQuestion {
  id: 'category' | 'texture' | 'equity' | 'purpose' | 'plan';
  prompt: string;
  options: ChecklistOption[];
}

export interface ChecklistGrade {
  questionId: ChecklistQuestion['id'];
  /** true = matched the app's read, false = missed it, null = no right answer (plan). */
  ok: boolean | null;
  /** truth + one-line coaching, shown after the hero locks answers. */
  note: string;
}

export const CATEGORY_OPTIONS: ChecklistOption[] = [
  { id: 'value', label: 'Strong made hand — value territory' },
  { id: 'marginal', label: 'Marginal made hand — pot control' },
  { id: 'draw', label: 'Draw — outs to improve' },
  { id: 'air', label: 'Air — no pair, no real draw' },
];

export const TEXTURE_OPTIONS: ChecklistOption[] = [
  { id: 'dry', label: 'Dry / static — few draws' },
  { id: 'semi', label: 'Semi-wet — one draw axis' },
  { id: 'wet', label: 'Wet / dynamic — draw-heavy' },
];

export const EQUITY_BUCKETS = [
  { id: 'lt30', label: 'Under 30% — clearly behind', lo: 0, hi: 0.3 },
  { id: 'b3045', label: '30–45% — live but behind', lo: 0.3, hi: 0.45 },
  { id: 'b4560', label: '45–60% — coin flip / slight edge', lo: 0.45, hi: 0.6 },
  { id: 'gt60', label: 'Over 60% — clear favorite', lo: 0.6, hi: 1.01 },
] as const;

export const PURPOSE_OPTIONS: ChecklistOption[] = [
  { id: 'value', label: 'Value — worse hands can call' },
  { id: 'semibluff', label: 'Semi-bluff — fold equity now, outs if called' },
  { id: 'bluff', label: 'Pure bluff — folds are the only way I win' },
  { id: 'protection', label: 'Protection — deny equity to overcards/draws' },
];

export const PLAN_OPTIONS: ChecklistOption[] = [
  { id: 'fold', label: 'Fold — this bet is my last chip in' },
  { id: 'call', label: 'Call — my hand/odds can stand a raise' },
  { id: 'raise', label: 'Re-raise / get it in' },
];

// Draw-first labels from handClass's classifyDrawOrAir — hero has no made pair
// of their own, only outs. Anything else with a real pair keys off strength.
const DRAW_LABEL =
  /^(Combo Draw|Nut Flush Draw|Flush Draw|Open-Ended Straight Draw|Gutshot Straight Draw|Two Overcards)/;

/** Bucket the hero's hand the way the quiz asks about it. */
export function heroCategory(hero: Card[], board: Card[]): HeroCategory {
  const hc = classifyHandClass(hero, board);
  if (DRAW_LABEL.test(hc.label)) return 'draw';
  if (hc.strength >= 4) return 'value';
  if (hc.strength >= 2) return 'marginal';
  return 'air';
}

/** Questions for this node. Equity question only appears when the HUD's
 *  equity-vs-range number is available (it computes async in a worker). */
export function buildChecklist(equity: number | null): ChecklistQuestion[] {
  const qs: ChecklistQuestion[] = [
    { id: 'category', prompt: 'What do you actually have?', options: CATEGORY_OPTIONS },
    { id: 'texture', prompt: 'How wet is this board?', options: TEXTURE_OPTIONS },
  ];
  if (equity != null)
    qs.push({
      id: 'equity',
      prompt: "Your equity vs villain's range is roughly…",
      options: EQUITY_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
    });
  qs.push(
    { id: 'purpose', prompt: 'Why are you putting chips in?', options: PURPOSE_OPTIONS },
    { id: 'plan', prompt: 'If you get raised, what then?', options: PLAN_OPTIONS },
  );
  return qs;
}

const CATEGORY_WORD: Record<HeroCategory, string> = {
  value: 'a strong made hand',
  marginal: 'a marginal made hand',
  draw: 'a draw',
  air: 'air',
};

// Which bet purposes are coherent for each hand category. Marginal accepts
// thin value AND protection but always carries a pot-control caution.
const PURPOSE_OK: Record<HeroCategory, string[]> = {
  value: ['value', 'protection'],
  marginal: ['value', 'protection'],
  draw: ['semibluff'],
  air: ['bluff'],
};

const PURPOSE_COACH: Record<HeroCategory, string> = {
  value: 'Strong hand → this is a value bet: pick a size worse hands still call.',
  marginal: 'Marginal hands usually prefer checks/pot control — bet only if you can name worse hands that call.',
  draw: 'A draw betting is a semi-bluff: you win folds now and have outs when called.',
  air: 'No pair, no draw → only fold-outs win it. Bluff only with a story and real fold equity.',
};

export function gradeChecklist(
  hero: Card[],
  board: Card[],
  equity: number | null,
  answers: Record<string, string>,
): { grades: ChecklistGrade[]; score: number; total: number } {
  const hc = classifyHandClass(hero, board);
  const cat = heroCategory(hero, board);
  const wet = boardWetness(board);
  const grades: ChecklistGrade[] = [];

  grades.push({
    questionId: 'category',
    ok: answers.category === cat,
    note: `You hold ${hc.label} — ${CATEGORY_WORD[cat]}. ${hc.blurb}`,
  });

  const wetNote =
    wet === 'dry'
      ? 'Dry board — few draws live: small sizes work and value dominates the betting.'
      : wet === 'semi'
        ? 'Semi-wet — one draw axis is live: medium sizing, start charging the draws.'
        : 'Wet board — multiple draws live: size up and make draws pay.';
  grades.push({ questionId: 'texture', ok: answers.texture === wet, note: wetNote });

  if (equity != null && answers.equity != null) {
    const bucket = EQUITY_BUCKETS.find((b) => equity >= b.lo && equity < b.hi) ?? EQUITY_BUCKETS[0];
    const picked = EQUITY_BUCKETS.findIndex((b) => b.id === answers.equity);
    const actual = EQUITY_BUCKETS.findIndex((b) => b.id === bucket.id);
    // a miss by one bucket with the true number within 4 points of the shared
    // boundary counts — Monte-Carlo wobbles and so does human estimation.
    const edge =
      Math.abs(picked - actual) === 1 &&
      Math.abs(equity - (picked > actual ? bucket.hi : bucket.lo)) <= 0.04;
    grades.push({
      questionId: 'equity',
      ok: answers.equity === bucket.id || edge,
      note: `HUD says ${(equity * 100).toFixed(0)}% vs the range — "${bucket.label}".${edge ? ' (Close enough — right at the boundary.)' : ''}`,
    });
  }

  grades.push({
    questionId: 'purpose',
    ok: PURPOSE_OK[cat].includes(answers.purpose ?? ''),
    note: PURPOSE_COACH[cat],
  });

  grades.push({
    questionId: 'plan',
    ok: null,
    note: 'No wrong answer — deciding NOW beats deciding under pressure after the raise lands.',
  });

  const gradeable = grades.filter((g) => g.ok !== null);
  return { grades, score: gradeable.filter((g) => g.ok).length, total: gradeable.length };
}
