// Equity-vs-range calibration drill — the skill that actually wins money. You
// can't memorize range equity (it shifts with hand × board × range × how many
// opponents), so instead this trains your GUT: random hero + board vs a real
// villain range, you call the bucket (behind / underdog / coinflip / ahead /
// crushing), and it reveals the true equity. Heads-up by default; bump the
// opponent count to see a made hand's equity collapse multiway (equityVsField).
// Reps tune the read you use at the table.

import { useEffect, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard } from '../engine/board';
import { equityVsRange, equityVsField, countOuts } from '../engine/equity';
import { rangeFromSet } from '../engine/range';
import type { ComboWeight, WeightedRange } from '../engine/range';
import { RFI_RANGES, THREEBET_RANGE, BB_DEFEND_RANGE } from '../ai/preflop';
import { classifyHandClass } from '../strategy/handClass';
import type { HandClass } from '../strategy/handClass';
import { betConditionedWeight } from '../strategy';
import { getProfile } from '../ai/profiles';
import { playGrade } from '../sound';
import { PlayingCard } from './PlayingCard';
import { PositionCheatSheet } from './PositionCheatSheet';
import { EquityAnchors, MADE as MADE_ANCHORS, type MadeRow } from './EquityAnchors';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

interface RangeOpt {
  id: string;
  label: string;
  note: string;
  /** how wide the range is — the other half of the equity read. */
  width: 'wide' | 'tight';
  range: WeightedRange;
}

// Static villain ranges (built once). These are the spots you face constantly.
const RANGES: RangeOpt[] = [
  { id: 'btn', label: 'BTN open', note: "Button opening range — wide steal", width: 'wide', range: rangeFromSet(RFI_RANGES.BTN) },
  { id: 'co', label: 'CO open', note: 'Cutoff open — fairly wide', width: 'wide', range: rangeFromSet(RFI_RANGES.CO) },
  { id: 'utg', label: 'UTG open', note: 'Early-position open — tight & strong', width: 'tight', range: rangeFromSet(RFI_RANGES.UTG) },
  { id: '3bet', label: '3-bet value', note: 'Re-raise range — QQ+/AK heavy', width: 'tight', range: rangeFromSet(THREEBET_RANGE) },
  { id: 'bbdef', label: 'BB defend', note: 'BB calling a button open — very wide', width: 'wide', range: rangeFromSet(BB_DEFEND_RANGE) },
];

// How many opponents hold that range. Heads-up is the core skill; multiway shows
// a made hand's equity collapse (you must beat ALL of them at once).
const OPP_OPTS = [
  { n: 1, label: 'Heads-up' },
  { n: 2, label: '3-way' },
  { n: 4, label: '5-way' },
];

// Villain ACTION this street. "Checked" leaves the range unconditioned (the old
// behaviour). A BET conditions the range toward value (betConditionedWeight) — the
// bigger the bet, the more polarized — which is what shrinks your raw-outs equity.
const BET_OPTS: { id: string; label: string; facing: boolean; frac: number }[] = [
  { id: 'check', label: 'Checked to you', facing: false, frac: 0 },
  { id: 'b33', label: 'Bets ⅓', facing: true, frac: 0.33 },
  { id: 'b66', label: 'Bets ⅔', facing: true, frac: 0.66 },
  { id: 'pot', label: 'Bets pot', facing: true, frac: 1 },
];

// Villain TYPE — only bites when he's BETTING. bluffFreq drives how value-heavy the
// bet range is (betConditionedWeight scales the air/bluff part vs a 0.33 GTO baseline):
// a station barrels almost only value (outs get dirty), a maniac fires tons of air
// (your bluff-catchers/draws keep more equity). Same mapping the solver uses.
const TYPE_OPTS: { id: string; label: string }[] = [
  { id: 'lp', label: '🐟 Station (LP)' },
  { id: 'tag', label: '🎯 TAG' },
  { id: 'gto', label: '⚖ Balanced' },
  { id: 'maniac', label: '🔥 Maniac' },
];

