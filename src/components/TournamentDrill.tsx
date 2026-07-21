// Tournament Drill — the two skills a LIVE-tournament grinder needs that the cash
// drills don't teach, and where mid-stakes live players bleed the most:
//   • PUSH/FOLD — folded to you on a short stack: shove or fold? Graded vs a
//     Nash-approx first-in jam chart (strategy/pushFold), keyed by stack + seat.
//   • ICM BUBBLE — facing an all-in on the bubble: chips aren't money, so a call
//     that's +chipEV can be a clear FOLD once pay jumps are priced in. Graded vs
//     ICM $EV (engine/icm), with the chipEV verdict shown alongside so the gap —
//     the "bubble tax" — is explicit.
// Follows the app's drill pattern: module-load first spot (no Math.random in
// render), keyboard 1/2 + Space, persistent per-mode score.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { handCode } from '../ai/preflop';
import { rangeFromTokens } from '../engine/range';
import { equityVsRange } from '../engine/equity';
import { icmEquities, payoutTable } from '../engine/icm';
import {
  PF_POSITIONS,
  PF_POS_LABEL,
  PF_BUCKET_LABEL,
  bucketFor,
  shouldJam,
  shoveTokens,
  jamPct,
  type PfPos,
} from '../strategy/pushFold';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';
import { playGrade } from '../sound';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

type Mode = 'pf' | 'icm';

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function dealHero(): Card[] {
  const rc = (): Card => ({ rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) });
  const a = rc();
  let b = rc();
  while (a.rank === b.rank && a.suit === b.suit) b = rc();
  return [a, b];
}

// ---------------- push / fold ----------------
interface PfSpot {
  hero: Card[];
  bb: number;
  pos: PfPos;
  jam: boolean; // chart says shove
  code: string;
}
function genPf(): PfSpot {
  const hero = dealHero();
  const bb = randInt(6, 25);
  const pos = PF_POSITIONS[randInt(0, PF_POSITIONS.length - 1)];
  return { hero, bb, pos, jam: shouldJam(hero, bb, pos), code: handCode(hero) };
}

// ---------------- ICM bubble ----------------
const FIELD = 6;
const PAYOUTS = payoutTable(FIELD); // [0.5, 0.3, 0.2] — top 3 paid, 4 alive = bubble
const DEAD = 1.5; // blinds/antes already in the middle (bb)
// A plausibly wide "big-stack bubble jam" — the range you're actually facing when a
// cover-stack puts you all-in on the bubble.
const SHOVER_TOKENS = ['22+', 'A2s+', 'A7o+', 'K9s+', 'KTo+', 'Q9s+', 'QJo', 'J9s+', 'T9s', '98s'];
const SHOVER_RANGE = rangeFromTokens(SHOVER_TOKENS);

interface IcmSpot {
  hero: Card[];
  code: string;
  stacks: number[]; // [hero, shover, o1, o2] in bb
  callAmt: number;
  pot: number;
  equity: number; // hero vs shover range
  chipEvCall: number; // bb
  potOdds: number; // equity needed for a chip-neutral call
  dEvCall: number; // ICM $ share if hero calls
  dEvFold: number; // ICM $ share if hero folds
  icmCall: boolean; // ICM-correct to call
  chipCall: boolean; // chipEV-correct to call
}
function icmShare(stacks: number[]): number {
  return icmEquities(stacks, PAYOUTS)[0] ?? 0; // hero is index 0
}
function genIcm(): IcmSpot {
  const hero = dealHero();
  const heroStack = randInt(8, 26);
  const shoverStack = randInt(10, 40);
  const o1 = randInt(5, 30);
  const o2 = randInt(5, 30);
  const stacks = [heroStack, shoverStack, o1, o2];

  const equity = equityVsRange(hero, [], SHOVER_RANGE, 2200).equity;
  const callAmt = Math.min(heroStack, shoverStack);
  const pot = 2 * callAmt + DEAD;

  // resulting stacks per outcome (busted = 0 → 0 ICM equity)
  const win = [heroStack + callAmt + DEAD, Math.max(0, shoverStack - callAmt), o1, o2];
  const lose = [Math.max(0, heroStack - callAmt), shoverStack + callAmt + DEAD, o1, o2];
  const fold = [heroStack, shoverStack + DEAD, o1, o2];

  const dEvCall = equity * icmShare(win) + (1 - equity) * icmShare(lose);
  const dEvFold = icmShare(fold);
  const chipEvCall = equity * pot - callAmt;
  return {
    hero,
    code: handCode(hero),
    stacks,
    callAmt,
    pot,
    equity,
    chipEvCall,
    potOdds: callAmt / pot,
    dEvCall,
    dEvFold,
    icmCall: dEvCall > dEvFold,
    chipCall: chipEvCall > 0,
  };
}

