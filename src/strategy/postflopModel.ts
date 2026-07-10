// Heuristic postflop "solver-model". For a node it estimates each action's EV
// (in bb) from equity-vs-range + a fold-equity model, then derives a mixed
// strategy. NOT a Nash solve — a fast, transparent approximation.

import type { Card } from '../engine/cards';
import { makeDeck, sameCard, makeRng } from '../engine/cards';
import type { WeightedRange, ComboWeight } from '../engine/range';
import { buildSampleTable, sampleCombo } from '../engine/range';
import { equityVsRange, equityVsField, countOuts, exactOutsEquity } from '../engine/equity';
import { evaluate7 } from '../engine/evaluator';
import { requiredEquityForBet } from '../engine/potOdds';
import { classifyFlop, boardWetScore } from '../engine/board';
import type { TextureInfo } from '../engine/board';
import type { ActionId, ActionOption, NodeStrategy } from './types';
import { mixFromEv } from './types';

// Classification of an aggressive line by hero equity (+ draw), so the explanation
// distinguishes a real bluff from thin value / a semi-bluff / a made bluff-catcher.
type BetClass = 'value' | 'thin' | 'semibluff' | 'marginal' | 'bluff';
function classifyBet(eHU: number, eField: number, outs: number, hasMade: boolean): BetClass {
  // value / thin value require an actual MADE hand (pair or better). A big draw can
  // sit at >60% equity vs a wide range, but it's a SEMI-BLUFF, not a value bet — so
  // it must NOT borrow the made-hand "you're ahead, get worse hands to call" story
  // (worse hands FOLD to the bet; the draw wins by folds + improving, not by calls).
  //
  // MULTIWAY GUARD: heads-up equity (eHU, vs the ONE caller a bet isolates) and field
  // equity (eField, vs EVERYONE) diverge hard in a 3-way+ pot — bottom pair can be
  // ~50% heads-up yet only ~32% vs two players. If we tier off eHU alone, that hand is
  // painted "thin value" (green, "get worse hands to call") while buildNote — which
  // reads the field equity — calls the very same bet a bluff ("profits only from
  // folds"). Same action, opposite stories. Requiring value/thin to clear BOTH a
  // heads-up favourite AND a not-sunk-vs-field bar keeps the colour and the note
  // consistent: a hand that's behind the field can no longer read as value.
  if (hasMade && eHU >= 0.62 && eField >= 0.5) return 'value';
  if (hasMade && eHU >= 0.5 && eField >= 0.45) return 'thin';
  // A SEMI-BLUFF requires a genuine DRAW (gutshot up, ~4+ outs). This MUST key on
  // outs, not on eHU: a made bluff-catcher can sit at eHU ≥ 0.3 with NO draw at all,
  // and betting it isn't a semi-bluff (the old `eHU >= 0.3` trigger mislabelled 88 on
  // 9-7-7 as "semi-bluff — keep barreling cards that complete your draw", a draw that
  // doesn't exist).
  if (outs >= 4) return 'semibluff';
  // Made hand that failed the value/thin bars and holds no draw: a bluff-catcher /
  // pure showdown hand. A bet folds out the worse hands it beats and is called only by
  // better, so it can neither get value nor semi-bluff — it wants to CHECK. Give it its
  // own class (coloured passive, so the bet reads as neither value nor bluff) and let
  // the EV mix pick the check.
  if (hasMade) return 'marginal';
  return 'bluff';
}
// kind drives grid/bar color: value (green), bluff (orange), and a marginal made
// bluff-catcher as passive (blue) — a bet with it is a mistake, not a value/bluff line.
const classKind = (c: BetClass): ActionOption['kind'] =>
  c === 'value' || c === 'thin' ? 'value' : c === 'marginal' ? 'passive' : 'bluff';

/** Flush-domination LEVEL: the count (0, 3, 4 or 5) of a single suit on the board
 *  that hero holds NONE of. It matters how many, because the threat is very
 *  different by count:
 *   • 4–5 on board: ANY opponent with a single card of the suit already HAS a made
 *     flush hero can't beat — the calling/raising range is a wall of flushes, so a
 *     no-flush bet almost never wins (a trap the generic model under-rates).
 *   • exactly 3 (a monotone / 3-flush flop): a MADE flush needs BOTH of villain's
 *     hole cards to be that suit — rare. Most in-suit hands are single-suit DRAWS
 *     that hero's made hand still beats, so betting to charge/deny them is fine;
 *     only a mild discount is warranted, not the 4-flush collapse.
 *  (At most one suit can reach 3+ on a ≤5-card board.) 0 = not flush-dominated. */
function flushDomLevel(hero: Card[], board: Card[]): number {
  const counts = [0, 0, 0, 0];
  for (const c of board) counts[c.suit]++;
  let level = 0;
  for (let s = 0; s < 4; s++) {
    if (counts[s] >= 3 && !hero.some((h) => h.suit === s)) level = Math.max(level, counts[s]);
  }
  return level;
}

/** GTO bluff frequency for a bet of `frac`×pot on the river, and value:bluff ratio.
 *  Memo: the bluff fraction equals the equity a caller needs at this size — same
 *  number, so `requiredEquityForBet` is the single source for both. */
function riverBalance(frac: number): string {
  const bluffFrac = requiredEquityForBet(frac);
  const ratio = (1 - bluffFrac) / Math.max(0.001, bluffFrac);
  return ` River balance: this size wants ~${Math.round(bluffFrac * 100)}% bluffs (≈ ${ratio.toFixed(1)} : 1 value-to-bluff).`;
}

/** Compact range-balance chip for a BET/RAISE of `frac`×pot. On the river a bet is
 *  polarized, so the meaningful number is the value:bluff BALANCE (how many bluffs
 *  this size wants). On the flop/turn there's no clean bluff% (semi-bluffs have
 *  equity, ranges aren't polarized), so show the opponent's MINIMUM-DEFENCE
 *  frequency instead — how much of their range must continue vs this size,
 *  = pot/(pot+bet) = 1/(1+frac). Both are honest per street; a fake bluff% on the
 *  flop is exactly what this avoids. */
function sizeBalanceNote(frac: number, river: boolean): string {
  if (river) {
    const bluff = requiredEquityForBet(frac);
    const ratio = (1 - bluff) / Math.max(0.001, bluff);
    return `⚖ ~${Math.round(bluff * 100)}% bluffs · ${ratio.toFixed(1)}:1 value:bluff`;
  }
  const mdf = 1 / (1 + Math.max(0, frac));
  return `villain must defend ~${Math.round(mdf * 100)}% vs this size (MDF)`;
}

// River call wording. The river is a pure pot-odds spot (no more cards, no
// implied odds) and a river BET is polarized — strong value + bluffs, little in
// between. A medium hand is therefore a BLUFF-CATCHER: it beats only his bluffs,
// never his value, and can't improve, so its equity ≈ how often he's bluffing.
function riverCallNote(isRiver: boolean, e: number, need: number): string {
  if (!isRiver) return '';
  if (e >= 0.7)
    return ` River read: your ~${Math.round(e * 100)}% beats enough of his value that this is a value call — raising mostly folds out the bluffs you beat, so calling captures them.`;
  return ` River = pure pot odds (no more cards, no implied odds), and a river bet is POLARIZED — strong value + bluffs, little between. This is a BLUFF-CATCH: you beat his bluffs, never his value, and can't improve, so your ~${Math.round(e * 100)}% is really "how often is he bluffing?". Call only if that clears the ${Math.round(need * 100)}% price AND he actually bluffs here — vs a player who never bluffs, fold.`;
}

