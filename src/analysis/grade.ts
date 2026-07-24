// Grades a hero action against the heuristic strategy: EV loss, RNG match,
// and a verdict. Replaces the old chart-only feedback with solver-model output.

import type { Action, GameState } from '../engine/table';
import { legalActions, positionLabel, potTotal } from '../engine/table';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { evLoss as computeEvLoss, rngPrescription } from '../strategy/types';
import { matchActionId, primaryVillainIdx } from '../strategy';
import { describeTexture, boardWetness } from '../engine/board';
import { classifyHandClass } from '../strategy/handClass';
import { playerLine, readVillainStory } from '../strategy/bettingStory';
import { readRiverBlockers } from '../strategy/riverBlockers';
import { getProfile } from '../ai/profiles';
import type { ActionClass } from './feedback';
import type { MoveTier } from '../store/stats';
import { moveTier, TIER } from '../store/stats';

// The grade uses the same five GTOW-style tiers as the session scorecard.
export type Verdict = MoveTier;

const HEADLINE: Record<Verdict, (loss: number) => string> = {
  best: () => '✓ Best — top of the solver line',
  correct: (l) => `✓ Correct — sound line (−${l.toFixed(2)} bb vs best)`,
  inaccuracy: (l) => `≈ Inaccuracy (−${l.toFixed(2)} bb vs best)`,
  wrong: (l) => `✗ Wrong — a costly line (−${l.toFixed(2)} bb vs best)`,
  blunder: (l) => `✗✗ Blunder (−${l.toFixed(2)} bb vs best)`,
};

/** Decision-time context captured for the gameplan/feedback explainer. */
export interface FeedbackContext {
  street: string;
  facing: string; // e.g. "first to act", "facing a check", "facing a bet of 6 (3.0bb)"
  position: string;
  villainName: string;
  villainTag: string;
  boardLabel: string;
  /** dry / semi-wet / wet — the sizing-relevant type ('' preflop). */
  boardType: string;
  boardSentence: string;
  boardFavours: string;
  handLabel: string;
  handBlurb: string;
  handStrength: number;
  potBB: number;
  toCallBB: number;
  /** live opponents (not folded, excl. hero). >1 → equity is vs the FIELD, so the
   *  explain panel labels it "vs the field", matching the multiway EV framing. */
  opponents: number;
  /** villain's LINE-SHAPE read (turn/river): value/trap (believe it, don't marry
   *  one pair), polar (nuts-or-bluff), or bluffy/capped (call wider). Complements
   *  the archetype bluff% — the STORY his bets tell, independent of the EV number.
   *  Undefined when there's no multi-street line to read. */
  villainStory?: { read: string; why: string; action: string };
  /** river-only: what the hero's EXACT cards remove from villain's range —
   *  blocking his value (lean fold) vs holding his bluffs (also lean fold) vs
   *  neutral. A live read that can OVERRIDE the raw price. Undefined pre-river. */
  blocker?: { read: string; why: string };
}

export interface NodeFeedback {
  verdict: Verdict;
  chosen: ActionId;
  chosenLabel: string;
  best: ActionId;
  bestLabel: string;
  evLoss: number;
  chosenEv: number;
  roll: number;
  prescribed: ActionId;
  prescribedLabel: string;
  rngMatch: boolean;
  equity?: number;
  headline: string;
  detail: string;
  /** A punchy one-liner shown when a bet/raise was oversized vs the best line —
   *  names the value-own (equity-when-called drop) + the multiway caution. */
  coach?: string;
  strategy: NodeStrategy;
  context?: FeedbackContext;
}

const pctOf = (f: number) => `${Math.round(f * 100)}%`;
const isAggro = (id: ActionId) => id.startsWith('bet') || id.startsWith('raise') || id === 'allin';

/** The sizing family of an aggressive action: two bets (or two raises) that differ
 *  only in % are the SAME strategic decision at different sizes. Returns null for
 *  check/call/fold and for all-in (a jam is a commitment choice, not a size nuance). */
