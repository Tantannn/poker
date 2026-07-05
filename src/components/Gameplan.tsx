// Postflop Gameplan tab — two modes:
//  • Chart (#1): the reference matrix (board texture × bets in pot → tier), tap a
//    cell to see the cumulative hand classes that tier bets.
//  • Drill (#2): deal a random board + bets-in-pot + hand; you say bet or check
//    (first to act), graded against the gameplan. Reveals the tier and the mapping
//    of your hand to its chart class. All logic comes from strategy/gameplan.

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomCard, describeTexture } from '../engine/board';
import { classifyHandClass } from '../strategy/handClass';
import {
  TEXTURE_ROWS, BET_COLS, GRID, TEXTURE_LABEL, tierGroups, tierIndex,
  SPECIAL_RULES, BETS_NOTE, FRAMING_NOTE,
  classifyGameplanTexture, shouldBet, betBucket,
} from '../strategy/gameplan';
import type { GTexture, BetBucket, Tier } from '../strategy/gameplan';
import { playGrade } from '../sound';
import { SpotBoard } from './SpotBoard';

const TIER_CLASS: Record<Tier, string> = {
  'Tight+': 'gp-tier-tightplus',
  Tight: 'gp-tier-tight',
  Loose: 'gp-tier-loose',
  'Loose+': 'gp-tier-looseplus',
};

type Mode = 'chart' | 'drill';

export function Gameplan() {
  const [mode, setMode] = useState<Mode>('chart');
  return (
    <div className="card">
      <h2>Postflop Gameplan</h2>
      <p className="sub">
        A simplified, memorizable betting system: look up a range by just two things — the <b>board
        texture</b> and the total <b>bets in pot</b> so far. For exact per-hand EV play use the{' '}
        <b>Postflop Lab</b>; this is the hold-it-in-your-head gameplan for when you're first to act.
      </p>
      <div className="quiz-bar">
        <div className="quiz-drills">
          <button className={mode === 'chart' ? 'active' : ''} onClick={() => setMode('chart')}>📋 Chart</button>
          <button className={mode === 'drill' ? 'active' : ''} onClick={() => setMode('drill')}>🎯 Drill</button>
        </div>
      </div>
      {mode === 'chart' ? <GameplanChart /> : <GameplanDrill />}
    </div>
  );
}

// ---------------- #1 reference chart ----------------
interface Sel { texture: GTexture; bucket: BetBucket }

