// Math Trainer — the pure-number skills that Modern Poker Theory drills but the
// rest of this app only TEACHES in the Reference tab. Four modes:
//   • MDF      — minimum defense frequency vs a bet size (how often you must continue).
//   • Pot odds — the equity a CALL needs to break even at a bet size (the price you pay).
//   • Ratio    — value:bluff ratio a polar betting range needs at a given size.
//   • Combos   — hand combinatorics + blocker effects (6 pairs, 16 unpaired, …).
// Every question is deterministic maths, so the answer is exact — no solver. Spots
// are SRS-weighted (store/srs) so the size/template you keep missing comes back
// more often, and the lifetime score persists per mode (store/drillScore). Matches
// the BetSizingDrill pattern: module-load first question (no Math.random in render),
// keyboard 1–4 / Space, reveal-then-explain.

import { useMemo, useState } from 'react';
import { playGrade } from '../sound';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';
import { loadSrs, recordSrs, weightOf, weightedIndex, type SrsMap } from '../store/srs';

type Mode = 'mdf' | 'potodds' | 'ratio' | 'combos';

// A fully-built question: the SRS id, the text, four answer strings, the index of
// the right one, and the teaching line shown after you answer.
interface Question {
  id: string;
  prompt: string;
  sub: string;
  options: string[];
  answer: number; // index into options
  explain: string;
}

// A template is the SRS-weighted UNIT: it owns a stable id and knows how to build
// its concrete question (correct answer + plausible distractors). weightedIndex
// picks WHICH template next; buildQuestion shuffles its options with the rng.
interface Template {
  id: string;
  build: () => { prompt: string; sub: string; correct: string; distractors: string[]; explain: string };
}

// ---- shared formatting ----
const pct = (x: number) => `${Math.round(x * 100)}%`;
// ratio value:bluff → "2:1", "1.5:1", "3:1" (one decimal, trailing .0 stripped).
const ratio = (v: number) => `${(Math.round(v * 10) / 10).toString().replace(/\.0$/, '')}:1`;

// canonical bet sizes we drill, as a fraction of the pot, with a human label.
const SIZES: { s: number; label: string }[] = [
  { s: 0.33, label: '⅓ pot' },
  { s: 0.5, label: '½ pot' },
  { s: 0.66, label: '⅔ pot' },
  { s: 0.75, label: '¾ pot' },
  { s: 1, label: 'pot' },
  { s: 1.5, label: '1.5× pot (overbet)' },
  { s: 2, label: '2× pot (overbet)' },
];

// ---- MDF templates ----
// MDF = pot / (pot + bet) = 1 / (1 + s). The two classic confusions become the
// distractors: alpha = 1 − MDF (the fold frequency), and the equity a CALL needs
// = s / (1 + 2s) (villain risks the bet to win pot+bet). Keeping those as wrong
// answers trains the difference instead of letting a lucky guess through.
const MDF_TEMPLATES: Template[] = SIZES.map(({ s, label }) => ({
  id: `mdf-${s}`,
  build: () => {
    const mdf = 1 / (1 + s);
    const alpha = 1 - mdf;
    const callEq = s / (1 + 2 * s);
    return {
      prompt: `Villain bets ${label}. What's your Minimum Defense Frequency?`,
      sub: 'MDF = how much of your range you must continue so a pure bluff makes 0.',
      correct: pct(mdf),
      distractors: [pct(alpha), pct(callEq), pct(Math.min(0.95, mdf + 0.14))],
      explain: `MDF = pot ÷ (pot + bet) = 1 ÷ (1 + ${s}) = ${pct(mdf)}. You fold at most α = bet ÷ (pot + bet) = ${pct(alpha)}. Don't confuse it with the equity a CALL needs (${pct(callEq)} = bet ÷ (pot + 2·bet)) — that's a different question.`,
    };
  },
}));

