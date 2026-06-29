// Hand Replayer. Step a finished hand street-by-street. The board, hole cards
// and actions are what actually happened. The headline of each street is the
// REAL decision the hero faced — the exact solved node captured live during play
// (true villain range, pot, facing-bet, equity, option mix). Board texture, hand
// class, outs and a street-by-street equity curve (vs a typical range) round out
// the review. Older hands captured before snapshots fall back to the curve only.

import { useMemo, useState } from 'react';
import type { useGame } from '../hooks/useGame';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES, handCode } from '../ai/preflop';
import { classifyHandClass } from '../strategy/handClass';
import { describeTexture } from '../engine/board';
import { equityVsRange, countOuts, ruleOf2and4 } from '../engine/equity';
import type { NodeStrategy } from '../strategy/types';
import type { DecisionSnapshot, HistoryHand } from '../store/history';
import { PlayingCard } from './PlayingCard';
import { RangeChartModal } from './RangeChartModal';

const KIND_COLOR: Record<string, string> = {
  value: '#2ec27e', bluff: '#e0843a', passive: '#3aa0e0', call: '#3aa0e0', fold: '#7a8a80', aggressive: '#2ec27e',
};

type G = ReturnType<typeof useGame>;
type Street = 'preflop' | 'flop' | 'turn' | 'river';
const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];
const CARDS_BY_STREET: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const VILLAIN = rangeFromSet(RFI_RANGES.BTN);

