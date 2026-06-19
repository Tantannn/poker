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
import type { DecisionSnapshot } from '../store/history';
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
  const taggedNums = useMemo(() => new Set(g.journal.map((e) => e.handNumber)), [g.journal]);
  const hands = useMemo(
    () => (taggedOnly ? g.history.filter((h) => taggedNums.has(h.handNumber)) : g.history),
    [g.history, taggedOnly, taggedNums],
  );
  const [sel, setSel] = useState(0);
  const idx = Math.min(sel, Math.max(0, hands.length - 1));
  const hand = hands[idx];
  const entry = hand ? g.journal.find((e) => e.handNumber === hand.handNumber) : undefined;
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
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const toggleCheck = (n: number) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
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
          {hands.map((h, i) => (
            <option key={h.handNumber} value={i}>
              #{h.handNumber} · {h.deltaBB >= 0 ? '+' : ''}{h.deltaBB.toFixed(1)}bb
            </option>
          ))}
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
          Tagged only ({taggedNums.size})
        </label>
        <button className={`rv-clear ${manageOpen ? 'on' : ''}`} onClick={() => setManageOpen((v) => !v)} title="Select hands to delete">
          🗑 Manage
        </button>
      </div>

      {manageOpen && (
        <div className="rv-manage">
          <div className="rv-manage-bar">
            <button className="rv-mini" onClick={() => setChecked(new Set(g.history.map((h) => h.handNumber)))}>Select all</button>
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
              <label key={h.handNumber} className="rv-manage-row">
                <input type="checkbox" checked={checked.has(h.handNumber)} onChange={() => toggleCheck(h.handNumber)} />
                <span className="rv-mg-num">#{h.handNumber}</span>
                <span className="pr-cards">{h.heroCards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</span>
                <span className={`rv-mg-delta ${h.deltaBB > 0 ? 'pos' : h.deltaBB < 0 ? 'neg' : ''}`}>
                  {h.deltaBB >= 0 ? '+' : ''}{h.deltaBB.toFixed(1)} bb
                </span>
                {taggedNums.has(h.handNumber) && <span className="rv-mg-tag">★</span>}
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
