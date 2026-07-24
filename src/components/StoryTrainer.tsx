// Betting-Story Trainer. Grinds the two live reads the Think-First gate now
// gates on, as active recall:
//   • READ HIS story  — a villain line is shown (no hole cards); call it value /
//     polarized / capped-bluffy.
//   • BUILD YOUR story — your own prior line is shown; call whether the pending
//     bet is credible / fresh / broken.
// The answer key is the SAME pure reader the gate uses (strategy/bettingStory),
// so the drill can't teach a read the live gate then contradicts. Lines are
// synthesised from per-class patterns, then classified by the reader — the
// reader is the source of truth, so the shown answer is always self-consistent.

import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { makeDeck, shuffle } from '../engine/cards';
import {
  readVillainStory,
  readHeroStory,
  type StreetMove,
  type VillainStory,
  type HeroStory,
} from '../strategy/bettingStory';
import { modulateStory, tagToType } from '../strategy/storyModulation';
import { PROFILE_LIST } from '../ai/profiles';
import { PlayingCard } from './PlayingCard';
import { useDrillKeys } from '../hooks/useDrillKeys';
import { playGrade } from '../sound';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

type Mode = 'villain' | 'hero';
type PostStreet = 'flop' | 'turn' | 'river';
const STREETS: PostStreet[] = ['flop', 'turn', 'river'];

interface Choice {
  id: string;
  label: string;
  hint: string;
}
const VILLAIN_CHOICES: Choice[] = [
  { id: 'value', label: 'Value story', hint: 'Consistent aggression, sizing up — believe it, fold marginal.' },
  { id: 'polar', label: 'Polarized', hint: 'Big bet or raise — nuts-or-bluff. Decide on blockers + price.' },
  { id: 'bluffy', label: 'Capped / bluffy', hint: 'Slowed down or a late stab — weaker range, call wider.' },
];
const HERO_CHOICES: Choice[] = [
  { id: 'credible', label: 'Credible', hint: "You've repped it — a bluff is believed, value gets paid." },
  { id: 'fresh', label: 'Fresh start', hint: 'First bet — credible only if this card fits YOUR range.' },
  { id: 'broken', label: 'Broken', hint: 'Passive then big — represents nothing, nobody folds.' },
];
const CHOICES: Record<Mode, Choice[]> = { villain: VILLAIN_CHOICES, hero: HERO_CHOICES };

// [kind, fracLo, fracHi]; frac ignored for check/call/none.
type Spec = [StreetMove['kind'], number, number];

// Villain patterns give the FULL shown line (specs.length === revealed).
const VILLAIN_PATTERNS: Record<2 | 3, Record<VillainStory, Spec[][]>> = {
  2: {
    value: [[['bet', 0.5, 0.6], ['bet', 0.65, 0.8]]],
    polar: [[['check', 0, 0], ['bet', 0.95, 1.3]], [['bet', 0.45, 0.6], ['raise', 0.6, 0.9]]],
    bluffy: [[['check', 0, 0], ['bet', 0.2, 0.32]], [['bet', 0.45, 0.6], ['check', 0, 0]]],
    none: [[['bet', 0.5, 0.6], ['none', 0, 0]]],
  },
  3: {
    value: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['bet', 0.72, 0.9]]],
    polar: [[['check', 0, 0], ['check', 0, 0], ['bet', 1.0, 1.4]], [['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['raise', 0.7, 1.0]]],
    bluffy: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72], ['check', 0, 0]], [['check', 0, 0], ['check', 0, 0], ['bet', 0.2, 0.35]]],
    none: [[['bet', 0.5, 0.6], ['none', 0, 0], ['none', 0, 0]]],
  },
};

// Hero patterns give the PRIOR line only (specs.length === revealed - 1); the
// pending bet is the street being decided and isn't part of the read.
const HERO_PATTERNS: Record<2 | 3, Record<HeroStory, Spec[][]>> = {
  2: {
    credible: [[['bet', 0.5, 0.66]]],
    fresh: [[['none', 0, 0]]],
    broken: [[['check', 0, 0]], [['call', 0, 0]]],
  },
  3: {
    credible: [[['bet', 0.5, 0.6], ['bet', 0.6, 0.72]], [['bet', 0.5, 0.66], ['check', 0, 0]]],
    fresh: [[['none', 0, 0], ['none', 0, 0]]],
    broken: [[['check', 0, 0], ['check', 0, 0]], [['check', 0, 0], ['call', 0, 0]]],
  },
};

