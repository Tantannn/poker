import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { handCode } from '../ai/preflop';
import type { Facing, PreflopScenario, TableSize } from '../strategy/preflopChart';
import { cellStrategy, dominantKind, getScenario, scenariosForSize } from '../strategy/preflopChart';
import { PlayingCard } from './PlayingCard';
import { MiniRangeGrid } from './MiniRangeGrid';
import { KIND_COLOR } from './chartColors';
import { playGrade } from '../sound';

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

// Table-size picker. Short tables reuse the 6-max charts via "lop the top":
// blinds + button are fixed, so each step removes the earliest seat. Heads-up
// is the exception — the SB is the button and opens huge, so it has its own
// ranges. The note explains what shifts at each size.
const TABLE_SIZES: { n: TableSize; label: string; note: string }[] = [
  { n: 6, label: '6-max', note: 'Full 6-max: UTG · MP · CO · BTN · SB · BB.' },
  { n: 5, label: '5-handed', note: 'UTG gone — earliest seat now plays MP’s range.' },
  { n: 4, label: '4-handed', note: 'UTG + MP gone — earliest seat plays CO’s range.' },
  { n: 3, label: '3-handed', note: 'Only BTN · SB · BB remain — everyone opens wide.' },
  { n: 2, label: 'Heads-up', note: 'SB is the button: opens ~80%+. Dedicated HU ranges.' },
];

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

// ---- Borderline-weighted dealing --------------------------------------------
// Uniform random deals mostly obvious trash (72o) or obvious premiums. The hands
// worth drilling are the CLOSE ones: mixed-frequency cells, and cells right on a
// range boundary (an open next to a fold, a fold next to an open, a value hand
// next to a call). We weight toward those so reps land where memory actually
// slips, not on hands whose answer is never in doubt.

const CHAR_TO_RANK: Record<string, number> = {
  A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
};
// Grid order (A→2) so cell neighbors map to adjacent hands, matching MiniRangeGrid.
const GRID_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

// The 169 code at grid cell (i,j): pair on the diagonal, suited above, offsuit below.
function codeAt(i: number, j: number): string {
  const r1 = GRID_RANKS[i];
  const r2 = GRID_RANKS[j];
  return i === j ? r1 + r1 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
}

// Concrete cards for a 169 code (suits fixed — the trainer only reads the code).
function cardsForCode(code: string): Card[] {
  if (code.length === 2) {
    const r = CHAR_TO_RANK[code[0]];
    return [{ rank: r, suit: 0 }, { rank: r, suit: 1 }];
  }
  const hi = CHAR_TO_RANK[code[0]];
  const lo = CHAR_TO_RANK[code[1]];
  const suited = code[2] === 's';
  return [{ rank: hi, suit: 0 }, { rank: lo, suit: suited ? 0 : 1 }];
}

// Per-cell deal weight for a scenario: mixed cells highest, then boundary cells
// (a neighbor plays a different dominant action), then a low floor for clear
// interior hands and a lower one for deep folds.
function borderlineWeights(sc: PreflopScenario): { code: string; w: number }[] {
  const N = GRID_RANKS.length;
  const dom: string[][] = [];
  const mixed: boolean[][] = [];
  for (let i = 0; i < N; i++) {
    dom[i] = [];
    mixed[i] = [];
    for (let j = 0; j < N; j++) {
      const opts = cellStrategy(sc, codeAt(i, j));
      dom[i][j] = dominantKind(opts) ?? 'fold';
      mixed[i][j] = opts.length > 1; // a real frequency split (mixOpen / bluff cells)
    }
  }
  const out: { code: string; w: number }[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const k = dom[i][j];
      const nb = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
      const boundary = nb.some(([ni, nj]) => ni >= 0 && nj >= 0 && ni < N && nj < N && dom[ni][nj] !== k);
      const w = mixed[i][j] ? 6 : boundary ? 4 : k === 'fold' ? 0.3 : 1.2;
      out.push({ code: codeAt(i, j), w });
    }
  }
  return out;
}