// ---- pot-odds (call price) templates ----
// The equity a CALL needs to break even = call ÷ (pot AFTER you call) = bet ÷ (pot +
// 2·bet) = s / (1 + 2s), where s = bet ÷ pot-before-the-bet. This is the "you need X%"
// side of the fold-to-a-bet decision the game keeps showing (⅓→20% · ½→25% · ⅔→28% ·
// pot→33%). The two classic ERRORS are the distractors so a right answer means you know
// which formula: MDF = 1/(1+s) (a RANGE-defense %, not your price) and the naive
// bet÷(pot+bet) = s/(1+s) (forgets your own call also joins the pot).
const POTODDS_TEMPLATES: Template[] = SIZES.map(({ s, label }) => ({
  id: `potodds-${s}`,
  build: () => {
    const callEq = s / (1 + 2 * s); // required equity to call
    const mdf = 1 / (1 + s); // range-defense % — the wrong grab
    const naive = s / (1 + s); // bet ÷ (pot+bet) — forgot the call joins the pot
    return {
      prompt: `Villain bets ${label}. What equity do you need to CALL?`,
      sub: 'The break-even price — call only if your hand wins at least this often.',
      correct: pct(callEq),
      // Two classic errors first (MDF, naive bet÷(pot+bet)); the last two are numeric
      // backups so buildQuestion always has 3 DISTINCT distractors — at s=1 mdf and naive
      // are both 50%, which would otherwise collide and make pad inject a bare number.
      distractors: [pct(mdf), pct(naive), pct(callEq * 2), pct(callEq + 0.06)],
      explain: `Need = call ÷ (pot after you call) = bet ÷ (pot + 2·bet) = ${s} ÷ (1 + 2·${s}) = ${pct(callEq)}. You risk the bet to win the pot + the bet, and your call also joins the pot. Compare to your equity (outs × 2 per card): more → call, less → fold. It is NOT the MDF (${pct(mdf)}, a range-defense %), nor bet÷(pot+bet) (${pct(naive)}, which forgets your own call goes in).`,
    };
  },
}));

// ---- value:bluff ratio templates ----
// A polar betting range makes a bluff-catcher indifferent when value:bluff =
// (pot + bet) : bet = (1 + 1/s) : 1. Pot-sized → 2:1, half → 3:1, 2× → 1.5:1.
const RATIO_TEMPLATES: Template[] = SIZES.map(({ s, label }) => ({
  id: `ratio-${s}`,
  build: () => {
    const vb = 1 + 1 / s; // value combos per 1 bluff
    const bluffFrac = 1 / (vb + 1); // = s/(1+2s)
    return {
      prompt: `You bet ${label} on the river with a polar range. What value:bluff ratio makes villain indifferent?`,
      sub: 'The mix that stops a bluff-catcher from profitably calling OR folding.',
      correct: ratio(vb),
      distractors: [ratio(1 / s), ratio(vb + 1), ratio(Math.max(1.2, vb - 1))],
      explain: `value : bluff = (pot + bet) : bet = 1 + 1/${s} = ${ratio(vb)}. So bluffs are ${pct(bluffFrac)} of the betting range. Bigger bet → fewer value per bluff (2× pot = 1.5:1); smaller bet → more (½ pot = 3:1).`,
    };
  },
}));

