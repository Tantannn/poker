// Bluff-Catcher drill — teaches the one question a bluff-catch turns on:
// does villain bluff OFTEN ENOUGH to beat the price he's laying you?
//
// A bluff-catcher is a hand that beats his bluffs but loses to his value bets.
// So your hand strength barely matters — what matters is:
//   • THE PRICE (pot odds) — fixed math. To call a bet of B into pot P you risk
//     B to win P+B, so you need to be good ≥ B/(P+2B) of the time. This is given.
//   • HIS BLUFF % — a READ on the player. Archetypes bluff at wildly different
//     rates (a nit/station almost never; a maniac constantly).
// Call when bluff% ≥ required%. Fold when it isn't. Fold too much and he prints
// bluffs on you (that's what MDF protects against); call too much and you pay off
// his value. The price is shown up front; the skill is reading the bluff rate.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { makeDeck, shuffle } from '../engine/cards';
import { evaluateBest, describeHand } from '../engine/evaluator';
import { PROFILE_LIST } from '../ai/profiles';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys } from '../hooks/useDrillKeys';
import { playGrade } from '../sound';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

type Act = 'call' | 'fold';

// River bet sizes framed as bluff-catch spots (polar sizings — where a pure
// bluff-catcher decision actually lives).
const SIZES = [
  { frac: 0.5, label: 'half pot' },
  { frac: 0.75, label: 'three-quarter pot' },
  { frac: 1, label: 'pot' },
  { frac: 1.5, label: 'an overbet (1.5× pot)' },
];
const POTS = [12, 18, 24, 30, 40, 50, 60, 80, 100];

// How often each archetype is actually BLUFFING when it fires this river.
// This is the hidden read the drill trains — the price is public, this isn't.
const BLUFF_BANDS: Record<string, [number, number]> = {
  NIT: [0.05, 0.14], // barely bluffs — believe the bet
  LP: [0.06, 0.16], // loose-passive station: bets value, rarely bluffs
  TAG: [0.22, 0.33], // balanced-ish, a few bluffs
  GTO: [0.28, 0.38], // bluffs near the price (near-indifference)
  LAG: [0.33, 0.46], // aggressive, bluffs a lot
  MANIAC: [0.44, 0.6], // fires air constantly — call them down
};
const BLUFF_NOTE: Record<string, string> = {
  NIT: 'Nits fire the river for value almost only — when they bet big, believe it.',
  LP: 'Loose-passive stations bet their made hands and check their air. A river bet is value; do not pay it off with a bluff-catcher.',
  TAG: 'A solid TAG has some bluffs but is value-weighted — you need a real price to call.',
  GTO: 'A balanced player bluffs right around the price, so you are near-indifferent — small edges, no auto-call.',
  LAG: 'LAGs barrel wide and bluff often — your bluff-catchers go up in value against them.',
  MANIAC: 'Maniacs fire air constantly. Bluff-catch WIDE — folding here just lets them run you over.',
};

const pick = <T,>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];
const fr = (lo: number, hi: number, rng: () => number): number => lo + rng() * (hi - lo);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

interface Spot {
  board: Card[];
  hole: Card[];
  handName: string;
  sizeLabel: string;
  potBB: number;
  betBB: number;
  requiredEq: number; // pot-odds threshold to call
  bluffShare: number; // villain's true river bluff %
  profileTag: string;
  profileName: string;
  correct: Act;
}

