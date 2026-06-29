import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { handCode } from '../ai/preflop';
import type { Facing } from '../strategy/preflopChart';
import { SCENARIOS, cellStrategy, getScenario } from '../strategy/preflopChart';
import { PlayingCard } from './PlayingCard';
import { MiniRangeGrid } from './MiniRangeGrid';
import { KIND_COLOR } from './chartColors';

// Trainer modes map onto the chart's `facing` types. RFI = open or fold; the
// rest face a raise, so the answer is 3-bet / call / fold (4-bet vs a 3-bet).
type Action = 'raise' | 'call' | 'fold';
type Mode = Extract<Facing, 'rfi' | 'vsopen' | 'vs3bet'> | 'random';

const MODES: { id: Mode; label: string }[] = [
  { id: 'rfi', label: 'Open (RFI)' },
  { id: 'vsopen', label: 'vs Open (3-bet)' },
  { id: 'vs3bet', label: 'vs 3-Bet (4-bet)' },
  { id: 'random', label: '🎲 Random' },
];

// Per-scenario-type wording. The active one follows the DEALT scenario, so a
// mixed spot pool still shows the right buttons/labels for whatever it dealt.
const FACING_META: Record<Facing, { raiseLabel: string; prompt: string }> = {
  rfi: { raiseLabel: 'Raise', prompt: 'It folds to you — open or fold?' },
  vsopen: { raiseLabel: '3-Bet', prompt: 'Someone opened — 3-bet, call, or fold?' },
  vs3bet: { raiseLabel: '4-Bet', prompt: 'You opened and got 3-bet — 4-bet, call, or fold?' },
  vs4bet: { raiseLabel: '5-Bet', prompt: 'You 3-bet and got 4-bet — 5-bet, call, or fold?' },
};

const ACTION_LABEL: Record<Action, string> = { raise: 'Raise', call: 'Call', fold: 'Fold' };

function kindToAction(kind?: string): Action {
  if (kind === 'value' || kind === 'bluff') return 'raise';
  if (kind === 'call') return 'call';
  return 'fold';
}

interface Dealt {
  scId: string;
  cards: Card[];
  code: string;
}

function dealRandom(scenarios: { id: string }[]): Dealt {
  const sc = scenarios[Math.floor(Math.random() * scenarios.length)];
  const a: Card = { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
  let b: Card;
  do {
    b = { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) };
  } while (b.rank === a.rank && b.suit === a.suit);
  return { scId: sc.id, cards: [a, b], code: handCode([a, b]) };
}

