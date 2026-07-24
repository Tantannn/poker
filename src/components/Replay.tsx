// Hand Replayer. Step a finished hand street-by-street. The board, hole cards
// and actions are what actually happened. The headline of each street is the
// REAL decision the hero faced — the exact solved node captured live during play
// (true villain range, pot, facing-bet, equity, option mix). Board texture, hand
// class, outs and a street-by-street equity curve (vs a typical range) round out
// the review. Older hands captured before snapshots fall back to the curve only.
//
// The review is MISTAKE-FIRST: a leak-finder rail surfaces the hands you punted
// most, a per-hand "Fix these" group lists every error in one place (so correct
// preflop calls don't bury the one spot you misplayed), streets that hold a
// mistake are flagged, and the per-decision solver mirrors the Play-vs-Bots
// strategy panel so the same picture reads the same in play and in review.

import { useMemo, useState, useEffect } from 'react';
import type { useGame } from '../hooks/useGame';
import type { Card } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES, handCode } from '../ai/preflop';
import { classifyHandClass } from '../strategy/handClass';
import { describeTexture } from '../engine/board';
import { equityVsRange, countOuts, ruleOf2and4 } from '../engine/equity';
import type { NodeStrategy } from '../strategy/types';
import type { DecisionSnapshot, HistoryHand } from '../store/history';
import { moveTier, type MoveTier } from '../store/stats';
import { buildSizingCoach } from '../analysis/grade';
import { PlayingCard } from './PlayingCard';
import { RangeChartModal } from './RangeChartModal';
import { ReasonList } from './ReasonList';

type G = ReturnType<typeof useGame>;