function GameplanChart() {
  const [sel, setSel] = useState<Sel>({ texture: 'high', bucket: 0 });
  const selTier = GRID[sel.texture][sel.bucket];
  const cut = tierIndex(selTier);
  const groups = tierGroups(sel.texture);
  const bucketLabel = BET_COLS[sel.bucket].label;

  return (
    <>
      <div className="gp-framing">{FRAMING_NOTE}</div>

      <div className="gp-table-wrap">
        <table className="gp-table">
          <thead>
            <tr>
              <th className="gp-corner">Board texture ↓ · Bets in pot →</th>
              {BET_COLS.map((c) => <th key={c.id}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {TEXTURE_ROWS.map((row) => (
              <tr key={row.id}>
                <th className="gp-rowhead" title={row.desc}>{row.label}</th>
                {BET_COLS.map((c) => {
                  const tier = GRID[row.id][c.id];
                  const active = sel.texture === row.id && sel.bucket === c.id;
                  return (
                    <td key={c.id}>
                      <button
                        className={`gp-cell ${TIER_CLASS[tier]} ${active ? 'active' : ''}`}
                        onClick={() => setSel({ texture: row.id, bucket: c.id })}
                      >
                        {tier}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note gp-betnote">{BETS_NOTE}</p>

      <div className="gp-detail">
        <div className="gp-detail-head">
          <span className={`gp-tier-pill ${TIER_CLASS[selTier]}`}>{selTier}</span>
          <div>
            <b>{TEXTURE_LABEL[sel.texture]}</b> · bets in pot <b>{bucketLabel}</b>
            <p>{TEXTURE_ROWS.find((r) => r.id === sel.texture)?.desc}</p>
          </div>
        </div>
        <p className="gp-detail-lead">Bet these hand classes (each tier includes every tighter tier above it):</p>
        {groups.map((g) => {
          const included = tierIndex(g.tier) <= cut;
          return (
            <div key={g.tier} className={`gp-group ${included ? '' : 'excluded'}`}>
              <span className={`gp-group-tag ${TIER_CLASS[g.tier]}`}>{g.tier}{included ? '' : ' (not bet here)'}</span>
              <div className="gp-chips">
                {g.classes.map((cls) => <span key={cls} className="gp-chip">{cls}</span>)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="gp-special">
        <h4>Special cases</h4>
        {SPECIAL_RULES.map((r) => (
          <div key={r.title} className="gp-special-row">
            <b>{r.title}</b>
            <p>{r.body}</p>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------- #2 drill ----------------
interface DrillSpot { hero: Card[]; board: Card[]; bets: number }

function dealSpot(): DrillSpot {
  const dead: Card[] = [];
  const draw = () => { const c = randomCard(dead); dead.push(c); return c; };
  const hero = [draw(), draw()];
  // flop/turn/river mix: turn+ (4-5 cards) makes 4-flush / 4-straight rows reachable;
  // flop/turn (3-4 cards) keeps draws live (the classifier only tags draws pre-river).
  const nBoard = 3 + Math.floor(Math.random() * 3);
  const board: Card[] = [];
  for (let i = 0; i < nBoard; i++) board.push(draw());
  const bucket = Math.floor(Math.random() * 3);
  const bets = bucket === 0 ? 0 : bucket === 1 ? [0.5, 1, 1.5][Math.floor(Math.random() * 3)] : [2, 2.5, 3][Math.floor(Math.random() * 3)];
  return { hero, board, bets };
}
// first spot at module load — React forbids Math.random in the render phase.
const FIRST_DRILL = dealSpot();

function GameplanDrill() {
  const [spot, setSpot] = useState<DrillSpot>(FIRST_DRILL);
  const [answer, setAnswer] = useState<'bet' | 'check' | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });

  const texture = useMemo(() => classifyGameplanTexture(spot.board), [spot]);
  const verdict = useMemo(() => shouldBet(spot.hero, spot.board, texture, spot.bets), [spot, texture]);
  const handLabel = useMemo(() => classifyHandClass(spot.hero, spot.board).label, [spot]);
  const groups = useMemo(() => tierGroups(texture), [texture]);

  const revealed = answer != null;
  const correct = revealed && (answer === 'bet') === verdict.bet;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  function pick(a: 'bet' | 'check') {
    if (revealed) return;
    const ok = (a === 'bet') === verdict.bet;
    setAnswer(a);
    setScore((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1 }));
    playGrade(ok);
  }
  function next() { setSpot(dealSpot()); setAnswer(null); }

  return (
    <>
      <div className="quiz-bar">
        <div className="gp-framing" style={{ margin: 0, flex: 1 }}>
          First to act (or facing a check) — bet or check? Read the <b>board texture</b> and the <b>bets in pot</b>,
          then decide whether your hand is in the tier that bets.
        </div>
        <div className="quiz-score">Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)</div>
      </div>

      <div className="lab-meta">
        Board: <b>{TEXTURE_LABEL[texture]}</b> · bets in pot <b>{spot.bets === 0 ? '0' : spot.bets}</b> → column <b>{BET_COLS[betBucket(spot.bets)].label}</b>
      </div>
      <SpotBoard
        hero={spot.hero}
        board={spot.board}
        handLabel={handLabel}
        boardTag={<>Board · {describeTexture(spot.board).label}</>}
        equity={null}
      />

      {!revealed ? (
        <>
          <div className="lab-prompt">Bet or check this hand?</div>
          <div className="rd-bands">
            <button className="rd-band" onClick={() => pick('bet')}>
              <span className="rd-band-lbl">Bet</span>
              <span className="rd-band-sub">hand is in the tier</span>
            </button>
            <button className="rd-band" onClick={() => pick('check')}>
              <span className="rd-band-lbl">Check</span>
              <span className="rd-band-sub">hand is below the tier</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct ? '✓ Correct — ' : '✗ '}
            Gameplan says <b>{verdict.bet ? 'BET' : 'CHECK'}</b>.{' '}
            {TEXTURE_LABEL[texture]} + bets {spot.bets === 0 ? '0' : spot.bets} → <b>{verdict.tier}</b> tier.{' '}
            Your hand ({verdict.chartClass ?? handLabel}) {verdict.entryTier
              ? <>enters at <b>{verdict.entryTier}</b> — {verdict.bet ? 'inside the range, so bet.' : 'looser than the recommended tier, so check.'}</>
              : <>isn't in the betting range at all, so check.</>}
            <button className="btn btn-deal lab-next" onClick={next}>Next hand →</button>
          </div>

          <div className="gp-detail">
            <div className="gp-detail-head">
              <span className={`gp-tier-pill ${TIER_CLASS[verdict.tier]}`}>{verdict.tier}</span>
              <div><b>{TEXTURE_LABEL[texture]}</b> · bets in pot <b>{spot.bets === 0 ? '0' : spot.bets}</b><p>Bet the classes up to and including the {verdict.tier} tier.</p></div>
            </div>
            {groups.map((g) => {
              const included = tierIndex(g.tier) <= tierIndex(verdict.tier);
              return (
                <div key={g.tier} className={`gp-group ${included ? '' : 'excluded'}`}>
                  <span className={`gp-group-tag ${TIER_CLASS[g.tier]}`}>{g.tier}{included ? '' : ' (not bet here)'}</span>
                  <div className="gp-chips">
                    {g.classes.map((cls) => (
                      <span key={cls} className={`gp-chip ${cls === verdict.chartClass ? 'you' : ''}`}>{cls}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <p className="note">
        Grades against the simplified gameplan (a transparent lookup), not the EV solver — your hand is
        mapped to its nearest chart class. First-to-act framing; the OOP special cases still apply.
      </p>
    </>
  );
}