const pick = <T,>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];
const fr = (lo: number, hi: number, rng: () => number): number => lo + rng() * (hi - lo);

function buildLine(specs: Spec[], rng: () => number): StreetMove[] {
  const line: StreetMove[] = STREETS.map((s) => ({ street: s, kind: 'none', frac: 0 }));
  specs.forEach(([kind, lo, hi], i) => {
    line[i] = { street: STREETS[i], kind, frac: kind === 'bet' || kind === 'raise' ? fr(lo, hi, rng) : 0 };
  });
  return line;
}

export interface Scenario {
  mode: Mode;
  board: Card[];
  revealed: 2 | 3; // 2 = turn, 3 = river
  line: StreetMove[];
  answer: string; // the reader's verdict — the graded truth (line SHAPE)
  why: string;
  action: string; // what the read prescribes — the decision rep
  pendingStreet: PostStreet; // hero mode: the street being bet
  // villain mode only — the type + player-count overlay (modulates the read).
  readId?: string;
  profileTag?: string;
  profileName?: string;
  opps: number; // live opponents; 1 = heads-up
}

export function genScenario(mode: Mode, rng: () => number = Math.random): Scenario {
  const revealed: 2 | 3 = rng() < 0.6 ? 3 : 2; // weight the river — richer stories
  const board = shuffle(makeDeck(), rng).slice(0, revealed + 2);
  const pendingStreet = STREETS[revealed - 1];

  if (mode === 'villain') {
    const target = pick<VillainStory>(['value', 'polar', 'bluffy'], rng);
    const specs = pick(VILLAIN_PATTERNS[revealed][target], rng);
    const line = buildLine(specs, rng);
    const v = readVillainStory(line, revealed);
    const profile = pick(PROFILE_LIST, rng);
    const opps = rng() < 0.3 ? (rng() < 0.5 ? 2 : 3) : 1; // sometimes multiway
    return {
      mode, board, revealed, line, answer: v.read, why: v.why, action: v.action, pendingStreet,
      readId: tagToType(profile.tag), profileTag: profile.tag, profileName: profile.name, opps,
    };
  }
  const target = pick<HeroStory>(['credible', 'fresh', 'broken'], rng);
  const specs = pick(HERO_PATTERNS[revealed][target], rng);
  const line = buildLine(specs, rng); // prior streets only
  const h = readHeroStory(line, revealed);
  return { mode, board, revealed, line, answer: h.read, why: h.why, action: h.action, pendingStreet, opps: 1 };
}

// First scenario at module load — React forbids impure Math.random in render.
const FIRST = genScenario('villain');

