// "Think-first" checklist — the pure logic behind the optional gate on postflop
// bets/raises at the live table. Before an aggressive action commits, the hero
// answers a short quiz (what do I have, what's the board, how the turn changed
// it, my equity, WHY I'm betting, HOW BIG, and my plan if raised). Answers are
// graded against the app's own reads (handClass, boardWetness, turn-card impact,
// the HUD's equity-vs-range, and the sizing cheat sheet) so sloppy clicks get
// caught before the chips go in. The question set changes by street. UI lives in
// components/DecisionChecklist.

import type { Card } from '../engine/cards';
import { boardWetness } from '../engine/board';
import { classifyHandClass } from './handClass';
import { requiredEquityForBet } from '../engine/potOdds';
import type { ObservedStats } from '../analysis/observed';
import type { StreetMove } from './bettingStory';
import { readVillainStory, readHeroStory } from './bettingStory';
import { modulateStory, heroStoryTypeNote } from './storyModulation';
import { readRiverBlockers, BLOCKER_READ_LABEL } from './riverBlockers';

export type HeroCategory = 'value' | 'marginal' | 'draw' | 'air';
export type Street = 'flop' | 'turn' | 'river';

export interface ChecklistOption {
  id: string;
  label: string;
}

export interface ChecklistQuestion {
  id:
    | 'category'
    | 'texture'
    | 'turn'
    | 'equity'
    | 'purpose'
    | 'spr'
    | 'size'
    | 'plan'
    // villain read (shared by both gates) — ungraded, keyed to observed stats
    | 'read'
    // betting-story: hero's own line (aggressive gate) / villain's line (call gate)
    | 'story'
    // river-only removal read — what your cards block (both gates, ungraded)
    | 'blocker'
    // call-gate questions
    | 'price'
    | 'verdict'
    | 'bluffcatch';
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

/** Bet/raise amount context the size question is graded against. */
export interface SizeContext {
  /** chips going in — the pending bet amount / raise-to. */
  amount: number;
  /** the pot the bet goes into (before hero's chips). */
  pot: number;
  /** effective stack-to-pot ratio; ≤ 1 means committed → jam. */
  spr: number;
}

export const CATEGORY_OPTIONS: ChecklistOption[] = [
  { id: 'value', label: 'Strong made hand — value territory' },
  { id: 'marginal', label: 'Marginal made hand — pot control' },
  { id: 'draw', label: 'Draw — outs to improve' },
  { id: 'air', label: 'Air — no pair, no real draw' },
];

// River: no cards to come, so a draw is just air — drop it as a choice.
export const CATEGORY_OPTIONS_RIVER: ChecklistOption[] = [
  { id: 'value', label: 'Strong made hand — value territory' },
  { id: 'marginal', label: 'Marginal made hand — bluff-catcher' },
  { id: 'air', label: 'Air — missed / busted draw, no pair' },
];

export const TEXTURE_OPTIONS: ChecklistOption[] = [
  { id: 'dry', label: 'Dry / static — few draws' },
  { id: 'semi', label: 'Semi-wet — one draw axis' },
  { id: 'wet', label: 'Wet / dynamic — draw-heavy' },
];

// Turn-only: what the fourth card did to the board vs the flop.
export const TURN_OPTIONS: ChecklistOption[] = [
  { id: 'brick', label: 'Bricked — changed nothing' },
  { id: 'draw', label: 'Completed / opened a draw (flush or straight)' },
  { id: 'pair', label: 'Paired the board' },
  { id: 'over', label: 'Brought a scare overcard' },
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

// River: no outs left, nothing to protect → a bet is value or a pure bluff.
export const PURPOSE_OPTIONS_RIVER: ChecklistOption[] = [
  { id: 'value', label: 'Value — worse hands can still call' },
  { id: 'bluff', label: 'Bluff — only folds win it, no cards to come' },
];

export const PLAN_OPTIONS: ChecklistOption[] = [
  { id: 'fold', label: 'Fold — this bet is my last chip in' },
  { id: 'call', label: 'Call — my hand/odds can stand a raise' },
  { id: 'raise', label: 'Re-raise / get it in' },
];

// ─────────────────────────────────────────────────────────────────────────
// VILLAIN READ — the exploit layer. The rest of the gate grades the GTO
// baseline (equity, price, board-driven sizing); this asks how THIS villain
// deviates from balance so the hero can deviate back. It's UNGRADED: at a live
// table you never see the archetype, only behaviour, and a read off a thin
// sample is a coin flip — so it's a teaching read (like plan/bluffcatch), not a
// score. The reveal shows the observed HUD stats + the exploit adjustment for
// the action in progress, and whether the pick matches the sample.
// ─────────────────────────────────────────────────────────────────────────

export type VillainReadId = 'overfold' | 'overcall' | 'spew' | 'unknown';

export const READ_OPTIONS: ChecklistOption[] = [
  { id: 'overfold', label: 'Folds too much — tight, gives up unless strong' },
  { id: 'overcall', label: 'Calls too much — sticky station' },
  { id: 'spew', label: 'Over-aggressive — barrels & bluffs a lot' },
  { id: 'unknown', label: 'No clear read yet — thin sample / plays balanced' },
];

// Below this hand count the observed stats are noise, not a read.
const READ_MIN_HANDS = 12;

/** Turn observed VPIP/AF into the dominant leak — the same reads the Exploit
 *  trainer grades, but derived from behaviour instead of the true profile.
 *  `enough` is false when the sample is too thin to trust. */
export function readFromObserved(s: ObservedStats | null | undefined): {
  read: VillainReadId;
  enough: boolean;
} {
  if (!s || s.hands < READ_MIN_HANDS) return { read: 'unknown', enough: false };
  const { vpip, af } = s;
  // fires far more than it calls → maniac/LAG spew
  if (af != null && af >= 3 && vpip >= 0.28) return { read: 'spew', enough: true };
  // in a lot of pots but passive → calling station
  if (vpip >= 0.4 && (af == null || af <= 1.2)) return { read: 'overcall', enough: true };
  // rarely voluntarily in → nit / weak-tight, over-folds
  if (vpip <= 0.22) return { read: 'overfold', enough: true };
  return { read: 'unknown', enough: true }; // moderate, no clear leak
}

const READ_LABEL: Record<VillainReadId, string> = {
  overfold: 'folds too much (tight / weak-tight)',
  overcall: 'calls too much (sticky station)',
  spew: 'over-aggressive (barrels & bluffs)',
  unknown: 'no clear leak — near-balanced',
};

// The exploit deviation per read, split by whether the hero is betting or
// calling — because the same leak flips the adjustment depending on who has the
// lead (a nit BETTING means believe them; a nit facing YOUR bet means bluff more).
const READ_COACH: Record<'aggressive' | 'call', Record<VillainReadId, string>> = {
  aggressive: {
    overfold: 'Exploit: bluff MORE — fold equity is huge. Size your value bets DOWN so worse hands stick around.',
    overcall: 'Exploit: value bet BIGGER and more often; cut bluffs to ~zero — they will not fold.',
    spew: "Exploit: don't bluff a bluffer — check/trap your strong hands and let them barrel into you; bet only for value.",
    unknown: 'No leak to attack — bet the GTO size/frequency the questions above point to.',
  },
  call: {
    overfold: 'Exploit: tight players bet real hands — believe them. Fold your bluff-catchers, do not hero-call.',
    overcall: 'Exploit: stations rarely bluff — their bets are value. Fold marginal hands; call only what beats value.',
    spew: "Exploit: they bluff a lot — call down LIGHTER, your bluff-catchers are good. Don't over-fold to pressure.",
    unknown: 'No leak — defend at the price / MDF the pot odds set, no deviation.',
  },
};

// ─────────────────────────────────────────────────────────────────────────
// BETTING STORY — does the LINE (across streets) tell one believable hand?
// Aggressive gate asks about the hero's OWN story (will a bluff be believed);
// call gate asks about the VILLAIN's story (is his bet credible). Both are
// GRADED — the line is in the hand log, so the read is deterministic, not a
// guess. Only shown from the turn on (need ≥2 streets for a line to exist).
// ─────────────────────────────────────────────────────────────────────────

// hero's own line — aggressive gate
export const HERO_STORY_OPTIONS: ChecklistOption[] = [
  { id: 'credible', label: 'Credible — I repped strength earlier, this continues it' },
  { id: 'fresh', label: 'Fresh — first bet; the story starts now and fits the board' },
  { id: 'broken', label: 'Broken — I was passive, now suddenly betting big' },
];

// villain's line — call gate
export const VILLAIN_STORY_OPTIONS: ChecklistOption[] = [
  { id: 'value', label: 'Value story — kept firing, the line is consistent' },
  { id: 'polar', label: 'Polarized — a big bet/raise; nuts-or-bluff' },
  { id: 'bluffy', label: 'Capped / delayed — slowed down or stabbed late' },
  { id: 'none', label: 'One bet — no multi-street story yet' },
];

// ─────────────────────────────────────────────────────────────────────────
// BLOCKERS — river only. Do your exact cards REMOVE combos from villain's
// range? Blocking his value (nut-flush/straight/boat cards) helps a bluff and
// a bluff-catch; blocking his BLUFFS (holding the cards he'd be bluffing with)
// hurts a catch. Deterministic from hole+board, but the "right" read leans on
// his actual range, so — like the villain-type read — it's UNGRADED: a live
// judgment call, with a concrete reveal note from strategy/riverBlockers.
// ─────────────────────────────────────────────────────────────────────────
export const BLOCKER_OPTIONS: ChecklistOption[] = [
  { id: 'blockValue', label: 'I block his value — hold his nut cards (flush / straight / boat / top pair)' },
  { id: 'blockBluffs', label: "I block his bluffs — hold the cards he'd be bluffing with" },
  { id: 'neutral', label: "Neutral — my cards don't shift his range" },
];

/** postflop streets reached: flop = 1, turn = 2, river = 3. */
const revealedStreets = (board: Card[]): number => Math.max(0, board.length - 2);
/** a line only exists to read once a second street is out (turn+). */
const storyReadable = (board: Card[]): boolean => board.length >= 4;

/** The (ungraded) note for the read question: observed stats + the exploit
 *  adjustment for the action in progress, and whether the pick matched. */
function readNote(
  observed: ObservedStats | null | undefined,
  picked: string | undefined,
  mode: 'aggressive' | 'call',
): string {
  const { read, enough } = readFromObserved(observed);
  const stat =
    observed && observed.hands > 0
      ? `Observed: ${observed.hands} hands · VPIP ${(observed.vpip * 100).toFixed(0)}% · PFR ${(observed.pfr * 100).toFixed(0)}% · AF ${observed.af != null ? observed.af.toFixed(1) : '—'}.`
      : 'No hands observed yet — you have no sample on this villain.';
  if (!enough)
    return `${stat} Too thin to trust a read — lean on the fundamentals above and adjust as the sample grows. "No clear read yet" is the honest answer here.`;
  const cmp =
    read === 'unknown'
      ? ''
      : picked === read
        ? ' Matches the sample.'
        : ` Your pick differs — the sample leans "${READ_LABEL[read]}".`;
  return `${stat} Sample suggests: ${READ_LABEL[read]}.${cmp} ${READ_COACH[mode][read]}`;
}

/** Ungraded blocker reveal: the concrete removal read for the hero's cards on
 *  this river + whether the pick matched (mode picks the bluff vs catch framing). */
function blockerNote(
  hero: Card[],
  board: Card[],
  picked: string | undefined,
  mode: 'aggressive' | 'call',
): string {
  const v = readRiverBlockers(hero, board, mode);
  const cmp = !picked
    ? ''
    : picked === v.read
      ? ' Matches your cards.'
      : ` Your cards actually read as ${BLOCKER_READ_LABEL[v.read]}.`;
  return `${v.why}${cmp}`;
}

// Commitment (stack-to-pot) — asked only when SPR actually flips the plan, i.e.
// committed (≤1) or deep (>4). In the normal 1–4 zone it's hidden to keep the
// gate short. Deciding "am I committed?" BEFORE sizing is the leak this catches.
export const SPR_OPTIONS: ChecklistOption[] = [
  { id: 'committed', label: 'Committed — SPR ≤ 1, the stack is going in' },
  { id: 'normal', label: 'Normal — SPR 1–4, a street to maneuver' },
  { id: 'deep', label: 'Deep — SPR > 4, small pot vs the stacks' },
];
type SprBucket = 'committed' | 'normal' | 'deep';
const sprBucket = (spr: number): SprBucket => (spr > 0 && spr <= 1 ? 'committed' : spr > 4 ? 'deep' : 'normal');
/** Does SPR bind here (change the plan)? Only then is it worth a question. */
const sprBinds = (spr: number | undefined): boolean => spr != null && spr > 0 && (spr <= 1 || spr > 4);

// Pot-fraction sizing bands — one source of truth with SizingCheatSheet.
export type SizeId = 'small' | 'half' | 'big' | 'pot' | 'over' | 'jam';
export const SIZE_OPTIONS: ChecklistOption[] = [
  { id: 'small', label: '25–33% pot — small / range bet' },
  { id: 'half', label: '~50% pot — medium' },
  { id: 'big', label: '66–75% pot — large / polar' },
  { id: 'pot', label: '~pot-sized (85–125%) — very polar' },
  { id: 'over', label: 'Overbet (125%+) — max polar, nut edge' },
  { id: 'jam', label: 'All-in / jam' },
];
const SIZE_ORDER: SizeId[] = ['small', 'half', 'big', 'pot', 'over', 'jam'];
const SIZE_WORD: Record<SizeId, string> = {
  small: 'small, ~⅓ pot',
  half: 'about half pot',
  big: 'large, ⅔–¾ pot',
  pot: 'about pot-sized',
  over: 'an overbet',
  jam: 'a jam',
};

// Draw-first labels from handClass's classifyDrawOrAir — hero has no made pair
// of their own, only outs. Anything else with a real pair keys off strength.
const DRAW_LABEL =
  /^(Combo Draw|Nut Flush Draw|Flush Draw|Open-Ended Straight Draw|Gutshot Straight Draw|Two Overcards)/;

// A STRONG draw (flush draw or open-ender, ≈8-9+ outs) anywhere in the label —
// whether the hand is a pure draw ("Nut Flush Draw") or a made hand carrying one
// ("Bottom Pair + Flush Draw", "Top Pair, Weak Kicker + Open-Ender"). Gutshots
// are excluded — too thin to reclassify a made hand as a semi-bluff. When true
// pre-river, betting is a legitimate semi-bluff regardless of the made-hand
// bucket, so the purpose/category grading accepts it.
const STRONG_DRAW = /(Combo Draw|Flush Draw|Open-End)/;
const hasStrongDraw = (label: string): boolean => STRONG_DRAW.test(label);

/** Which street this board is on. Postflop only — 3 cards = flop … 5 = river. */
export function streetOf(board: Card[]): Street {
  return board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop';
}

/** Bucket the hero's hand the way the quiz asks about it. */
export function heroCategory(hero: Card[], board: Card[]): HeroCategory {
  const hc = classifyHandClass(hero, board);
  if (DRAW_LABEL.test(hc.label)) return 'draw';
  if (hc.strength >= 4) return 'value';
  if (hc.strength >= 2) return 'marginal';
  return 'air';
}

const maxSuitCount = (cards: Card[]): number => {
  const c = [0, 0, 0, 0];
  for (const x of cards) c[x.suit]++;
  return Math.max(...c);
};
const isStraighty = (cards: Card[]): boolean => {
  const u = [...new Set(cards.map((c) => c.rank))].sort((a, b) => a - b);
  for (let i = 0; i + 1 < u.length; i++) if (u[i + 1] - u[i] <= 2) return true;
  return false;
};

/** What the turn card did to the flop. pair > draw-completer > overcard > brick. */
export function turnImpact(board: Card[]): 'brick' | 'draw' | 'pair' | 'over' {
  if (board.length < 4) return 'brick';
  const flop = board.slice(0, 3);
  const four = board.slice(0, 4);
  const t = board[3];
  if (flop.some((c) => c.rank === t.rank)) return 'pair';
  // a flush becomes possible (2→3 of a suit), or a straight axis newly appears
  if (maxSuitCount(flop) < 3 && maxSuitCount(four) >= 3) return 'draw';
  if (!isStraighty(flop) && isStraighty(four)) return 'draw';
  if (t.rank > Math.max(...flop.map((c) => c.rank))) return 'over';
  return 'brick';
}

/** Which pot-fraction the real bet actually is (jam handled separately by SPR). */
function fractionBucket(frac: number): SizeId {
  if (frac >= 1.25) return 'over';
  if (frac >= 0.85) return 'pot';
  if (frac >= 0.6) return 'big';
  if (frac >= 0.42) return 'half';
  return 'small';
}

/** The size the board/SPR calls for — the answer the size question is graded on. */
function targetSize(board: Card[], spr: number): SizeId {
  if (spr > 0 && spr <= 1) return 'jam';
  const wet = boardWetness(board);
  return wet === 'wet' ? 'big' : wet === 'semi' ? 'half' : 'small';
}

/** Questions for this node. The equity question only appears once the HUD's
 *  equity-vs-range number is available; the turn question only on the turn; the
 *  category/purpose sets narrow on the river. */
export function buildChecklist(equity: number | null, board: Card[] = [], spr?: number): ChecklistQuestion[] {
  const street = streetOf(board);
  const river = street === 'river';
  const qs: ChecklistQuestion[] = [
    {
      id: 'category',
      prompt: 'What do you actually have?',
      options: river ? CATEGORY_OPTIONS_RIVER : CATEGORY_OPTIONS,
    },
    { id: 'texture', prompt: 'How wet is this board?', options: TEXTURE_OPTIONS },
  ];
  if (street === 'turn')
    qs.push({ id: 'turn', prompt: 'How did the turn change things?', options: TURN_OPTIONS });
  if (equity != null)
    qs.push({
      id: 'equity',
      prompt: "Your equity vs villain's range is roughly…",
      options: EQUITY_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
    });
  // read the villain BEFORE deciding why/how to bet — it shapes both.
  qs.push({ id: 'read', prompt: 'How is this villain playing?', options: READ_OPTIONS });
  qs.push({
    id: 'purpose',
    prompt: 'Why are you putting chips in?',
    options: river ? PURPOSE_OPTIONS_RIVER : PURPOSE_OPTIONS,
  });
  // does your own line sell this bet? (only once a line exists — turn+)
  if (storyReadable(board))
    qs.push({ id: 'story', prompt: 'Does your line tell a credible story?', options: HERO_STORY_OPTIONS });
  // river removal read — do your cards block his value or his bluffs? (river only)
  if (river)
    qs.push({ id: 'blocker', prompt: 'What do your cards block?', options: BLOCKER_OPTIONS });
  // commitment comes BEFORE sizing — it drives it — and only when it binds.
  if (sprBinds(spr))
    qs.push({ id: 'spr', prompt: 'How deep are the stacks (SPR)?', options: SPR_OPTIONS });
  qs.push(
    { id: 'size', prompt: 'How big — relative to the pot?', options: SIZE_OPTIONS },
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

// River: outs are gone and there's nothing left to protect, so every category
// collapses to value-or-bluff.
const PURPOSE_OK_RIVER: Record<HeroCategory, string[]> = {
  value: ['value'],
  marginal: ['value'],
  draw: ['bluff'],
  air: ['bluff'],
};

const PURPOSE_COACH_RIVER: Record<HeroCategory, string> = {
  value: 'River value bet — size so worse hands still call; no protection needed, nothing to come.',
  marginal: 'River: no protection to buy. Bet only for thin value (more worse hands call than better) — otherwise check and bluff-catch.',
  draw: 'A busted draw on the river is air — this can only be a pure bluff with blockers and a story.',
  air: 'River air = pure bluff: folds are the only way you win. Need blockers and a credible line, not hope.',
};

const TURN_COACH: Record<'brick' | 'draw' | 'pair' | 'over', string> = {
  brick: 'The turn bricked — ranges and equities barely moved. If you were ahead and betting the flop, keep applying pressure.',
  draw: 'The turn completed/opened a draw — a flush or straight is now live. Play polar: barrel value, and slow down bluffs that just got outdrawn.',
  pair: 'The turn paired the board — trips and full houses are now possible and many draws died. Bluffs lose fold equity; value gets thinner.',
  over: "The turn is an overcard — it likely hit the caller's range and can scare yours. Barrel it if it favours you; check if it smashed them.",
};

function sizeCoach(target: SizeId, street: Street): string {
  switch (target) {
    case 'jam':
      return "SPR ≤ 1 — you're committed: jam or bet ≥75%, the exact size barely matters.";
    case 'small':
      return street === 'river'
        ? 'Thin-value spot — 25–33% for the worse hands that still call; no protection to buy.'
        : 'Dry board wants 25–33% — a small range bet; little to protect.';
    case 'half':
      return 'Semi-wet, one draw axis — ~50% starts charging the draw.';
    case 'big':
      return street === 'river'
        ? 'Polar river — 66–75%+ with a value+bluff range; pick sizes worse hands still pay.'
        : 'Wet board — size up to 66–75% to make draws pay.';
    default:
      return '';
  }
}

export function gradeChecklist(
  hero: Card[],
  board: Card[],
  equity: number | null,
  answers: Record<string, string>,
  size?: SizeContext,
  observed?: ObservedStats | null,
  heroLine?: StreetMove[],
): { grades: ChecklistGrade[]; score: number; total: number } {
  const hc = classifyHandClass(hero, board);
  const cat = heroCategory(hero, board);
  const wet = boardWetness(board);
  const street = streetOf(board);
  const river = street === 'river';
  const grades: ChecklistGrade[] = [];

  // A made hand carrying a live (pre-river) strong draw plays as a semi-bluff, so
  // reading it as "draw" is correct even though its strength buckets it as a made
  // hand — accept either. The blurb already spells out the semi-bluff logic.
  const semiBluff = !river && hasStrongDraw(hc.label);
  grades.push({
    questionId: 'category',
    ok: answers.category === cat || (semiBluff && answers.category === 'draw'),
    note: `You hold ${hc.label} — ${CATEGORY_WORD[cat]}. ${hc.blurb}`,
  });

  const wetNote =
    wet === 'dry'
      ? 'Dry board — few draws live: small sizes work and value dominates the betting.'
      : wet === 'semi'
        ? 'Semi-wet — one draw axis is live: medium sizing, start charging the draws.'
        : 'Wet board — multiple draws live: size up and make draws pay.';
  grades.push({ questionId: 'texture', ok: answers.texture === wet, note: wetNote });

  if (street === 'turn' && answers.turn != null) {
    const impact = turnImpact(board);
    grades.push({ questionId: 'turn', ok: answers.turn === impact, note: TURN_COACH[impact] });
  }

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

  // Purpose: a live strong draw makes "semi-bluff" a valid reason to bet on top
  // of the made-hand bucket's usual purposes — the draw, not thin value, is why
  // you fire. This keeps the gate consistent with the semi-bluff read the hand
  // class / situation panel now give.
  const purposeOk =
    (river ? PURPOSE_OK_RIVER : PURPOSE_OK)[cat].includes(answers.purpose ?? '') ||
    (semiBluff && answers.purpose === 'semibluff');
  grades.push({
    questionId: 'purpose',
    ok: purposeOk,
    note: semiBluff
      ? `You also hold a strong draw, so betting is a SEMI-BLUFF:` +
        ` • Fold equity now — worse hands give up.` +
        ` • Outs when called — that, not thin value, is the reason to bet.` +
        ` • Builds the pot for when you hit, and denies a free card.`
      : (river ? PURPOSE_COACH_RIVER : PURPOSE_COACH)[cat],
  });

  // villain read — ungraded teaching note (observed stats + exploit adjustment).
  grades.push({ questionId: 'read', ok: null, note: readNote(observed, answers.read, 'aggressive') });

  // betting story — your OWN line. Graded (deterministic from the hand log);
  // the note also folds in how the villain TYPE (from the read question) changes
  // whether the bet even works.
  if (answers.story != null && heroLine) {
    const s = readHeroStory(heroLine, revealedStreets(board));
    const typeNote = heroStoryTypeNote(answers.read);
    grades.push({ questionId: 'story', ok: answers.story === s.read, note: typeNote ? `${s.why} ${typeNote}` : s.why });
  }

  // river blocker read — ungraded (removal is a live judgment vs his real range).
  if (river && answers.blocker != null)
    grades.push({ questionId: 'blocker', ok: null, note: blockerNote(hero, board, answers.blocker, 'aggressive') });

  if (size && answers.spr != null) {
    const b = sprBucket(size.spr);
    const note =
      b === 'committed'
        ? `SPR ${size.spr.toFixed(1)} ≤ 1 — you're committed: the stack goes in regardless, so bet big/jam and deny equity NOW rather than give draws a cheap card.`
        : b === 'deep'
          ? `SPR ${size.spr.toFixed(1)} — deep: keep the pot smaller; position and later streets matter more than this one bet.`
          : `SPR ${size.spr.toFixed(1)} — normal: one street of room, size by the board.`;
    grades.push({ questionId: 'spr', ok: answers.spr === b, note });
  }

  if (size && answers.size != null) {
    const { amount, pot, spr } = size;
    const frac = pot > 0 ? amount / pot : 0;
    const committed = spr > 0 && spr <= 1;
    const actual: SizeId = committed ? 'jam' : fractionBucket(frac);
    const target = targetSize(board, spr);
    const pi = SIZE_ORDER.indexOf(answers.size as SizeId);
    const ti = SIZE_ORDER.indexOf(target);
    // sizing is a band, not a point — the right band or one either side counts
    // (mirrors the equity question's boundary tolerance).
    const ok = pi >= 0 && Math.abs(pi - ti) <= 1;
    const real = `Your ${amount} into ${pot} ≈ ${(frac * 100).toFixed(0)}% pot (${SIZE_WORD[actual]}).`;
    let nudge = '';
    if (!committed && actual !== target) {
      nudge =
        SIZE_ORDER.indexOf(actual) > ti
          ? ' Your bet runs bigger than that — consider sizing down.'
          : ' Your bet runs smaller than that — consider sizing up.';
    }
    // range-balance consequence of the size: on the river the value:bluff ratio, on
    // earlier streets the opponent's minimum-defence frequency (no clean bluff% yet).
    // Skipped when committed (a jam isn't a balance choice).
    let balance = '';
    if (!committed && frac > 0) {
      if (street === 'river') {
        const b = requiredEquityForBet(frac);
        const r = (1 - b) / Math.max(0.001, b);
        balance = ` ⚖ This size wants ~${Math.round(b * 100)}% bluffs (≈ ${r.toFixed(1)}:1 value:bluff).`;
      } else {
        balance = ` ⚖ It makes villain defend ~${Math.round(100 / (1 + frac))}% (MDF).`;
      }
    }
    grades.push({
      questionId: 'size',
      ok,
      note: `${real} ${sizeCoach(target, street)}${nudge}${balance}`,
    });
  }

  grades.push({
    questionId: 'plan',
    ok: null,
    note: 'No wrong answer — deciding NOW beats deciding under pressure after the raise lands.',
  });

  const gradeable = grades.filter((g) => g.ok !== null);
  return { grades, score: gradeable.filter((g) => g.ok).length, total: gradeable.length };
}

// ─────────────────────────────────────────────────────────────────────────
// CALL GATE — a call is a defensive decision, so it gets its own question set:
// the price (pot odds), your equity, the call/fold/raise verdict, and — on the
// river — a bluff-catch read. Graded against the HUD's pot odds + equity so
// hero-calls and over-folds get caught before the chips go in.
// ─────────────────────────────────────────────────────────────────────────

/** Required-equity (pot-odds) buckets, keyed to common bet sizes. */
export const PRICE_OPTIONS: ChecklistOption[] = [
  { id: 'lt20', label: '~20% — a small bet (≤ ⅓ pot)' },
  { id: 'b25', label: '~25% — about half pot' },
  { id: 'b30', label: '~30% — ⅔ to ¾ pot' },
  { id: 'gt33', label: '33%+ — pot-sized or an overbet' },
];
const PRICE_BUCKETS = [
  { id: 'lt20', lo: 0, hi: 0.225 },
  { id: 'b25', lo: 0.225, hi: 0.275 },
  { id: 'b30', lo: 0.275, hi: 0.315 },
  { id: 'gt33', lo: 0.315, hi: 1.01 },
] as const;

export const VERDICT_OPTIONS: ChecklistOption[] = [
  { id: 'call', label: 'Call — my equity clears the price' },
  { id: 'fold', label: 'Fold — short of the price, no draw' },
  { id: 'draw', label: 'Peel — behind now, but a draw with implied odds' },
  { id: 'raise', label: 'Raise instead — ahead, or fold equity as a bluff' },
];

// River-only judgment: how often villain bluffs. Ungraded (a read), but the note
// ties it to the price so the bluff-catch decision is explicit.
export const BLUFF_OPTIONS: ChecklistOption[] = [
  { id: 'often', label: 'Often — he barrels / bluffs a lot here' },
  { id: 'sometimes', label: 'Sometimes — fairly balanced' },
  { id: 'rarely', label: 'Rarely — he value-bets, seldom bluffs' },
];

/** Bet/call context the call gate is graded against (all from the HUD/legal). */
export interface CallContext {
  /** chips needed to call. */
  toCall: number;
  /** pot before the call. */
  pot: number;
  /** hero's outs (0 if unknown / river). */
  outs: number;
  /** live opponents (1 = heads-up). Multiway lowers the "fair share" break-even. */
  opps?: number;
}

const pct = (f: number) => `${(f * 100).toFixed(0)}%`;

export function buildCallChecklist(equity: number | null, board: Card[] = []): ChecklistQuestion[] {
  const river = streetOf(board) === 'river';
  const qs: ChecklistQuestion[] = [
    { id: 'price', prompt: 'What equity do you need to call?', options: PRICE_OPTIONS },
  ];
  if (equity != null)
    qs.push({
      id: 'equity',
      prompt: 'Your equity vs his range is roughly…',
      options: EQUITY_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
    });
  // read the villain before the call/fold verdict — it drives bluff-catching.
  qs.push({ id: 'read', prompt: 'How is this villain playing?', options: READ_OPTIONS });
  // does his line add up to a value hand? (only once a line exists — turn+)
  if (storyReadable(board))
    qs.push({ id: 'story', prompt: 'What story does his line tell?', options: VILLAIN_STORY_OPTIONS });
  // river removal read — do your cards block his value or his bluffs? (river only)
  if (river)
    qs.push({ id: 'blocker', prompt: 'What do your cards block?', options: BLOCKER_OPTIONS });
  qs.push({ id: 'verdict', prompt: 'So — call, fold, or raise?', options: VERDICT_OPTIONS });
  if (river)
    qs.push({ id: 'bluffcatch', prompt: 'How often is he bluffing here?', options: BLUFF_OPTIONS });
  return qs;
}

export function gradeCallChecklist(
  hero: Card[],
  board: Card[],
  equity: number | null,
  ctx: CallContext,
  answers: Record<string, string>,
  observed?: ObservedStats | null,
  villainLine?: StreetMove[],
): { grades: ChecklistGrade[]; score: number; total: number } {
  const { toCall, pot, outs, opps = 1 } = ctx;
  const need = toCall > 0 ? toCall / (pot + toCall) : 0;
  const river = streetOf(board) === 'river';
  // multiway, an average hand's share is only 1/(players) — so a "low" raw
  // equity % isn't "behind"; the call is decided by the price, not by 50%.
  const fairShare = 1 / (opps + 1);
  const hc = classifyHandClass(hero, board);
  const cat = heroCategory(hero, board);
  const grades: ChecklistGrade[] = [];

  // price — graded against the real pot odds (adjacency tolerance, like equity)
  const priceBucket = PRICE_BUCKETS.find((b) => need >= b.lo && need < b.hi) ?? PRICE_BUCKETS[0];
  const pi = PRICE_BUCKETS.findIndex((b) => b.id === answers.price);
  const ti = PRICE_BUCKETS.findIndex((b) => b.id === priceBucket.id);
  // Read the price off the BET size, not the call-vs-current-pot ratio: `pot`
  // already contains his bet, so `toCall / pot` under-reads it. The cheat-sheet
  // buckets (½ pot→25%, pot→33%…) are keyed to bet ÷ pot-BEFORE-the-bet.
  const potBeforeBet = Math.max(1, pot - toCall);
  const betFrac = toCall / potBeforeBet;
  grades.push({
    questionId: 'price',
    ok: pi >= 0 && Math.abs(pi - ti) <= 1,
    note: `You must call ${toCall} into ${pot} → need ${pct(need)} equity (call ÷ (pot + call)). The ${pot} already includes his ${toCall} bet — that ${toCall} is a ${pct(betFrac)}-pot bet (into ${potBeforeBet} before he bet), so read the price off the bet size, not ${toCall}÷${pot}.`,
  });

  if (equity != null && answers.equity != null) {
    const bucket = EQUITY_BUCKETS.find((b) => equity >= b.lo && equity < b.hi) ?? EQUITY_BUCKETS[0];
    const picked = EQUITY_BUCKETS.findIndex((b) => b.id === answers.equity);
    const actual = EQUITY_BUCKETS.findIndex((b) => b.id === bucket.id);
    const edge =
      Math.abs(picked - actual) === 1 &&
      Math.abs(equity - (picked > actual ? bucket.hi : bucket.lo)) <= 0.04;
    const multiwayNote =
      opps > 1
        ? ` (${opps + 1}-way, an average hand's share is only ~${pct(fairShare)} — a low % here isn't "clearly behind"; the call is decided by the price above, not by 50%.)`
        : '';
    grades.push({
      questionId: 'equity',
      ok: answers.equity === bucket.id || edge,
      note: `HUD says ${pct(equity)} vs the range — "${bucket.label}".${edge ? ' (Close enough — right at the boundary.)' : ''}${multiwayNote}`,
    });
  }

  // verdict — the whole point: does your equity clear the price?
  if (equity == null) {
    grades.push({
      questionId: 'verdict',
      ok: null,
      note: 'Equity still computing — decide on the price and your read; the number confirms after.',
    });
  } else {
    // A made hand is not a bluff-catch or a draw: it has showdown value AND outs
    // to improve, so raw all-in equity vs a multiway field understates a call —
    // especially in position, where implied odds are real. Only air/thin misses
    // that are clearly short of the price are pure folds.
    const made = cat === 'value' || cat === 'marginal';
    const ahead = equity >= need;
    const bigDraw = !river && (cat === 'draw' || outs >= 8); // a real draw to peel
    // how much under the raw price a made hand can still profitably call for
    // (outs to improve + position + implied odds); none of that exists on the river.
    const IMPLIED = 0.08;
    let correct: string[];
    let note: string;
    if (ahead) {
      correct = made ? ['call', 'raise'] : ['call', 'draw', 'raise'];
      note = `${pct(equity)} ≥ ${pct(need)} needed → you're ahead of the price: call (raise only if worse hands still pay).`;
    } else if (made && !river && equity >= need - IMPLIED) {
      correct = ['call'];
      note = `${pct(equity)} vs ${pct(need)} needed is close, but ${hc.label} is a made hand — showdown value plus outs to improve, and the raw multiway equity understates a call in position. You're priced in: call (don't fold a made hand getting this price).`;
    } else if (bigDraw) {
      const drawOuts = outs > 0 ? `${outs} outs` : 'a real draw';
      note = `${pct(equity)} < ${pct(need)} on raw equity, but ${drawOuts} — peel only if you'll get paid when you hit (implied odds); otherwise fold.`;
      correct = ['draw', 'fold'];
    } else {
      correct = ['fold'];
      note = `${pct(equity)} < ${pct(need)} needed with no made hand or real draw${river ? ' and no cards to come' : ''} — folding saves the chips.`;
    }
    grades.push({ questionId: 'verdict', ok: correct.includes(answers.verdict ?? ''), note });
  }

  // villain read — ungraded teaching note (observed stats + call-side exploit).
  grades.push({ questionId: 'read', ok: null, note: readNote(observed, answers.read, 'call') });

  // betting story — HIS line. Graded on the shape (deterministic from the log);
  // the note then modulates by the villain TYPE (read question) + player count —
  // the same line means opposite things vs a nit vs a maniac, and multiway.
  if (answers.story != null && villainLine) {
    const s = readVillainStory(villainLine, revealedStreets(board));
    const mod = modulateStory(s.read, answers.read, opps);
    grades.push({ questionId: 'story', ok: answers.story === s.read, note: `${s.why} ${mod.note}` });
  }

  // river blocker read — ungraded (removal is a live judgment vs his real range).
  if (river && answers.blocker != null)
    grades.push({ questionId: 'blocker', ok: null, note: blockerNote(hero, board, answers.blocker, 'call') });

  // river bluff-catch — ungraded read, but pinned to the price
  if (river)
    grades.push({
      questionId: 'bluffcatch',
      ok: null,
      note: `Bluff-catch: you need him bluffing ≥ ${pct(need)} of the time. Your ~${equity != null ? pct(equity) : '—'} equity is roughly that break-even — call only if he actually bluffs this often, fold if he rarely does.`,
    });

  const gradeable = grades.filter((g) => g.ok !== null);
  return { grades, score: gradeable.filter((g) => g.ok).length, total: gradeable.length };
}
