import type { ReactNode } from 'react';
import type { HudInfo } from '../hooks/useGame';
import type { NodeStrategy, ActionOption } from '../strategy/types';
import { CalcLabel, Tooltip } from './CalcTip';
import { CALC } from './CalConstant';
import { suitClass } from '../engine/cards';

interface Props {
  hud: HudInfo | null;
  loading: boolean;
  street: string;
  enabled: boolean;
  onToggle: () => void;
  strategy?: NodeStrategy | null;
  hideAnswer?: boolean; // study mode: hide the solver verdict until the hero acts
  onPeek?: () => void;
}

export function Hud({ hud, loading, street, enabled, onToggle, strategy, hideAnswer, onPeek }: Props) {
  // The solver's recommended line — the SAME object the Solver panel renders. The
  // 🧭 Decision logic + the pot-odds verdict both defer to it postflop, so the HUD
  // can never contradict the solver (it used to, ignoring implied odds / fold
  // equity that the solver counts). Preflop keeps the chart-based heuristic.
  const solverBest =
    strategy && strategy.source === 'postflop-model'
      ? strategy.options.find((o) => o.id === strategy.bestId) ?? null
      : null;
  const solverContinues = !!solverBest && solverBest.id !== 'fold';
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

          {hud.villainShape.length > 0 && (
            <div className="hud-read">
              <div className="hud-read-head">
                <Tooltip
                  className="tip-label"
                  content={
                    <span className="tip-body">
                      <b className="tip-title">What villain is repping</b>
                      <span className="tip-what">
                        His preflop range, re-weighted by the board and the action he took. When he bets — especially
                        big on a wet board — air is thinned and made hands (flushes, straights, sets) become a bigger
                        share. The bars are that conditioned mix; "{`beats you`}" is how much of it is ahead of your hand
                        right now.
                      </span>
                      <span className="tip-remember"><b>Remember:</b> a bet on a scary board means a stronger range — bluff-catch accordingly.</span>
                    </span>
                  }
                >
                  🔍 Villain range read
                </Tooltip>
                <b className={hud.villainAhead >= 0.5 ? 'bad' : hud.villainAhead <= 0.3 ? 'good' : 'okv'}>
                  {pct(hud.villainAhead)} beats you
                </b>
              </div>

              {hud.conditioned && (
                <div className="read-compare">
                  Equity: <span className="muted">{pct(hud.equityRaw)}</span> vs his opening range →{' '}
                  <b className={hud.equity < hud.equityRaw - 0.01 ? 'bad' : 'good'}>{pct(hud.equity)}</b> vs his betting
                  range
                  {hud.equity < hud.equityRaw - 0.01 && (
                    <span className="read-drop"> (−{((hud.equityRaw - hud.equity) * 100).toFixed(1)}pts — he bet, so he has it more often)</span>
                  )}
                </div>
              )}

              <div className="read-shape">
                {hud.villainShape.map((s) => (
                  <div className="shape-row" key={s.label}>
                    <span className="shape-lbl">{s.label}</span>
                    <span className="shape-bar">
                      <span className={`shape-fill ${strongBucket(s.label) ? 'strong' : ''}`} style={{ width: `${Math.max(2, Math.round(s.pct * 100))}%` }} />
                    </span>
                    <span className="shape-pct">{Math.round(s.pct * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="hud-risk">
            <div className="hud-row">
              <CalcLabel id="spr">Effective stack · SPR</CalcLabel>
              <b>{hud.effStackBB.toFixed(0)}bb · {hud.spr > 0 ? hud.spr.toFixed(1) : '—'}</b>
            </div>
            {hud.toCall > 0 && (
              <div className={`hud-commit ${hud.callStackPct >= 0.5 ? 'warn' : ''}`}>
                {hud.callStackPct >= 0.5
                  ? `⚠ A call commits ${Math.round(hud.callStackPct * 100)}% of your stack — treat this as a stack-off, not a cheap peel.`
                  : `A call costs ${Math.round(hud.callStackPct * 100)}% of your remaining stack.`}
              </div>
            )}
            {hud.toCall === 0 && hud.spr > 0 && hud.spr < 3 && (
              <div className="hud-commit warn">
                ⚠ Low SPR ({hud.spr.toFixed(1)}) — pots here get all-in fast. Plan to commit with top pair+ or fold.
              </div>
            )}
          </div>

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
              <div className={`hud-verdict ${hud.equity >= hud.requiredEquity ? 'good' : solverContinues && !hideAnswer ? 'okv' : hideAnswer ? '' : 'bad'}`}>
                {hud.equity >= hud.requiredEquity
                  ? `✓ Calling is +EV on raw equity (${pct(hud.equity)} vs ${pct(hud.requiredEquity)} needed)`
                  : hideAnswer
                    ? `Raw pot odds: ${pct(hud.equity)} < ${pct(hud.requiredEquity)} needed — a pure call is short.${street === 'river' ? '' : ' Implied odds (or raising) may still justify continuing.'} Decide, then reveal.`
                    : solverContinues
                      ? `~ Immediate pot odds say fold (${pct(hud.equity)} < ${pct(hud.requiredEquity)}), but the solver's best line is ${solverBest?.label} — ${street === 'river' ? "the EV model's read of his range tips it (no implied odds on the river)" : 'implied odds or the fold equity of raising tip it'}. See 🧭 below.`
                      : `✗ Pure pot odds say fold (${pct(hud.equity)} < ${pct(hud.requiredEquity)} needed)`}
              </div>
            </div>
          )}

          {hideAnswer ? (
            <div className="hud-guide locked">
              <div className="hud-row">
                <span className="tip-label">🧭 Decision logic</span>
                <button className="peek-btn" onClick={onPeek}>👁 Reveal</button>
              </div>
              <div className="hud-verdict">
                🎓 Study mode — call it yourself first. The solver's raise / call / fold + reasoning is revealed after you act
                (or hit Reveal to peek).
              </div>
            </div>
          ) : (
            <DecisionGuide hud={hud} street={street} best={solverBest} />
          )}

          {street === 'river' && hud.toCall > 0 && (
            <div className="hud-river-note">
              {hud.equity < 0.5 ? (
                <>🎯 River = pure pot odds (no more cards), and a river bet is <b>polarized</b> — strong value + bluffs, little between. This is a <b>bluff-catch</b>: you beat his bluffs, never his value, and can't improve. Your <b>{pct(hud.equity)}</b> ≈ how often he's bluffing — call only if it clears the <b>{pct(hud.requiredEquity)}</b> price <i>and</i> he actually bluffs here.</>
              ) : hud.equity < 0.7 ? (
                <>🎯 River = pure pot odds (no more cards). Your <b>{pct(hud.equity)}</b> beats his bluffs <i>and</i> part of his value — stronger than a pure bluff-catcher. The price is <b>{pct(hud.requiredEquity)}</b>; calling rates to be good unless this opponent never bluffs.</>
              ) : (
                <>🎯 River value spot — your <b>{pct(hud.equity)}</b> beats enough of his value to call. Raising mostly folds out the bluffs you beat, so calling captures them.</>
              )}
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
                          ? hud.outs >= 9
                            ? `≈ outs × 4 − (outs − 8) = ${hud.outs} × 4 − ${hud.outs - 8} = ${hud.ruleEstimate}%`
                            : `≈ outs × 4 = ${hud.outs} × 4 = ${hud.ruleEstimate}%`
                          : `≈ outs × 2 = ${hud.outs} × 2 = ${hud.ruleEstimate}%`}
                      </code>
                      <code className="tip-formula">
                        {street === 'flop'
                          ? `true = 1 − (${47 - hud.outs}/47)(${46 - hud.outs}/46) = ${hud.trueEstimate.toFixed(1)}%`
                          : `true = ${hud.outs}/46 = ${hud.trueEstimate.toFixed(1)}%`}
                      </code>
                      <span className="tip-remember"><b>Remember:</b> {CALC.ruleOf24.remember}</span>
                    </span>
                  }
                >
                  Rule of 2 &amp; 4 estimate
                </Tooltip>
                <b>
                  {hud.ruleEstimate}% <small className="hud-true">· true {hud.trueEstimate.toFixed(1)}%</small>
                </b>
              </div>
              {hud.ruleEstimate / 100 - hud.equity > 0.1 && (
                <div className="out-caveat">
                  ⚠ Optimistic — this counts <i>every</i> out as a winner.
                  {softOuts(hud) > 0 && ` ${softOuts(hud)} of them only make a pair or weak two pair that may not beat villain's range.`}
                  {' '}Your real win chance is <b>{pct(hud.equity)}</b> (the equity up top) — trust that for the call.
                </div>
              )}
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
                          <span key={i} className={`out-pill ${suitClass(c.suit)}`}>
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

// ---- live "what do I do?" guide ----
// Turns the raw equity vs the price into a plain RAISE / CALL / CHECK / FOLD
// call, with the one-line reason. Thresholds are deliberately simple & fixed so
// they're memorable — the cheat-sheet tooltip spells out the exact same rules.
type Verdict = { action: string; cls: 'good' | 'okv' | 'bad'; why: string };

function deriveVerdict(hud: HudInfo, street: string): Verdict {
  const e = hud.equity;
  const drawHeavy = (street === 'flop' || street === 'turn') && hud.outs >= 8;

  if (hud.toCall > 0) {
    // facing a bet — compare equity to the price (required equity to call)
    const margin = e - hud.requiredEquity;
    if (e >= 0.7) return { action: 'RAISE (value)', cls: 'good', why: `You're a big favourite (${pct(e)}). Raise to build the pot — worse hands still call.` };
    if (margin >= 0.12) return { action: 'CALL — maybe RAISE', cls: 'good', why: `Comfortably ahead of the price (${pct(e)} vs ${pct(hud.requiredEquity)} needed). Call always; raise if you're confident worse hands pay.` };
    if (margin >= 0) return { action: 'CALL (thin)', cls: 'okv', why: `Just ahead of the price (${pct(e)} vs ${pct(hud.requiredEquity)}). Call — raising risks folding out the worse hands you beat.` };
    if (drawHeavy) return { action: 'CALL / FOLD (draw)', cls: 'okv', why: `Behind the price on raw equity (${pct(e)} < ${pct(hud.requiredEquity)}), but ${hud.outs} outs. Peel only if you'll get paid when you hit (implied odds); otherwise fold.` };
    return { action: 'FOLD', cls: 'bad', why: `Short of the price (${pct(e)} < ${pct(hud.requiredEquity)} needed) with no real draw. Calling burns chips — let it go.` };
  }

  // no bet to face — check or bet
  if (e >= 0.62) return { action: 'BET (value)', cls: 'good', why: `You're ahead (${pct(e)}). Bet to grow the pot and charge their draws — checking lets them catch up free.` };
  if (drawHeavy && e >= 0.35) return { action: 'BET (semi-bluff) or CHECK', cls: 'okv', why: `${hud.outs} outs (${pct(e)}). Betting gives two ways to win (fold now, or hit later); checking takes a free card.` };
  if (e >= 0.45) return { action: 'CHECK', cls: 'okv', why: `Marginal (${pct(e)}) — not strong enough to bet for value. Check to control the pot and see a cheap showdown.` };
  return { action: 'CHECK / give up', cls: 'bad', why: `Weak (${pct(e)}). Nothing to bet for value and little to draw to — check and fold to pressure.` };
}

// Turn the solver's best option into the headline verdict — identical action to
// what the Solver panel shows, so the two are synced by construction. Includes
// the solver's own reason (which already mentions implied odds / fold equity).
function solverVerdict(best: ActionOption): Verdict {
  const mixed = best.freq > 0 && best.freq < 0.85;
  const action = best.label.toUpperCase() + (mixed ? ` (${Math.round(best.freq * 100)}%)` : '');
  const cls: Verdict['cls'] = best.id === 'fold' ? 'bad' : best.ev >= 0.5 ? 'good' : best.ev > 0.05 ? 'okv' : 'bad';
  return { action, cls, why: best.why ?? `Highest-EV line (${best.ev.toFixed(2)} bb).` };
}

function DecisionGuide({ hud, street, best }: { hud: HudInfo; street: string; best: ActionOption | null }) {
  // postflop: defer to the solver so HUD == Solver panel; else chart heuristic.
  const v = best ? solverVerdict(best) : deriveVerdict(hud, street);
  return (
    <div className="hud-guide">
      <div className="hud-row">
        <Tooltip
          className="tip-label"
          content={
            <span className="tip-body">
              <b className="tip-title">🧭 How to decide: raise / call / fold</b>
              <span className="tip-what">Compare your <b>equity</b> (win share, top of HUD) to the <b>price</b> (equity needed to call):</span>
              <code className="tip-formula">{[
                'FACING A BET:',
                '  equity ≥ 70% ............ RAISE for value',
                '  equity ≥ need + 12% ..... CALL (raise if confident)',
                '  equity ≥ need ........... CALL (thin)',
                '  equity < need, 8+ outs .. peel only w/ implied odds',
                '  equity < need, no draw .. FOLD',
                '',
                'NO BET (you act first):',
                '  equity ≥ 62% ............ BET for value',
                '  strong draw ............. BET semi-bluff / or check',
                '  equity 45–62% ........... CHECK (pot control)',
                '  equity < 45% ............ CHECK / give up',
              ].join('\n')}</code>
              <span className="tip-remember"><b>Remember:</b> price = call ÷ (pot + call). Beat the price → continue; way ahead → raise; behind with no draw → fold.</span>
            </span>
          }
        >
          🧭 Decision logic
        </Tooltip>
        <b className={v.cls === 'good' ? 'good' : v.cls === 'bad' ? 'bad' : 'okv'}>{v.action}</b>
      </div>
      <div className={`hud-verdict ${v.cls === 'good' ? 'good' : v.cls === 'bad' ? 'bad' : ''}`}>{v.why}</div>
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

// buckets that beat a typical bluff-catcher — coloured to pop in the read box.
function strongBucket(label: string): boolean {
  return label === 'Flush+' || label === 'Straight' || label === 'Set / trips';
}

// "soft" outs — ones that only make a (weak) pair/two-pair. They improve your
// hand category but often don't beat a betting range, which is why the outs
// estimate can sit far above your real equity.
function softOuts(hud: HudInfo): number {
  return hud.outsBreakdown
    .filter((g) => g.category === 'Pair' || g.category === 'Two Pair')
    .reduce((n, g) => n + g.cards.length, 0);
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