// how close your % guess must be to count as calibrated. 2500-iter MC noise is ~±1pt,
// so ±6 rewards a genuine read without demanding solver precision.
const GUESS_TOL = 6;

// "🎲 Random" villain: reroll a concrete range/type each spot so you train across the
// whole cast instead of one fixed opponent. Not a real archetype — a mode flag.
const RANDOM_ID = 'rand';
const pickId = <T extends { id: string }>(arr: T[]): string => arr[Math.floor(Math.random() * arr.length)].id;

// Canonical outs for a LABELLED draw, so the read matches the label. countOuts
// reports every category-improving card — for a gutshot that includes pairing your
// undercards (~10 "outs"), which are NOT real draw outs. A "Gutshot" is 4, an
// "Open-Ender" 8, a "Flush Draw" 9, "Two Overcards" 6, a "Combo Draw" ~15. Falls back
// to the counted number for an unlabelled draw. (Same ladder as the 🎯 anchor sheet.)
function canonicalDrawOuts(hc: HandClass, counted: number): number {
  const l = hc.label.toLowerCase();
  if (/combo draw/.test(l)) return 15; // flush + straight
  if (/flush draw/.test(l)) return 9;
  if (/open-end|open-ender|oesd/.test(l)) return 8;
  if (/two overcards/.test(l)) return 6;
  if (/gutshot/.test(l)) return 4;
  return counted;
}

// Reason for the equity read — now WITH the math, so the number isn't a mystery.
// Equity vs a range is driven by two things you can eyeball: how strong YOUR hand
// is, and how WIDE their range is. For draws we show the actual decomposition:
//   raw draw equity (Rule of 2 & 4) + the slice of their air you beat unimproved
//   = the % you saw. Each line ends with a memorizable anchor.
function whyRange(
  hc: HandClass,
  width: 'wide' | 'tight',
  equity: number,
  outs: number,
  street: 'Flop' | 'Turn',
  facingBet = false,
  betTypeLabel = '',
): string {
  const isDrawLabel = /draw|over-ender|open-end|gutshot|overcards/i.test(hc.label);
  // a PURE draw (no made pair) vs a made hand that also has draw outs
  const isPureDraw = isDrawLabel && hc.strength < 4 && !/pair/i.test(hc.label);
  const s = hc.strength;
  const eq = Math.round(equity);

  const hand =
    isPureDraw ? `You have a draw (${hc.label}) — outs, but nothing made yet`
    : s >= 4 ? `You have a strong made hand (${hc.label})`
    : s >= 3 ? `You have a solid made hand (${hc.label})`
    : s === 0 ? `You have air (${hc.label}) — no pair, no draw`
    : `You have a weak made hand (${hc.label})`;

  const range =
    width === 'wide'
      ? `their range is wide — mostly unpaired air and weak hands`
      : `their range is tight — big pairs and strong aces, few weak hands`;

  // draw outs read off the LABEL, not countOuts (which over-counts weak-pair "outs").
  const drawO = canonicalDrawOuts(hc, outs);
  // THE NUMBER — where this exact % comes from.
  let math: string;
  if (isPureDraw && drawO > 0) {
    const mult = street === 'Flop' ? 4 : 2; // Rule of 2 & 4
    const hit = drawO * mult; // % chance you complete by the river
    const bump = eq - hit;
    const bumpTxt =
      bump >= 4
        ? `Their air adds ~${bump} pts you scoop unimproved → about ${eq}%.`
        : bump <= -4
        ? `But you must actually hit — their made hands pull it to about ${eq}%.`
        : `That lands right around ${eq}%.`;
    math = `~${drawO} outs → Rule of ${mult}: ${drawO}×${mult} ≈ ${hit}% to hit. ${bumpTxt}`;
  } else if (s === 0) {
    math =
      width === 'wide'
        ? `You win only when you out-flop or bluff — about ${eq}% raw.`
        : `Against strength you're near drawing dead — about ${eq}%.`;
  } else if (s >= 4) {
    math =
      width === 'wide'
        ? `You beat almost their whole range → ~${eq}%.`
        : eq >= 62
          ? `A monster stays ahead of even a tight value range → ~${eq}%.`
          : `Strong, but a tight value range fights back — you're ahead of only part of it → ~${eq}%.`;
  } else if (s >= 3) {
    math =
      width === 'wide'
        ? `You beat all their air and flip with their pairs → ~${eq}%.`
        : `You're only ahead of the worst of a tight range → ~${eq}%.`;
  } else {
    math =
      width === 'wide'
        ? `You beat their air but lose to any pair → a thin ~${eq}%.`
        : `They out-pair or out-kick you most of the time → ~${eq}%.`;
  }
  // made hand that ALSO has draw outs — note the backup equity
  if (!isPureDraw && isDrawLabel && outs > 0) math += ` Plus ~${outs} outs of backup.`;

  // FACING A BET — his range is value-weighted, so the number above is already the
  // DISCOUNTED equity. This is the exact lesson: raw outs × 2/4 over-counts because
  // some of them now lose to the hands that would bet. A value-heavy type (station)
  // discounts hardest; a bluffer (maniac) barely at all.
  if (facingBet) {
    const rawHit = drawO * (street === 'Flop' ? 4 : 2);
    math +=
      isPureDraw && drawO > 0
        ? ` He BET (${betTypeLabel}) — value-weighted, so some draw outs are DIRTY (they hit but still lose).${
            eq < rawHit
              ? ` Real equity ${eq}%, below the raw ${rawHit}%.`
              : ` Raw draw ≈ ${rawHit}%; pair/air backup lifts the real number to ${eq}%.`
          }`
        : ` He BET (${betTypeLabel}) — his range narrows to value, dragging you to ${eq}%.`;
  }

  const hook =
    isPureDraw
      ? `💡 Draw% ≈ outs × ${street === 'Flop' ? 4 : 2}; a wide range adds a few points.`
    : s === 0
      ? `💡 No pair, no draw = behind.`
    : s >= 3
      ? (width === 'wide'
          ? `💡 Strong hand + wide range = crushing.`
          : `💡 Tighter range → less equity for you.`)
    : (width === 'wide'
        ? `💡 Any pair vs a wide range ≈ ahead but thin.`
        : `💡 Weak hand + tight range = behind.`);

  return `${hand}; ${range}. ${math} ${hook}`;
}