function whyBet(
  c: BetClass,
  e: number,
  d: { fe: number; e2: number; contFrac?: number },
  outs: number,
  isAllIn: boolean,
  river: boolean,
  frac: number,
): string {
  const fe = `${Math.round(d.fe * 100)}%`;
  const eq = `${Math.round(e * 100)}%`;
  const e2 = `${Math.round(d.e2 * 100)}%`;
  const cont = d.contFrac != null ? `${Math.round(d.contFrac * 100)}%` : '';
  let base: string;
  switch (c) {
    case 'value':
      base = isAllIn
        ? `Value shove — but a jam folds out every worse hand and gets called almost only by what beats you${cont ? ` (~${cont} of his range continues, the strong part)` : ''}, so your equity WHEN CALLED drops to ~${e2}. Worth it only when committed (low SPR) or vs a station who won't fold — otherwise a sized value bet that keeps worse hands in prints more across streets.`
        : `Value bet: you're ahead (~${eq}). Bet to get WORSE hands to call and build the pot${cont ? ` — ~${cont} of his range continues at this size` : ''}. Size to the worst hand that still calls: too big and you fold out your customers and get called only by what beats you, too small and you leave value behind.`;
      break;
    case 'thin':
      base = `Thin value / merge: only a slight favourite (~${eq}). Bet to get called by worse — but size down, you're not strong enough to bloat the pot.`;
      break;
    case 'semibluff':
      base = `Semi-bluff: ~${eq} equity now${outs > 0 ? ` with ~${outs} outs` : ''}. Two ways to win — villain folds ~${fe}, and when called you still hit ~${e2} of the time. Keep barreling cards that complete your draw.`;
      break;
    case 'marginal':
      base = `Marginal made hand — a bluff-catcher (~${eq} equity) with no draw. Betting folds out the worse hands you beat and gets called only by better, so it can't make value; and with no draw there's nothing to semi-bluff. Check for pot control and showdown value instead — especially multiway, where a made hand this thin is rarely ahead of the range that continues.`;
      break;
    default:
      base = `Pure bluff: ~${eq} equity — essentially drawing thin. Only profitable via fold equity (~${fe}); pick good blocker cards and a believable story, otherwise just give up.`;
  }
  return river ? base + riverBalance(frac) : base;
}

export interface PostflopInput {
  hero: Card[];
  board: Card[];
  oppRange: WeightedRange;
  /** ranges of EVERY live opponent (for multiway equity). Falls back to [oppRange]
   *  when omitted. >1 entry → hero must beat the whole field, so equity/EV drop. */
  oppRanges?: WeightedRange[];
  pot: number; // chips in middle before hero acts (incl. villain bet)
  toCall: number; // chips to call (0 if can check)
  heroCommitted: number; // chips hero already put this street
  currentBet: number; // highest committed this street
  minRaiseTo: number;
  maxRaiseTo: number; // all-in target
  canCheck: boolean;
  canRaise: boolean;
  bigBlind: number;
  iterations?: number;
  rangeNote?: string;
  heroCode?: string;
  /** hero's position vs the villain — affects equity realisation & fold equity. */
  position?: 'ip' | 'oop';
  /** effective stack BEHIND (chips still wagerable), in chips = min(hero, villain).
   *  Drives implied odds (draws win more on later streets) and the all-in risk
   *  premium (a deep shove risks far more than a shallow one). Falls back to the
   *  hero's remaining stack when omitted. */
  effStack?: number;
  /** precomputed hero equity (0..1). When provided, the model reuses it instead of
   *  running its OWN Monte-Carlo — so the solver panel and the HUD pot-odds panel
   *  read the identical number and can't contradict each other on a thin spot. */
  precomputedEquity?: number;
  /** board+action range conditioning. Used to discount implied odds by how often a
   *  draw that hits actually WINS vs the villain's *conditioned* betting range
   *  (clean outs), instead of crediting every raw out as a winner. */
  comboWeight?: ComboWeight;
}