export function PreflopTrainer() {
  const [mode, setMode] = useState<Mode>('rfi');
  const [spotId, setSpotId] = useState<string | null>(null); // null = mix all spots in the mode
  const [cur, setCur] = useState<Dealt | null>(null);
  const [answered, setAnswered] = useState(false);
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0, streak: 0 });
  const [showChart, setShowChart] = useState(false);

  // scenarios for the selected mode; the spot picker pins one (null = mix all).
  const scenarios = useMemo(
    () => (mode === 'random' ? SCENARIOS : SCENARIOS.filter((s) => s.facing === mode)),
    [mode],
  );
  const dealPool = useMemo(
    () => (spotId ? scenarios.filter((s) => s.id === spotId) : scenarios),
    [scenarios, spotId],
  );

  // current spot: scenario + the per-action frequency mix for the dealt hand.
  const spot = useMemo(() => {
    if (!cur) return null;
    const sc = getScenario(cur.scId);
    const opts = cellStrategy(sc, cur.code);
    const freq: Record<Action, number> = { raise: 0, call: 0, fold: 0 };
    for (const o of opts) freq[kindToAction(o.kind)] += o.freq;
    const order: Action[] = ['raise', 'call', 'fold'];
    const present = order.filter((a) => freq[a] > 0).sort((x, y) => freq[y] - freq[x]);
    return { sc, freq, present, dominant: present[0] ?? 'fold' };
  }, [cur]);

  // The active scenario type drives the buttons/labels: follow the dealt spot,
  // else fall back to the chosen mode pre-deal.
  const curFacing: Facing | null = spot ? spot.sc.facing : mode === 'random' ? null : mode;
  const raiseLabel = curFacing ? FACING_META[curFacing].raiseLabel : 'Raise';
  const facingRaise = curFacing ? curFacing !== 'rfi' : true;
  const headerPrompt =
    mode === 'random' ? 'Random spot — read the scenario, then act.' : FACING_META[mode].prompt;

  const deal = useCallback(() => {
    setCur(dealRandom(dealPool.length ? dealPool : scenarios));
    setAnswered(false);
    setLastCorrect(null);
    setShowChart(false);
  }, [dealPool, scenarios]);

  // switching mode resets the current hand + spot so the scenario matches the buttons.
  const switchMode = useCallback((m: Mode) => {
    setMode(m);
    setSpotId(null);
    setCur(null);
    setAnswered(false);
    setLastCorrect(null);
    setShowChart(false);
  }, []);

  // pick a specific spot to drill (or null to mix every spot in the mode).
  const selectSpot = useCallback((id: string | null) => {
    setSpotId(id);
    setCur(null);
    setAnswered(false);
    setLastCorrect(null);
    setShowChart(false);
  }, []);

  const answer = useCallback(
    (action: Action) => {
      if (!cur || !spot || answered) return;
      if (action === 'call' && !facingRaise) return; // no call button in RFI mode
      const correct = spot.freq[action] > 0; // any action the solver mixes here counts
      setAnswered(true);
      setLastCorrect(correct);
      setScore((s) => ({
        correct: s.correct + (correct ? 1 : 0),
        total: s.total + 1,
        streak: correct ? s.streak + 1 : 0,
      }));
    },
    [cur, spot, answered, facingRaise],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'r' || e.key === 'R') answer('raise');
      else if (e.key === 'c' || e.key === 'C') answer('call');
      else if (e.key === 'f' || e.key === 'F') answer('fold');
      else if (e.key === ' ') {
        e.preventDefault();
        deal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer, deal]);

  const acc = score.total ? Math.round((score.correct / score.total) * 100) : 0;

  // human-readable mix for the feedback line, e.g. "3-Bet 50% / Call 50%".
  const describeMix = (): string => {
    if (!spot) return '';
    const lbl = (a: Action) => (a === 'raise' ? raiseLabel : ACTION_LABEL[a]);
    if (spot.present.length <= 1) return lbl(spot.dominant);
    return spot.present.map((a) => `${lbl(a)} ${Math.round(spot.freq[a] * 100)}%`).join(' / ');
  };

  return (
    <div className="card trainer-card">
      <h2>Preflop Range Trainer</h2>
      <p className="sub">
        {headerPrompt} Keys: <kbd>R</kbd> {raiseLabel.toLowerCase()}
        {facingRaise && <> · <kbd>C</kbd> call</>} · <kbd>F</kbd> fold · <kbd>Space</kbd> next.
      </p>

      <div className="trainer-filter">
        {MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? 'active' : ''} onClick={() => switchMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="trainer-spots">
        <span className="trainer-spots-label">{mode === 'rfi' ? 'Seat' : 'Spot'}</span>
        {/* in Random mode 🎲 Mix = every spot across all facings */}
        <button className={spotId === null ? 'active' : ''} onClick={() => selectSpot(null)}>
          🎲 Mix
        </button>
        {scenarios.map((s) => (
          <button key={s.id} className={spotId === s.id ? 'active' : ''} onClick={() => selectSpot(s.id)}>
            {s.short}
          </button>
        ))}
      </div>

      <div className="trainer-scenario">
        {cur && spot ? (
          <>
            Scenario: <b>{spot.sc.label}</b>
          </>
        ) : (
          'Press Deal to start'
        )}
      </div>

      <div className="trainer-cards">
        {cur ? (
          cur.cards.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)
        ) : (
          <>
            <div className="pcard back lg" />
            <div className="pcard back lg" />
          </>
        )}
      </div>

      <div className="trainer-actions">
        <button className="btn btn-raise" disabled={!cur || answered} onClick={() => answer('raise')}>
          {raiseLabel}
        </button>
        {facingRaise && (
          <button className="btn btn-call" disabled={!cur || answered} onClick={() => answer('call')}>
            Call
          </button>
        )}
        <button className="btn btn-fold" disabled={!cur || answered} onClick={() => answer('fold')}>
          Fold
        </button>
      </div>

      <div className={`trainer-fb ${lastCorrect === null ? '' : lastCorrect ? 'good' : 'bad'}`}>
        {answered && cur && spot
          ? lastCorrect
            ? `✓ Correct — ${cur.code} is a ${describeMix()} from ${spot.sc.short}.`
            : `✗ ${cur.code} should be ${describeMix()} from ${spot.sc.short}.`
          : facingRaise
            ? '3-bet, call, or fold?'
            : 'Raise or fold?'}
      </div>

      <button className="btn btn-deal" onClick={deal}>
        Deal Hand <kbd>Space</kbd>
      </button>

      <div className="trainer-score">
        <div>
          Correct <b>{score.correct}</b>
        </div>
        <div>
          Total <b>{score.total}</b>
        </div>
        <div>
          Accuracy <b>{score.total ? acc + '%' : '—'}</b>
        </div>
        <div>
          Streak <b>{score.streak}</b>
        </div>
      </div>

      {cur && (
        <button className="btn-chart-seat trainer-chart-btn" onClick={() => setShowChart(true)}>
          📊 Range chart — {spot?.sc.short}
        </button>
      )}

      {showChart && cur && spot && (
        <div className="modal-backdrop" onClick={() => setShowChart(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{spot.sc.label}</span>
              <button className="modal-close" onClick={() => setShowChart(false)}>✕</button>
            </div>
            <div className="modal-body">
              <MiniRangeGrid scenarioId={cur.scId} highlight={cur.code} />
              <div className="modal-side">
                <p className="modal-note">
                  {spot.sc.label}. Your hand <b>{cur.code}</b> is outlined in gold — its color shows the action.
                </p>
                <div className="legend chart-legend">
                  <div><span className="sw" style={{ background: KIND_COLOR.value }} /> {facingRaise ? `${raiseLabel} (value)` : 'Open / raise'}</div>
                  {facingRaise && <div><span className="sw" style={{ background: KIND_COLOR.call }} /> Call</div>}
                  {facingRaise && <div><span className="sw" style={{ background: KIND_COLOR.bluff }} /> {raiseLabel} bluff</div>}
                  {!facingRaise && <div><span className="sw" style={{ background: `linear-gradient(to right, ${KIND_COLOR.value} 50%, ${KIND_COLOR.fold} 50%)` }} /> Mixed (≈50% open)</div>}
                  <div><span className="sw" style={{ background: KIND_COLOR.fold }} /> Fold</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