// Multiway explanation — the heads-up "vs their range" math doesn't apply when
// you must beat several ranges at once, so it gets its own read.
function whyMultiway(hc: HandClass, equity: number, opps: number): string {
  const eq = Math.round(equity);
  const players = opps + 1;
  const strong = hc.strength >= 3;
  const lesson = strong
    ? `A hand that crushes one opponent gets ground down — every extra player is another chance someone already has you beat.`
    : `Weak and multiway is the worst mix — you're behind more ranges at once and rarely win at showdown.`;
  return `${players}-way pot: you must beat ALL ${opps} opponents at once, so equity ≈ your heads-up share to the power of ${opps}. ${hc.label} lands ~${eq}% here. ${lesson} 💡 A dry board stops draws, not the made hands already sitting in ${opps} ranges — that's why one pair sinks multiway.`;
}

// Map a hand class to its 🎯 anchor-sheet made-hand row. Label-first (top/two pair
// before the generic strong tier) so a "Top Pair + Flush Draw" lands on Top Pair,
// not the set row its "flush" substring would otherwise grab. Returns null for a
// pure draw — those anchor off outs × the Rule of 2 & 4, not a made row.
function madeAnchorRow(hc: HandClass, isPureDraw: boolean): MadeRow | null {
  if (isPureDraw) return null;
  const l = hc.label.toLowerCase();
  if (hc.strength === 0) return MADE_ANCHORS[0]; // Air
  if (/two pair|overpair/.test(l)) return MADE_ANCHORS[3]; // Overpair / two pair
  if (/top pair/.test(l)) return MADE_ANCHORS[2]; // Top pair
  if (hc.strength >= 4) return MADE_ANCHORS[4]; // Set / straight+
  return MADE_ANCHORS[1]; // Weak / 2nd pair
}