function genSpot(rng: () => number = Math.random): Spot {
  // Deal a real river board + a genuine bluff-catcher (ace-high or one pair —
  // beats bluffs, loses to value). Two-pair+ isn't a catcher, so reject it.
  let board: Card[] = [];
  let hole: Card[] = [];
  for (let i = 0; i < 300; i++) {
    const d = shuffle(makeDeck(), rng);
    const b = d.slice(0, 5);
    const h = d.slice(5, 7);
    if (evaluateBest(h, b).categoryRank <= 1) {
      board = b;
      hole = h;
      break;
    }
  }
  if (!board.length) {
    const d = shuffle(makeDeck(), rng);
    board = d.slice(0, 5);
    hole = d.slice(5, 7);
  }

  const profile = pick(PROFILE_LIST, rng);
  const size = pick(SIZES, rng);
  const potBB = pick(POTS, rng);
  const betBB = Math.max(1, Math.round(potBB * size.frac));
  // Required equity from the ACTUAL chips shown, so the reveal math ties out:
  // risk betBB to win (potBB + betBB) → break-even = betBB / (potBB + 2·betBB).
  const requiredEq = betBB / (potBB + 2 * betBB);

  const band = BLUFF_BANDS[profile.tag] ?? [0.2, 0.35];
  let bluffShare = fr(band[0], band[1], rng);
  // Guarantee a clear answer: if the sampled bluff% lands on top of the price,
  // push it to the side the archetype leans (so the lesson stays legible).
  if (Math.abs(bluffShare - requiredEq) < 0.03) {
    const center = (band[0] + band[1]) / 2;
    bluffShare = requiredEq + (center >= requiredEq ? 1 : -1) * 0.05;
  }
  bluffShare = clamp(bluffShare, 0.03, 0.75);

  return {
    board,
    hole,
    handName: describeHand(evaluateBest(hole, board)),
    sizeLabel: size.label,
    potBB,
    betBB,
    requiredEq,
    bluffShare,
    profileTag: profile.tag,
    profileName: profile.name,
    correct: bluffShare >= requiredEq ? 'call' : 'fold',
  };
}

const FIRST = genSpot();
const pctOf = (x: number) => Math.round(x * 100);

interface Choice {
  id: Act;
  label: string;
  hint: string;
}
const CHOICES: Choice[] = [
  { id: 'call', label: 'Call (catch)', hint: 'He bluffs enough to beat the price.' },
  { id: 'fold', label: 'Fold', hint: 'Not enough bluffs — you’d just pay off value.' },
];