const FIRST_PF = genPf();
const FIRST_ICM = genIcm();

export function TournamentDrill() {
  const [mode, setMode] = useState<Mode>('pf');
  const [pf, setPf] = useState<PfSpot>(FIRST_PF);
  const [icm, setIcm] = useState<IcmSpot>(FIRST_ICM);
  const [pick, setPick] = useState<string | null>(null); // 'shove'|'fold' | 'call'|'fold'
  const [score, setScore] = useState(() => loadDrillScore('td-pf'));

  const revealed = pick != null;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  const correct = useMemo(() => {
    if (mode === 'pf') return pf.jam ? 'shove' : 'fold';
    return icm.icmCall ? 'call' : 'fold';
  }, [mode, pf, icm]);

  const choices = mode === 'pf' ? ['shove', 'fold'] : ['call', 'fold'];
  const good = revealed && pick === correct;

  const pickAns = useCallback(
    (id: string) => {
      if (revealed) return;
      setPick(id);
      const ok = id === (mode === 'pf' ? (pf.jam ? 'shove' : 'fold') : icm.icmCall ? 'call' : 'fold');
      setScore(recordDrillScore(`td-${mode}`, ok));
      playGrade(ok);
    },
    [revealed, mode, pf, icm],
  );

  const next = useCallback(() => {
    setPick(null);
    if (mode === 'pf') setPf(genPf());
    else setIcm(genIcm());
  }, [mode]);

  function switchMode(m: Mode) {
    if (m === mode) return;
    setMode(m);
    setPick(null);
    setScore(loadDrillScore(`td-${m}`));
  }

  useDrillKeys({
    choices: choices.length,
    onPick: (i) => pickAns(choices[i]),
    onNext: next,
    revealed,
  });

  return (
    <div className="card">
      <h2>Tournament Drill — Push/Fold &amp; ICM</h2>
      <p className="sub">
        The two live-tournament skills the cash drills skip. <b>Push/Fold</b>: short and folded to — shove or fold,
        graded vs a Nash-approx jam chart. <b>ICM Bubble</b>: chips aren't money — a <i>+chipEV</i> call can be a clear
        <b> fold</b> once pay jumps bite. You're graded on the ICM-correct line; the chipEV verdict is shown so you see the gap.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          <button className={mode === 'pf' ? 'active' : ''} onClick={() => switchMode('pf')}>🅿 Push/Fold</button>
          <button className={mode === 'icm' ? 'active' : ''} onClick={() => switchMode('icm')}>💵 ICM Bubble</button>
        </div>
        <div className="quiz-score">
          Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore(`td-${mode}`))} title="Reset this mode's saved score">↺</button>
          )}
        </div>
      </div>
      <p className="note">{drillKeysHint(choices.length)} · score saved across sessions.</p>

      {/* ============ PUSH / FOLD ============ */}
      {mode === 'pf' && (
        <>
          <div className="lab-board">
            <div className="lab-hero">
              <span className="lab-tag">Your hand · {pf.code}</span>
              <div className="lab-cards">{pf.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
            </div>
            <div className="td-stackbox">
              <div className="big-stat gold">{pf.bb}<span className="td-bb">bb</span></div>
              <div className="stat-lbl">effective stack · {PF_BUCKET_LABEL[bucketFor(pf.bb)]}</div>
              <div className="td-pos">{PF_POS_LABEL[pf.pos]}</div>
            </div>
          </div>

          <div className="lab-prompt">Folded to you. Shove or fold?</div>

          <div className="rd-bands td-bands">
            {(['shove', 'fold'] as const).map((id) => {
              const isCorrect = id === correct;
              return (
                <button
                  key={id}
                  className={`rd-band ${pick === id ? 'chosen' : ''} ${revealed && isCorrect ? 'is-best' : ''} ${revealed && pick === id && !isCorrect ? 'is-wrong' : ''}`}
                  onClick={() => pickAns(id)}
                >
                  <span className="rd-band-lbl">{id === 'shove' ? '♠ Shove all-in' : '✕ Fold'}</span>
                  <span className="rd-band-sub">{id === 'shove' ? `jam ${pf.bb}bb` : 'muck it'}</span>
                </button>
              );
            })}
          </div>

          {revealed && (
            <>
              <div className={`lab-feedback ${good ? 'good' : 'bad'}`}>
                {good
                  ? `✓ Correct — chart ${pf.jam ? 'jams' : 'folds'} ${pf.code} at ${pf.bb}bb ${PF_POS_LABEL[pf.pos]}.`
                  : `✗ Chart says ${pf.jam ? 'SHOVE' : 'FOLD'} ${pf.code} here. ${pf.jam ? 'Folding a jam-range hand bleeds you out — short-stack fold equity is the whole point.' : 'Jamming outside the range gets you called by better and busts your tournament.'}`}
                <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
              </div>
              <div className="td-rangebox">
                <b>{PF_POS_LABEL[pf.pos]} · {PF_BUCKET_LABEL[bucketFor(pf.bb)]} jam range</b> (~{jamPct(pf.bb, pf.pos).toFixed(0)}% of hands):
                <span className="td-tokens">{shoveTokens(pf.bb, pf.pos).join(', ')}</span>
              </div>
            </>
          )}
        </>
      )}

      {/* ============ ICM BUBBLE ============ */}
      {mode === 'icm' && (
        <>
          <div className="lab-board">
            <div className="lab-hero">
              <span className="lab-tag">Your hand · {icm.code}</span>
              <div className="lab-cards">{icm.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
            </div>
            <div className="lab-eq">
              {revealed
                ? <><div className="big-stat gold">{(icm.equity * 100).toFixed(1)}%</div><div className="stat-lbl">equity vs jam range</div></>
                : <><div className="big-stat dim">?? %</div><div className="stat-lbl">hidden — decide first</div></>}
            </div>
          </div>

          <div className="td-icm-info">
            <div className="td-stacks">
              {['You', 'Shover', 'Player 3', 'Player 4'].map((name, i) => (
                <div key={name} className={`td-stackrow ${i === 0 ? 'hero' : ''} ${i === 1 ? 'shover' : ''}`}>
                  <span>{name}</span><b>{icm.stacks[i]}bb</b>
                </div>
              ))}
            </div>
            <p className="td-scenario">
              <b>Bubble</b> — 4 left, top 3 pay ({PAYOUTS.map((p) => `${Math.round(p * 100)}%`).join(' / ')}). The
              <b> Shover</b> jams; it's <b>{icm.callAmt}bb</b> to call ({(icm.potOdds * 100).toFixed(0)}% equity for a chip-neutral call).
            </p>
          </div>

          <div className="lab-prompt">Call or fold?</div>

          <div className="rd-bands td-bands">
            {(['call', 'fold'] as const).map((id) => {
              const isCorrect = id === correct;
              return (
                <button
                  key={id}
                  className={`rd-band ${pick === id ? 'chosen' : ''} ${revealed && isCorrect ? 'is-best' : ''} ${revealed && pick === id && !isCorrect ? 'is-wrong' : ''}`}
                  onClick={() => pickAns(id)}
                >
                  <span className="rd-band-lbl">{id === 'call' ? '☎ Call it off' : '✕ Fold'}</span>
                  <span className="rd-band-sub">{id === 'call' ? `${icm.callAmt}bb` : 'keep your fold equity'}</span>
                </button>
              );
            })}
          </div>

          {revealed && (
            <>
              <div className={`lab-feedback ${good ? 'good' : 'bad'}`}>
                {good
                  ? `✓ Correct — ICM says ${icm.icmCall ? 'CALL' : 'FOLD'}.`
                  : `✗ ICM says ${icm.icmCall ? 'CALL' : 'FOLD'} here.`}
                <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
              </div>

              <div className="td-verdicts">
                <div className={`td-verdict ${icm.chipCall ? 'call' : 'fold'}`}>
                  <span className="td-vlabel">Chip EV</span>
                  <b>{icm.chipCall ? 'CALL' : 'FOLD'}</b>
                  <span className="td-vsub">{icm.chipEvCall >= 0 ? '+' : ''}{icm.chipEvCall.toFixed(2)} bb ({(icm.equity * 100).toFixed(1)}% vs {(icm.potOdds * 100).toFixed(0)}% needed)</span>
                </div>
                <div className={`td-verdict ${icm.icmCall ? 'call' : 'fold'} td-icm`}>
                  <span className="td-vlabel">ICM $EV</span>
                  <b>{icm.icmCall ? 'CALL' : 'FOLD'}</b>
                  <span className="td-vsub">call {(icm.dEvCall * 100).toFixed(2)}% vs fold {(icm.dEvFold * 100).toFixed(2)}% of pool</span>
                </div>
              </div>

              <div className="td-lesson">
                {icm.chipCall && !icm.icmCall ? (
                  <><span className="td-lesson-tag">📌 Bubble tax</span> A profitable chip call is an ICM <b>FOLD</b>: busting on the bubble costs your whole cash equity, so you need a much bigger edge than the pot odds imply. When you cover / risk elimination, <b>tighten up</b> — let the other shorties bust first.</>
                ) : !icm.chipCall && icm.icmCall ? (
                  <><span className="td-lesson-tag">📌 Rare ICM call</span> ICM says call even though chips are borderline — usually because folding still leaves you at risk or a bust here barely dents your equity. Uncommon; the bubble default is the opposite.</>
                ) : icm.icmCall ? (
                  <><span className="td-lesson-tag">📌 Clear call</span> Big enough edge that even the bubble tax can't make it a fold. Chip EV and ICM agree — snap it.</>
                ) : (
                  <><span className="td-lesson-tag">📌 Clear fold</span> Not enough equity — both chip EV and ICM fold. On the bubble, folding a marginal spot preserves fold equity and lets shorter stacks bust into the money ahead of you.</>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ============ cheat sheet ============ */}
      <div className="bsd-cheat">
        <h4>The short-stack &amp; bubble rules</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill polar">Push/Fold</span> Under ~20–25bb and folded to, a min-raise commits you anyway — so it's <b>shove or fold</b>. Jam <b>wider in late position</b> (more fold equity, fewer players behind) and <b>wider the shorter you get</b> (folding blinds you out).</div>
          <div><span className="bsd-pill small">≤10bb</span> Jam a wide range — you're desperate for fold equity and can't afford to blind down. From the button/SB this is 35–45% of hands.</div>
          <div><span className="bsd-pill big">17–25bb</span> Tighter jams — you still have some room, so only strong hands go all-in first-in. Early position stays very tight.</div>
          <div><span className="bsd-pill check">ICM</span> <b>Chips ≠ money.</b> Payouts are capped, so busting costs more $ equity than doubling gains. A call that wins chips on average can still <b>lose money</b> — that's the bubble tax.</div>
          <div><span className="bsd-pill polar">Bubble default</span> When you risk elimination (especially covering shorter stacks), <b>fold marginal spots</b>. Let the short stacks bust into the money first — your fold equity and survival are worth more than a thin edge.</div>
          <div><span className="bsd-pill small">When ICM relaxes</span> If YOU'RE the short stack with nothing to lose, or already locked into the money, ICM pressure drops — play closer to chip EV again.</div>
        </div>
        <p className="bsd-note">
          Live tournaments are <b>push/fold + ICM</b> most of the time you're in a pot short. Master these two and you
          beat the field that only knows how to play deep-stacked cash. The jam ranges here are a <b>teaching baseline</b>
          (Nash-approx), not an exact solver — but they're miles ahead of feel.
        </p>
      </div>
    </div>
  );
}