// Flush-hazard LEVEL for the anchor: the count (0 / 3 / 4+) of a single suit on the
// board that hero holds NONE of. On a monotone/3-flush board the villain's betting
// range is spade-heavy — made flushes + live flush draws — so a hand that does NOT
// beat a flush (two pair, one pair, set, straight) is worth well below the sheet's
// dry-board average. Mirrors flushDomLevel in the postflop model. 0 = no hazard.
function anchorFlushLevel(hero: Card[], board: Card[]): number {
  const counts = [0, 0, 0, 0];
  for (const c of board) counts[c.suit]++;
  let level = 0;
  for (let s = 0; s < 4; s++) if (counts[s] >= 3 && !hero.some((h) => h.suit === s)) level = Math.max(level, counts[s]);
  return level;
}

// The 🎯 Equity-anchors read, worked live for THIS spot and checked against the true
// equity — so the gut estimate and the real number sit side by side. Mirrors the
// sheet, then makes its two footnotes concrete:
//  • BLUFF-CATCHER collapse — a weak made hand (air w/ showdown, 2nd-or-worse pair)
//    beats worse VALUE almost never, so facing a bet it is NOT "base − 15"; its equity
//    ≈ how often villain BLUFFS. A value-heavy station (bluffFreq 0.08) crushes it to
//    ~15%; a maniac (0.70) leaves it ~50%. Only hands that still beat worse value (top
//    pair+) take the flat size-based cut.
//  • FLUSH-board hazard — a made hand that can't beat a flush, on a monotone board it
//    holds none of, drops further (the sheet's "paired/flush board" footnote).
// The remaining GAP to the truth is the lesson. Heads-up only (multiway is its own
// table). `betFrac` 0 when not facing a bet; `bluffFreq` = villain type's bluff rate.
function anchorRead(
  hc: HandClass,
  width: 'wide' | 'tight',
  equity: number,
  outs: number,
  street: 'Flop' | 'Turn',
  facingBet: boolean,
  betFrac: number,
  betLabel: string,
  hero: Card[],
  board: Card[],
  bluffFreq: number,
): string {
  const eq = Math.round(equity);
  const col = width === 'wide' ? 'WIDE' : 'TIGHT';
  const isDrawLabel = /draw|over-ender|open-end|gutshot|overcards/i.test(hc.label);
  const isPureDraw = isDrawLabel && hc.strength < 4 && !/pair/i.test(hc.label);
  const clamp = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

  let est: number;
  let step: string;
  const row = madeAnchorRow(hc, isPureDraw);
  if (row) {
    est = width === 'wide' ? row.wide : row.tight;
    step = `${row.hero} → vs ${col} ≈ ${est}`;
    // Air and the Weak/2nd-pair row are bluff-catchers — the top two MADE rows.
    const isBluffCatcher = row === MADE_ANCHORS[0] || row === MADE_ANCHORS[1];
    if (facingBet && isBluffCatcher) {
      // Bet SIZE shifts a bluff-catcher's equity: a small/medium bet is a WIDER, thinner
      // range (a station "can't fold" and bets worse pairs + air too) so you catch more;
      // an overbet is polar — only bluffs pay you. Centered on the ⅔-pot baseline the
      // sheet assumes, so ⅔ ≈ no change, ⅓ lifts it, pot/overbet cuts it.
      const sizeAdj = betFrac >= 1.1 ? -9 : betFrac >= 0.85 ? -4 : betFrac <= 0.4 ? 8 : 0;
      const sizeWord = betFrac >= 1.1 ? 'overbet' : betFrac >= 0.85 ? 'pot' : betFrac <= 0.4 ? 'small' : 'medium';
      const bluffPct = Math.round(bluffFreq * 100);
      // The anchor row (≈ 50 / 30) is the PRE-BET number vs his whole range. A bet is
      // value-weighted, so it does NOT subtract a flat cut — it REPLACES that number:
      // a bluff-catcher only keeps what still beats his BETTING range. Spell that out so
      // the drop from the anchor isn't a mystery jump.
      if (row === MADE_ANCHORS[0]) {
        // pure AIR: no showdown value beyond catching a bluff → equity ≈ his bluff
        // rate, wider on a small bet. Station 0.08 → ~14 (a fold); maniac 0.70 → ~40.
        est = clamp(10 + bluffFreq * 45 + sizeAdj);
        step += ` — but that's PRE-bet. He bet (${sizeWord}), a value-weighted range, and air beats none of it → you keep ≈ only his bluff rate (~${bluffPct}%) → ≈ ${est}`;
      } else {
        // a WEAK PAIR beats his bluffs AND every missed OVERCARD/air hand — and a wide
        // range is full of those, so it holds well ABOVE a pure bluff-catcher. Bluff
        // slope + the air it out-showdowns (much bigger vs a wide range) + the bet-size
        // tilt. Station on a wide ⅔ bet → ~24; a small bet lifts it, an overbet cuts it.
        const airBeat = width === 'wide' ? 9 : 3;
        est = clamp(12 + bluffFreq * 40 + airBeat + sizeAdj);
        const beatsBet = clamp(est - bluffPct); // the worse pairs/air he still bets
        step += ` — but that's PRE-bet. He bet (${sizeWord}), a value-weighted range, so instead of a flat cut a bluff-catcher keeps only what beats his BETTING range: ≈ his bluffs (~${bluffPct}%) + the worse pairs/air a ${sizeWord} bet still includes (~${beatsBet}) → ≈ ${est}`;
      }
    } else {
      if (facingBet) {
        const cut = betFrac >= 1 ? 20 : betFrac >= 0.6 ? 15 : 10;
        est = clamp(est - cut);
        step += `, he bet (${betLabel.toLowerCase()}) → made hand −${cut} ≈ ${est}`;
      }
      // Flush-board hazard — only for a made hand that does NOT already beat a flush
      // (a boat/quads/straight-flush, or hero's own flush, is fine). This is what pulls
      // two pair / a set on a monotone board down to its true, much lower number.
      const beatsFlush = /flush|full house|four of a kind/i.test(hc.label) && !/draw/i.test(hc.label);
      const fLevel = anchorFlushLevel(hero, board);
      if (!beatsFlush && fLevel >= 3) {
        const fcut = fLevel >= 4 ? 18 : 8;
        est = clamp(est - fcut);
        step += `, ${fLevel}-flush board & you hold none → −${fcut} ≈ ${est}`;
      }
    }
  } else {
    // pure draw: LABEL outs (canonicalDrawOuts — a gutshot is 4, not the ~10 category
    // cards countOuts sees) × Rule of 2 & 4, +~4 vs a wide range (you scoop some air),
    // then cut facing a bet: overcards HALVE (very dirty — you pair and still lose),
    // a straight/flush draw takes ⅓ (mostly-clean outs, but redraws/reverse-implied).
    const dOuts = canonicalDrawOuts(hc, outs);
    const mult = street === 'Flop' ? 4 : 2;
    const raw = dOuts * mult + (width === 'wide' ? 4 : 0);
    est = clamp(raw);
    step = `~${dOuts} outs → ×${mult}${width === 'wide' ? ' +~4 (wide)' : ''} ≈ ${raw}`;
    if (facingBet) {
      const overcards = /overcards/i.test(hc.label);
      const cut = Math.round(overcards ? raw / 2 : raw / 3);
      est = clamp(raw - cut);
      step += `, he bet → ${overcards ? 'overcards halve (dirty)' : 'cut ⅓ dirty outs'} (−${cut}) ≈ ${est}`;
    }
  }

  const gap = eq - est;
  // Attribute a gap to the likeliest cause given what we KNOW: a high-bluff type can
  // lift a bluff-catcher; otherwise a positive gap is usually a wide range's extra air
  // you out-showdown. Don't blame a "bluffy bettor" when he isn't one (station).
  const higherReason =
    bluffFreq >= 0.35
      ? 'he bluffs more than the sheet assumes, or his range is wider/weaker'
      : "his range is wider/weaker than the anchor assumes — you out-showdown more of his missed air";
  const verdict =
    Math.abs(gap) <= 6
      ? ` — actual ${eq}%, so the anchor nailed it.`
      : gap > 0
        ? ` — actual ${eq}%, ~${gap} higher: ${higherReason}, so you beat more of it.`
        : ` — actual ${eq}%, ~${-gap} lower: his range is stronger than the anchor assumes — a paired/flush board or a value-heavy bettor puts more hands ahead of you.`;
  return `🎯 Anchor read: ${step}%${verdict}`;
}