// Villain line-shape + river blocker reads → scannable chips (same mapping as the
// live explain panel). Tone reuses board-type pill colors: wet = red (danger —
// fold/trap), semiwet = gold (caution), dry = green (favourable to hero).
const STORY_LABEL: Record<string, string> = { value: 'Value / trap', polar: 'Polarized', bluffy: 'Capped / bluffy' };
const STORY_TONE: Record<string, string> = { value: 'wet', polar: 'semiwet', bluffy: 'dry' };
const BLOCKER_LABEL: Record<string, string> = { blockValue: 'Blocks his value', blockBluffs: 'Holds his bluffs', neutral: 'Neutral removal' };
const BLOCKER_TONE: Record<string, string> = { blockValue: 'wet', blockBluffs: 'wet', neutral: 'semiwet' };
type Street = 'preflop' | 'flop' | 'turn' | 'river';
const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];
const CARDS_BY_STREET: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const VILLAIN = rangeFromSet(RFI_RANGES.BTN);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const bb = (chips: number, bigBlind: number) => (chips / bigBlind).toFixed(1);
const fmtBB = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}bb`;
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};

// ───────────────────────── grading (mistake-first) ─────────────────────────
// One source of truth for "what tier is this decision" — reuses the same
// moveTier the live grade + scorecard use, so review never contradicts them.
const TIER_RANK: Record<MoveTier, number> = { best: 0, correct: 1, inaccuracy: 2, wrong: 3, blunder: 4 };
const IS_MISTAKE: Record<MoveTier, boolean> = { best: false, correct: false, inaccuracy: true, wrong: true, blunder: true };

function decTier(d: DecisionSnapshot): MoveTier {
  const chosenEv = d.options.find((o) => o.id === d.chosenId)?.ev ?? 0;
  return moveTier(d.evLoss, chosenEv);
}

// Plain-language rendering of the five move tiers (store/stats moveTier).
const TIER_META: Record<MoveTier, { cls: string; word: string; icon: string }> = {
  best: { cls: 'good', word: 'best move', icon: '✓' },
  correct: { cls: 'good', word: 'correct', icon: '✓' },
  inaccuracy: { cls: 'okv', word: 'inaccuracy', icon: '≈' },
  wrong: { cls: 'bad', word: 'mistake', icon: '✗' },
  blunder: { cls: 'bad', word: 'blunder', icon: '‼' },
};
const TIER_GLOSS: Record<MoveTier, string> = {
  best: 'matches the solver line — no EV given up.',
  correct: 'a sound alternative the solver also plays — nothing meaningful given up.',
  inaccuracy: 'clearly suboptimal, but not a punt — patch it before it compounds.',
  wrong: 'a real error — the better line wins meaningfully more.',
  blunder: 'a big punt — this is where stacks leak fastest.',
};

interface HandGrade {
  blunders: number;
  mistakes: number; // tier === 'wrong'
  inaccuracies: number;
  evLost: number;
  worst: MoveTier | null;
  heavy: boolean; // "lots of mistakes" — the ones to highlight
  streets: Set<Street>; // streets that hold at least one mistake
}

function gradeHand(h: HistoryHand): HandGrade {
  let blunders = 0;
  let mistakes = 0;
  let inaccuracies = 0;
  let evLost = 0;
  let worst: MoveTier | null = null;
  const streets = new Set<Street>();
  for (const d of h.decisions ?? []) {
    const t = decTier(d);
    evLost += Math.max(0, d.evLoss);
    if (t === 'blunder') blunders++;
    else if (t === 'wrong') mistakes++;
    else if (t === 'inaccuracy') inaccuracies++;
    if (IS_MISTAKE[t]) streets.add(d.street as Street);
    if (worst == null || TIER_RANK[t] > TIER_RANK[worst]) worst = t;
  }
  const heavy = blunders >= 1 || blunders + mistakes >= 2;
  return { blunders, mistakes, inaccuracies, evLost, worst, heavy, streets };
}

// Severity for ranking the leak rail: blunders dominate, then mistakes, then
// inaccuracies, EV lost as the tiebreak.
const severity = (g: HandGrade) => g.blunders * 1000 + g.mistakes * 100 + g.inaccuracies * 10 + g.evLost;
const firstMistakeStreet = (g: HandGrade): Street | null => STREETS.find((s) => g.streets.has(s)) ?? null;

// Compact badges for the dropdown / rail.
function BadgeRow({ g }: { g: HandGrade }) {
  if (!g.blunders && !g.mistakes && !g.inaccuracies) return null;
  return (
    <span className="rv-rail-badges">
      {g.blunders > 0 && <span className="rv-badge blunder">‼{g.blunders}</span>}
      {g.mistakes > 0 && <span className="rv-badge mistake">✗{g.mistakes}</span>}
      {g.inaccuracies > 0 && <span className="rv-badge inacc">≈{g.inaccuracies}</span>}
    </span>
  );
}
function badgeText(g: HandGrade): string {
  if (g.blunders) return '‼'.repeat(Math.min(g.blunders, 2)) + ' ';
  if (g.mistakes) return '✗'.repeat(Math.min(g.mistakes, 2)) + ' ';
  if (g.inaccuracies) return '≈ ';
  return '';
}

interface Session {
  sid: string;
  hands: HistoryHand[];
  net: number; // sum of deltaBB across the session
  evLost: number; // total EV given up (sum of positive per-decision losses)
  tournament: boolean;
  place?: number; // tournament finishing place, from the terminal hand
}

/** Group a (newest-first, session-contiguous) hand list into sessions. */
function groupSessions(hands: HistoryHand[]): Session[] {
  const order: string[] = [];
  const map = new Map<string, HistoryHand[]>();
  for (const h of hands) {
    const sid = h.sessionId ?? 'legacy';
    if (!map.has(sid)) { map.set(sid, []); order.push(sid); }
    map.get(sid)!.push(h);
  }
  return order.map((sid) => {
    const hs = map.get(sid)!;
    return {
      sid,
      hands: hs,
      net: hs.reduce((s, h) => s + h.deltaBB, 0),
      evLost: hs.reduce((s, h) => s + (h.decisions ?? []).reduce((a, d) => a + Math.max(0, d.evLoss), 0), 0),
      tournament: hs.some((h) => h.tournament),
      place: hs.find((h) => h.place != null)?.place,
    };
  });
}

function sessionLabel(s: Session): string {
  if (s.sid === 'legacy') return `Earlier hands · ${s.hands.length}`;
  if (s.tournament) {
    const fin = s.place ? `${ordinal(s.place)}` : 'in progress';
    return `🏆 Tournament — ${fin} · ${s.hands.length} hands · ${fmtBB(s.net)}`;
  }
  return `💵 Cash · ${s.hands.length} hands · ${fmtBB(s.net)}`;
}

// Per-option tier vs the best line, by EV loss (bb) — MIRRORS StrategyPanel's
// tierOf so the review solver reads identically to the Play-vs-Bots panel.
function optionTier(evLoss: number): { cls: string; tag: string } {
  if (evLoss <= 0.04) return { cls: 'tier-best', tag: 'best' };
  if (evLoss <= 0.4) return { cls: 'tier-ok', tag: 'inaccuracy' };
  return { cls: 'tier-bad', tag: 'mistake' };
}

/** The solver mix for one decision, rendered in the SAME visual language as the
 *  live Play-vs-Bots StrategyPanel: kind-coloured frequency bars, per-option tier
 *  tags, EV, and the concrete size. Options are sorted best-EV first; the chosen
 *  line is outlined and the top line carries the ★. */
function SolverRows({ d, bigBlind }: { d: DecisionSnapshot; bigBlind: number }) {
  const bestEv = d.options.find((o) => o.id === d.bestId)?.ev ?? Math.max(...d.options.map((o) => o.ev));
  const rows = [...d.options].sort((a, b) => b.ev - a.ev);
  return (
    <div className="strat-rows rv-solver">
      {rows.map((o) => {
        const isBest = o.id === d.bestId;
        const isYou = o.id === d.chosenId;
        const evLoss = Math.max(0, bestEv - o.ev);
        const tier = isBest ? { cls: 'tier-best', tag: 'best' } : optionTier(evLoss);
        return (
          <div key={o.id} className="strat-rowwrap">
            <div className={`strat-row ${isYou ? 'rv-you' : ''}`}>
              <div className="strat-bar-wrap">
                <div className={`strat-bar kind-${o.kind ?? 'fold'}`} style={{ width: `${o.freq * 100}%` }} />
                <span className="strat-label">
                  {o.label}
                  <span className={`tier-tag ${tier.cls}`}>{tier.tag}</span>
                  {isBest && <span className="rv-star" title="highest-EV line">★</span>}
                  {isYou && <span className="rv-you-tag">◂ you</span>}
                </span>
                <span className="strat-freq">{(o.freq * 100).toFixed(0)}%</span>
              </div>
              <div className={`strat-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>
                {o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb
              </div>
            </div>
            {o.amount != null && (
              <div className="strat-amt">
                {o.id === 'call' ? 'call' : o.id === 'raise' ? 'raise to' : o.id === 'open' ? 'open to' : 'bet to'} <b>{o.amount}</b>
                {' '}({(o.amount / bigBlind).toFixed(1)}bb){o.sizePct != null ? ` · ${o.sizePct}% pot` : ''}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Deep-dive on a single decision: pot-odds math, equity vs price, EV cost over
 *  a sample, and a concept hook. Renders as a collapsible under the decision. */
function DecisionDeepDive({ d, bigBlind, heroCards, board }: { d: DecisionSnapshot; bigBlind: number; heroCards: Card[]; board: Card[] }) {
  const req = d.toCall > 0 ? d.toCall / (d.pot + d.toCall) : null;
  const bestOpt = d.options.find((o) => o.id === d.bestId);
  const chosenOpt = d.options.find((o) => o.id === d.chosenId);
  const tier = decTier(d);
  const tierText = TIER_META[tier];
  const ahead = req != null && d.equity != null ? d.equity >= req : null;
  // Reuse the live oversizing coach so Hand Review teaches the same sizing lesson
  // (size follows hand strength, not the board; the size-up test). Fires only when
  // this decision was bigger than the solver's best line and cost EV. Opponent
  // count + equity-when-called come from the snapshot; hands captured before those
  // fields fall back to heads-up (no multiway caution) / the generic wording.
  const handLabel = heroCards.length === 2 ? classifyHandClass(heroCards, board.slice(0, d.boardLen)).label : undefined;
  const sizingCoach = buildSizingCoach(snapToStrategy(d, ''), d.chosenId, d.evLoss, d.opponents ?? 1, handLabel);

  return (
    <details className="rv-deep">
      <summary>🔬 Deep dive — why this grades “{tierText.word}”</summary>
      <div className="rv-deep-body">
        {req != null ? (
          <div className="rv-deep-block">
            <div className="rv-deep-h">The price</div>
            <p>
              You had to call <b>{d.toCall}</b> ({bb(d.toCall, bigBlind)}bb) into a <b>{d.pot}</b> ({bb(d.pot, bigBlind)}bb) pot,
              so you were getting <b>{(d.pot / d.toCall).toFixed(1)}-to-1</b> and needed{' '}
              <b>{pct(req)}</b> equity to break even.
              {d.equity != null && (
                <> You actually held <b>{pct(d.equity)}</b> — {ahead
                  ? <span className="good">a profitable call on raw equity alone.</span>
                  : <span className="bad">short of the price, so a call needs implied odds to justify — fold equity only comes from raising.</span>}
                </>
              )}
            </p>
          </div>
        ) : (
          <div className="rv-deep-block">
            <div className="rv-deep-h">The spot</div>
            <p>
              No bet was facing you — it was checked to you or you were first in. The question isn't pot odds
              but whether <b>betting</b> (for value or as a bluff) beats <b>checking</b>, given your{' '}
              {d.equity != null ? <>~{pct(d.equity)} equity</> : 'hand strength'} and how villain's range reacts.
            </p>
          </div>
        )}

        <div className="rv-deep-block">
          <div className="rv-deep-h">Your line vs the solver</div>
          <p>
            You chose <b>{d.chosenLabel}</b>
            {chosenOpt && <> (the solver mixes it {pct(chosenOpt.freq)} of the time, {chosenOpt.ev >= 0 ? '+' : ''}{chosenOpt.ev.toFixed(2)}bb)</>}.
            {' '}The highest-EV line was <b>{d.bestLabel}</b>
            {bestOpt && <> at {bestOpt.ev >= 0 ? '+' : ''}{bestOpt.ev.toFixed(2)}bb</>}.
            {d.evLoss > 0.001
              ? <> The gap is <b className="bad">−{d.evLoss.toFixed(2)}bb</b>: repeated, that's roughly <b>{(d.evLoss * 100).toFixed(0)}bb per 100 times this spot comes up</b> bleeding off. <span className={tierText.cls === 'good' ? 'good' : 'muted'}>{TIER_GLOSS[tier]}</span></>
              : <> You picked the top line — <span className="good">{TIER_GLOSS[tier]}</span></>}
          </p>
        </div>

        {d.rngMatch === true && (
          <div className="rv-deep-block">
            <div className="rv-deep-h">Mixed strategy</div>
            <p className="gp-muted">
              This is a mixed spot — more than one action is correct at some frequency. The RNG roll picked this
              branch, and you followed it, so it's graded as correct even if a different action also scores well.
            </p>
          </div>
        )}

        {sizingCoach && (
          <div className="rv-deep-block">
            <div className="rv-deep-h">Sizing</div>
            <div className="gp-muted"><ReasonList text={sizingCoach} /></div>
          </div>
        )}

        {d.villainStory && (
          <div className="rv-deep-block">
            <div className="rv-deep-h">
              Villain's story
              <span className={`board-type ${STORY_TONE[d.villainStory.read] ?? ''}`}>{STORY_LABEL[d.villainStory.read] ?? d.villainStory.read}</span>
            </div>
            <p>{d.villainStory.why}</p>
            <p className="gp-muted"><b>{d.villainStory.action}</b></p>
          </div>
        )}

        {d.blocker?.why && (
          <div className="rv-deep-block">
            <div className="rv-deep-h">
              What you block
              <span className={`board-type ${BLOCKER_TONE[d.blocker.read] ?? ''}`}>{BLOCKER_LABEL[d.blocker.read] ?? d.blocker.read}</span>
            </div>
            <p>{d.blocker.why}</p>
          </div>
        )}

        {d.note && (
          <div className="rv-deep-block">
            <div className="rv-deep-h">Solver note</div>
            <p className="gp-muted">{d.note}</p>
          </div>
        )}
      </div>
    </details>
  );
}

/** Rebuild a NodeStrategy from a stored decision snapshot, for the range chart. */
function snapToStrategy(snap: DecisionSnapshot, heroCode: string): NodeStrategy {
  return {
    options: snap.options.map((o) => ({ ...o, kind: o.kind as never })),
    bestEv: snap.options.find((o) => o.id === snap.bestId)?.ev ?? 0,
    bestId: snap.bestId,
    source: 'postflop-model',
    note: snap.note,
    equity: snap.equity,
    rangeNote: snap.rangeNote,
    heroCode,
    villainRange: new Map(snap.villainRange),
  };
}

type RailFilter = 'worst' | 'preflop' | 'all';

export function Replay({ g }: { g: G }) {
  const [taggedOnly, setTaggedOnly] = useState(false);
  const taggedIds = useMemo(() => new Set(g.journal.map((e) => e.id)), [g.journal]);
  const hands = useMemo(
    () => (taggedOnly ? g.history.filter((h) => taggedIds.has(h.id)) : g.history),
    [g.history, taggedOnly, taggedIds],
  );
  const [sel, setSel] = useState(0);
  const idx = Math.min(sel, Math.max(0, hands.length - 1));
  const hand = hands[idx];
  // sessions group the dropdown; hands are session-contiguous so a flat global
  // index still maps 1:1 to the position in `hands`.
  const sessions = useMemo(() => groupSessions(hands), [hands]);
  const curSession = hand ? sessions.find((s) => s.hands.some((h) => h.id === hand.id)) : undefined;
  const entry = hand ? g.journal.find((e) => e.id === hand.id) : undefined;
  const isTagged = !!entry;

  // grade EVERY hand once — powers the dropdown badges, the leak rail, and the
  // per-hand mistake group. Cheap: it's arithmetic over already-stored snapshots.
  const graded = useMemo(() => hands.map((h, i) => ({ h, i, g: gradeHand(h) })), [hands]);
  const grade = hand ? graded[idx]?.g : undefined;

  // streets actually reached this hand (always at least preflop)
  const reached = useMemo<Street[]>(() => {
    if (!hand) return ['preflop'];
    const n = hand.board.length;
    return STREETS.filter((s) => CARDS_BY_STREET[s] <= n);
  }, [hand]);

  const [street, setStreet] = useState<Street>('flop');
  const [chartSnap, setChartSnap] = useState<DecisionSnapshot | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [mistakesOnly, setMistakesOnly] = useState(true); // hide the decisions you got right
  const [railFilter, setRailFilter] = useState<RailFilter>('worst');
  const [handSort, setHandSort] = useState<'time' | 'worst'>('time'); // dropdown order
  const [showAllRail, setShowAllRail] = useState(false);
  const [focusGi, setFocusGi] = useState<number | null>(null); // decision to flash-scroll to

  const toggleCheck = (id: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const activeStreet = reached.includes(street) ? street : reached[reached.length - 1];

  // jump-to-decision: after a click sets the street, scroll the target into view
  // and let the flash animation play, then clear so a repeat click re-triggers it.
  useEffect(() => {
    if (focusGi == null) return;
    const el = document.getElementById(`rv-dec-${focusGi}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setFocusGi(null), 1500);
    return () => clearTimeout(t);
  }, [focusGi, activeStreet]);

  // jump to a hand from the leak rail — land on the street that holds its worst
  // mistake so the leak is the first thing shown.
  const jumpToHand = (i: number, hg: HandGrade) => {
    setSel(i);
    setManageOpen(false);
    const s = firstMistakeStreet(hg);
    if (s) setStreet(s);
  };

  const boardSoFar = useMemo(
    () => (hand ? hand.board.slice(0, CARDS_BY_STREET[activeStreet]) : []),
    [hand, activeStreet],
  );

  // texture + hand class for the active street (cheap, no solve)
  const analysis = useMemo(() => {
    if (!hand || boardSoFar.length < 3) return null;
    return {
      hand: classifyHandClass(hand.heroCards, boardSoFar),
      tex: describeTexture(boardSoFar),
    };
  }, [hand, boardSoFar]);

  // all hero decisions with their stable index, and the ones on the active street
  const decsAll = useMemo(() => hand?.decisions ?? [], [hand]);
  const streetDecisions = useMemo(
    () => decsAll.map((d, gi) => ({ d, gi })).filter((x) => x.d.street === activeStreet),
    [decsAll, activeStreet],
  );
  // every mistake in the hand, street-ordered (decsAll is chronological) — the
  // "Fix these" group so a correct preflop call never buries the misplayed spot.
  const mistakes = useMemo(
    () => decsAll.map((d, gi) => ({ d, gi, t: decTier(d) })).filter((x) => IS_MISTAKE[x.t]),
    [decsAll],
  );

  const preflopClass = useMemo(
    () => (hand ? classifyHandClass(hand.heroCards, []) : null),
    [hand],
  );

  // equity vs a typical BTN range at EACH reached street — shows how the hand's
  // strength evolved as the board ran out.
  const equityCurve = useMemo(() => {
    if (!hand) return [] as { street: Street; equity: number }[];
    return reached.map((s) => ({
      street: s,
      equity: equityVsRange(hand.heroCards, hand.board.slice(0, CARDS_BY_STREET[s]), VILLAIN, 1200).equity,
    }));
  }, [hand, reached]);

  // outs + rule-of-2-and-4 estimate on flop/turn (a draw still live)
  const outsInfo = useMemo(() => {
    if (!hand || boardSoFar.length < 3 || boardSoFar.length >= 5) return null;
    const o = countOuts(hand.heroCards, boardSoFar);
    if (o.outs === 0) return null;
    const cardsToCome = boardSoFar.length === 3 ? 2 : 1;
    return { outs: o.outs, cards: o.cards, est: ruleOf2and4(o.outs, cardsToCome), cardsToCome };
  }, [hand, boardSoFar]);

  const streetActions = useMemo(
    () => (hand ? hand.log.filter((l) => l.text.endsWith(`— ${activeStreet}`)) : []),
    [hand, activeStreet],
  );

  // leak rail: filter + rank the whole (filtered) history so the biggest punts
  // float to the top and are one click away.
  const railHands = useMemo(() => {
    let list = graded;
    if (railFilter === 'worst') list = graded.filter((x) => x.g.mistakes + x.g.blunders > 0);
    else if (railFilter === 'preflop') list = graded.filter((x) => x.g.streets.has('preflop'));
    const sorted = railFilter === 'all' ? [...list] : [...list].sort((a, b) => severity(b.g) - severity(a.g));
    return sorted;
  }, [graded, railFilter]);
  const RAIL_CAP = 12;
  const railShown = showAllRail ? railHands : railHands.slice(0, RAIL_CAP);

  if (!hand) {
    return (
      <div className="card">
        <h2>Hand Review</h2>
        {taggedOnly && g.history.length > 0 ? (
          <p className="sub">
            No tagged hands yet. Hit <b>☆ Tag for review</b> after a hand in <b>Play vs Bots</b> to mark it, then{' '}
            <button className="link-btn" onClick={() => setTaggedOnly(false)}>show all hands</button>.
          </p>
        ) : (
          <p className="sub">No hands yet. Play some in <b>Play vs Bots</b> — finished hands land here to review.</p>
        )}
      </div>
    );
  }

  const activeEquity = equityCurve.find((p) => p.street === activeStreet)?.equity ?? 0;
  const heroCode = handCode(hand.heroCards);
  const shownDecisions = mistakesOnly ? streetDecisions.filter((x) => IS_MISTAKE[decTier(x.d)]) : streetDecisions;
  const hiddenSound = streetDecisions.length - shownDecisions.length;

  return (
    <div className="card">
      <h2>Hand Review</h2>
      <p className="sub">
        Mistake-first. The <b>leak rail</b> lists the hands you punted most — one click jumps you to the exact
        street. Each hand's <b>🔧 Fix these</b> box groups every error in one place, and the per-decision solver
        reads just like the <b>Play vs Bots</b> panel.
      </p>

      <div className="rv-bar">
        <label className="inline-label">Hand</label>
        <select value={idx} onChange={(e) => { setSel(Number(e.target.value)); }}>
          {handSort === 'worst'
            ? [...graded]
                .sort((a, b) => severity(b.g) - severity(a.g))
                .map(({ h, i, g: hg }) => (
                  <option key={h.id} value={i}>{badgeText(hg)}{h.tournament ? '🏆 ' : '💵 '}#{h.handNumber} · {fmtBB(h.deltaBB)}</option>
                ))
            : (() => {
                let gi = 0; // running global index into `hands`
                return sessions.map((s) => (
                  <optgroup key={s.sid} label={sessionLabel(s)}>
                    {s.hands.map((h) => {
                      const v = gi++;
                      const hg = graded[v]?.g;
                      const badge = hg ? badgeText(hg) : '';
                      return <option key={h.id} value={v}>{badge}{h.tournament ? '🏆 ' : '💵 '}#{h.handNumber} · {fmtBB(h.deltaBB)}</option>;
                    })}
                  </optgroup>
                ));
              })()}
        </select>
        <button
          className={`rv-sortbtn ${handSort === 'worst' ? 'on' : ''}`}
          onClick={() => setHandSort((v) => (v === 'worst' ? 'time' : 'worst'))}
          title={handSort === 'worst' ? 'Sorted by worst mistakes — click for newest-first' : 'Sorted newest-first — click to sort by worst mistakes'}
        >
          ⇅ {handSort === 'worst' ? 'Worst first' : 'Newest'}
        </button>
        <span className={`rv-delta ${hand.deltaBB > 0 ? 'pos' : hand.deltaBB < 0 ? 'neg' : ''}`}>
          {hand.deltaBB >= 0 ? '+' : ''}{hand.deltaBB.toFixed(1)} bb
        </span>
        <span className="rv-result">{hand.result}</span>
        <button className={`tag-btn ${isTagged ? 'on' : ''}`} onClick={() => g.toggleTag(hand)}>
          {isTagged ? '★ Tagged' : '☆ Tag'}
        </button>
        <label className="rv-filter">
          <input type="checkbox" checked={taggedOnly} onChange={(e) => { setTaggedOnly(e.target.checked); setSel(0); }} />
          Tagged only ({taggedIds.size})
        </label>
        <button className={`rv-clear ${manageOpen ? 'on' : ''}`} onClick={() => setManageOpen((v) => !v)} title="Select hands to delete">
          🗑 Manage
        </button>
      </div>

      {/* ── Leak rail: find & highlight the hands with the most mistakes ── */}
      <div className="rv-rail">
        <div className="rv-rail-head">
          <span className="rv-rail-title">🎯 Leak rail — jump to your worst hands</span>
          <div className="rv-rail-filters">
            <button className={`rv-chipbtn ${railFilter === 'worst' ? 'on' : ''}`} onClick={() => { setRailFilter('worst'); setShowAllRail(false); }}>Most mistakes</button>
            <button className={`rv-chipbtn ${railFilter === 'preflop' ? 'on' : ''}`} onClick={() => { setRailFilter('preflop'); setShowAllRail(false); }}>Preflop leaks</button>
            <button className={`rv-chipbtn ${railFilter === 'all' ? 'on' : ''}`} onClick={() => { setRailFilter('all'); setShowAllRail(false); }}>All</button>
          </div>
        </div>
        {railHands.length === 0 ? (
          <p className="rv-empty">
            {railFilter === 'preflop'
              ? '✅ No preflop leaks logged — your preflop has been clean.'
              : '✅ No mistakes logged — clean play. Switch to “All” to browse every hand.'}
          </p>
        ) : (
          <>
            <div className="rv-rail-list">
              {railShown.map(({ h, i, g: hg }) => (
                <button
                  key={h.id}
                  className={`rv-rail-row ${i === idx ? 'on' : ''} ${hg.heavy ? 'heavy' : ''}`}
                  onClick={() => jumpToHand(i, hg)}
                >
                  <span className="rv-rail-mode" title={h.tournament ? 'tournament hand' : 'cash hand'}>{h.tournament ? '🏆' : '💵'}</span>
                  <span className="rv-rail-num">#{h.handNumber}</span>
                  <span className="rv-rail-cards">{h.heroCards.map((c, j) => <PlayingCard key={j} card={c} size="sm" />)}</span>
                  <BadgeRow g={hg} />
                  {hg.evLost > 0.05 && <span className="rv-rail-ev">−{hg.evLost.toFixed(1)}bb</span>}
                  {taggedIds.has(h.id) && <span className="rv-mg-tag">★</span>}
                  <span className={`rv-rail-delta ${h.deltaBB > 0 ? 'pos' : h.deltaBB < 0 ? 'neg' : ''}`}>{fmtBB(h.deltaBB)}</span>
                </button>
              ))}
            </div>
            {railHands.length > RAIL_CAP && (
              <button className="rv-rail-more" onClick={() => setShowAllRail((v) => !v)}>
                {showAllRail ? 'Show fewer' : `Show all ${railHands.length}`}
              </button>
            )}
          </>
        )}
      </div>

      {curSession && curSession.sid !== 'legacy' && (
        <div className={`rv-session ${curSession.tournament ? 'tourney' : ''}`}>
          <span className="rv-session-badge">{curSession.tournament ? '🏆 Tournament' : '💵 Cash session'}</span>
          {curSession.tournament && (
            <span className="rv-session-place">
              {curSession.place ? `finished ${ordinal(curSession.place)}` : 'in progress'}
            </span>
          )}
          <span>{curSession.hands.length} hands</span>
          <span className={curSession.net >= 0 ? 'pos' : 'neg'}>net {fmtBB(curSession.net)}</span>
          <span className="gp-muted">EV lost −{curSession.evLost.toFixed(2)}bb</span>
        </div>
      )}

      {manageOpen && (
        <div className="rv-manage">
          <div className="rv-manage-bar">
            <button className="rv-mini" onClick={() => setChecked(new Set(g.history.map((h) => h.id)))}>Select all</button>
            <button className="rv-mini" onClick={() => setChecked(new Set())}>Clear</button>
            <button
              className="rv-mini danger"
              disabled={checked.size === 0}
              onClick={() => { g.removeHistoryHands([...checked]); setChecked(new Set()); setSel(0); }}
            >
              Delete selected ({checked.size})
            </button>
            <button
              className="rv-mini danger"
              onClick={() => { if (confirm('Clear all reviewable hands? (Tagged hands & takeaways are kept.)')) { g.clearHistory(); setChecked(new Set()); setSel(0); } }}
            >
              Clear all (keep tagged)
            </button>
          </div>
          <div className="rv-manage-list">
            {g.history.map((h) => (
              <label key={h.id} className="rv-manage-row">
                <input type="checkbox" checked={checked.has(h.id)} onChange={() => toggleCheck(h.id)} />
                <span className="rv-mg-num">#{h.handNumber}</span>
                <span className="pr-cards">{h.heroCards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</span>
                <span className={`rv-mg-delta ${h.deltaBB > 0 ? 'pos' : h.deltaBB < 0 ? 'neg' : ''}`}>
                  {h.deltaBB >= 0 ? '+' : ''}{h.deltaBB.toFixed(1)} bb
                </span>
                {taggedIds.has(h.id) && <span className="rv-mg-tag">★</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="rv-streets">
        {reached.map((s) => {
          const hasMistake = grade?.streets.has(s);
          return (
            <button key={s} className={`sb-step ${s === activeStreet ? 'on' : ''} ${hasMistake ? 'has-mistake' : ''}`} onClick={() => setStreet(s)}>
              {s.toUpperCase()}{hasMistake && <span className="sb-dot">•</span>}
            </button>
          );
        })}
      </div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand{activeStreet === 'preflop' && preflopClass ? ` · ${preflopClass.label}` : ''}</span>
          <div className="lab-cards">{hand.heroCards.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">Board · {activeStreet}</span>
          <div className="lab-cards">
            {boardSoFar.length === 0
              ? <span className="rv-noboard">— no board preflop —</span>
              : boardSoFar.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}
          </div>
        </div>
        {boardSoFar.length >= 3 && (
          <div className="lab-eq">
            <div className="big-stat gold">{(activeEquity * 100).toFixed(1)}%</div>
            <div className="stat-lbl">equity vs range</div>
          </div>
        )}
      </div>

      {(() => {
        const eqFirst = equityCurve[0];
        const eqLast = equityCurve[equityCurve.length - 1];
        const swing = eqFirst && eqLast ? eqLast.equity - eqFirst.equity : 0;
        const swungUp = swing > 0.06;
        const swungDown = swing < -0.06;
        const g0 = grade ?? { blunders: 0, mistakes: 0, inaccuracies: 0, evLost: 0 } as HandGrade;
        const anyMistake = g0.blunders + g0.mistakes + g0.inaccuracies > 0;
        return (
          <div className="rv-summary">
            <div className="gp-h">📖 Hand summary — the whole arc</div>
            <div className="rv-scoreboard">
              {g0.blunders > 0 && <span className="rv-chip blunder">‼ {g0.blunders} blunder{g0.blunders > 1 ? 's' : ''}</span>}
              {g0.mistakes > 0 && <span className="rv-chip mistake">✗ {g0.mistakes} mistake{g0.mistakes > 1 ? 's' : ''}</span>}
              {g0.inaccuracies > 0 && <span className="rv-chip inacc">≈ {g0.inaccuracies} inaccurac{g0.inaccuracies > 1 ? 'ies' : 'y'}</span>}
              {!anyMistake && decsAll.length > 0 && <span className="rv-chip clean">✓ clean hand</span>}
              {g0.evLost > 0.05 && <span className="rv-chip ev">−{g0.evLost.toFixed(2)}bb EV lost</span>}
            </div>
            <p>
              You were dealt <b>{heroCode}</b>{preflopClass ? <> ({preflopClass.label})</> : null}.{' '}
              {equityCurve.length > 1 && eqFirst && eqLast && (
                <>Equity vs a typical opening range moved from <b>{pct(eqFirst.equity)}</b>{' '}
                {eqFirst.street === 'preflop' ? 'preflop' : <>on the {eqFirst.street}</>} to <b>{pct(eqLast.equity)}</b> by the {eqLast.street}
                {swungUp && <> — the board <span className="good">ran in your favour</span> (you picked up equity)</>}
                {swungDown && <> — the board <span className="bad">ran against you</span> (your hand faded)</>}
                {!swungUp && !swungDown && <> — a flat run-out, roughly the equity you started with</>}.{' '}</>
              )}
              {hand.result}{' '}
              Net result: <span className={hand.deltaBB > 0 ? 'good' : hand.deltaBB < 0 ? 'bad' : ''}>
                {hand.deltaBB >= 0 ? '+' : ''}{hand.deltaBB.toFixed(1)} bb
              </span>.
            </p>
          </div>
        );
      })()}

      {/* ── Fix these: every mistake in the hand, grouped & clickable ── */}
      {decsAll.length > 0 && (
        <div className={`rv-fix ${mistakes.length === 0 ? 'clean-fix' : ''}`}>
          <div className="gp-h">🔧 Fix these — every mistake in this hand</div>
          {mistakes.length === 0 ? (
            <p className="rv-clean">✅ Clean hand — you matched the solver on every decision. A losing result here is just variance, not a leak.</p>
          ) : (
            <div className="rv-fix-list">
              {mistakes.map(({ d, gi, t }) => {
                const m = TIER_META[t];
                return (
                  <button key={gi} className={`rv-fix-row ${m.cls}`} onClick={() => { setStreet(d.street as Street); setFocusGi(gi); }}>
                    <span className={`rv-fix-tier ${m.cls}`}>{m.icon} {m.word}</span>
                    <span className="rv-fix-street">{d.street}{d.position ? ` · ${d.position}` : ''}</span>
                    <span className="rv-fix-line">you <b>{d.chosenLabel}</b> · best <b>{d.bestLabel}</b></span>
                    {d.evLoss > 0.001 && <span className="rv-fix-loss">−{d.evLoss.toFixed(2)}bb</span>}
                    <span className="rv-fix-go">▸</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="rv-decisions">
        <div className="rv-dechead-row">
          <div className="gp-h">Your {activeStreet} decision{shownDecisions.length === 1 ? '' : 's'} — the real spot</div>
          {streetDecisions.length > 0 && (
            <button className={`rv-toggle ${mistakesOnly ? 'on' : ''}`} onClick={() => setMistakesOnly((v) => !v)}
              title="Hide the decisions you played correctly and show only the leaks">
              {mistakesOnly ? '⚠ Mistakes only' : 'Showing all'}
            </button>
          )}
        </div>
        {streetDecisions.length === 0 ? (
          <p className="gp-muted">
            No hero decision recorded on this street (you weren’t to act, folded earlier, or this hand was
            played before decision-capture). The equity curve & texture below still apply.
          </p>
        ) : shownDecisions.length === 0 ? (
          <p className="rv-sound-chip">
            ✓ {activeStreet === 'preflop' ? 'Preflop played correctly' : `All ${streetDecisions.length} ${activeStreet} decision${streetDecisions.length === 1 ? '' : 's'} were sound`} — nothing to fix here.{' '}
            <button className="link-btn" onClick={() => setMistakesOnly(false)}>show anyway</button>
          </p>
        ) : (
          <>
            {shownDecisions.map(({ d, gi }) => {
              const t = decTier(d);
              const m = TIER_META[t];
              const chosenOpt = d.options.find((o) => o.id === d.chosenId);
              return (
                <div key={gi} id={`rv-dec-${gi}`} className={`rv-dec ${focusGi === gi ? 'rv-dec-focus' : ''}`}>
                  <div className="rv-dec-head">
                    <span className="rv-dec-pos">{d.position}</span>
                    <span className="rv-dec-face">
                      {d.toCall > 0 ? `facing ${d.toCall} (${(d.toCall / hand.bigBlind).toFixed(1)}bb)` : 'first to act / checked to'}
                      {d.villainTag ? ` · vs ${d.villainTag}` : ''}
                    </span>
                    <span className="rv-dec-pot">pot {d.pot} ({(d.pot / hand.bigBlind).toFixed(1)}bb)</span>
                    {d.equity != null && <span className="rv-dec-eq">{(d.equity * 100).toFixed(1)}% eq</span>}
                  </div>

                  <div className={`rv-dec-verdict ${m.cls}`}>
                    <span className="rv-verdict-tag">{m.icon} {m.word}</span>
                    You <b>{d.chosenLabel}</b>
                    {chosenOpt && <span className="gp-muted"> ({(chosenOpt.ev >= 0 ? '+' : '')}{chosenOpt.ev.toFixed(2)}bb)</span>}
                    {' · '}best line <b>{d.bestLabel}</b>
                    {d.evLoss > 0.001 && <span className="rv-dec-loss"> · −{d.evLoss.toFixed(2)} bb</span>}
                    {d.rngMatch === true && <span className="rv-dec-rng"> · 🎲 followed RNG</span>}
                  </div>

                  <SolverRows d={d} bigBlind={hand.bigBlind} />

                  <div className="rv-dec-foot">
                    <span className="gp-muted">{d.note}</span>
                    {d.villainRange.length > 0 && (
                      <button className="toggle" onClick={() => setChartSnap(d)} title="See the villain range this equity is measured against">📊 Range chart</button>
                    )}
                  </div>

                  <DecisionDeepDive d={d} bigBlind={hand.bigBlind} heroCards={hand.heroCards} board={hand.board} />
                </div>
              );
            })}
            {mistakesOnly && hiddenSound > 0 && (
              <p className="rv-sound-chip">
                ✓ {hiddenSound} sound decision{hiddenSound === 1 ? '' : 's'} on the {activeStreet} hidden.{' '}
                <button className="link-btn" onClick={() => setMistakesOnly(false)}>show all</button>
              </p>
            )}
          </>
        )}
      </div>

      {equityCurve.length > 1 && (
        <div className="rv-curve">
          <div className="gp-h">Equity vs a typical BTN range — street by street</div>
          <div className="rv-curve-rows">
            {equityCurve.map((p) => (
              <div key={p.street} className="rv-curve-row">
                <span className="rv-curve-lbl">{p.street.toUpperCase()}</span>
                <span className="rv-curve-track">
                  <span
                    className="rv-curve-fill"
                    style={{ width: `${(p.equity * 100).toFixed(1)}%`, background: p.equity >= 0.5 ? 'var(--raise)' : 'var(--red)' }}
                  />
                </span>
                <span className="rv-curve-pct">{(p.equity * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis && (
        <div className="rv-analysis">
          <div className="gp-block">
            <div className="gp-h">Board texture: {analysis.tex.label}</div>
            <p>{analysis.tex.sentence}</p>
          </div>
          <div className="gp-block">
            <div className="gp-h">Your hand: {analysis.hand.label}</div>
            <div className="gp-hand-blurb"><ReasonList text={analysis.hand.blurb} /></div>
          </div>

          {outsInfo && (
            <div className="gp-block">
              <div className="gp-h">Draw math — {outsInfo.outs} outs</div>
              <p>
                Rule of {outsInfo.cardsToCome === 2 ? '4' : '2'}: ~<b>{outsInfo.est.toFixed(0)}%</b> to improve with{' '}
                {outsInfo.cardsToCome} card{outsInfo.cardsToCome === 2 ? 's' : ''} to come ({outsInfo.outs} outs ×{' '}
                {outsInfo.cardsToCome === 2 ? 4 : 2}).
              </p>
              <div className="rv-outs">
                {outsInfo.cards.slice(0, 14).map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}
              </div>
            </div>
          )}

        </div>
      )}

      <div className="rv-takeaway">
        <div className="gp-h">📝 Takeaway {isTagged ? '' : '(typing tags this hand)'}</div>
        <textarea
          className="rv-takeaway-in"
          placeholder='Extract one principle, e.g. "vs a nit who check-raises the turn, overpairs become bluff-catchers."'
          value={entry?.takeaway ?? ''}
          onChange={(e) => g.upsertTakeaway(hand, e.target.value)}
        />
      </div>

      <div className="rv-actions">
        <div className="gp-h">What happened on the {activeStreet}</div>
        {streetActions.length === 0 ? (
          <p className="gp-muted">No actions logged this street.</p>
        ) : (
          <ul className="rv-log">
            {streetActions.map((a, i) => <li key={i}>{a.text.replace(` — ${activeStreet}`, '')}</li>)}
          </ul>
        )}
      </div>

      {activeStreet === reached[reached.length - 1] && (
        <div className="rv-showdown">
          <div className="gp-h">Showdown</div>
          <div className="rv-sd-grid">
            {hand.showdown.map((p, i) => (
              <div key={i} className={`rv-sd ${p.folded ? 'folded' : ''}`}>
                <span className="rv-sd-name">{p.name}{p.folded ? ' (folded)' : ''}</span>
                <div className="rv-sd-cards">
                  {p.cards.length ? p.cards.map((c, j) => <PlayingCard key={j} card={c} size="sm" dim={p.folded} />) : <span className="gp-muted">—</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {chartSnap && (
        <RangeChartModal strategy={snapToStrategy(chartSnap, heroCode)} onClose={() => setChartSnap(null)} />
      )}
    </div>
  );
}
