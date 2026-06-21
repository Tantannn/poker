import type { ReactNode } from 'react';
import type { HudInfo } from '../hooks/useGame';
import { CalcLabel, Tooltip } from './CalcTip';
import { CALC } from './CalConstant';

interface Props {
  hud: HudInfo | null;
  loading: boolean;
  street: string;
  enabled: boolean;
  onToggle: () => void;
}

export function Hud({ hud, loading, street, enabled, onToggle }: Props) {
  return (
    <div className="hud">
      <div className="hud-head">
        <span>📊 Training HUD</span>
        <div className="strat-head-btns">
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
            <Stat
              label={
                <Tooltip
                  pos="bottom"
                  className="tip-label"
                  content={
                    <span className="tip-body">
                      <b className="tip-title">{CALC.equity.title}</b>
                      <span className="tip-what">{CALC.equity.what}</span>
                      <code className="tip-formula">{tallyText(hud)}</code>
                      <span className="tip-remember"><b>Remember:</b> {CALC.equity.remember}</span>
                    </span>
                  }
                >
                  {CALC.equity.title}
                </Tooltip>
              }
              value={pct(hud.equity)}
              big
              highlight
            />
            <Stat
              label={
                <Tooltip
                  pos="bottom"
                  className="tip-label"
                  content={
                    <span className="tip-body">
                      <b className="tip-title">{CALC.winTie.title}</b>
                      <span className="tip-what">
                        Out of many simulated run-outs: <b>win</b> = you hold the best hand, <b>tie</b> = you chop the pot.
                      </span>
                      <code className="tip-formula">{tallyText(hud)}</code>
                      <span className="tip-remember"><b>Remember:</b> {CALC.winTie.remember}</span>
                    </span>
                  }
                >
                  Win / Tie
                </Tooltip>
              }
              value={`${pct(hud.win)} / ${pct(hud.tie)}`}
            />
            <Stat label="Pot" value={`${hud.pot}`} />
            <Stat label="To call" value={`${hud.toCall}`} />
          </div>
          <div className="hud-range">vs {hud.rangeNote}</div>

          {hud.toCall > 0 && (
            <div className="hud-odds">
              <div className="hud-row">
                <CalcLabel id="oddsRatio">Pot odds</CalcLabel>
                <b>{hud.oddsRatio > 0 ? `${hud.oddsRatio.toFixed(1)} : 1` : '—'}</b>
              </div>
              <div className="hud-row">
                <Tooltip
                  className="tip-label"
                  content={
                    <span className="tip-body">
                      <b className="tip-title">{CALC.potOdds.title}</b>
                      <span className="tip-what">{CALC.potOdds.what}</span>
                      <code className="tip-formula">
                        need = call ÷ (pot + call) = {hud.toCall} ÷ {hud.pot + hud.toCall} = {pct(hud.requiredEquity)}
                      </code>
                      <span className="tip-remember"><b>Remember:</b> {CALC.potOdds.remember}</span>
                    </span>
                  }
                >
                  Equity needed to call
                </Tooltip>
                <b>{pct(hud.requiredEquity)}</b>
              </div>
              <div className={`hud-verdict ${hud.equity >= hud.requiredEquity ? 'good' : 'bad'}`}>
                {hud.equity >= hud.requiredEquity
                  ? `✓ Calling is +EV (you have ${pct(hud.equity)} vs ${pct(hud.requiredEquity)} needed)`
                  : `✗ Pure pot odds say fold (${pct(hud.equity)} < ${pct(hud.requiredEquity)} needed)`}
              </div>
            </div>
          )}

          {(street === 'flop' || street === 'turn') && (
            <div className="hud-outs">
              <div className="hud-row">
                <CalcLabel id="outs">Outs (cards that improve you)</CalcLabel>
                <b>{hud.outs}</b>
              </div>
              <div className="hud-row">
                <Tooltip
                  className="tip-label"
                  content={
                    <span className="tip-body">
                      <b className="tip-title">{CALC.ruleOf24.title}</b>
                      <span className="tip-what">{CALC.ruleOf24.what}</span>
                      <code className="tip-formula">
                        {street === 'flop'
                          ? `≈ outs × 4 = ${hud.outs} × 4 = ${hud.ruleEstimate}%`
                          : `≈ outs × 2 = ${hud.outs} × 2 = ${hud.ruleEstimate}%`}
                      </code>
                      <span className="tip-remember"><b>Remember:</b> {CALC.ruleOf24.remember}</span>
                    </span>
                  }
                >
                  Rule of 2 &amp; 4 estimate
                </Tooltip>
                <b>{hud.ruleEstimate}%</b>
              </div>
              {hud.outsBreakdown.length > 0 && hud.outs <= 24 && (
                <div className="out-breakdown">
                  {hud.outsBreakdown.map((grp) => (
                    <div className="out-group" key={grp.category}>
                      <div className="out-group-head">
                        <span className="out-count">{grp.cards.length}</span>
                        <span className="out-cat">→ {grp.category}</span>
                      </div>
                      <div className="out-cards">
                        {grp.cards.map((c, i) => (
                          <span key={i} className={`out-pill ${c.suit === 1 || c.suit === 2 ? 'red' : ''}`}>
                            {'23456789TJQKA'[c.rank - 2]}
                            {['♣', '♦', '♥', '♠'][c.suit]}
                          </span>
                        ))}
                      </div>
                    </div>
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

function Stat({ label, value, big, highlight }: { label: ReactNode; value: string; big?: boolean; highlight?: boolean }) {
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

// Worked example for the equity tooltip — shows the raw Monte-Carlo tally so the
// win%/tie% are traceable to actual simulated hands, not a black-box number.
function tallyText(hud: HudInfo): string {
  const { trials, wins, ties, losses, win, tie, equity } = hud;
  if (trials <= 0) return `equity = win% + ½ × tie% = ${pct(equity)}`;
  return [
    `Dealt ${trials} random run-outs vs villain's range:`,
    `  won ${wins} · tied ${ties} · lost ${losses}`,
    ``,
    `win%   = ${wins} / ${trials} = ${pct(win)}`,
    `tie%   = ${ties} / ${trials} = ${pct(tie)}`,
    `equity = win% + ½ × tie% = ${pct(equity)}`,
  ].join('\n');
}