// Buckets = how you actually think at the table. Boundaries are [lo, hi).
const BANDS = [
  { lbl: 'Drawing / behind', sub: '< 30%', cls: 'bad' },
  { lbl: 'Underdog', sub: '30–45%', cls: 'okv' },
  { lbl: 'Coinflip', sub: '45–55%', cls: 'okv' },
  { lbl: 'Ahead', sub: '55–70%', cls: 'good' },
  { lbl: 'Crushing', sub: '> 70%', cls: 'good' },
];
function bandOf(e: number): number {
  if (e < 30) return 0;
  if (e < 45) return 1;
  if (e < 55) return 2;
  if (e < 70) return 3;
  return 4;
}

function dealHero(): Card[] {
  const a = randomCard([]);
  let b = randomCard([a]);
  while (b.rank === a.rank && b.suit === a.suit) b = randomCard([a]);
  return [a, b];
}

interface Spot { hero: Card[]; board: Card[]; hc: HandClass }

function genSpot(): Spot {
  const hero = dealHero();
  let board = randomFlop('any', hero);
  if (Math.random() < 0.5) board = [...board, randomCard([...hero, ...board])]; // sometimes a turn
  return { hero, board, hc: classifyHandClass(hero, board) };
}

// First spot generated at module load, not during render (Math.random is impure
// and a useState initializer runs in the render phase). Handlers reroll after.
const FIRST_SPOT = genSpot();

