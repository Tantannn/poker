// Pre-lock measuring aid: sort villain's range into piles, price each pile, and the
// weighted sum is your equity estimate. After lock it shows each pile's true value.
import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { rankToChar, SUIT_SYMBOLS } from '../engine/cards';
import { buildSampleTable, rangeCombos } from '../engine/range';
import type { ComboWeight, WeightedRange } from '../engine/range';
import {
  buildTallyGroups, exampleCombos, groupTruth, ruleOfFourEstimate, tallyEstimate,
  TALLY_STEPS, UNTOUCHED_PCT,
} from '../strategy/rangeTally';

const STEP_LABELS: Record<number, string> = { 0: 'lose', 25: 'mostly lose', 50: 'flip', 75: 'mostly beat', 100: 'beat' };

const nearestStep = (pct: number) =>
  TALLY_STEPS.reduce((best, s) => (Math.abs(s - pct) < Math.abs(best - pct) ? s : best), TALLY_STEPS[0]);

const fmtCombo = (combo: [Card, Card]) => combo.map((c) => rankToChar(c.rank) + SUIT_SYMBOLS[c.suit]).join('');

interface Props {
  hero: Card[];
  board: Card[];
  range: WeightedRange;
  comboWeight?: ComboWeight;
  street: 'Flop' | 'Turn';
  drawOuts: number;
  locked: boolean;
  trueEquity: number;
  rangeLabel: string;
  /** null when he checked */
  betLabel: string | null;
  typeLabel: string;
  onUseEstimate: (pct: number) => void;
  onPeek: () => void;
}

export function RangeTally({ hero, board, range, comboWeight, street, drawOuts, locked, trueEquity, rangeLabel, betLabel, typeLabel, onUseEstimate, onPeek }: Props) {
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const groups = useMemo(() => buildTallyGroups(hero, board, range, comboWeight), [hero, board, range, comboWeight]);
  const [peeked, setPeeked] = useState(false);
  const showAnswers = locked || peeked;
  const truths = useMemo(
    () => (showAnswers ? Object.fromEntries(groups.map((g) => [g.id, groupTruth(hero, board, g)])) : null),
    [showAnswers, groups, hero, board],
  );
  const rawGroups = useMemo(() => buildTallyGroups(hero, board, range), [hero, board, range]);
  const preflopCombos = Math.round(rangeCombos(range));
  const afterBlockers = useMemo(() => buildSampleTable(range, [...hero, ...board]).combos.length, [hero, board, range]);
  const estimate = Math.round(tallyEstimate(groups, picks));
  const touched = Object.keys(picks).length;

  if (!open) {
    return (
      <button className="rd-cheat" onClick={() => setOpen(true)} title="Sort his range into piles and price each one — the weighted sum is your estimate">
        🧮 measure it
      </button>
    );
  }

  return (
    <div className="rd-tally">
      <div className="rd-tally-head">
        <b>🧮 Measure it</b> — price each pile of his range (what % of the pot you win vs that pile). Estimate = Σ share × price.
        <button className="btn-small" onClick={() => setOpen(false)}>hide</button>
      </div>
      <div className="rd-tally-build">
        <b>How his range is built (this spot)</b>
        <div>
          <b>1 · Position:</b> {rangeLabel} = about {preflopCombos} of 1326 combos ({Math.round((preflopCombos / 1326) * 100)}% of all hands).
          Card removal from your hand and the board leaves {afterBlockers} combos.
        </div>
        <div>
          <b>2 · Board:</b> sort what is left by how it hit — {rawGroups.map((g) => `${g.label} ${Math.round(g.share * 100)}%`).join(' · ')}.
        </div>
        <div>
          <b>3 · His action:</b>{' '}
          {betLabel
            ? `he ${betLabel.toLowerCase()} as a ${typeLabel}. A bet keeps value and draws and drops weak showdown hands: ${groups
                .map((g) => `${g.label} ${Math.round((rawGroups.find((r) => r.id === g.id)?.share ?? 0) * 100)}% → ${Math.round(g.share * 100)}%`)
                .join(' · ')}.`
            : 'he checked, so nothing is cut — the piles above are his whole range.'}
        </div>
      </div>
      {drawOuts > 0 && (
        <div className="muted">
          Your ~{drawOuts} outs → Rule of {street === 'Flop' ? '4' : '2'} ≈ {ruleOfFourEstimate(drawOuts, street)}% to hit
          {street === 'Flop' && drawOuts > 8 ? ' (corrected: −1 per out past 8)' : ''}. Use it to price the piles you're behind.
        </div>
      )}
      {groups.map((g) => {
        const pick = picks[g.id];
        const truth = truths?.[g.id];
        return (
          <div key={g.id} className="rd-tally-row">
            <div>
              <b>{g.label}</b> · {Math.round(g.share * 100)}% of his range
              <span className="muted"> · {exampleCombos(g).map(fmtCombo).join('  ')}</span>
            </div>
            <div className="rd-tally-steps">
              {TALLY_STEPS.map((s) => (
                <button
                  key={s}
                  disabled={locked}
                  className={`rd-range ${pick === s ? 'active' : ''} ${truth != null && s === nearestStep(truth) ? 'rd-correct' : ''}`}
                  onClick={() => setPicks((p) => ({ ...p, [g.id]: s }))}
                >
                  {STEP_LABELS[s]}{truth != null && s === nearestStep(truth) ? ' ✓' : ''}
                </button>
              ))}
              {truth != null && (
                <span className={pick != null && pick === nearestStep(truth) ? 'good' : 'bad'}>
                  {' '}actually {Math.round(truth)}% → {STEP_LABELS[nearestStep(truth)]}
                </span>
              )}
            </div>
            <div className="muted">
              {Math.round(g.share * 100)}% × {pick ?? UNTOUCHED_PCT} = <b>{(g.share * (pick ?? UNTOUCHED_PCT)).toFixed(1)}</b> pts
              {truth != null && <> · correct: {(g.share * truth).toFixed(1)} pts</>}
            </div>
          </div>
        );
      })}
      <div className="muted">
        How to add: each pile's points = its share × your price (0 / 25 / 50 / 75 / 100). Add all the points up —
        that sum is your equity: {groups.map((g) => (g.share * (picks[g.id] ?? UNTOUCHED_PCT)).toFixed(1)).join(' + ')} = <b>{estimate}%</b>
      </div>
      <div className="rd-tally-foot">
        <span className="big-stat gold">{estimate}%</span>
        <span className="muted"> tally estimate{touched < groups.length ? ` (${groups.length - touched} untouched pile(s) counted as flip)` : ''}</span>
        {!locked ? (
          <>
            <button className="btn btn-deal" onClick={() => onUseEstimate(estimate)}>Use as my guess</button>
            {peeked && <span className="good">true equity {trueEquity.toFixed(1)}% (unscored)</span>}
            {!peeked && (
              <button
                className="btn-small"
                onClick={() => { setPeeked(true); onPeek(); }}
                title="Reveal what each pile is really worth — this spot then won't count toward your score"
              >
                👁 show answers
              </button>
            )}
          </>
        ) : (
          <span className={Math.abs(estimate - trueEquity) <= 10 ? 'good' : 'bad'}>
            {' '}tally was {estimate}%, true {trueEquity.toFixed(1)}% → off by {Math.abs(estimate - trueEquity).toFixed(0)} pts
          </span>
        )}
      </div>
    </div>
  );
}