interface Candidate {
  id: ActionId;
  label: string;
  ev: number; // bb
  amount?: number;
  sizePct?: number;
  calledEq?: number; // hero equity vs the range that continues (bets/raises only)
  kind: ActionOption['kind'];
  why?: string;
  math?: string;
  sizeNote?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Binomial pmf P(K=k) for small n — used to average hero's equity-when-called over
 *  the number of opponents who actually continue against a bet. */
function binomPmf(n: number, k: number, p: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

/** Narrative overview shown above the option grid. Composed from spot-specific
 *  signals so different spots read differently — an equity tier, how far the
 *  price is from the equity (when facing a bet), ONE street-specific idea, a
 *  texture warning only when the texture actually shifts the maths, and stack
 *  depth only when it binds. Replaces the old single template, which printed
 *  the same skeleton for every spot and read as boilerplate. */
function buildNote(a: {
  e: number;
  eHU: number;
  nOpp: number;
  street: 'flop' | 'turn' | 'river';
  P: number;
  C: number;
  bb: number;
  outs: number;
  cardsToCome: number;
  hasMade: boolean;
  implied: number;
  cleanFrac: number;
  flushLevel: number;
  tex: TextureInfo | null;
  wet01: number;
  spr: number;
  sprKnown: boolean;
  canRaise: boolean;
}): string[] {
  const s: string[] = [];
  const ePct = Math.round(a.e * 100);

  // 1) where the hand stands — tiered. Heads-up the bar is 50%; MULTIWAY the bar
  // is your FAIR SHARE (1/players), so a "low" field equity can still be the best
  // hand at the table. Tier off the right bar or a favourite reads as "behind"
  // and then contradicts the "you're committed, bet big" advice below.
  const field =
    a.nOpp > 1 ? ` in this ${a.nOpp + 1}-way pot (you must beat everyone at once — each extra player cuts your share)` : '';
  if (a.nOpp > 1) {
    const fair = 1 / (a.nOpp + 1);
    const fairPct = Math.round(fair * 100);
    const r = fair > 0 ? a.e / fair : 1; // multiples of an even share
    if (r >= 1.6)
      s.push(`You'd win about ${ePct}%${field} — well above an even ${fairPct}% share, so you're the favourite of the field (even if the pack as a whole still beats you most hands).`);
    else if (r >= 1.15)
      s.push(`You'd win about ${ePct}%${field} — above your ${fairPct}% fair share: ahead of the pack, not behind it.`);
    else if (r >= 0.85)
      s.push(`You'd win about ${ePct}%${field} — right around an even ${fairPct}% share: middle of the pack.`);
    else
      s.push(`You'd win only about ${ePct}%${field} — below an even ${fairPct}% share, genuinely behind this field.`);
  } else if (a.e >= 0.65) s.push(`You'd win about ${ePct}% of showdowns — a clear favourite.`);
  else if (a.e >= 0.5) s.push(`You'd win about ${ePct}% — slightly ahead, but not by enough to pile money in.`);
  else if (a.e >= 0.35) s.push(`You'd win about ${ePct}% — behind, but live.`);
  else if (a.e >= 0.2) s.push(`You'd win only about ${ePct}% — well behind the ranges you're up against.`);
  else s.push(`You'd win only about ${ePct}% — you're beaten almost everywhere.`);

  // 2) the price, when facing a bet — say HOW FAR off it is, not just the numbers
  if (a.C > 0) {
    const need = a.C / (a.P + a.C);
    const needPct = Math.round(need * 100);
    const gapPts = Math.round((a.e - need) * 100);
    const draw = a.implied > 0;
    if (gapPts >= 8) s.push(`The price is great: you need ${needPct}% and have ~${ePct}% — ${gapPts} points to spare, calling clearly makes money.`);
    else if (gapPts >= 2) s.push(`The price works: you need ${needPct}% and have ~${ePct}%, a ${gapPts}-point edge.`);
    else if (gapPts > -2) s.push(`Razor-thin: you need ${needPct}% and have ~${ePct}%. Either line costs almost nothing — coin-flips like this barely matter.`);
    else if (gapPts > -8)
      s.push(
        `You're ${-gapPts} points short of the ${needPct}% the price demands${draw ? ' on raw equity — only the implied odds from hitting your draw can rescue a call' : ' — a fold, unless this opponent bluffs noticeably too often'}.`,
      );
    else s.push(`You're nowhere near the price: ${needPct}% needed vs ~${ePct}% held, ${-gapPts} points short. ${draw ? 'Even with a draw the maths is not close.' : 'Calling burns money no matter how the hand "feels".'}`);
  }

  // 3) exactly one street-specific idea
  if (a.street === 'river') {
    if (a.C > 0 && a.e >= 0.65)
      s.push(`On the river nothing can improve, but you beat enough of his betting range that this is a value call — raising only folds out the bluffs you already beat.`);
    else if (a.C > 0)
      s.push(
        `On the river nothing can improve: a medium hand is a pure bluff-catcher, so that ~${ePct}% really asks "how often is this bet a bluff?". River bets are polarized — strong value and bluffs, little between.`,
      );
    else if (a.hasMade && a.eHU >= 0.62)
      s.push(`On the river no more cards are coming, so bet to get WORSE hands to call — with a made hand this strong you profit every time a weaker hand pays you off, and checking a value hand just leaves that money behind.`);
    else if (a.hasMade && a.eHU >= 0.5)
      s.push(`On the river no more cards are coming: only a slight favourite, so this is thin value — a small bet gets called by worse, but don't bloat the pot.`);
    else
      s.push(`On the river no more cards are coming, so a bet only makes money when MORE worse hands call than better ones — with a middling hand, checking usually beats betting.`);
  } else if (a.outs >= 4 && a.e < 0.55) {
    const hit = Math.round(exactOutsEquity(a.outs, a.cardsToCome));
    s.push(
      `You have ~${a.outs} outs — roughly ${hit}% to get there ${a.cardsToCome === 1 ? 'on the river (the ×2 rule)' : 'by the river (the ×4 rule)'}.${
        a.implied > 0
          ? ` Chips behind add implied odds (~${(a.implied / a.bb).toFixed(1)}bb extra when you hit), but only ~${Math.round(a.cleanFrac * 100)}% of those outs win cleanly against this range, so the draw is discounted.`
          : ''
      }`,
    );
  } else if (a.nOpp > 1 && !a.hasMade) {
    s.push(`Multiway, a bet mainly thins the field: with fewer players in, a modest hand wins far more often, and a small bet denies free cards.`);
  } else if (a.cardsToCome === 1) {
    s.push(
      a.wet01 >= 0.35
        ? `One card to come, but the board is draw-heavy — straight/flush draws can still complete on the river, so charge them now rather than treating ranges as set.`
        : `One card to come: ranges are nearly set, so think in terms of value hands vs bluff-catchers rather than draws.`,
    );
  }

  // 4) texture, only when it actually changes the maths
  if (a.flushLevel >= 4)
    s.push(
      `Danger: ${a.flushLevel} cards of one suit are on board and you hold none — ANY single card of that suit already beats you, so the range that continues against a bet is a wall of flushes.`,
    );
  else if (a.flushLevel === 3)
    s.push(`Three of one suit are out and you hold none — made flushes are rare (both hole cards must match), but flush draws are everywhere: charge them, don't panic.`);
  else if (a.tex?.connected && a.hasMade && a.e < 0.62)
    s.push(`The board is connected, so straights are live — a one-pair hand shrinks on boards like this.`);
  else if (a.tex?.paired && !a.hasMade && a.e < 0.5)
    s.push(`The board is paired — trips and full houses are possible, and drawing hands lose value when the board can fill up.`);

  // 5) stack depth, only when it binds
  if (a.sprKnown && a.P > 0) {
    if (a.spr < 1) s.push(`SPR ${a.spr.toFixed(1)} — barely a pot-sized bet behind, so the money goes in fast: commit or fold, no room to maneuver.`);
    else if (a.spr > 4 && a.street !== 'river')
      s.push(`Stacks are deep (SPR ${a.spr.toFixed(1)}): big pots want big hands, and position and later streets matter more than this one bet.`);
  }

  // 6) sizing guidance, only when hero can actually bet/raise. The value tier
  // needs BOTH numbers: eHU (a raise only has to beat the one caller) AND the
  // field equity e — otherwise a hand that's "well behind" multiway gets told
  // it can value-bet, contradicting the opening sentence.
  if (a.canRaise) {
    const verb = a.C > 0 ? 'raise' : 'bet';
    if (a.sprKnown && a.spr < 1 && a.eHU >= 0.6)
      s.push(`SPR is under 1 and you hold a strong hand, so you're committed: the stack goes in over the streets regardless. Any committing size is close in EV — a token ${verb} just gives draws a cheap card first, so ${verb} big (or jam) and take the equity now.`);
    else if (a.street !== 'river' && a.wet01 >= 0.35 && a.e >= 0.5 && a.eHU >= 0.6)
      s.push(`The board is draw-heavy, so ${verb} bigger — charging the straight/flush draws and denying their equity is worth more than the extra thin calls a small ${verb} would pick up.`);
    else if (a.eHU >= 0.65 && (a.C === 0 || a.e >= 0.5))
      s.push(`You're strong enough to ${verb} for value — size to the worst hand that still calls; oversizing folds out your customers.`);
    else if (a.eHU >= 0.45 && a.e >= 0.35)
      s.push(`Bigger bets only get called by stronger hands, so with a hand this strength ${verb === 'raise' ? 'raising' : 'betting'} huge or shoving isn't rewarded.`);
    else s.push(`With this little equity a ${verb} is a bluff — it profits only from folds, so it needs a believable story and good blockers, not a "maybe I'm good" hope.`);
  }

  s.push(`This is a quick estimate to guide you, not a perfect solver.`);
  return s;
}

export function solvePostflop(inp: PostflopInput): NodeStrategy {
  const ranges = inp.oppRanges && inp.oppRanges.length ? inp.oppRanges : [inp.oppRange];
  const nOpp = ranges.length;
  const iters = inp.iterations ?? 1200;
  // multiway: hero must beat the whole field, so equity is lower than heads-up.
  // Reuse the caller's equity when supplied (shared with the HUD); otherwise run
  // our own Monte-Carlo (drills call this directly without a precomputed number).
  const e =
    inp.precomputedEquity ??
    (nOpp > 1
      ? equityVsField(inp.hero, inp.board, ranges, iters).equity
      : equityVsRange(inp.hero, inp.board, inp.oppRange, iters).equity);
  // Heads-up equity vs the villain's range — the number that matters WHEN HERO BETS.
  // A value bet only has to beat the ONE opponent who calls, not the whole field, so
  // equity-when-called is based on this, NOT the multiway field equity `e` (which is
  // correctly lower because a checked-down showdown must beat everyone). Conflating
  // the two made overpairs look like check-only semibluffs and graded a bet a blunder.
  const eHU = nOpp > 1 ? equityVsRange(inp.hero, inp.board, inp.oppRange, iters).equity : e;
  const P = inp.pot;
  const C = inp.toCall;
  const bb = inp.bigBlind;

  // outs for semi-bluff vs pure-bluff labelling (meaningful flop/turn only)
  const outs = inp.board.length >= 3 && inp.board.length < 5 ? countOuts(inp.hero, inp.board).outs : 0;
  const isRiver = inp.board.length === 5;
  // does hero hold a MADE hand (pair or better)? gates value-vs-semibluff labelling
  // so a high-equity DRAW is called a semi-bluff, not a value bet. Must be measured
  // as a LIFT over the bare board — on a paired board every hand "has" the board's
  // pair, and the absolute check labelled K-high on AAQT a value bet.
  const hasMade =
    inp.board.length >= 3 &&
    evaluate7([...inp.hero, ...inp.board]).categoryRank > evaluate7(inp.board).categoryRank;

  const tex = inp.board.length >= 3 ? classifyFlop(inp.board) : null;
  const wetness =
    tex == null
      ? 0
      : (tex.connected ? 0.06 : 0) + (tex.suitPattern !== 'rainbow' ? 0.05 : 0) + (tex.paired ? -0.03 : 0);
  // 0..1 draw-pressure, from the shared wet score (dry 0 · semi ~0.4 · wet ≥0.8). Drives
  // the equity-denial (charge draws) and multi-street (keep worse hands in) tradeoff so
  // sizing follows texture: small on dry, big on wet. Same source as the Dry/Wet badge.
  const wet01 = tex == null ? 0 : Math.min(1, boardWetScore(inp.board) / 2.5);

  // hero can't make the board flush and holds none of it → flush-dominated (see
  // helper). The LEVEL (3 vs 4+) scales the fold-equity/equity-when-called penalty
  // in computeAggro; `flushDom` (level ≥ 3) drives the qualitative "no redraw" read.
  const flushLevel = inp.board.length >= 3 ? flushDomLevel(inp.hero, inp.board) : 0;
  const flushDom = flushLevel >= 3;

  // position: in position you act last, so you realise more of your equity
  // (free cards, pot control) and your bets carry a touch more fold equity;
  // out of position the opposite. 1.0 = neutral when position is unknown.
  const oop = inp.position === 'oop';
  const ip = inp.position === 'ip';
  const realize = ip ? 1.06 : oop ? 0.9 : 1.0;
  const feMult = ip ? 1.1 : oop ? 0.9 : 1.0;
  const eReal = Math.min(1, e * realize);

  // ---- depth: effective stack behind + SPR ----
  // The thing the pure pot-odds EV ignores. effStack = chips still wagerable
  // (min of hero vs villain). SPR drives implied odds for draws and the all-in
  // risk premium below — so the SAME spot plays differently 100bb vs 800bb deep.
  const effStack = inp.effStack ?? Math.max(0, inp.maxRaiseTo - inp.heroCommitted);
  const cardsToCome = inp.board.length === 3 ? 2 : inp.board.length === 4 ? 1 : 0;
  const spr = P > 0 ? effStack / P : 0;
  // Implied odds for a CALL with a draw: when it completes on a later street hero
  // wins EXTRA chips beyond today's pot — future bets villain pays off. That money
  // is bounded by the stack behind, so deeper stacks = bigger implied odds. Only
  // credited for real draws (>=4 outs) not already ahead, on flop/turn (the river
  // has no "later street", so depth correctly adds nothing there).
  let implied = 0;
  let cleanFrac = 1; // share of outs that, when they hit, actually WIN vs his range
  if (cardsToCome > 0 && C > 0 && outs >= 4 && e < 0.55) {
    const pHit = Math.min(0.9, exactOutsEquity(outs, cardsToCome) / 100);
    const behind = Math.max(0, effStack - C); // wagerable after the call
    const futureBet = Math.min(behind, 0.6 * (P + C)); // ~⅔-pot payoff, capped by stack
    // CLEAN OUTS: not every out is a winner. On a wet board a draw to two pair can
    // hit and still lose to a flush / better two pair, and a "scary" card may stop
    // villain paying. Scale implied odds by how often hitting actually wins vs his
    // (conditioned) range — so optimistic draw-calls get pulled back toward fold.
    cleanFrac = winIfHit(inp.hero, inp.board, inp.oppRange, inp.comboWeight);
    implied = pHit * futureBet * realize * cleanFrac;
  }

  const cands: Candidate[] = [];

  // passive line
  if (inp.canCheck) {
    // On the river an IP check-back is pure showdown — no realisation boost
    // applies (there are no more cards to realise anything with). The OOP
    // discount stays: checking OOP still lets villain bet you off your share.
    const checkEq = isRiver && !oop ? e : eReal;
    const posClause = inp.position
      ? ` (${ip ? 'in position you realise it well — you can check back and take a free card' : 'out of position you realise less — villain can barrel you off it'})`
      : '';
    const checkBase = `Realize your ~${pct(e)} equity in a ${P}-chip pot without risking more${posClause}.`;
    // Reason to check depends on WHY betting is worse — a strong made hand can be
    // best-checked on a dangerous board, which is NOT the same as "no edge".
    const checkWhy =
      flushDom && e >= 0.5
        ? `${checkBase} You're AHEAD now — but the board is flush-heavy and you hold NONE of that suit, so you have no redraw. Betting folds out the hands you beat and gets called or raised by the made flushes & flush draws that crush or outdraw you. Check to pot-control, keep his bluffs in, and don't bloat a pot you can't safely build with a no-flush hand.`
        : e >= 0.6
          ? `${checkBase} You're ahead, but betting here mostly folds out the worse hands you beat and bloats the pot against the part of his range that continues. Checking captures more by keeping his weaker hands and bluffs in while you control the pot.`
          : `${checkBase} Best when you're not ahead enough to bet for value or to profitably pressure.`;
    cands.push({
      id: 'check',
      label: 'Check',
      ev: (checkEq * P) / bb,
      kind: 'passive',
      why: checkWhy,
      math: `EV = equity × pot${checkEq !== e ? ` × realise(${realize})` : ''} = ${pct1(checkEq)} × ${P} = ${(checkEq * P).toFixed(1)} chips ≈ ${((checkEq * P) / bb).toFixed(2)} bb`,
    });
  }
  if (C > 0) {
    const need = C / (P + C);
    // A river call CLOSES the action: there are no later streets to be outplayed
    // on, so the position realisation factor must NOT apply — you always get to
    // showdown for exactly your equity. (Flop/turn calls keep it: OOP you realise
    // less of the equity you're paying for.)
    const callEq = isRiver ? e : eReal;
    const evCall = (callEq * (P + C) - C + implied) / bb;
    cands.push({
      id: 'fold',
      label: 'Fold',
      ev: 0,
      kind: 'fold',
      // Say the truth about the price: when the call makes money, folding is the
      // line that gives up EV — don't tell the user they "only have" enough. The
      // raw price (e vs need) and the full EV (with implied odds + realisation)
      // can disagree, so the wording keys on BOTH, never claiming "price met"
      // when only implied odds carry the call.
      why:
        evCall > 0.05
          ? e >= need
            ? `You need ${pct(need)} equity and have ~${pct(e)} — the price is met, so folding surrenders a profitable call. Fold only with a strong read that this opponent never bluffs here.`
            : `The raw price isn't met (~${pct(e)} vs ${pct(need)} needed), but implied odds make calling profitable — folding still surrenders EV.`
          : e >= need
            ? `~${pct(e)} vs ${pct(need)} needed — technically enough, but the call is about break-even at best once realisation is counted, so folding gives up almost nothing.`
            : `You need ${pct(need)} equity to call but only have ~${pct(e)}. Folding forfeits the pot but loses the least.`,
      math: `Pot odds: need = call ÷ (pot + call) = ${C} ÷ ${P + C} = ${pct(need)}; you have ~${pct(e)}.\nEV(fold) = 0 bb (you put in nothing more).`,
    });
    cands.push({
      id: 'call',
      label: `Call ${C}`,
      ev: evCall,
      kind: 'passive',
      why: `Pot odds require ${pct(need)}; you have ~${pct(e)}, so calling is ${evCall > 0.05 ? 'profitable' : evCall > -0.05 ? 'about break-even' : '-EV'}.${
        !isRiver && oop ? ' Out of position you realise less of that equity, so call tighter.' : !isRiver && ip ? ' In position you realise it well.' : ''
      }${implied > 0 ? ` Implied odds add ~${(implied / bb).toFixed(1)}bb: ${effStack} behind (SPR ${spr.toFixed(1)}) pays you off when the draw lands — but only ~${Math.round(cleanFrac * 100)}% of your outs actually win vs his range here, so the draw is discounted (clean outs, not raw outs).` : ''}${riverCallNote(isRiver, e, need)}`,
      math: `Pot odds: need = call ÷ (pot + call) = ${C} ÷ ${P + C} = ${pct(need)} (you have ~${pct(e)}).\nEV = equity × (pot + call) − call${implied > 0 ? ' + implied' : ''} = ${pct1(callEq)} × ${P + C} − ${C}${implied > 0 ? ` + ${implied.toFixed(1)} (implied odds, after a ${Math.round(cleanFrac * 100)}% clean-out discount)` : ''} = ${(callEq * (P + C) - C + implied).toFixed(1)} chips ≈ ${((callEq * (P + C) - C + implied) / bb).toFixed(2)} bb`,
    });
  }

  // aggressive lines
  const potForSize = P + C; // pot if hero just calls
  const addBet = (id: ActionId, frac: number, label: string) => {
    if (!inp.canRaise) return;
    let target: number;
    if (C === 0) target = Math.round(inp.heroCommitted + frac * P);
    else target = Math.round(inp.currentBet + frac * potForSize);
    target = Math.max(target, inp.minRaiseTo);
    target = Math.min(target, inp.maxRaiseTo);
    if (target >= inp.maxRaiseTo) return; // becomes all-in; handled separately
    const d = computeAggro(eHU, P, C, target, inp.currentBet, inp.heroCommitted, wetness, false, realize, feMult, nOpp, effStack, cardsToCome, e, flushLevel, wet01);
    const cls = classifyBet(eHU, e, outs, hasMade);
    const sv = d.streetValue > 0.05;
    const dv = d.denial > 0.05;
    cands.push({
      id,
      label,
      ev: d.ev / bb,
      amount: target,
      sizePct: Math.round((100 * (target - inp.currentBet)) / Math.max(1, potForSize)),
      calledEq: d.e2,
      kind: classKind(cls),
      sizeNote: sizeBalanceNote(frac, isRiver),
      why: whyBet(cls, e, d, outs, false, isRiver, frac),
      math: `EV = ${d.evLabel}${sv ? ' + multi-street value' : ''}\n   = ${d.evExpr}${sv ? ` + ${d.streetValue.toFixed(1)}` : ''}\n   = ${d.ev.toFixed(1)} chips ≈ ${(d.ev / bb).toFixed(2)} bb${
        d.committed
          ? `\n   (SPR < 1: you're committed, so the effective stack goes in over the streets whatever you bet now — every committing size wins ~the same; only the draws you deny THIS street differ, so sizing is a minor EV choice here)`
          : sv
          ? `\n   (~${Math.round(d.contFrac * 100)}% of his range calls this size; the rest folds — a smaller bet keeps more worse hands in to pay later streets)`
          : dv
            ? `\n   (equity denial: a bigger bet folds live draws off this wet board — denying that equity beats the extra crying calls a small bet would earn)`
            : d.isThinValue
              ? `\n   (river: worse hands call and pay the bet, better hands call and beat you — betting profits only when more worse call than better)`
              : ''
      }`,
    });
  };

  addBet('bet33', 0.33, C === 0 ? 'Bet 33%' : 'Raise 33%');
  addBet('bet50', 0.5, C === 0 ? 'Bet 50%' : 'Raise 50%');
  addBet('bet75', 0.75, C === 0 ? 'Bet 75%' : 'Raise 75%');
  addBet('betpot', 1.0, C === 0 ? 'Bet pot' : 'Raise pot');

  if (inp.canRaise && inp.maxRaiseTo > inp.currentBet) {
    const d = computeAggro(eHU, P, C, inp.maxRaiseTo, inp.currentBet, inp.heroCommitted, wetness, true, realize, feMult, nOpp, effStack, cardsToCome, e, flushLevel, wet01);
    const cls = classifyBet(eHU, e, outs, hasMade);
    const allinFrac = (inp.maxRaiseTo - inp.currentBet) / Math.max(1, potForSize);
    // shoving your whole stack is high-variance and hard to recover from IRL, so
    // apply a risk premium — all-in only "wins" when it's clearly best. SCALES
    // WITH SPR: a sub-1-SPR jam is standard and barely a gamble, while a deep
    // (high-SPR) shove risks a huge earned stack on one runout, so demand a far
    // clearer edge before all-in becomes the top line.
    const RISK = Math.max(0.1, Math.min(2.0, 0.3 + 0.25 * spr));
    const rawEv = d.ev / bb;
    const adjEv = rawEv - RISK;
    cands.push({
      id: 'allin',
      label: 'All-in',
      ev: adjEv,
      amount: inp.maxRaiseTo,
      sizePct: Math.round((100 * (inp.maxRaiseTo - inp.currentBet)) / Math.max(1, potForSize)),
      calledEq: d.e2,
      kind: classKind(cls),
      sizeNote: sizeBalanceNote(allinFrac, isRiver),
      why:
        whyBet(cls, e, d, outs, true, isRiver, allinFrac) +
        ` Note: a ${RISK.toFixed(1)}bb risk premium is applied (scaled to SPR ${spr.toFixed(1)} — deeper stacks risk more, so the premium is bigger) — shoving your whole stack is high-variance and hard to recover from, so prefer a sized bet unless all-in is clearly best.`,
      math: `EV = ${d.evExpr} = ${d.ev.toFixed(1)} chips ≈ ${rawEv.toFixed(2)} bb\n   ${
        d.isThinValue
          ? `river shove: worse hands FOLD and better hands CALL, so a jam prints only when more worse hands call than better — it can't fold out a made hand for value.`
          : `only ~${Math.round(d.contFrac * 100)}% of his range calls a shove (the strong part), so eq-when-called is just ${pct1(d.e2)}; and a jam forgoes all later-street value.`
      }\n   − ${RISK.toFixed(1)} bb risk premium (SPR ${spr.toFixed(1)}) → ${adjEv.toFixed(2)} bb`,
    });
  }

  // ---- mix ----
  const evs = cands.map((c) => ({ id: c.id, ev: c.ev }));
  // temperature 0.3 (was 0.5): sharper mix — the top-EV line keeps most of the
  // frequency and dominated lines fade faster, closer to "play the best line".
  const mix = mixFromEv(evs, 0.3, 1.4);
  const bestEv = Math.max(...cands.map((c) => c.ev));
  // Only zero out fold when some line CLEARLY beats folding (> 0.1bb). A razor-thin
  // +EV — a spot sitting right on the pot-odds line — stays a CALL/FOLD *mix* rather
  // than snapping to 100%, so a break-even hand reads as "mostly call, sometimes
  // fold" instead of flip-flopping between 100% fold and 100% call on tiny noise.
  if (bestEv > 0.1) mix.set('fold', 0);
  // renormalise
  let sum = 0;
  mix.forEach((v) => (sum += v));
  if (sum > 0) mix.forEach((v, k) => mix.set(k, v / sum));

  const options: ActionOption[] = cands
    .map((c) => ({
      id: c.id,
      label: c.label,
      freq: mix.get(c.id) ?? 0,
      ev: round2(c.ev),
      amount: c.amount,
      sizePct: c.sizePct,
      calledEq: c.calledEq,
      kind: c.kind,
      why: c.why,
      math: c.math,
      sizeNote: c.sizeNote,
    }))
    .sort((a, b) => b.freq - a.freq || b.ev - a.ev);

  const best = options.reduce((a, b) => (b.ev > a.ev ? b : a), options[0]);

  const noteLines = buildNote({
    e,
    eHU,
    nOpp,
    street: isRiver ? 'river' : cardsToCome === 1 ? 'turn' : 'flop',
    P,
    C,
    bb,
    outs,
    cardsToCome,
    hasMade,
    implied,
    cleanFrac,
    flushLevel,
    tex,
    wet01,
    spr,
    sprKnown: inp.effStack != null,
    canRaise: inp.canRaise && inp.maxRaiseTo > inp.currentBet,
  });

  return {
    options,
    bestEv: round2(bestEv),
    bestId: best.id,
    source: 'postflop-model',
    note: noteLines.join(' '),
    notes: noteLines,
    equity: e,
    rangeNote: inp.rangeNote,
    heroCode: inp.heroCode,
    villainRange: inp.oppRange,
  };
}

interface AggroDetail {
  ev: number;
  fe: number;
  e2: number;
  calledPot: number;
  A: number;
  /** extra EV from getting to value bet a later street (0 for all-in / river). */
  streetValue: number;
  /** extra EV from folding live draws off a wet board (equity denial; 0 on dry). */
  denial: number;
  /** low-SPR spot where the stacks go in regardless of size (sizing barely matters). */
  committed: boolean;
  /** share of villain's range that continues at this size (minimum-defence). */
  contFrac: number;
  /** the EV formula for THIS branch — symbolic form + the numbers plugged in — so the
   *  displayed math matches what was actually computed. The flop/turn branch and the
   *  river thin-value branch use different formulas; each supplies its own here rather
   *  than letting solvePostflop print one hardcoded template that only fits the former. */
  evLabel: string;
  evExpr: string;
  /** river thin-value branch (no more cards): worse hands fold, better hands call — a
   *  different EV structure and a different all-in story than a flop/turn shove. */
  isThinValue: boolean;
}

function computeAggro(
  e: number,
  P: number,
  C: number,
  target: number,
  currentBet: number,
  heroCommitted: number,
  wetness: number,
  isAllIn: boolean,
  realize = 1.0,
  feMult = 1.0,
  oppCount = 1,
  effStack = 0,
  cardsToCome = 0,
  eField = e,
  flushLevel = 0, // 0 = not flush-dominated; 3 = monotone/3-flush (mild); 4+ = made-flush wall
  wet01 = 0, // 0..1 draw pressure — drives the denial (charge) vs multi-street (keep-in) tradeoff
): AggroDetail {
  // Cap the bet by the EFFECTIVE stack: chips past what opponents can call come back,
  // so a jam vs a short stack is NOT a giant overbet — it's whatever fraction of the
  // pot the effective stack covers. Capping here means `s` (hence fold/continue rates),
  // hero's at-risk chips, and the called pot all use the real, callable size, so at low
  // SPR a 75%/pot/all-in bet converge instead of the shove reading as a 4× overbet.
  const cap = effStack > 0 ? effStack : Infinity;
  const R = Math.min(target - currentBet, cap); // callable pressure on top of a call
  const A = Math.min(target - heroCommitted, cap); // hero's real at-risk chips
  const s = R / Math.max(1, P + C); // effective raise size relative to the pot

  // ---- RIVER: thin-value model (no more cards to come) ----
  // Minimum-defence (below) answers "does villain fold enough vs a BLUFF?" — the
  // wrong question for a made-hand VALUE bet on the river. On the river worse hands
  // FOLD to a bet and better hands CALL, so a bet profits ONLY when more worse
  // hands call than better do — the textbook thin-value rule:
  //     EV(bet) − EV(check) = bet × (worse-that-call − better-that-call).
  // Baseline is the MULTIWAY FIELD equity `eField` — the SAME number the CHECK uses
  // — so a bet can't escape the field penalty by pretending it's heads-up. eHU is
  // deliberately NOT used here: with no later street, isolating one caller earns
  // nothing; you just show down for whatever the pot already is. There is also NO
  // fe×pot term — hero already wins vs the folders at showdown, so crediting their
  // folds again would double-count (the bug that made marginal made hands over-bet).
  // This applies to an ALL-IN too: a river shove can't fold out a made hand for
  // value, so the old fold-equity path (gated `!isAllIn`) credited ~40% phantom
  // folds and made hero jam no-flush hands into a flush board (a made flush never
  // folds). Score the river shove with the same thin-value model; the all-in risk
  // premium is still layered on afterward in solvePostflop.
  if (cardsToCome === 0) {
    // Showdown share. NO realisation factor on the river: a called bet always
    // reaches showdown for exact equity (and folds win outright). The OOP check
    // keeps its discount in solvePostflop — that asymmetry is the block-bet
    // logic: betting OOP locks in your price instead of facing villain's.
    const base = Math.min(1, eField); // showdown EV baseline
    const worse = base; // hands hero beats vs the field
    const better = 1 - base; // hands that beat hero
    // cry-call rate: share of WORSE hands that still call, shrinking with size — a
    // small bet buys a few crying calls, a pot bet buys almost none.
    const cryCall = Math.max(0.05, Math.min(0.55, 0.55 - 0.45 * s));
    const Cw = worse * cryCall; // worse hands that call (hero wins R off each)
    const Cb = better; // better hands ~always call a bet (hero loses A to each)
    const cont = Cw + Cb;
    const e2r = cont > 0 ? Cw / cont : 0; // hero equity GIVEN called
    const fer = Math.max(0.02, 1 - cont); // share that folds (worse, didn't cry-call)
    const evr = base * P + R * Cw - A * Cb; // showdown + thin-value increment
    // river math is a thin-value increment, NOT the generic fold-equity template —
    // print the formula that was actually evaluated so the panel can't contradict it.
    const evLabel = `showdown share × pot + bet × (worse hands that call) − you invest × (better hands that call)`;
    const evExpr = `${pct1(base)} × ${P} + ${R} × ${pct1(Cw)} − ${A} × ${pct1(Cb)}`;
    return { ev: evr, fe: fer, e2: e2r, calledPot: P + A + R, A, streetValue: 0, denial: 0, committed: false, contFrac: cont, evLabel, evExpr, isThinValue: true };
  }

  // ---- PER-OPPONENT continue rate, driven by SIZE ----
  // Minimum-defence: vs a bet of `s` pots ONE opponent continues with ~his strongest
  // 1/(1+s) of range. This single rate feeds the caller-count distribution, the
  // pot-split, and the range-strength lift below, so they can't disagree.
  let contHU = 1 / (1 + Math.max(0, s));
  // FLUSH DOMINATION floor: hero holds none of the board suit, so on a 4+ flush board
  // one-card flushes never fold; on a 3-flush board made flushes are rare but draws
  // are everywhere — a milder floor.
  if (flushLevel >= 4) contHU = Math.max(contHU, 0.92);
  else if (flushLevel === 3) contHU = Math.max(contHU, 0.72);
  // position/texture nudge on the PER-OPPONENT rate (IP folds a hair more out, a wet
  // board keeps a hair more in). `q` is the one continue rate everything below reads.
  const q = Math.max(0.02, Math.min(0.98, contHU + (1 - feMult) * 0.15 + wetness));

  // FOLD EQUITY = EVERY opponent folds. The number who actually call, given ≥1 does,
  // is Binomial(oppCount, q): a bet takes the pot uncontested only when ALL fold, and
  // multiway that's rare (someone out of n usually has a hand).
  const pAllFold = Math.pow(1 - q, oppCount);
  let fe = Math.max(0.02, pAllFold);
  let contFrac = 1 - fe; // P(≥1 continues) — the "called%" shown in the math
  const kbar = (oppCount * q) / Math.max(1e-6, 1 - pAllFold); // E[callers | called]

  // ---- EQUITY WHEN CALLED — hero must beat EVERY caller ----
  // Base = equity vs ONE tightened caller: a bigger bet folds the weak part, so the
  // continuer is stronger (`rangeLift`). Then correct for facing SEVERAL callers with
  // ρ — the per-extra-opponent equity multiplier IMPLIED by this hand's own heads-up
  // vs field drop (eField ≈ eHU·ρ^(n−1)) — averaged over the caller-count distribution.
  // Result: when almost everyone calls (small bet) e2 is pulled DOWN toward the field
  // number; when a big bet isolates to one caller, e2 rises toward the heads-up value.
  // This kills the old bug where equity-when-called sat ABOVE the field equity, and it
  // replaces the flat multiTax with a size-aware isolation reward — so charging or
  // isolating multiway is no longer graded worse than a token bet.
  // ORDER-STATISTIC range tightening (replaces a flat rangeLift). Villain continues
  // with his top `contHU` fraction and folds his weakest `foldFrac = 1 − contHU`. Model
  // hero as beating the WEAKEST `eR` share of villain's range — true for a made hand: it
  // beats the air/overcards/underpairs at the bottom and loses to the top. Hero's equity
  // vs the part that CONTINUES is then (eR − foldFrac)/contHU — the beaten combos that
  // did NOT fold, over the combos that call. This self-calibrates off eHU: the nuts
  // (eR ≈ 1) barely tighten, while a bluff-catcher whose equity lives entirely in
  // villain's foldable air collapses toward 0 once that air folds. The old flat lift
  // (0.32·foldFrac) never captured that, so bluff-catchers read as thin-value-when-called
  // and got over-bet multiway (88/977, 99·TT on AA5). See classifyBet for the label side.
  const eR = Math.min(1, e * realize);
  const foldFrac = 1 - contHU;
  const eTight = contHU > 0 ? Math.max(0, (eR - foldFrac) / contHU) : eR;
  // a shove reads scarier than the same chips as a bet, so the stack-off range is a
  // touch tighter — but ONLY once the jam is a real OVERBET (s > 1 pot). A sub-pot jam
  // at low SPR is just a normal committing bet and shouldn't be taxed at all, or a
  // standard low-SPR shove reads as a blunder vs the same-size sized bet.
  const allinTax = isAllIn ? 0.06 * Math.min(1, Math.max(0, s - 1)) : 0;
  // flush-dominated: callers skew to the suit. 4+ flush board → made flushes that crush
  // hero (heavy tax toward ~0); 3-flush → mostly draws hero still beats (small tax).
  const flushTax = flushLevel >= 4 ? 0.25 : flushLevel === 3 ? 0.08 : 0;
  const eOne = Math.max(0, eTight - allinTax - flushTax); // vs one caller
  let e2 = eOne;
  if (oppCount > 1) {
    const rho = Math.max(0.2, Math.min(1, Math.pow(Math.max(0.01, eField) / Math.max(0.01, e), 1 / (oppCount - 1))));
    let acc = 0;
    for (let k = 1; k <= oppCount; k++) acc += binomPmf(oppCount, k, q) * Math.pow(rho, k - 1);
    e2 = Math.max(0, eOne * (acc / Math.max(1e-6, contFrac)));
    // SANITY BOUND: the hands that CALL are the top of ranges, so hero's equity vs the
    // callers cannot exceed his equity vs the whole field (eField). This bites the SMALL
    // bet — where almost everyone calls, so the order-stat barely tightens yet the
    // callers are still stronger than average — and stops a marginal made hand reading
    // as if a cheap bet keeps more than its showdown share. Heads-up (oppCount === 1,
    // eField === eHU) it never binds; the order-stat handles the big-bet isolation.
    e2 = Math.min(e2, eField);
  }

  // pot at showdown = dead pot + hero's (callable) chips + each caller's match (R, already
  // capped to the effective stack above, so this can't bank chips nobody can call).
  let calledPot = P + A + kbar * R;
  let ev = fe * P + contFrac * (e2 * calledPot - A);

  // MULTI-STREET VALUE — favours SMALLER bets, and only on DRY boards. A non-all-in
  // value bet keeps worse hands in AND lets hero bet again later; that future value is
  // largest when more worse hands continue (small bets) and fades to ~0 as the board
  // gets wetter (there you'd rather charge/deny now) or when shoving (no next street).
  let streetValue = 0;
  if (!isAllIn && cardsToCome > 0 && e > 0.55 && flushLevel < 4) {
    const behind = Math.max(0, effStack - A); // wagerable on later streets
    const futureExtract = Math.min(behind, 0.5 * calledPot); // ~½-pot next street
    const edge = Math.max(0, Math.min(1, (e2 - 0.5) * 2)); // how far ahead of callers
    const dryness = Math.max(0, 1 - wet01); // dry boards keep worse hands around
    streetValue = contFrac * edge * futureExtract * 0.5 * dryness;
    ev += streetValue;
  }

  // EQUITY DENIAL — favours BIGGER bets, and only on WET boards. Folding a live draw
  // off the board stops it outdrawing hero; the benefit scales with how many hands the
  // bet folds out (bigger = more) and how much equity they carried (wetter = more). ~0
  // on dry boards (folders near-dead) and when hero isn't ahead. This is the
  // counterweight that makes charging draws beat a token 33% bet on a drawy board.
  let denial = 0;
  if (cardsToCome > 0 && eOne > 0.5) {
    const expFolders = oppCount * (1 - q); // hands bet out
    denial = expFolders * (wet01 * 0.28) * P * 0.5;
    ev += denial;
  }

  // ---- LOW-SPR COMMITMENT ----
  // SPR < 1 with a hand that won't fold means the effective stack goes in over the
  // streets NO MATTER what you bet now — so the money is ~identical for every committing
  // size, and only the equity you deny THIS street differs (a bigger bet folds more draws
  // now). Recompute the money term at the effective all-in size so every committing size
  // shares it, leaving denial as the sole differentiator. Without this, single-street EV
  // punishes a small flop bet as a blunder when in reality the stacks go in regardless.
  let committed = false;
  const sprLocal = P > 0 ? effStack / P : 0;
  if (!isAllIn && cardsToCome > 0 && sprLocal > 0 && sprLocal < 1 && eOne > 0.5) {
    committed = true;
    const sA = effStack / P; // the size the stacks actually go in at
    const qA = Math.max(0.02, Math.min(0.98, 1 / (1 + sA) + (1 - feMult) * 0.15 + wetness));
    const contA = 1 - Math.max(0.02, Math.pow(1 - qA, oppCount));
    const kbarA = (oppCount * qA) / Math.max(1e-6, 1 - Math.pow(1 - qA, oppCount));
    const contHUA = 1 / (1 + sA); // per-opponent continue vs the all-in size
    const eOneA = Math.max(0, (Math.min(1, e * realize) - (1 - contHUA)) / Math.max(1e-6, contHUA) - flushTax);
    let e2A = eOneA;
    if (oppCount > 1) {
      const rho = Math.max(0.2, Math.min(1, Math.pow(Math.max(0.01, eField) / Math.max(0.01, e), 1 / (oppCount - 1))));
      let acc = 0;
      for (let k = 1; k <= oppCount; k++) acc += binomPmf(oppCount, k, qA) * Math.pow(rho, k - 1);
      e2A = Math.max(0, eOneA * (acc / Math.max(1e-6, contA)));
      e2A = Math.min(e2A, eField);
    }
    fe = 1 - contA;
    contFrac = contA;
    e2 = e2A;
    calledPot = P + effStack + kbarA * effStack;
    streetValue = 0;
    ev = fe * P + contFrac * (e2 * calledPot - effStack) + denial;
  }
  const invest = committed ? effStack : A;

  const showDenial = denial > 0.05;
  const evLabel = `fold% × pot + called% × (eq-when-called × final pot − you invest)${showDenial ? ' + equity denial' : ''}`;
  const evExpr = `${pct1(fe)} × ${P} + ${pct1(contFrac)} × (${pct1(e2)} × ${Math.round(calledPot)} − ${Math.round(invest)})${showDenial ? ` + ${denial.toFixed(1)}` : ''}`;
  return { ev, fe, e2, calledPot, A, streetValue, denial, contFrac, committed, evLabel, evExpr, isThinValue: false };
}

/**
 * Probability hero WINS at showdown GIVEN the draw completes, vs the (conditioned)
 * villain range — the "clean outs" factor. On a wet board a draw can hit and still
 * lose (flush over your two pair, a higher two pair, a counterfeiting river), so
 * implied odds must be scaled by this rather than crediting every raw out.
 *
 * Seeded deterministically from hero+board so the discount (and the EV / HUD
 * verdict that read it) stay stable across re-renders of the same node.
 */
function winIfHit(hero: Card[], board: Card[], oppRange: WeightedRange, comboWeight?: ComboWeight, iters = 300): number {
  if (board.length >= 5) return 1;
  const outs = countOuts(hero, board).cards;
  if (!outs.length) return 1;
  const dead = [...hero, ...board];
  const table = buildSampleTable(oppRange, dead, comboWeight);
  if (table.total <= 0) return 1;
  let seed = 0x1a2b3c >>> 0;
  for (const c of dead) seed = (seed ^ Math.imul(c.rank * 4 + c.suit + 1, 0x9e3779b1)) >>> 0;
  const rng = makeRng(seed >>> 0 || 1);
  let wins = 0;
  let n = 0;
  for (let i = 0; i < iters; i++) {
    const out = outs[Math.floor(rng() * outs.length)]; // condition on a hit
    const opp = sampleCombo(table, rng);
    if (!opp) continue;
    if (sameCard(opp[0], out) || sameCard(opp[1], out)) continue; // villain holds the out
    const b2 = [...board, out];
    const used = [...hero, ...b2, opp[0], opp[1]];
    const deck = makeDeck().filter((d) => !used.some((u) => sameCard(u, d)));
    const need = 5 - b2.length;
    const fb = b2.slice();
    let top = deck.length;
    for (let k = 0; k < need; k++) {
      const j = Math.floor(rng() * top);
      fb.push(deck[j]);
      deck[j] = deck[top - 1];
      top--;
    }
    const hs = evaluate7([...hero, ...fb]).score;
    const os = evaluate7([opp[0], opp[1], ...fb]).score;
    n++;
    if (hs > os) wins += 1;
    else if (hs === os) wins += 0.5;
  }
  return n > 0 ? wins / n : 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