export function RangeDrill() {
  const [rangeId, setRangeId] = useState('btn');
  const [opps, setOpps] = useState(1);
  const [betId, setBetId] = useState('b66'); // villain action — default: he BET ⅔
  const [typeId, setTypeId] = useState('lp'); // villain type — default: calling station
  const [rolledRangeId, setRolledRangeId] = useState('btn'); // concrete pick when rangeId = random
  const [rolledTypeId, setRolledTypeId] = useState('lp'); // concrete pick when typeId = random
  const [spot, setSpot] = useState<Spot>(FIRST_SPOT);
  const [guess, setGuess] = useState(50); // your equity guess, 0..100
  const [locked, setLocked] = useState(false); // answer submitted?
  // lifetime calibration score, persisted across sessions (store/drillScore).
  const [score, setScore] = useState(() => loadDrillScore('rangedrill'));
  const [showCheat, setShowCheat] = useState(false);
  const [showAnchors, setShowAnchors] = useState(false);

  // "random" resolves to whatever concrete villain was last rolled (rerolled per spot).
  const effRangeId = rangeId === RANDOM_ID ? rolledRangeId : rangeId;
  const effTypeId = typeId === RANDOM_ID ? rolledTypeId : typeId;
  const ropt = RANGES.find((r) => r.id === effRangeId)!;
  const betOpt = BET_OPTS.find((b) => b.id === betId)!;
  const typeOpt = TYPE_OPTS.find((t) => t.id === effTypeId)!;

  // When villain BETS, condition his range toward value the same way the solver does
  // (betConditionedWeight, scaled by the type's bluffFreq). When he CHECKED, no
  // conditioning — plain equity vs his whole range (the original baseline read).
  const bluffMult = Math.max(0.12, Math.min(1.6, getProfile(effTypeId).bluffFreq / 0.33));
  const comboWeight = useMemo<ComboWeight | undefined>(
    () =>
      betOpt.facing
        ? (a, b) => betConditionedWeight(a, b, spot.board, true, betOpt.frac, bluffMult)
        : undefined,
    [spot.board, betOpt.facing, betOpt.frac, bluffMult],
  );

  // truth — recomputed when the hand, range, opponent count, or villain action changes.
  // 2500 iters is stable to ~±1pt and runs in a few ms. Multiway uses equityVsField vs
  // `opps` copies of the range (comboWeight applied to each) — you must beat them all.
  const equity = useMemo(
    () =>
      (opps <= 1
        ? equityVsRange(spot.hero, spot.board, ropt.range, 2500, undefined, comboWeight)
        : equityVsField(spot.hero, spot.board, Array.from({ length: opps }, () => ropt.range), 2500, undefined, comboWeight)
      ).equity * 100,
    [spot, ropt, opps, comboWeight],
  );
  const trueBand = bandOf(equity);
  const outs = useMemo(() => countOuts(spot.hero, spot.board).outs, [spot]);

  const err = Math.abs(guess - equity);
  const correct = locked && err <= GUESS_TOL;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  function lock() {
    if (locked) return;
    const ok = Math.abs(guess - equity) <= GUESS_TOL;
    setLocked(true);
    setScore(recordDrillScore('rangedrill', ok));
    playGrade(ok);
  }
  function next() {
    if (rangeId === RANDOM_ID) setRolledRangeId(pickId(RANGES)); // fresh villain each deal
    if (typeId === RANDOM_ID) setRolledTypeId(pickId(TYPE_OPTS));
    setSpot(genSpot());
    setLocked(false);
  }
  // any control change re-opens the guess so the new equity is re-read (same hand).
  function switchRange(id: string) { setRangeId(id); if (id === RANDOM_ID) setRolledRangeId(pickId(RANGES)); setLocked(false); }
  function switchOpps(n: number) { setOpps(n); setLocked(false); }
  function switchBet(id: string) { setBetId(id); setLocked(false); }
  function switchType(id: string) { setTypeId(id); if (id === RANDOM_ID) setRolledTypeId(pickId(TYPE_OPTS)); setLocked(false); }

  // keyboard: ←/→ (±2) or ↑/↓ nudge the guess, Enter/Space locks it in, then
  // Enter/Space deals the next spot. Disabled while the cheat sheet is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showCheat || showAnchors) return;
      if (!locked) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setGuess((g) => Math.max(0, g - 2)); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setGuess((g) => Math.min(100, g + 2)); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lock(); }
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const street = spot.board.length === 3 ? 'Flop' : 'Turn';
  const oppLabel = OPP_OPTS.find((o) => o.n === opps)!.label;

  return (
    <>
      <div className="rd-ranges">
        <span className="rd-vs">vs villain:</span>
        {RANGES.map((r) => (
          <button key={r.id} className={`rd-range ${rangeId === r.id ? 'active' : ''}`} onClick={() => switchRange(r.id)}>
            {r.label}
          </button>
        ))}
        <button className={`rd-range ${rangeId === RANDOM_ID ? 'active' : ''}`} onClick={() => switchRange(RANDOM_ID)} title="Face a random position range, rerolled every spot">
          🎲 Random
        </button>
        <button className="rd-cheat" onClick={() => setShowAnchors(true)} title="Equity anchor numbers to calibrate from">
          🎯 anchors
        </button>
        <button className="rd-cheat" onClick={() => setShowCheat(true)} title="How position swings your equity">
          📊 cheat sheet
        </button>
      </div>
      <div className="rd-ranges">
        <span className="rd-vs">opponents:</span>
        {OPP_OPTS.map((o) => (
          <button key={o.n} className={`rd-range ${opps === o.n ? 'active' : ''}`} onClick={() => switchOpps(o.n)} title={`${o.n} player(s) holding this range — you must beat all of them`}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="rd-ranges">
        <span className="rd-vs">his action:</span>
        {BET_OPTS.map((b) => (
          <button key={b.id} className={`rd-range ${betId === b.id ? 'active' : ''}`} onClick={() => switchBet(b.id)} title="A bet narrows his range to value — your raw-outs equity shrinks">
            {b.label}
          </button>
        ))}
      </div>
      {betOpt.facing && (
        <div className="rd-ranges">
          <span className="rd-vs">his type:</span>
          {TYPE_OPTS.map((t) => (
            <button key={t.id} className={`rd-range ${typeId === t.id ? 'active' : ''}`} onClick={() => switchType(t.id)} title="How value-heavy his bet is — a station barrels value, a maniac fires air">
              {t.label}
            </button>
          ))}
          <button className={`rd-range ${typeId === RANDOM_ID ? 'active' : ''}`} onClick={() => switchType(RANDOM_ID)} title="Face a random villain type, rerolled every spot">
            🎲 Random
          </button>
        </div>
      )}
      {showCheat && <PositionCheatSheet onClose={() => setShowCheat(false)} />}
      {showAnchors && <EquityAnchors onClose={() => setShowAnchors(false)} />}
      <div className="rd-rangenote">
        {(rangeId === RANDOM_ID || typeId === RANDOM_ID) && '🎲 '}
        {ropt.note}
        {betOpt.facing ? ` · he ${betOpt.label.toLowerCase()} as a ${typeOpt.label.replace(/^\S+\s/, '')} → range weighted to value` : ' · checked to you — full range'}
        {opps > 1 && ` · ${opps} of them — you must beat all at once (equity collapses multiway)`}
      </div>

      <div className="quiz-score rd-score">
        Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)
        {score.total > 0 && (
          <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore('rangedrill'))} title="Reset your saved score">↺</button>
        )}
        <span className="muted"> ←/→ adjust · Enter locks · within ±{GUESS_TOL}% counts</span>
      </div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand · {spot.hc.label}</span>
          <div className="lab-cards">{spot.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">{street}</span>
          <div className="lab-cards">{spot.board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
      </div>

      {!locked && (
        <div className="lab-prompt">
          Your equity vs <b>{ropt.label}</b>{betOpt.facing && <> ({typeOpt.label})</>}{opps > 1 && <> ({oppLabel})</>}?
        </div>
      )}

      <div style={{ margin: '0.75rem 0' }}>
        <input
          type="range"
          min={0}
          max={100}
          value={locked ? Math.round(equity) : guess}
          disabled={locked}
          onChange={(e) => setGuess(+e.target.value)}
          style={{ width: '100%' }}
          aria-label="equity guess percent"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <span className="big-stat gold">{locked ? equity.toFixed(1) : guess}%</span>
          {!locked ? (
            <button className="btn btn-deal" onClick={lock}>Lock in</button>
          ) : (
            <span className={correct ? 'good' : 'bad'}>
              you said {guess}% · off by {err.toFixed(0)} pts
            </span>
          )}
        </div>
      </div>

      {locked && (
        <>
          <div className="rd-truth">
            <div className="stat-lbl">true equity{betOpt.facing ? ` vs ${typeOpt.label}'s ${betOpt.label.toLowerCase()}` : ` vs ${ropt.label}`}{opps > 1 && `, ${oppLabel}`} → <b>{BANDS[trueBand].lbl}</b></div>
          </div>
          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct
              ? `✓ Calibrated — ${equity.toFixed(1)}% (you were ${err.toFixed(0)} pts off).`
              : `✗ Off by ${err.toFixed(0)} pts — it's ${equity.toFixed(1)}% (${BANDS[trueBand].lbl}), you said ${guess}%.`}
            <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
          </div>
          <div className="drill-hook">
            <span className="drill-hook-tag">💡 Why</span>
            <p>{opps > 1 ? whyMultiway(spot.hc, equity, opps) : whyRange(spot.hc, ropt.width, equity, outs, street, betOpt.facing, typeOpt.label)}</p>
            {opps === 1 && (
              <p className="rd-anchor">{anchorRead(spot.hc, ropt.width, equity, outs, street, betOpt.facing, betOpt.frac, betOpt.label, spot.hero, spot.board, getProfile(effTypeId).bluffFreq)}</p>
            )}
          </div>
          <div className="rd-tip">
            Tip: flip <i>his action</i> (checked → bets pot) or <i>his type</i> (maniac → station) on the same hand — watch a
            bet drag your equity down, and a value-heavy type drag it further. That gap is the raw-outs discount you can't read off a chart.
          </div>
        </>
      )}
    </>
  );
}