// ---- combos / blockers templates ----
// Fixed, exact combinatorics. Each answer is a count; distractors are the other
// common counts (4/6/9/12/16/3) so a right answer means you know WHY, not which
// number "looks like a combo count".
const COMBO_TEMPLATES: Template[] = [
  {
    id: 'combo-pair',
    build: () => ({
      prompt: 'How many combos of a specific pocket pair (e.g. QQ), no cards dead?',
      sub: 'Choose 2 of the 4 suits.',
      correct: '6',
      distractors: ['4', '12', '16'],
      explain: 'A pocket pair = C(4,2) = 6 combos. (4 suited + 12 offsuit = 16 is for an UNPAIRED hand.)',
    }),
  },
  {
    id: 'combo-suited',
    build: () => ({
      prompt: 'How many combos of a specific SUITED hand (e.g. AKs), no cards dead?',
      sub: 'One per suit.',
      correct: '4',
      distractors: ['6', '12', '16'],
      explain: 'Suited = 4 combos (one per suit). Offsuit = 12. Together AKs + AKo = 16 total AK.',
    }),
  },
  {
    id: 'combo-offsuit',
    build: () => ({
      prompt: 'How many combos of a specific OFFSUIT hand (e.g. AKo), no cards dead?',
      sub: '4×4 minus the 4 suited pairings.',
      correct: '12',
      distractors: ['16', '6', '9'],
      explain: 'Offsuit = 4×4 − 4 suited = 12 combos. Suited = 4. Total AK = 16.',
    }),
  },
  {
    id: 'combo-anyAK',
    build: () => ({
      prompt: 'How many combos of AK total (suited + offsuit), no cards dead?',
      sub: '#aces × #kings.',
      correct: '16',
      distractors: ['12', '8', '6'],
      explain: 'Any two unpaired ranks = 4 × 4 = 16 combos (4 suited + 12 offsuit).',
    }),
  },
  {
    id: 'combo-block-unpaired',
    build: () => ({
      prompt: 'You hold the A♥. How many combos of AK can villain have?',
      sub: 'One ace is gone from the deck.',
      correct: '12',
      distractors: ['16', '9', '8'],
      explain: 'Aces left = 3, kings left = 4 → 3 × 4 = 12. Holding one blocker cuts AK from 16 to 12.',
    }),
  },
  {
    id: 'combo-block-both',
    build: () => ({
      prompt: 'Board is A♠K♦-x. How many combos of AK (two pair) can villain have?',
      sub: 'One ace AND one king are on the board.',
      correct: '9',
      distractors: ['12', '16', '6'],
      explain: 'Aces left = 3, kings left = 3 → 3 × 3 = 9 combos of two pair. Board cards block hard.',
    }),
  },
  {
    id: 'combo-set',
    build: () => ({
      prompt: 'Board is K♠-x-x (one king). How many combos of a set of kings (KK) can villain have?',
      sub: 'Only 3 kings remain; choose 2.',
      correct: '3',
      distractors: ['6', '1', '2'],
      explain: 'With one K on board, KK = C(3,2) = 3 combos. Full-pair 6 combos only when no card of that rank is dead.',
    }),
  },
  {
    id: 'combo-block-AA',
    build: () => ({
      prompt: 'You hold the A♣. How many combos of AA can villain have?',
      sub: 'One ace is in your hand.',
      correct: '3',
      distractors: ['6', '1', '4'],
      explain: 'Aces left = 3 → C(3,2) = 3 combos of AA. Holding one ace halves AA (6 → 3).',
    }),
  },
];

const BANKS: Record<Mode, Template[]> = { mdf: MDF_TEMPLATES, potodds: POTODDS_TEMPLATES, ratio: RATIO_TEMPLATES, combos: COMBO_TEMPLATES };
const MODE_LABEL: Record<Mode, string> = { mdf: '🛡 MDF', potodds: '🎯 Pot odds', ratio: '⚖ Value:Bluff', combos: '🔢 Combos' };

// Turn a template into a concrete question: dedupe distractors against the correct
// answer (and each other), keep the first three unique, then shuffle all four.
function buildQuestion(t: Template, rng: () => number): Question {
  const { prompt, sub, correct, distractors, explain } = t.build();
  const opts = [correct];
  for (const d of distractors) {
    if (opts.length >= 4) break;
    if (!opts.includes(d)) opts.push(d);
  }
  // pad (only bites if a template's distractors collided) so there are always 4.
  let pad = 1;
  while (opts.length < 4) {
    const candidate = `${opts.length + pad}`;
    if (!opts.includes(candidate)) opts.push(candidate);
    pad++;
  }
  // Fisher–Yates with the passed rng (never Math.random in render).
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  return { id: t.id, prompt, sub, options: opts, answer: opts.indexOf(correct), explain };
}

// Pick the next template by SRS weight, then build it. Pure given the rng.
function nextQuestion(mode: Mode, srs: SrsMap, rng: () => number, avoidId?: string): Question {
  const bank = BANKS[mode];
  const weights = bank.map((t) => weightOf(srs, t.id));
  const avoid = avoidId ? bank.findIndex((t) => t.id === avoidId) : -1;
  const idx = weightedIndex(weights, rng, avoid >= 0 ? avoid : undefined);
  return buildQuestion(bank[idx], rng);
}

// First question at module load — a useState lazy initializer runs in render,
// where React forbids Math.random.
const FIRST = nextQuestion('mdf', loadSrs(), Math.random);