function sizingFamily(id: ActionId): 'bet' | 'raise' | null {
  if (id === 'allin') return null;
  if (id.startsWith('bet')) return 'bet';
  if (id.startsWith('raise')) return 'raise';
  return null;
}

/** Bet-SIZING near-tie: the chosen line and the best line are aggressive of the
 *  SAME family (both bets, or both raises) and differ only in size, with an EV gap
 *  inside a small, pot-relative tolerance. Adjacent sizes are a mix the heuristic
 *  can't resolve — they sit inside its EV noise — so this is a sound line, not a
 *  "wrong". gradeNode uses it to clamp the tier into the sound band while still
 *  displaying the TRUE gap; `best` (the top-EV size) is unchanged. Scoped to the
 *  postflop model. A clearly-off size (a min-raise, a ½-pot on a board that wanted
 *  pot) clears the tolerance and keeps its full penalty. `loss` = raw EV gap (bb),
 *  `potBB` = pot at decision time (bb). */
export function isSizingNearTie(
  strategy: NodeStrategy,
  chosen: ActionId,
  chosenEv: number,
  loss: number,
  potBB: number,
): boolean {
  if (strategy.source !== 'postflop-model') return false;
  const bestFam = sizingFamily(strategy.bestId);
  if (bestFam == null || sizingFamily(chosen) !== bestFam || chosen === strategy.bestId) return false;
  if (chosenEv <= 0 || loss <= TIER.correct) return false;
  const tol = Math.min(3, Math.max(TIER.correct, potBB * 0.1));
  return loss <= tol;
}

/** GTO give-up guard: a CHECK/FOLD of a stone-cold air hand (strength 0) when the
 *  solver's best line is a bet is a "declining to bluff" — optional at equilibrium.
 *  The EV model always rates the bluff ABOVE a check by its fold-equity edge, so
 *  declining to bluff registers an EV gap even though you're never obliged to bluff.
 *  gradeNode uses this to clamp that gap into the sound-line band. Scoped to
 *  postflop-model + true air so it never softens a real error (e.g. checking a made
 *  hand that should value-bet keeps its full penalty). */
export function isFreeGiveUp(
  strategy: NodeStrategy,
  chosen: ActionId,
  handStrength: number | null,
): boolean {
  if (strategy.source !== 'postflop-model') return false;
  if (chosen !== 'check' && chosen !== 'fold') return false;
  if (handStrength !== 0) return false;
  const bestOpt = strategy.options.find((o) => o.id === strategy.bestId);
  return !!bestOpt && isAggro(bestOpt.id);
}

/** Oversizing coach: fires only when hero bet/raised BIGGER than the best line
 *  and it cost EV. Surfaces the reason a big bet backfires — worse hands fold,
 *  so only stronger hands call and hero's equity-when-called drops (value-own) —
 *  plus a multiway caution. Returns undefined when it doesn't apply. */
// One-pair made-hand labels (not two-pair+/sets) — a medium tier that sizes
// small even on a wet board. Used to make the size lesson concrete.
const ONE_PAIR_LABEL = /(Top Pair|Middle Pair|Bottom Pair|Pocket Pair|Pair of)/;

