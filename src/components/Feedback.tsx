import { useState } from 'react';
import type { NodeFeedback } from '../analysis/grade';
import { RangeChartModal } from './RangeChartModal';
import { SizingCheatSheet } from './SizingCheatSheet';
import { KIND_COLOR } from './chartColors';
import { CalcLabel, GlossaryText } from './CalcTip';
import { ReasonList } from './ReasonList';

export function Feedback({ fb, peeked }: { fb: NodeFeedback | null; peeked?: boolean }) {
  const [explain, setExplain] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [showCheat, setShowCheat] = useState(false);
  const [openWhy, setOpenWhy] = useState<Set<string>>(new Set());
  const [prevFb, setPrevFb] = useState(fb);

  // when a new decision is graded, auto-open the gameplan for a leak/mistake
  if (fb !== prevFb) {
    setPrevFb(fb);
    setExplain(fb ? fb.verdict !== 'best' && fb.verdict !== 'correct' : false);
    setShowChart(false);
    // pre-open the "why" for the best line and the line you took, so the
    // comparison you most need — "why is the top line better than mine?" — is
    // visible without a click.
    setOpenWhy(fb ? new Set([fb.best, fb.chosen]) : new Set());
  }

  const toggleWhy = (id: string) =>
    setOpenWhy((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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
  // Postflop is an EV model, not a solver — name it "highest-EV" to match the
  // headline/detail. Preflop charts aren't EV-solved, so keep the old wording.
  const postflop = strat.source === 'postflop-model';
  const bestTerm = postflop ? 'highest-EV line' : 'solver line';
  const engineName = postflop ? 'EV model' : 'solver-model';

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
        You <b>{fb.chosenLabel}</b> · {bestTerm} <b>{fb.bestLabel}</b>
        {fb.evLoss > 0.001 && <span className="fb-evloss"> · −{fb.evLoss.toFixed(2)} bb <CalcLabel id="evLoss" pos="bottom">EV</CalcLabel></span>}
      </div>
      <div className={`fb-rng ${fb.rngMatch ? 'good' : ''}`}>
        🎲 RNG {fb.roll} → prescribed <b>{fb.prescribedLabel}</b>
        {fb.rngMatch ? ' ✓ you followed it' : ` (you took ${fb.chosenLabel})`}
      </div>
      <div className="fb-detail"><GlossaryText text={fb.detail} /></div>
      {fb.coach && (
        <div className="fb-coach"><ReasonList text={fb.coach} /></div>
      )}

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
                <div className="gp-hand-blurb"><ReasonList text={ctx.handBlurb} /></div>
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
              The {engineName}'s best line is <b>{fb.bestLabel}</b>. Frequencies are the mixed strategy; the bar
              shows how often to take each action. <b>Tap any line</b> for the reason behind its EV.
            </p>
            <div className="gp-rows">
              {strat.options.map((o) => {
                const open = openWhy.has(o.id);
                return (
                  <div key={o.id} className="gp-row-wrap">
                    <button
                      type="button"
                      className={`gp-row ${o.id === fb.best ? 'is-best' : ''} ${o.id === fb.chosen ? 'is-chosen' : ''} ${open ? 'is-open' : ''}`}
                      onClick={() => toggleWhy(o.id)}
                      aria-expanded={open}
                      title="Show why this line has this EV"
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
                      <span className="gp-why-caret">{open ? '▾' : '▸'}</span>
                    </button>
                    {open && o.why && (
                      <div className="gp-why">
                        <GlossaryText text={o.why} />
                        {o.sizeNote && <div className="gp-why-size">{o.sizeNote}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
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

          {strat.notes?.length ? (
            <ul className="strat-note-list">
              {strat.notes.map((line, i) => (
                <li key={i}><GlossaryText text={line} /></li>
              ))}
            </ul>
          ) : (
            <div className="strat-note"><GlossaryText text={strat.note} /></div>
          )}
        </div>
      )}

      {showChart && <RangeChartModal strategy={strat} onClose={() => setShowChart(false)} />}
    </div>
  );
}