const evRank = (a: { ev: number }, b: { ev: number }) => b.ev - a.ev;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const bb = (chips: number) => (chips / 2).toFixed(1);
const fmtBB = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}bb`;
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};

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

// Plain-language tier for an EV loss (in bb) — what the mistake actually cost.
function evLossTier(loss: number): { label: string; cls: string; gloss: string } {
  if (loss <= 0.05) return { label: 'Optimal', cls: 'good', gloss: 'matches the solver line — no EV given up.' };
  if (loss <= 0.5) return { label: 'Minor', cls: 'okv', gloss: 'a small leak; close spot, cheap to get slightly wrong.' };
  if (loss <= 1.5) return { label: 'Mistake', cls: 'bad', gloss: 'a clear error — the better line wins meaningfully more.' };
  return { label: 'Blunder', cls: 'bad', gloss: 'a big punt — this is where stacks leak fastest.' };
}

/** Deep-dive on a single decision: pot-odds math, equity vs price, EV cost over
 *  a sample, and a concept hook. Renders as a collapsible under the decision. */
function DecisionDeepDive({ d }: { d: DecisionSnapshot }) {
  const req = d.toCall > 0 ? d.toCall / (d.pot + d.toCall) : null;
  const tier = evLossTier(d.evLoss);
  const bestOpt = d.options.find((o) => o.id === d.bestId);
  const chosenOpt = d.options.find((o) => o.id === d.chosenId);
  const ahead = req != null && d.equity != null ? d.equity >= req : null;

  return (
    <details className="rv-deep">
      <summary>🔬 Deep dive — why this is a {tier.label.toLowerCase()}</summary>
      <div className="rv-deep-body">
        {req != null ? (
          <div className="rv-deep-block">
            <div className="rv-deep-h">The price</div>
            <p>
              You had to call <b>{d.toCall}</b> ({bb(d.toCall)}bb) into a <b>{d.pot}</b> ({bb(d.pot)}bb) pot,
              so you were getting <b>{(d.pot / d.toCall).toFixed(1)}-to-1</b> and needed{' '}
              <b>{pct(req)}</b> equity to break even.
              {d.equity != null && (
                <> You actually held <b>{pct(d.equity)}</b> — {ahead
                  ? <span className="good">a profitable call on raw equity alone.</span>
                  : <span className="bad">short of the price, so a pure call needs implied odds or fold equity to justify.</span>}
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
              ? <> The gap is <b className="bad">−{d.evLoss.toFixed(2)}bb</b>: repeated every time this exact spot comes up, that's roughly <b>{(d.evLoss * 100).toFixed(0)}bb per 100 hands</b> bleeding off. <span className={tier.cls === 'good' ? 'good' : 'muted'}>{tier.gloss}</span></>
              : <> You picked the top line — <span className="good">{tier.gloss}</span></>}
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

  const toggleCheck = (id: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const activeStreet = reached.includes(street) ? street : reached[reached.length - 1];

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

  // the real decisions the hero made on the active street (captured live)
  const streetDecisions = useMemo(
    () => (hand?.decisions ?? []).filter((d) => d.street === activeStreet),
    [hand, activeStreet],
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

  return (
    <div className="card">
      <h2>Hand Review</h2>
      <p className="sub">
        Step a finished hand street-by-street. The headline of each street is the <b>real decision</b> you
        faced — the exact solved node from play (true villain, pot, equity, option mix). Texture, outs and the
        equity curve round it out.
      </p>

      <div className="rv-bar">
        <label className="inline-label">Hand</label>
        <select value={idx} onChange={(e) => { setSel(Number(e.target.value)); }}>
          {(() => {
            let gi = 0; // running global index into `hands`
            return sessions.map((s) => (
              <optgroup key={s.sid} label={sessionLabel(s)}>
                {s.hands.map((h) => {
                  const v = gi++;
                  return <option key={h.id} value={v}>#{h.handNumber} · {fmtBB(h.deltaBB)}</option>;
                })}
              </optgroup>
            ));
          })()}
        </select>
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
        {reached.map((s) => (
          <button key={s} className={`sb-step ${s === activeStreet ? 'on' : ''}`} onClick={() => setStreet(s)}>
            {s.toUpperCase()}
          </button>
        ))}
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
        const decs = hand.decisions ?? [];
        const totalLoss = decs.reduce((s, d) => s + Math.max(0, d.evLoss), 0);
        const eqFirst = equityCurve[0];
        const eqLast = equityCurve[equityCurve.length - 1];
        const swing = eqFirst && eqLast ? eqLast.equity - eqFirst.equity : 0;
        const swungUp = swing > 0.06;
        const swungDown = swing < -0.06;
        return (
          <div className="rv-summary">
            <div className="gp-h">📖 Hand summary — the whole arc</div>
            <p>
              You were dealt <b>{heroCode}</b>{preflopClass ? <> ({preflopClass.label})</> : null}.{' '}
              {equityCurve.length > 1 && eqFirst && eqLast && (
                <>Equity vs a typical opening range moved from <b>{pct(eqFirst.equity)}</b> on the{' '}
                {eqFirst.street} to <b>{pct(eqLast.equity)}</b> by the {eqLast.street}
                {swungUp && <> — the board <span className="good">ran in your favour</span> (you picked up equity)</>}
                {swungDown && <> — the board <span className="bad">ran against you</span> (your hand faded)</>}
                {!swungUp && !swungDown && <> — a flat run-out, roughly the equity you started with</>}.{' '}</>
              )}
              {hand.result}{' '}
              Net result: <span className={hand.deltaBB > 0 ? 'good' : hand.deltaBB < 0 ? 'bad' : ''}>
                {hand.deltaBB >= 0 ? '+' : ''}{hand.deltaBB.toFixed(1)} bb
              </span>.
            </p>
            {decs.length > 0 && (
              <p className="gp-muted">
                {totalLoss <= 0.1
                  ? '✅ You played this hand to the solver line — no meaningful EV left on the table. Result aside, the decisions were sound.'
                  : <>Across {decs.length} decision{decs.length === 1 ? '' : 's'} you gave up <b className="bad">−{totalLoss.toFixed(2)}bb</b> total vs the best lines. Remember: a losing hand played correctly is still a win for your win-rate — variance owns the short term, EV owns the long run. Expand each <b>🔬 Deep dive</b> below to see exactly where.</>}
              </p>
            )}
          </div>
        );
      })()}

      <div className="rv-decisions">
        <div className="gp-h">Your decision{streetDecisions.length === 1 ? '' : 's'} on the {activeStreet} — the real spot</div>
        {streetDecisions.length === 0 ? (
          <p className="gp-muted">
            No hero decision recorded on this street (you weren’t to act, folded earlier, or this hand was
            played before decision-capture). The equity curve & texture below still apply.
          </p>
        ) : (
          streetDecisions.map((d, i) => {
            const correct = d.evLoss <= 0.05;
            const minor = d.evLoss <= 0.5;
            return (
              <div key={i} className="rv-dec">
                <div className="rv-dec-head">
                  <span className="rv-dec-pos">{d.position}</span>
                  <span className="rv-dec-face">
                    {d.toCall > 0 ? `facing ${d.toCall} (${(d.toCall / 2).toFixed(1)}bb)` : 'first to act / checked to'}
                    {d.villainTag ? ` · vs ${d.villainTag}` : ''}
                  </span>
                  <span className="rv-dec-pot">pot {d.pot} ({(d.pot / 2).toFixed(1)}bb)</span>
                  {d.equity != null && <span className="rv-dec-eq">{(d.equity * 100).toFixed(1)}% eq</span>}
                </div>

                <div className={`rv-dec-verdict ${correct ? 'good' : minor ? 'okv' : 'bad'}`}>
                  You <b>{d.chosenLabel}</b> · solver line <b>{d.bestLabel}</b>
                  {d.evLoss > 0.001 && <span className="rv-dec-loss"> · −{d.evLoss.toFixed(2)} bb EV</span>}
                  {d.rngMatch === true && <span className="rv-dec-rng"> · 🎲 followed RNG</span>}
                </div>

                <div className="rv-opts">
                  {[...d.options].sort(evRank).map((o) => (
                    <div key={o.id} className={`rv-opt ${o.id === d.bestId ? 'best' : ''} ${o.id === d.chosenId ? 'chosen' : ''}`}>
                      <span className="rv-opt-lbl">
                        {o.label}
                        {o.id === d.bestId ? ' ★' : ''}
                        {o.id === d.chosenId ? ' ◂ you' : ''}
                      </span>
                      <span className="rv-opt-track">
                        <span className="rv-opt-fill" style={{ width: `${o.freq * 100}%`, background: KIND_COLOR[o.kind ?? 'fold'] }} />
                      </span>
                      <span className="rv-opt-freq">{(o.freq * 100).toFixed(0)}%</span>
                      <span className={`rv-opt-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>{o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb</span>
                    </div>
                  ))}
                </div>

                <div className="rv-dec-foot">
                  <span className="gp-muted">{d.note}</span>
                  {d.villainRange.length > 0 && (
                    <button className="toggle" onClick={() => setChartSnap(d)} title="See the villain range this equity is measured against">📊 Range chart</button>
                  )}
                </div>

                <DecisionDeepDive d={d} />
              </div>
            );
          })
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
            <p>{analysis.hand.blurb}</p>
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