function moveText(m: StreetMove): string {
  switch (m.kind) {
    case 'bet':
      return `bets ${Math.round(m.frac * 100)}% pot`;
    case 'raise':
      return 'raises';
    case 'call':
      return 'calls';
    case 'check':
      return 'checks';
    default:
      return '—';
  }
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function StoryTrainer() {
  const [mode, setMode] = useState<Mode>('villain');
  const [scenario, setScenario] = useState<Scenario>(FIRST);
  const [pickId, setPickId] = useState<string | null>(null);
  const [score, setScore] = useState(() => loadDrillScore('story-villain'));

  const choices = CHOICES[mode];
  const revealed = pickId != null;

  const next = useCallback((m: Mode) => {
    setScenario(genScenario(m));
    setPickId(null);
  }, []);

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setScore(loadDrillScore(`story-${m}`));
    next(m);
  };

  const choose = (id: string) => {
    if (revealed) return;
    setPickId(id);
    const correct = id === scenario.answer;
    setScore(recordDrillScore(`story-${mode}`, correct));
    playGrade(correct ? 'good' : 'bad');
  };

  useDrillKeys({
    choices: choices.length,
    onPick: (i) => choose(choices[i].id),
    onNext: () => next(mode),
    revealed,
  });

  const pct = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  // villain mode shows the full line; hero mode shows the prior streets only.
  const shownMoves = useMemo(
    () => scenario.line.slice(0, mode === 'villain' ? scenario.revealed : scenario.revealed - 1).filter((m) => m.kind !== 'none'),
    [scenario, mode],
  );
  const correct = revealed && pickId === scenario.answer;

  return (
    <div className="card">
      <h2>🎭 Betting-Story Trainer</h2>
      <p className="sub">
        A line of bets should describe ONE believable hand. Read the line — no hole cards, no equity — and call
        the story. Same reader the live Think-First gate uses, so what you learn here is what it grades.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          <button className={mode === 'villain' ? 'active' : ''} onClick={() => switchMode('villain')}>
            🕵 Read HIS story
          </button>
          <button className={mode === 'hero' ? 'active' : ''} onClick={() => switchMode('hero')}>
            🎬 Build YOUR story
          </button>
        </div>
        <div className="quiz-score">
          Reads: <b>{score.correct}/{score.total}</b> ({pct}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore(`story-${mode}`))} title="Reset this mode's saved score">
              ↺
            </button>
          )}
        </div>
      </div>

      {/* board + the line */}
      <div className="hr-board">
        {scenario.board.map((c, i) => (
          <PlayingCard key={i} card={c} size="md" />
        ))}
        <div className="hr-actions">
          {shownMoves.map((m) => (
            <span key={m.street} className={`hr-streetbadge ${m.kind === 'check' || m.kind === 'call' ? 'check' : 'bet'}`}>
              {cap(m.street)}: {mode === 'villain' ? 'he ' : 'you '}
              {moveText(m)}
            </span>
          ))}
          {shownMoves.length === 0 && <span className="hr-streetbadge check">No action yet</span>}
        </div>
      </div>

      {mode === 'villain' && scenario.profileTag && (
        <div className="st-context">
          <span className={`opp-tag tag-${scenario.profileTag.toLowerCase()}`}>{scenario.profileTag}</span>
          <span className="sub">{scenario.profileName}</span>
          <span className={`st-way ${scenario.opps > 1 ? 'multi' : ''}`}>
            {scenario.opps > 1 ? `${scenario.opps + 1}-way pot` : 'heads-up'}
          </span>
        </div>
      )}

      <div className="lab-prompt">
        {mode === 'villain'
          ? `He bets the ${scenario.pendingStreet} into you. What story does his line tell?`
          : `You're about to bet the ${scenario.pendingStreet}. Does your line tell a credible story?`}
      </div>
      {mode === 'villain' && (
        <p className="sub st-hint">
          Call the LINE SHAPE — type &amp; player count don't change the shape. The reveal shows how they shift your
          real read (trust it vs fade it).
        </p>
      )}

      {/* choices — reuse the Exploit trainer's read buttons */}
      <div className="et-reads">
        {choices.map((c) => {
          const isPicked = pickId === c.id;
          const isAnswer = revealed && c.id === scenario.answer;
          const isWrong = revealed && isPicked && c.id !== scenario.answer;
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
            {correct ? '✓ Correct.' : `✗ Off — it's "${choices.find((c) => c.id === scenario.answer)?.label}".`}
          </div>
          <div className="gp-block">
            <div className="gp-h">Why — the line shape</div>
            <p>{scenario.why}</p>
          </div>
          <div className="gp-block st-do">
            <div className="gp-h">{mode === 'villain' ? '➡ Do — facing this bet' : '➡ Do — your pending bet'}</div>
            <p>{scenario.action}</p>
          </div>
          {mode === 'villain' && scenario.readId && (
            <div className="gp-block st-mod">
              <div className="gp-h">
                💡 Adjust for {scenario.profileTag}
                {scenario.opps > 1 ? ` · ${scenario.opps + 1}-way` : ''}
              </div>
              <p>{modulateStory(scenario.answer as VillainStory, scenario.readId, scenario.opps).note}</p>
            </div>
          )}
          <button className="btn btn-deal" onClick={() => next(mode)}>
            Next line →
          </button>
        </div>
      )}
    </div>
  );
}