function weightedPick(items: { code: string; w: number }[]): string {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.code;
  }
  return items[items.length - 1].code;
}

// Pick a scenario, then a borderline-weighted hand within it.
function borderlineDeal(scenarios: PreflopScenario[]): Dealt {
  const sc = scenarios[Math.floor(Math.random() * scenarios.length)];
  const code = weightedPick(borderlineWeights(sc));
  return { scId: sc.id, cards: cardsForCode(code), code };
}

export function PreflopTrainer() {
  const [mode, setMode] = useState<Mode>('rfi');
  const [tableSize, setTableSize] = useState<TableSize>(6);
  const [spotId, setSpotId] = useState<string | null>(null); // null = mix all spots in the mode
  const [cur, setCur] = useState<Dealt | null>(null);
  const [answered, setAnswered] = useState(false);
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0, streak: 0 });
  const [showChart, setShowChart] = useState(false);
  // Deal weighted toward borderline hands (mixed cells + range edges) instead of
  // uniform random, so reps land on the close decisions, not obvious trash.
  const [edgeFocus, setEdgeFocus] = useState(true);

  // scenarios reachable at the chosen table size, then narrowed to the mode;
  // the spot picker pins one (null = mix all).
  const sizePool = useMemo(() => scenariosForSize(tableSize), [tableSize]);
  const scenarios = useMemo(
    () => (mode === 'random' ? sizePool : sizePool.filter((s) => s.facing === mode)),
    [mode, sizePool],
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
    const pool = dealPool.length ? dealPool : scenarios;
    if (!pool.length) return; // no spot for this mode + table size
    setCur(edgeFocus ? borderlineDeal(pool) : dealRandom(pool));
    setAnswered(false);
    setLastCorrect(null);
    setShowChart(false);
  }, [dealPool, scenarios, edgeFocus]);

  // switching mode resets the current hand + spot so the scenario matches the buttons.
  const switchMode = useCallback((m: Mode) => {
    setMode(m);
    setSpotId(null);
    setCur(null);
    setAnswered(false);
    setLastCorrect(null);
    setShowChart(false);
  }, []);

  // switching table size resets the hand + spot; the scenario pool changes.
  const switchSize = useCallback((n: TableSize) => {
    setTableSize(n);
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
      playGrade(correct);
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
  const sizeNote = TABLE_SIZES.find((t) => t.n === tableSize)?.note ?? '';
  const noSpots = scenarios.length === 0;

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

      <div className="trainer-filter trainer-sizes">
        <span className="trainer-spots-label">Players</span>
        {TABLE_SIZES.map((t) => (
          <button key={t.n} className={tableSize === t.n ? 'active' : ''} onClick={() => switchSize(t.n)}>
            {t.label}
          </button>
        ))}
      </div>

      <p className="sub trainer-size-note">{sizeNote}</p>

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

      <label
        className="sc-check trainer-edge-toggle"
        title="Deal mostly borderline hands — mixed spots and hands right on the edge of the range — instead of uniformly random hands where most are obvious trash or obvious premiums."
      >
        <input type="checkbox" checked={edgeFocus} onChange={(e) => setEdgeFocus(e.target.checked)} />
        🎯 Focus borderline hands
      </label>

      <div className="trainer-scenario">
        {noSpots ? (
          <>No <b>{MODES.find((m) => m.id === mode)?.label}</b> spot at this table size — try another mode.</>
        ) : cur && spot ? (
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

      <button className="btn btn-deal" onClick={deal} disabled={noSpots}>
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
                {spot.sc.mnemonic && (
                  <details className="equity-explain chart-mnemonic">
                    <summary>💡 How to remember this range</summary>
                    <p>{spot.sc.mnemonic}</p>
                  </details>
                )}
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
