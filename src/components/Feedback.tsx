import { useState } from 'react';
import type { NodeFeedback } from '../analysis/grade';
import { RangeChartModal } from './RangeChartModal';
import { SizingCheatSheet } from './SizingCheatSheet';
import { KIND_COLOR } from './chartColors';
import { CalcLabel } from './CalcTip';

export function Feedback({ fb, peeked }: { fb: NodeFeedback | null; peeked?: boolean }) {
  const [explain, setExplain] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [showCheat, setShowCheat] = useState(false);
  const [prevFb, setPrevFb] = useState(fb);

  // when a new decision is graded, auto-open the gameplan for a leak/mistake
  if (fb !== prevFb) {
    setPrevFb(fb);
    setExplain(fb ? fb.verdict !== 'best' && fb.verdict !== 'correct' : false);
    setShowChart(false);
  }

  if (!fb) return null;
  const cls =
    fb.verdict === 'best' || fb.verdict === 'correct'
      ? 'good'
      : fb.verdict === 'inaccuracy'
        ? 'okv'
        : 'bad';
  const ctx = fb.context;
  const strat = fb.strategy;
  const best = strat.options.find((o) => o.id === fb.best);
  const chosen = strat.options.find((o) => o.id === fb.chosen);

  return (
    <div className={`feedback-box ${cls}`}>
      <div className="fb-top">
        <div className="fb-head">{fb.headline}</div>
        <div className="strat-head-btns">
          <button
            className={`toggle ${explain ? 'on' : ''}`}
            onClick={() => setExplain((v) => !v)}
            title="Show the full gameplan, hand read & EV math"
          >
            ⓘ Explain
          </button>
          <button className="toggle" onClick={() => setShowChart(true)} title="See the range chart for this spot">
            📊 Chart
          </button>
          <button
            className={`toggle ${showCheat ? 'on' : ''}`}
            onClick={() => setShowCheat((v) => !v)}
            title="Postflop sizing cheat sheet — what to do in each spot"
          >
            📐 Cheat sheet
          </button>
        </div>
      </div>

      {showCheat && (
        <div className="fb-cheat">
          <SizingCheatSheet />
        </div>
      )}

      {peeked && (
        <div className="fb-peeked">👁 You revealed the solver before acting — this rep isn't unaided. Counts in your score, but don't read it as a clean solve.</div>
      )}

      <div className="fb-line">
        You <b>{fb.chosenLabel}</b> · solver line <b>{fb.bestLabel}</b>
        {fb.evLoss > 0.001 && <span className="fb-evloss"> · −{fb.evLoss.toFixed(2)} bb <CalcLabel id="evLoss" pos="bottom">EV</CalcLabel></span>}
      </div>
      <div className={`fb-rng ${fb.rngMatch ? 'good' : ''}`}>
        🎲 RNG {fb.roll} → prescribed <b>{fb.prescribedLabel}</b>
        {fb.rngMatch ? ' ✓ you followed it' : ` (you took ${fb.chosenLabel})`}
      </div>
      <div className="fb-detail">{fb.detail}</div>

      {explain && (
        <div className="fb-gameplan">
          {ctx && (
            <>
              <div className="gp-block">
                <div className="gp-h">Scenario</div>
                <p>
                  You are in <b>{ctx.position}</b>, {ctx.street}, <b>{ctx.facing}</b>
                  {ctx.villainName !== 'the field' && (
                    <> vs <b>{ctx.villainName}</b>{ctx.villainTag ? ` (${ctx.villainTag})` : ''}</>
                  )}
                  . Pot is <b>{ctx.potBB.toFixed(1)}bb</b>
                  {ctx.toCallBB > 0 ? <> and it's <b>{ctx.toCallBB.toFixed(1)}bb</b> to call.</> : '.'}
                </p>
              </div>

              {ctx.street !== 'preflop' && (
                <div className="gp-block">
                  <div className="gp-h">
                    Board texture: {ctx.boardLabel}
                    {ctx.boardType && <span className={`board-type ${ctx.boardType.toLowerCase().replace('-', '')}`}>{ctx.boardType}</span>}
                  </div>
                  <p>{ctx.boardSentence}</p>
                  {ctx.boardFavours && <p className="gp-muted">{ctx.boardFavours}</p>}
                </div>
              )}

              <div className="gp-block">
                <div className="gp-h">Your hand: {ctx.handLabel}</div>
                <p>{ctx.handBlurb}</p>
                {fb.equity != null && (
                  <p className="gp-muted">
                    <CalcLabel id="equity">Equity vs villain's range</CalcLabel>: <b>{(fb.equity * 100).toFixed(1)}%</b>.
                  </p>
                )}
              </div>
            </>
          )}

          <div className="gp-block">
            <div className="gp-h">Recommended mix</div>
            <p className="gp-muted">
              The solver-model's best line is <b>{fb.bestLabel}</b>. Frequencies are the mixed strategy; the bar
              shows how often to take each action.
            </p>
            <div className="gp-rows">
              {strat.options.map((o) => (
                <div
                  key={o.id}
                  className={`gp-row ${o.id === fb.best ? 'is-best' : ''} ${o.id === fb.chosen ? 'is-chosen' : ''}`}
                >
                  <span className="gp-bar-wrap">
                    <span
                      className="gp-bar"
                      style={{ width: `${o.freq * 100}%`, background: KIND_COLOR[o.kind ?? 'fold'] }}
                    />
                    <span className="gp-lbl">
                      {o.label}
                      {o.id === fb.best && <span className="best-tag">best</span>}
                      {o.id === fb.chosen && <span className="you-tag">you</span>}
                    </span>
                    <span className="gp-freq">{(o.freq * 100).toFixed(0)}%</span>
                  </span>
                  <span className={`gp-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>
                    {o.ev >= 0 ? '+' : ''}
                    {o.ev.toFixed(2)} bb
                  </span>
                </div>
              ))}
            </div>
          </div>

          {(best?.math || chosen?.math) && (
            <div className="gp-block">
              <div className="gp-h">
                <CalcLabel id="betEvFormula">The calculation ⓘ</CalcLabel>
              </div>
              <div className="gp-calc-plain">Plain version: how many chips each line wins on average — bigger is better. Hover the title for what the math means.</div>
              {best?.math && (
                <div className="gp-calc">
                  <div className="gp-calc-tag">Best — {best.label}</div>
                  <div className="se-math">{best.math}</div>
                </div>
              )}
              {chosen && chosen.id !== best?.id && chosen.math && (
                <div className="gp-calc">
                  <div className="gp-calc-tag">Your line — {chosen.label}</div>
                  <div className="se-math">{chosen.math}</div>
                </div>
              )}
            </div>
          )}

          <div className="strat-note">{strat.note}</div>
        </div>
      )}

      {showChart && <RangeChartModal strategy={strat} onClose={() => setShowChart(false)} />}
    </div>
  );
}
