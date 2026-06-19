import { useState } from 'react';
import type { HudInfo } from '../hooks/useGame';

interface Props {
  hud: HudInfo | null;
  loading: boolean;
  street: string;
  enabled: boolean;
  onToggle: () => void;
}

export function Hud({ hud, loading, street, enabled, onToggle }: Props) {
  const [explain, setExplain] = useState(false);
  return (
    <div className="hud">
      <div className="hud-head">
        <span>📊 Training HUD</span>
        <div className="strat-head-btns">
          {enabled && hud && (
            <button
              className={`toggle ${explain ? 'on' : ''}`}
              onClick={() => setExplain((v) => !v)}
              title="Explain each number & show the math"
            >
              ⓘ Explain
            </button>
          )}
          <button className="toggle" onClick={onToggle}>
            {enabled ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {!enabled ? (
        <div className="hud-hidden">HUD hidden — flip it back on to see equity &amp; pot odds.</div>
      ) : loading ? (
        <div className="hud-loading">Simulating equity…</div>
      ) : !hud ? (
        <div className="hud-hidden">Waiting for your turn…</div>
      ) : (
        <>
          <div className="hud-grid">
            <Stat label="Equity vs range" value={pct(hud.equity)} big highlight />
            <Stat label="Win / Tie" value={`${pct(hud.win)} / ${pct(hud.tie)}`} />
            <Stat label="Pot" value={`${hud.pot}`} />
            <Stat label="To call" value={`${hud.toCall}`} />
          </div>
          <div className="hud-range">vs {hud.rangeNote}</div>

          {explain && (
            <div className="hud-explain">
              <div className="he-why">
                <b>Equity vs range</b> is your share of the pot if the hand went all-in right now against{' '}
                {hud.rangeNote}. It already blends ties.
              </div>
              <div className="he-math">
                equity = win% + ½ × tie% = {pct(hud.win)} + ½ × {pct(hud.tie)} = {pct(hud.equity)}
              </div>
            </div>
          )}

          {hud.toCall > 0 && (
            <div className="hud-odds">
              <div className="hud-row">
                <span>Pot odds</span>
                <b>{hud.oddsRatio > 0 ? `${hud.oddsRatio.toFixed(1)} : 1` : '—'}</b>
              </div>
              <div className="hud-row">
                <span>Equity needed to call</span>
                <b>{pct(hud.requiredEquity)}</b>
              </div>
              <div className={`hud-verdict ${hud.equity >= hud.requiredEquity ? 'good' : 'bad'}`}>
                {hud.equity >= hud.requiredEquity
                  ? `✓ Calling is +EV (you have ${pct(hud.equity)} vs ${pct(hud.requiredEquity)} needed)`
                  : `✗ Pure pot odds say fold (${pct(hud.equity)} < ${pct(hud.requiredEquity)} needed)`}
              </div>
              {explain && (
                <div className="hud-explain">
                  <div className="he-why">
                    You risk <b>{hud.toCall}</b> to win the <b>{hud.pot}</b> already in the middle. The break-even
                    point is the slice of the final pot your call buys.
                  </div>
                  <div className="he-math">
                    needed = call ÷ (pot + call) = {hud.toCall} ÷ {hud.pot + hud.toCall} = {pct(hud.requiredEquity)}
                    {'\n'}odds = pot : call = {hud.pot} : {hud.toCall} = {hud.oddsRatio.toFixed(1)} : 1
                  </div>
                </div>
              )}
            </div>
          )}

          {(street === 'flop' || street === 'turn') && (
            <div className="hud-outs">
              <div className="hud-row">
                <span>Outs (cards that improve you)</span>
                <b>{hud.outs}</b>
              </div>
              <div className="hud-row">
                <span>Rule of 2 &amp; 4 estimate</span>
                <b>{hud.ruleEstimate}%</b>
              </div>
              {explain && (
                <div className="hud-explain">
                  <div className="he-why">
                    An <b>out</b> is an unseen card that improves you to a better hand. The Rule of 2 &amp; 4 turns
                    outs into rough equity-to-improve.
                  </div>
                  <div className="he-math">
                    {street === 'flop'
                      ? `≈ outs × 4 (two cards to come) = ${hud.outs} × 4 = ${hud.ruleEstimate}%`
                      : `≈ outs × 2 (one card to come) = ${hud.outs} × 2 = ${hud.ruleEstimate}%`}
                  </div>
                </div>
              )}
              {hud.outCards.length > 0 && hud.outCards.length <= 24 && (
                <div className="out-cards">
                  {hud.outCards.map((c, i) => (
                    <span key={i} className={`out-pill ${c.suit === 1 || c.suit === 2 ? 'red' : ''}`}>
                      {'23456789TJQKA'[c.rank - 2]}
                      {['♣', '♦', '♥', '♠'][c.suit]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, big, highlight }: { label: string; value: string; big?: boolean; highlight?: boolean }) {
  return (
    <div className={`hud-stat ${highlight ? 'hl' : ''}`}>
      <div className={`hud-value ${big ? 'big' : ''}`}>{value}</div>
      <div className="hud-label">{label}</div>
    </div>
  );
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}