export function buildSizingCoach(
  strategy: NodeStrategy,
  chosen: ActionId,
  loss: number,
  nOpp: number,
  handLabel?: string,
): string | undefined {
  if (loss <= 0.05 || !isAggro(chosen)) return undefined;
  const chosenOpt = strategy.options.find((o) => o.id === chosen);
  const bestOpt = strategy.options.find((o) => o.id === strategy.bestId);
  if (!chosenOpt || !bestOpt) return undefined;
  const chosenSize = chosenOpt.sizePct ?? 0;
  const bestSize = bestOpt.sizePct ?? 0; // check/call have none → treat as 0
  if (chosenSize <= bestSize) return undefined; // only coach OVER-sizing

  // Built as " • "-delimited segments: a lead line + bullet points (rendered as
  // a dot list in the Explain panel).
  const bullets: string[] = [];
  if (
    chosenOpt.calledEq != null &&
    bestOpt.calledEq != null &&
    chosenOpt.calledEq < bestOpt.calledEq - 0.005
  ) {
    bullets.push(
      `Worse hands fold to the bigger size, so only stronger hands call — your equity-when-called drops ${pctOf(bestOpt.calledEq)} → ${pctOf(chosenOpt.calledEq)}. You bet more into a range that beats you more.`,
    );
  } else {
    bullets.push(`A bigger bet folds out the worse hands you wanted to call and gets called mostly by what beats you.`);
  }
  bullets.push(`Size to the worst hand that still calls — oversizing folds out your customers.`);
  if (nOpp > 1) {
    bullets.push(
      `Multiway (${nOpp} opponents) — someone is likelier to actually have it: size down, or check with anything short of premium value.`,
    );
  }

  // The core lesson: SIZE comes from hand strength, not board wetness. A wet
  // board is a reason to BET (charge draws), never a reason to bet big — one
  // pair sizes small even when wet; big sizes are for the strong tier.
  const onePair = handLabel != null && ONE_PAIR_LABEL.test(handLabel) && !/Two Pair/.test(handLabel);
  bullets.push(
    onePair
      ? `Your size comes from HAND STRENGTH, not the board. ${handLabel} is one pair — a medium hand that sizes small (⅓–½ pot) even on a wet board. Big sizes (⅔–pot) are for two-pair+, sets and overpairs, where worse hands still call and you're ahead when called. A wet board means BET (charge draws), not bet big.`
      : `Your size comes from HAND STRENGTH, not the board. A wet board is a reason to bet (charge draws) — your hand decides how big. Big sizes are for the strong tier (two-pair+, sets, overpairs); one pair sizes small even when wet.`,
  );
  // The reusable mental tool.
  bullets.push(
    `The size-up test — before betting bigger, ask: would WORSE hands still call it? Yes → big is fine (value + protection). No → you only fold worse and get called by better, so size down.`,
  );

  const lead = `⚠ Too big — ${bestOpt.label} beat ${chosenOpt.label} by ${loss.toFixed(2)} bb.`;
  return [lead, ...bullets].join(' • ');
}

/** Hero out of position vs the primary villain? Postflop the lower order-rank
 *  (closer to left of the button) acts FIRST = out of position. null when there's
 *  no single villain. Mirrors the position derivation in strategy/index.ts. */
function heroIsOOP(state: GameState, heroIdx: number): boolean | null {
  const vIdx = primaryVillainIdx(state, heroIdx);
  if (vIdx < 0) return null;
  const np = state.players.length;
  const orderRank = (seat: number) => (seat - (state.buttonIndex + 1) + np) % np;
  return orderRank(heroIdx) < orderRank(vIdx);
}

/** Check-line coach: fires when the solver's best line is to CHECK but hero BET.
 *  Unlike the sizing coach, the fix here isn't a smaller bet — it's not betting at
 *  all, so "size down" would mislead (this is the leak the sizing coach used to
 *  mis-explain). Explains why a check wins: a near-nut hand (strength 5) TRAPS —
 *  nothing to protect, a lead folds out the worse hands you want called and you
 *  often block villain's strong continues; OOP, checking lets the aggressor bet
 *  worse hands for you. A weaker made hand checks for pot control instead.
 *  `handStrength` is 0..5 (see classifyHandClass); `oop` = hero out of position vs
 *  the primary villain (null when unknown). Returns undefined when it doesn't apply. */
