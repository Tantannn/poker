// Sizing-Tells drill — read what a villain's BET SIZE means. Complements the
// Story trainer (line shape) and Read & Exploit (type): here a single bet's SIZE
// is shown on a real board + street + archetype, and you call what it polarises
// toward (range / value / polar / capped). Graded against the pure sizingTell
// reader; the reveal adds how the villain type bends it, plus a live population
// cheat-card of default reads before you have info.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { makeDeck, shuffle } from '../engine/cards';
import { readSizing, sizingTypeNote, SIZING_OPTIONS, type SizingMeaning, type Street } from '../strategy/sizingTell';
import { tagToType } from '../strategy/storyModulation';
import { PROFILE_LIST } from '../ai/profiles';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys } from '../hooks/useDrillKeys';
import { playGrade } from '../sound';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

const DRILL_ID = 'sizingtell';
const FRACS = [0.25, 0.33, 0.5, 0.66, 0.75, 1.0, 1.5];

const pick = <T,>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];

interface Spot {
  board: Card[];
  street: Street;
  frac: number;
  profileTag: string;
  profileName: string;
  readId: string;
  meaning: SizingMeaning;
  why: string;
}

export function genSpot(rng: () => number = Math.random): Spot {
  const r = rng();
  const street: Street = r < 0.4 ? 'flop' : r < 0.7 ? 'turn' : 'river';
  const len = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
  const board = shuffle(makeDeck(), rng).slice(0, len);
  const frac = pick(FRACS, rng);
  const profile = pick(PROFILE_LIST, rng);
  const v = readSizing(frac, street, board);
  return {
    board, street, frac, profileTag: profile.tag, profileName: profile.name,
    readId: tagToType(profile.tag), meaning: v.meaning, why: v.why,
  };
}

// First spot at module load — React forbids impure Math.random in render.
const FIRST = genSpot();

export function SizingTellDrill() {
  const [spot, setSpot] = useState<Spot>(FIRST);
  const [pickId, setPickId] = useState<SizingMeaning | null>(null);
  const [score, setScore] = useState(() => loadDrillScore(DRILL_ID));

  const revealed = pickId != null;
  const next = useCallback(() => { setSpot(genSpot()); setPickId(null); }, []);

  const choose = (id: SizingMeaning) => {
    if (revealed) return;
    setPickId(id);
    const correct = id === spot.meaning;
    setScore(recordDrillScore(DRILL_ID, correct));
    playGrade(correct ? 'good' : 'bad');
  };

  useDrillKeys({
    choices: SIZING_OPTIONS.length,
    onPick: (i) => choose(SIZING_OPTIONS[i].id),
    onNext: next,
    revealed,
  });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const correct = revealed && pickId === spot.meaning;
  const typeNote = useMemo(() => sizingTypeNote(spot.readId), [spot.readId]);

  return (
    <div className="card">
      <h2>🔎 Sizing Tells — read the bet size</h2>
      <p className="sub">
        A single bet's <b>size</b> leaks its range. Read what this size polarises toward — same fraction means
        different things by street and texture. Sizing tells beat physical tells at live low/mid stakes.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          <span className={`opp-tag tag-${spot.profileTag.toLowerCase()}`}>{spot.profileTag}</span>
          <span className="sub">{spot.profileName}</span>
        </div>
        <div className="quiz-score">
          Reads: <b>{score.correct}/{score.total}</b> ({pct}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore(DRILL_ID))} title="Reset saved score">↺</button>
          )}
        </div>
      </div>

      <div className="hr-board">
        {spot.board.map((c, i) => (
          <PlayingCard key={i} card={c} size="md" />
        ))}
        <div className="hr-actions">
          <span className="hr-streetbadge bet">
            {spot.profileTag} bets {Math.round(spot.frac * 100)}% pot on the {spot.street}
          </span>
        </div>
      </div>

      <div className="lab-prompt">What does that size tell you?</div>

      <div className="et-reads">
        {SIZING_OPTIONS.map((o) => {
          const isPicked = pickId === o.id;
          const isAnswer = revealed && o.id === spot.meaning;
          const isWrong = revealed && isPicked && o.id !== spot.meaning;
          return (
            <button
              key={o.id}
              className={`et-read ${isPicked ? 'picked' : ''} ${isAnswer ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
              onClick={() => choose(o.id)}
              disabled={revealed}
            >
              <span className="et-read-label">{o.label}</span>
            </button>
          );
        })}
      </div>

      {revealed && (
        <div className="et-reveal">
          <div className={`et-readres ${correct ? 'good' : 'bad'}`}>
            {correct ? '✓ Correct.' : `✗ Off — it's "${SIZING_OPTIONS.find((o) => o.id === spot.meaning)?.label}".`}
          </div>
          <div className="gp-block">
            <div className="gp-h">Why</div>
            <p>{spot.why}</p>
          </div>
          {typeNote && (
            <div className="gp-block st-mod">
              <div className="gp-h">💡 Adjust for {spot.profileTag}</div>
              <p>{typeNote}</p>
            </div>
          )}
          <button className="btn btn-deal" onClick={next}>Next size →</button>
        </div>
      )}

      <div className="bsd-cheat">
        <h4>Live low-stakes population defaults (your read before you have info)</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill big">Under-bluff rivers</span> A big river bet is almost always value. Fold more; hero-calls burn money.</div>
          <div><span className="bsd-pill pos">Over-value top pair</span> They stack off too light with top pair / overpairs — value bet big, they pay.</div>
          <div><span className="bsd-pill polar">3-bets are real</span> A preflop 3-bet = a genuine hand (QQ+/AK-ish). Don't spew back light.</div>
          <div><span className="bsd-pill small">Limps are weak</span> Limpers are capped — iso-raise wide, a c-bet takes it down.</div>
          <div><span className="bsd-pill check">Stations call</span> They call too much — bet value bigger, cut bluffs to zero.</div>
          <div><span className="bsd-pill small">Small = weak</span> A small river bet is usually a blocker/thin value — raise it or call light.</div>
          <div><span className="bsd-pill big">Multiway = value</span> Bets into 3+ players are value-heavy; bluffs are rare multiway — fold marginal.</div>
          <div><span className="bsd-pill polar">Tempo tells</span> Snap-bet = often weak/standard; long tank-then-bet = frequently strong. Watch, don't rely.</div>
        </div>
      </div>
    </div>
  );
}