export function MathDrill() {
  const [mode, setMode] = useState<Mode>('mdf');
  const [srs, setSrs] = useState<SrsMap>(() => loadSrs());
  const [q, setQ] = useState<Question>(FIRST);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(() => loadDrillScore('math-mdf'));

  const revealed = picked != null;
  const correct = revealed && picked === q.answer;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;

  function pick(i: number) {
    if (revealed) return;
    const ok = i === q.answer;
    setPicked(i);
    setSrs((m) => recordSrs(m, q.id, ok));
    setScore(recordDrillScore(`math-${mode}`, ok));
    playGrade(ok);
  }
  function next() {
    setQ(nextQuestion(mode, srs, Math.random, q.id));
    setPicked(null);
  }
  function switchMode(m: Mode) {
    if (m === mode) return;
    setMode(m);
    setScore(loadDrillScore(`math-${m}`));
    setPicked(null);
    setQ(nextQuestion(m, srs, Math.random));
  }

  useDrillKeys({ choices: q.options.length, onPick: pick, onNext: next, revealed });

  const mastery = useMemo(() => {
    // share of this mode's templates with a low SRS weight = "known cold".
    const bank = BANKS[mode];
    const known = bank.filter((t) => weightOf(srs, t.id) <= 0.5).length;
    return { known, total: bank.length };
  }, [mode, srs]);

  return (
    <div className="card">
      <h2>Math Trainer</h2>
      <p className="sub">
        The pure-number skills — <b>MDF</b>, <b>pot odds</b> (the price a call needs), <b>value:bluff
        ratios</b>, and <b>combinatorics</b>. The Reference tab explains these; this drills them until
        they're instant. Every answer is exact maths (no solver). Spots you miss come back more often
        (spaced repetition).
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          {(Object.keys(BANKS) as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => switchMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="quiz-score">
          Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore(`math-${mode}`))} title="Reset this mode's saved score">↺</button>
          )}
        </div>
      </div>
      <p className="note">{drillKeysHint(q.options.length)} · score saved across sessions · mastered {mastery.known}/{mastery.total}.</p>

      <div className="lab-prompt">{q.prompt}</div>
      <p className="note" style={{ marginTop: 0 }}>{q.sub}</p>

      <div className="rd-bands bsd-sizes">
        {q.options.map((o, i) => (
          <button
            key={i}
            className={`rd-band ${picked === i ? 'chosen' : ''} ${revealed && i === q.answer ? 'is-best' : ''} ${revealed && picked === i && i !== q.answer ? 'is-wrong' : ''}`}
            onClick={() => pick(i)}
          >
            <span className="rd-band-lbl">{o}</span>
          </button>
        ))}
      </div>

      {revealed && (
        <>
          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct ? '✓ Correct.' : `✗ Answer: ${q.options[q.answer]}.`}
            <button className="btn btn-deal lab-next" onClick={next}>Next →</button>
          </div>
          <div className="bsd-lesson">
            <span className="bsd-lesson-tag">📌 Why</span>
            <p>{q.explain}</p>
          </div>
        </>
      )}

      <div className="bsd-cheat">
        <h4>The formulas</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill small">MDF</span> pot ÷ (pot + bet) = 1 ÷ (1 + s). ½ pot → 67% · pot → 50% · 2× → 33%. Fold more than this vs an under-bluffer.</div>
          <div><span className="bsd-pill big">α (alpha)</span> bet ÷ (pot + bet) = the max you may fold = 1 − MDF. Pot → 50%.</div>
          <div><span className="bsd-pill polar">Value:Bluff</span> (pot + bet) : bet. ½ pot → 3:1 · pot → 2:1 · 2× → 1.5:1. Bigger bet = fewer value per bluff.</div>
          <div><span className="bsd-pill check">Pot odds (call price)</span> bet ÷ (pot + 2·bet) — what a CALL needs to break even. ⅓ → 20% · ½ → 25% · ⅔ → 28% · pot → 33%. Compare to your equity (outs × 2 per card). NOT the same as MDF.</div>
          <div><span className="bsd-pill pos">Combos</span> pair = 6 · suited = 4 · offsuit = 12 · any two ranks = 16. Each blocker you or the board holds cuts the count.</div>
          <div><span className="bsd-pill polar">Blockers</span> #left(rank A) × #left(rank B) for unpaired; C(#left, 2) for a pair/set. Board + your hand both remove cards.</div>
        </div>
      </div>
    </div>
  );
}