export function buildCheckLineCoach(
  strategy: NodeStrategy,
  chosen: ActionId,
  loss: number,
  handStrength: number | null,
  oop: boolean | null,
): string | undefined {
  if (strategy.source !== 'postflop-model') return undefined;
  if (strategy.bestId !== 'check' || !isAggro(chosen) || loss <= 0.05) return undefined;
  const chosenOpt = strategy.options.find((o) => o.id === chosen);
  if (!chosenOpt) return undefined;

  const lead = `⚠ Betting was the leak — Check beat ${chosenOpt.label} by ${loss.toFixed(2)} bb. The fix isn't a smaller bet, it's checking.`;
  const bullets: string[] = [];
  if (handStrength != null && handStrength >= 5) {
    bullets.push(
      `With a near-nut hand almost nothing can outdraw you, so there's no draw to protect — the usual reason to bet is gone.`,
    );
    bullets.push(
      `A lead folds out the worse hands you want paying you off and gets called mostly by what ties or beats you — and you often hold the very cards that block his strong calls, so betting has few customers.`,
    );
    bullets.push(
      `"Bet to build the pot" only builds if worse hands CALL — building means getting HIS chips in, not yours. Count your customers: many worse hands call → bet and build across streets; few customers + he bets when checked to → check and let him build it.`,
    );
    bullets.push(
      oop === true
        ? `Out of position vs the aggressor, checking hands him the lead: he barrels his air and value-bets worse for you. Then check-raise or check-call and win MORE than a bet that only folds worse hands out.`
        : `Check to trap — keep his weaker hands and bluffs in, then let him pay you off.`,
    );
    bullets.push(
      `Caveat: the trap needs a villain who bets when checked to. In position, or vs a passive player who checks back, LEAD instead — nobody bets it for you.`,
    );
  } else {
    bullets.push(
      `Betting folds out the worse hands you beat and gets called mostly by better, so a bet here can't make value.`,
    );
    bullets.push(
      `Check to control the pot and keep his bluffs in — you realize your showdown equity without bloating a pot you're not strong enough to build.`,
    );
  }
  return [lead, ...bullets].join(' • ');
}

/** Build the rich gameplan context from the live state at the hero's decision. */
export function buildFeedbackContext(state: GameState, heroIdx: number): FeedbackContext {
  const bb = state.bigBlind;
  const la = legalActions(state);
  const pos = positionLabel(heroIdx, state.buttonIndex, state.players.length);
  const tex = describeTexture(state.board);
  const boardType =
    state.board.length < 3 ? '' : { dry: 'Dry', semi: 'Semi-wet', wet: 'Wet' }[boardWetness(state.board)];
  const hand = classifyHandClass(state.players[heroIdx].holeCards, state.board);

  const vIdx = primaryVillainIdx(state, heroIdx);
  const villain = vIdx >= 0 ? state.players[vIdx] : null;
  const villainName = villain ? villain.name : 'the field';
  const villainTag = villain && !villain.isHero ? getProfile(villain.profileId).tag : '';

  let facing: string;
  if (la.callAmount > 0) {
    facing = `facing a bet of ${la.callAmount} (${(la.callAmount / bb).toFixed(1)}bb)`;
  } else if (state.street === 'preflop') {
    facing = 'preflop, action on you';
  } else {
    const aggressedThisStreet = state.lastAggressor >= 0 && state.lastAggressor !== heroIdx;
    facing = aggressedThisStreet ? 'facing a check' : 'first to act';
  }

  // Two live reads that turn a gut call into a reasoned fold/raise — the skills
  // this trainer is built around. Both are pure fns; attach only when they say
  // something. villainStory: the line-shape (turn+river, where a multi-street
  // story exists). blocker: river-only card removal, framed for the decision hero
  // faces (call = bluff-catch, else = rep/bluff).
  let villainStory: FeedbackContext['villainStory'];
  let blocker: FeedbackContext['blocker'];
  if (vIdx >= 0 && !villain?.isHero && state.board.length >= 4) {
    const vs = readVillainStory(playerLine(state.log, state.handNumber, vIdx), state.board.length - 2);
    if (vs.read !== 'none') villainStory = { read: vs.read, why: vs.why, action: vs.action };
  }
  if (state.board.length === 5 && !state.players[heroIdx].folded) {
    // call-mode (bluff-catch) removal is always relevant when FACING a bet. The
    // aggressive-mode "what do you rep / fold-equity" framing only makes sense for a
    // genuine BLUFF — busted air (strength 0-1). A MADE hand betting first-to-act is
    // either value (wants CALLS, nothing to rep) or a check/showdown hand (middle
    // pair) — the rep/fold-equity read misleads there (it read as "you're bluffing"
    // on a straight, and as "lean on your story" on a middle pair vs a station).
    // strength 0..5; 2 = one pair, 4+ = straight/flush/boat/set/two-pair/overpair.
    const facingBet = la.callAmount > 0;
    if (facingBet) {
      const b = readRiverBlockers(state.players[heroIdx].holeCards, state.board, 'call');
      if (b.why) blocker = { read: b.read, why: b.why };
    } else if (hand.strength <= 1) {
      const b = readRiverBlockers(state.players[heroIdx].holeCards, state.board, 'aggressive');
      if (b.why) blocker = { read: b.read, why: b.why };
    }
  }

  return {
    street: state.street,
    facing,
    position: pos,
    villainName,
    villainTag,
    boardLabel: tex.label,
    boardType,
    boardSentence: tex.sentence,
    boardFavours: tex.favours,
    handLabel: hand.label,
    handBlurb: hand.blurb,
    handStrength: hand.strength,
    potBB: potTotal(state) / bb,
    toCallBB: la.callAmount / bb,
    opponents: state.players.filter((p, i) => i !== heroIdx && !p.folded).length,
    villainStory,
    blocker,
  };
}

