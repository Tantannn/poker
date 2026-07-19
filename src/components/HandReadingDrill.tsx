import { useMemo, useState } from 'react';
import { PlayingCard } from './PlayingCard';
import { handCode } from '../ai/preflop';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';
import {
  makeScenario,
  gridCode,
  scoreRead,
  rangeMakeup,
  classifyCombo,
  HR_RANKS,
  type HRScenario,
  type HRScore,
} from '../strategy/handReading';

const DRILL_ID = 'handreading';
const PASS = 0.75; // grade the read "correct" for the streak at ≥75% cell accuracy

function fracLabel(f: number): string {
  if (f >= 0.72) return '¾ pot';
  if (f >= 0.6) return '⅔ pot';
  if (f >= 0.45) return '½ pot';
  return `${Math.round(f * 100)}%`;
}

const CLASS_LABEL: Record<string, string> = { value: 'a made hand (value)', draw: 'a draw', air: 'air (a bluff)' };

export function HandReadingDrill() {
  const [scenario, setScenario] = useState<HRScenario>(() => makeScenario());
  const [revealed, setRevealed] = useState(1); // streets shown: 1=flop … 3=river
  const [heroKeep, setHeroKeep] = useState<Set<string>>(() => new Set(scenario.profile.codes));
  const [result, setResult] = useState<HRScore | null>(null);
  const [score, setScore] = useState(() => loadDrillScore(DRILL_ID));

  const startSet = useMemo(() => new Set(scenario.profile.codes), [scenario]);
  const villainCode = useMemo(() => handCode(scenario.villainHand), [scenario]);
  const board = scenario.streets[revealed - 1].board;
  const shown = result != null;

  const toggle = (code: string) => {
    if (shown || !startSet.has(code)) return;
    setHeroKeep((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const nextStreet = () => {
    if (revealed < 3) setRevealed((r) => r + 1);
  };

  const reveal = () => {
    const r = scoreRead(scenario, revealed, heroKeep);
    setResult(r);
    setScore(recordDrillScore(DRILL_ID, r.accuracy >= PASS));
  };

  const newHand = () => {
    const sc = makeScenario();
    setScenario(sc);
    setRevealed(1);
    setHeroKeep(new Set(sc.profile.codes));
    setResult(null);
  };

  const pct = score.total ? Math.round((score.correct / score.total) * 100) : 0;
  const makeup = shown ? rangeMakeup(result!.target, scenario, revealed) : null;
  const vClass = shown ? classifyCombo(scenario.villainHand, board) : null;

  return (
    <div className="card">
      <div className="analytics-head">
        <h2>🕵 Hand-Reading Trainer</h2>
        <div className="hr-streak">
          <span>
            Reads on point: <b>{score.correct}</b>/{score.total} ({pct}%)
          </span>
          <button
            className="btn-small"
            onClick={() => {
              setScore(resetDrillScore(DRILL_ID));
            }}
          >
            Reset streak
          </button>
        </div>
      </div>

      <p className="note">
        Put villain on a range. Start with his whole preflop range lit up, then <b>click to remove</b> the hands
        he <i>wouldn't</i> play this way as the story unfolds. Reveal to see how tight your read was — and what he
        actually had.
      </p>

      <div className="hr-villain">
        <span className="hr-tag">{scenario.profile.label}</span>
        <span className="sub">{scenario.profile.note}</span>
      </div>

      <div className="hr-board">
        {board.map((c, i) => (
          <PlayingCard key={i} card={c} size="md" />
        ))}
        <div className="hr-actions">
          {scenario.streets.slice(0, revealed).map((s) => (
            <span key={s.name} className={`hr-streetbadge ${s.action.kind}`}>
              {s.name}: {s.action.kind === 'bet' ? `bets ${fracLabel(s.action.frac)}` : 'checks'}
            </span>
          ))}
        </div>
      </div>

      <div className="hr-grid" role="grid" aria-label="Villain range grid">
        {HR_RANKS.map((_, i) => (
          <div key={i} className="hr-row" role="row">
            {HR_RANKS.map((__, j) => {
              const code = gridCode(i, j);
              const inStart = startSet.has(code);
              const kept = heroKeep.has(code);
              const targetIn = shown ? result!.target.has(code) : false;
              const wrong = shown && inStart && kept !== targetIn;
              const cls = [
                'hr-cell',
                inStart ? (kept ? 'hr-keep' : 'hr-cut') : 'hr-out',
                wrong ? (kept ? 'hr-wrong-keep' : 'hr-wrong-cut') : '',
                shown && code === villainCode ? 'hr-actual' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={j}
                  role="gridcell"
                  className={cls}
                  disabled={shown || !inStart}
                  onClick={() => toggle(code)}
                  title={code}
                >
                  {code.replace('s', '').replace('o', '')}
                  {code.endsWith('s') ? <sup>s</sup> : code.endsWith('o') ? <sup>o</sup> : ''}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="hr-legend">
        <span><i className="sw hr-keep" /> kept in range</span>
        <span><i className="sw hr-cut" /> you removed</span>
        <span><i className="sw hr-out" /> never in range</span>
        {shown && <span><i className="sw hr-actual" /> what he had</span>}
      </div>

      <div className="hr-controls">
        {!shown && revealed < 3 && (
          <button className="btn secondary" onClick={nextStreet}>
            Next street ▶
          </button>
        )}
        {!shown && (
          <button className="btn primary" onClick={reveal}>
            Reveal read
          </button>
        )}
        <button className="btn btn-deal" onClick={newHand}>
          New hand ⟳
        </button>
      </div>

      {shown && result && makeup && (
        <div className="hr-result">
          <div className={`hr-grade ${result.accuracy >= PASS ? 'pos' : 'neg'}`}>
            {result.accuracy >= PASS ? '✓ Sharp read' : '✗ Off'} — {Math.round(result.accuracy * 100)}% of cells
            matched the solver's narrowed range ({result.correct}/{result.total}).
          </div>
          <p className="note">
            You left in <b>{result.keptWrong.length}</b> hand{result.keptWrong.length === 1 ? '' : 's'} he'd have
            folded/checked, and cut <b>{result.cutWrong.length}</b> he'd actually keep barrelling.
          </p>

          <div className="hr-actualhand">
            He had{' '}
            {scenario.villainHand.map((c, i) => (
              <PlayingCard key={i} card={c} size="sm" />
            ))}
            <span className="sub">
              {' '}
              — {villainCode}, {CLASS_LABEL[vClass!]} on this runout.
            </span>
          </div>

          <div className="hr-makeup">
            <div className="an-h">His consistent range here ≈ {makeup.combos} combos</div>
            <div className="hr-makeup-bar">
              <Seg cls="hrm-value" n={makeup.value} total={makeup.combos} label="Value" />
              <Seg cls="hrm-draw" n={makeup.draw} total={makeup.combos} label="Draws" />
              <Seg cls="hrm-air" n={makeup.air} total={makeup.combos} label="Air" />
            </div>
            <div className="hr-makeup-legend">
              <span><i className="sw hrm-value" /> Value {makeup.value}</span>
              <span><i className="sw hrm-draw" /> Draws {makeup.draw}</span>
              <span><i className="sw hrm-air" /> Air {makeup.air}</span>
            </div>
          </div>

          <p className="note">
            Read the ratio, not the hand: {makeup.value + makeup.draw} of ~{makeup.combos} combos are value or
            draws, so his barrel here is {makeup.air >= makeup.value ? 'bluff-heavy — a bluff-catcher can call' : 'value-weighted — bluff-catchers are in trouble'}.
            The exact hand ({villainCode}) is one draw from that distribution — you play the range, not the guess.
          </p>
        </div>
      )}
    </div>
  );
}

function Seg({ cls, n, total, label }: { cls: string; n: number; total: number; label: string }) {
  const pct = total ? (n / total) * 100 : 0;
  if (n === 0) return null;
  return (
    <div className={`hr-seg ${cls}`} style={{ flexGrow: Math.max(0.02, pct) }} title={`${label}: ${n}`}>
      {pct > 10 ? `${Math.round(pct)}%` : ''}
    </div>
  );
}