export function BluffCatcherDrill() {
  const [spot, setSpot] = useState<Spot>(FIRST);
  const [pickId, setPickId] = useState<Act | null>(null);
  const [score, setScore] = useState(() => loadDrillScore('bluffcatch'));

  const revealed = pickId !== null;

  const next = useCallback(() => {
    setSpot(genSpot());
    setPickId(null);
  }, []);

  const choose = useCallback(
    (id: Act) => {
      if (revealed) return;
      setPickId(id);
      const correct = id === spot.correct;
      setScore(recordDrillScore('bluffcatch', correct));
      playGrade(correct ? 'good' : 'bad');
    },
    [revealed, spot],
  );

  useDrillKeys({ choices: CHOICES.length, onPick: (i) => choose(CHOICES[i].id), onNext: next, revealed });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const correct = revealed && pickId === spot.correct;
  const reqPct = pctOf(spot.requiredEq);
  const bluffPct = pctOf(spot.bluffShare);
  const marginTop = Math.min(100, Math.max(6, bluffPct));
  const shownMargin = useMemo(() => bluffPct - reqPct, [bluffPct, reqPct]);

  return (
    <div className="card">
      <h2>🎣 Bluff-Catcher</h2>
      <p className="sub">
        A <b>bluff-catcher</b> beats his bluffs but loses to his value bets — so your hand strength barely matters.
        Only one thing decides the call: <b>does he bluff often enough to beat the price?</b>
      </p>
      <div className="bc-primer">
        <div><b>The price</b> is fixed math (pot odds) — shown to you every hand. <b>His bluff %</b> is a read on the
        player. <b>Call when bluff % ≥ the price.</b> Fold too much and he prints bluffs on you (that’s MDF); call
        too much and you pay off his value.</div>
      </div>

      <div className="quiz-bar">
        <div className="quiz-score" style={{ marginLeft: 0 }}>
          Caught right: <b>{score.correct}/{score.total}</b> ({pct}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore('bluffcatch'))} title="Reset saved score">
              ↺
            </button>
          )}
        </div>
      </div>

      {/* board + your catcher */}
      <div className="hr-board">
        {spot.board.map((c, i) => (
          <PlayingCard key={i} card={c} size="md" />
        ))}
      </div>
      <div className="cf-hero">
        <span className="cf-hero-lbl">You hold</span>
        {spot.hole.map((c, i) => (
          <PlayingCard key={i} card={c} size="md" />
        ))}
        <span className="cf-hand">{spot.handName}</span>
        <span className="cf-tier t-marginal">🎣 bluff-catcher — beats bluffs, loses to value</span>
      </div>

      <div className="st-context">
        <span className={`opp-tag tag-${spot.profileTag.toLowerCase()}`}>{spot.profileTag}</span>
        <span className="sub">{spot.profileName}</span>
      </div>

      {/* the public price — always visible, it's not a read */}
      <div className="bc-price">
        <div className="bc-price-row">
          <span>River. Pot <b>{spot.potBB}bb</b>. He bets <b>{spot.betBB}bb</b> ({spot.sizeLabel}).</span>
        </div>
        <div className="bc-price-row bc-need">
          You risk {spot.betBB} to win {spot.potBB + spot.betBB} → you must be good{' '}
          <b>≥ {reqPct}%</b> of the time to call.
        </div>
      </div>

      <div className="lab-prompt">
        Does the <b>{spot.profileTag}</b> bluff more than <b>{reqPct}%</b> here? Call or fold.
      </div>

      {/* choices */}
      <div className="et-reads bc-choices">
        {CHOICES.map((c) => {
          const isPicked = pickId === c.id;
          const isAnswer = revealed && c.id === spot.correct;
          const isWrong = revealed && isPicked && c.id !== spot.correct;
          return (
            <button
              key={c.id}
              className={`et-read ${isPicked ? 'picked' : ''} ${isAnswer ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
              onClick={() => choose(c.id)}
              disabled={revealed}
            >
              <span className="et-read-label">{c.label}</span>
              {revealed && <span className="et-read-hint">{c.hint}</span>}
            </button>
          );
        })}
      </div>

      {revealed && (
        <div className="et-reveal">
          <div className={`et-readres ${correct ? 'good' : 'bad'}`}>
            {correct ? '✓ Right.' : `✗ Off — the play is "${spot.correct === 'call' ? 'Call' : 'Fold'}".`}
          </div>

          {/* the two numbers side by side — the whole decision */}
          <div className="bc-verdict">
            <div className="bc-num">
              <div className="bc-num-v">{bluffPct}%</div>
              <div className="bc-num-l">he bluffs</div>
            </div>
            <div className="bc-vs">{shownMargin >= 0 ? '≥' : '<'}</div>
            <div className="bc-num">
              <div className="bc-num-v">{reqPct}%</div>
              <div className="bc-num-l">price to call</div>
            </div>
            <div className={`bc-call ${spot.correct === 'call' ? 'good' : 'bad'}`}>
              {spot.correct === 'call' ? '→ CALL' : '→ FOLD'}
            </div>
          </div>
          <div className="bc-bar" aria-hidden="true">
            <div className="bc-bar-need" style={{ left: `${Math.min(100, reqPct)}%` }} title={`price ${reqPct}%`} />
            <div className="bc-bar-bluff" style={{ width: `${marginTop}%` }} />
          </div>

          <div className="gp-block">
            <div className="gp-h">Why</div>
            <p>
              {spot.correct === 'call'
                ? `He bluffs ~${bluffPct}%, more than the ${reqPct}% the price needs — so your catcher wins often enough to profit. Calling here prints; folding would let him bluff you off the pot for free.`
                : `He bluffs only ~${bluffPct}%, below the ${reqPct}% the price needs — his bets are too value-heavy, so calling just pays off a better hand. Fold and save the chips.`}
            </p>
          </div>
          <div className="gp-block">
            <div className="gp-h">Read: {spot.profileTag}</div>
            <p>{BLUFF_NOTE[spot.profileTag] ?? 'Weigh how often this player type turns a made hand into a bet vs fires air.'}</p>
          </div>
          <div className="gp-block">
            <div className="gp-h">The lesson</div>
            <p>
              Bigger bet = worse price = you need MORE bluffs to call (an overbet needs ~{pctOf(1.5 / (1 + 2 * 1.5))}%,
              a half-pot only ~{pctOf(0.5 / (1 + 2 * 0.5))}%). Same hand, same board — the CALL depends on the price and
              the player, not on how pretty your pair looks.
            </p>
          </div>

          <button className="btn btn-deal" onClick={next}>
            Next spot →
          </button>
        </div>
      )}
    </div>
  );
}