export function idToClass(id: ActionId): ActionClass {
  if (id === 'fold') return 'fold';
  if (id === 'check') return 'check';
  if (id === 'call') return 'call';
  return 'raise';
}

function labelFor(strategy: NodeStrategy, id: ActionId): string {
  return strategy.options.find((o) => o.id === id)?.label ?? id;
}

export function gradeNode(
  strategy: NodeStrategy,
  action: Action,
  callAmount: number,
  roll: number,
  ctx?: { state: GameState; heroIdx: number },
): NodeFeedback {
  const chosen = matchActionId(strategy, action, callAmount);
  let loss = computeEvLoss(strategy, chosen);
  const rawLoss = loss; // true EV gap, kept for display even when the tier is softened
  const chosenEv = evOf(strategy, chosen);
  const prescribed = rngPrescription(strategy, roll);

  // Hand class (air / draw / made) at this node — reused for the give-up guard
  // below and the sizing coach further down.
  const hand = ctx ? classifyHandClass(ctx.state.players[ctx.heroIdx].holeCards, ctx.state.board) : null;

  // GTO give-up guard (see isFreeGiveUp): the EV model rates a bluff strictly above a
  // check by its fold-equity edge, so declining to bluff stone-cold air always shows
  // an EV gap — but that's optional value, not a leak. When it applies, clamp the
  // penalty into the "sound line" band — live AND in the scorecard, which re-derives
  // the tier from this same evLoss.
  const softenedGiveUp = isFreeGiveUp(strategy, chosen, hand?.strength ?? null) && loss > TIER.correct;
  if (softenedGiveUp) loss = TIER.correct;

  // Bet-SIZING near-tie: when hero's line and the best line are aggressive of the
  // SAME family (both bets, or both raises), the only difference is size — a mixed
  // decision the heuristic can't resolve precisely, since adjacent sizes sit inside
  // its EV noise. Grade a small, pot-relative gap as a sound line instead of "wrong",
  // so e.g. a ¾-pot raise where pot-pot rated highest isn't flagged as a costly
  // error. `best` is unchanged (the star still points at the top-EV size) and the
  // TRUE gap is still displayed (rawLoss) — only the verdict/scorecard tier softens.
  // A clearly-off size (a min-raise, or a ½-pot on a board that wanted pot) keeps its
  // full penalty because its gap clears the tolerance. Postflop-model only; preflop
  // deviations are graded by frequency below.
  const potBB = ctx ? potTotal(ctx.state) / ctx.state.bigBlind : 0;
  const softenedSizing = !softenedGiveUp && isSizingNearTie(strategy, chosen, chosenEv, loss, potBB);
  if (softenedSizing) loss = TIER.correct;

  let verdict: Verdict = moveTier(loss, chosenEv);
  // Preflop CHART EVs are relative estimates, NOT solved — so a tiny EV gap can hide
  // a real leak. Grade chart deviations by FREQUENCY instead: taking an action the
  // chart almost never plays (e.g. folding AJo when it's a pure ~100% call) is at
  // least an inaccuracy, never "✓ Correct — sound line". Legit MIXED spots are spared
  // (folding a 40%-fold hand stays fine) because the chosen action still has weight.
  if (strategy.source === 'preflop-chart' && chosen !== strategy.bestId) {
    const chosenFreq = strategy.options.find((o) => o.id === chosen)?.freq ?? 0;
    const bestFreq = strategy.options.find((o) => o.id === strategy.bestId)?.freq ?? 0;
    if (chosenFreq < 0.15 && bestFreq >= 0.6 && (verdict === 'best' || verdict === 'correct')) {
      verdict = 'inaccuracy';
    }
  }

  const headline = HEADLINE[verdict](softenedSizing ? rawLoss : loss);

  const bestLabel = labelFor(strategy, strategy.bestId);
  const chosenLabel = labelFor(strategy, chosen);
  const rngMatch = chosen === prescribed;

  let detail: string;
  if (softenedGiveUp) {
    detail = `Giving up is fine — you're never forced to bluff. With stone-cold air a check just gives up your small showdown equity, while ${bestLabel} scores higher only by adding fold-equity EV on top — and that extra value is optional, needing a believable story and the right blockers to collect. Declining it is a sound, low-cost line, not a mistake.`;
  } else if (softenedSizing) {
    detail = `${chosenLabel} and ${bestLabel} are the same decision at a slightly different size — ${rawLoss.toFixed(2)} bb apart, which is inside the model's margin. Bet sizing is a mix and adjacent big sizes are near-equivalent, so this is a sound line, not an error. Pick one size and be consistent — ${bestLabel} edged it here, but that gap isn't something you can read at the table.`;
  } else if (verdict === 'best' || verdict === 'correct') {
    const lead = verdict === 'best' ? '' : `A fine alternative (−${loss.toFixed(2)} bb). `;
    detail = lead + (strategy.source === 'preflop-chart'
      ? `${strategy.rangeNote}: ${bestLabel} is the standard line.`
      : `Highest-EV action was ${bestLabel}.`);
  } else {
    const head = `Best was ${bestLabel} (${fmtEv(evOf(strategy, strategy.bestId))} bb) vs your ${chosenLabel} (${fmtEv(
      evOf(strategy, chosen),
    )} bb).`;
    // Postflop carries a bulleted `notes` list (rendered in the Explain panel),
    // so don't also glue the paragraph here — it used to show up twice. Preflop
    // has no bullets, so keep the one-line note inline.
    detail = strategy.notes?.length ? head : `${head} ${strategy.note}`;
  }

  const nOpp = ctx
    ? ctx.state.players.filter((p, i) => i !== ctx.heroIdx && !p.folded).length
    : 1;
  const handLabel = hand?.label;

  // Pick the coach by WHAT the best line is. When the solver's best line is to
  // CHECK, "size down" is the wrong lesson (the fix is not betting at all) — use the
  // check-line coach, which explains the trap (near-nut) or pot-control (marginal)
  // reason a check beats the lead. Otherwise the best line is a bet/raise and the
  // leak is genuinely one of SIZE, so keep the oversizing coach.
  const coach =
    strategy.bestId === 'check'
      ? buildCheckLineCoach(strategy, chosen, loss, hand?.strength ?? null, ctx ? heroIsOOP(ctx.state, ctx.heroIdx) : null)
      : buildSizingCoach(strategy, chosen, loss, nOpp, handLabel);

  return {
    verdict,
    chosen,
    chosenLabel,
    best: strategy.bestId,
    bestLabel,
    evLoss: loss,
    chosenEv,
    roll,
    prescribed,
    prescribedLabel: labelFor(strategy, prescribed),
    rngMatch,
    equity: strategy.equity,
    headline,
    detail,
    coach,
    strategy,
    context: ctx ? buildFeedbackContext(ctx.state, ctx.heroIdx) : undefined,
  };
}

function evOf(strategy: NodeStrategy, id: ActionId): number {
  return strategy.options.find((o) => o.id === id)?.ev ?? 0;
}
function fmtEv(x: number): string {
  return (x >= 0 ? '+' : '') + x.toFixed(2);
}
