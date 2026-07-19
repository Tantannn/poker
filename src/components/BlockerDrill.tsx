// Blocker Decision drill — the skill BEYOND counting combos: do the specific
// cards in YOUR hand turn a river spot into a CALL, a FOLD, or a BLUFF-RAISE?
// Holding one card of villain's value class removes a big share of his nut
// combos (favouring a bluff-raise); holding his busted-draw cards removes his
// bluffs (favouring a fold). Every verdict here is HONEST combinatorics — we
// enumerate villain's actual value + bluff combos with codeToCombos, delete the
// ones that collide with your hand or the board (that IS the blocker effect),
// then compare his resulting bluff frequency to your pot-odds price. Nothing is
// hardcoded; decideBlocker() recomputes the answer from the cards every time, so
// it's unit-tested in BlockerDrill.test.ts. Matches the BetSizingDrill /
// MathDrill pattern: module-load first spot, keyboard 1–3 / Space, reveal-then-
// explain, lifetime score persisted per drill id ('blocker').

/* eslint-disable react-refresh/only-export-components -- the pure grading logic
   (decideBlocker / countCombos / gradeScenario) and the scenario data are
   exported from this file on purpose so BlockerDrill.test.ts can unit-test the
   honest combinatoric verdict co-located with the component it drives. */

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { parseCard, sameCard, cardId } from '../engine/cards';
import { codeToCombos } from '../engine/range';
import { classifyHandClass } from '../strategy/handClass';
import { playGrade } from '../sound';
import { SpotBoard } from './SpotBoard';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

// ---- decision logic (pure + exported for tests) --------------------------

export type BlockerAction = 'call' | 'fold' | 'bluff-raise';
export type BlockerRationale = 'block-value-raise' | 'price-call' | 'block-bluffs-fold' | 'price-fold';

/** The minimum a pure, testable grade needs: hero's two cards, the board, the
 *  villain's VALUE + BLUFF combos as 169-codes, and the money. */
export interface BlockerInput {
  hero: Card[];
  board: Card[];
  value: string[]; // 169-codes: 'QQ', 'AKs', 'AKo', … (codeToCombos-expandable)
  bluff: string[];
  pot: number; // pot BEFORE villain's river bet
  bet: number; // villain's river bet
}

export interface BlockerVerdict {
  action: BlockerAction;
  rationale: BlockerRationale;
  valueBefore: number; // combos with only the BOARD removed
  valueAfter: number; //  … with the board AND hero's cards removed (blockers)
  bluffBefore: number;
  bluffAfter: number;
  valueBlockRate: number; // share of villain's value your cards remove, 0..1
  bluffBlockRate: number;
  bluffFracBefore: number; // bluff / (value + bluff), board-only
  bluffFracAfter: number; //  … after your blockers — the number that decides
  need: number; // break-even equity to call, 0..1
  call: number; // chips you must put in = bet
  potWithBet: number; // pot + villain's bet (what's in the middle when you act)
}

// Bluff-raise triggers when your cards strip a large share of villain's VALUE
// (so a raise makes him fold — he rarely has it) while barely touching his
// BLUFFS (which stay in his range and fold to the raise). Tuned so that blocking
// one card of a concentrated nut class (~25–33% of it) clears the bar, but the
// incidental blocking in a normal bluff-catch spot does not.
export const VALUE_BLOCK_RAISE = 0.18;
export const BLUFF_BLOCK_RAISE_MAX = 0.12;

/** Concrete combos of `codes` after deleting any that collide with a `dead`
 *  card (hero's hand + the board). This is the blocker removal — the whole
 *  point of the drill. Deduped so overlapping codes never double-count. */
export function countCombos(codes: string[], dead: Card[]): number {
  const seen = new Set<number>();
  let n = 0;
  for (const code of codes) {
    for (const [a, b] of codeToCombos(code)) {
      if (dead.some((d) => sameCard(d, a) || sameCard(d, b))) continue;
      const key = cardId(a) < cardId(b) ? cardId(a) * 52 + cardId(b) : cardId(b) * 52 + cardId(a);
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
    }
  }
  return n;
}

/** Grade a river blocker spot from HONEST combinatorics — no hardcoded answer.
 *  1. Enumerate villain's value + bluff combos, board-only then minus hero (the
 *     blocker effect). 2. If hero removes lots of value & little bluff → bluff-
 *     raise. 3. Else it's a pure bluff-catch: call iff villain's post-blocker
 *     bluff frequency beats your pot-odds price, else fold. */
export function decideBlocker(input: BlockerInput): BlockerVerdict {
  const { hero, board, value, bluff, pot, bet } = input;
  const dead = [...hero, ...board];

  const valueBefore = countCombos(value, board);
  const bluffBefore = countCombos(bluff, board);
  const valueAfter = countCombos(value, dead);
  const bluffAfter = countCombos(bluff, dead);

  const call = bet;
  const potWithBet = pot + bet;
  // Break-even equity to call = call / (final pot) = bet / (pot + 2·bet). Equal
  // to call/(pot+call) once "pot" already contains villain's bet.
  const need = call / (potWithBet + call);

  const bluffFracAfter = valueAfter + bluffAfter > 0 ? bluffAfter / (valueAfter + bluffAfter) : 0;
  const bluffFracBefore = valueBefore + bluffBefore > 0 ? bluffBefore / (valueBefore + bluffBefore) : 0;
  const valueBlockRate = valueBefore > 0 ? (valueBefore - valueAfter) / valueBefore : 0;
  const bluffBlockRate = bluffBefore > 0 ? (bluffBefore - bluffAfter) / bluffBefore : 0;

  let action: BlockerAction;
  let rationale: BlockerRationale;
  if (valueBlockRate >= VALUE_BLOCK_RAISE && bluffBlockRate <= BLUFF_BLOCK_RAISE_MAX) {
    action = 'bluff-raise';
    rationale = 'block-value-raise';
  } else if (bluffFracAfter >= need) {
    action = 'call';
    rationale = 'price-call';
  } else {
    action = 'fold';
    // If your cards cut his bluffs and that is what pushed the price out of
    // reach (a call without your blockers), it's a blocker fold; else a price fold.
    rationale = bluffBlockRate > 0 && bluffFracBefore >= need ? 'block-bluffs-fold' : 'price-fold';
  }

  return {
    action,
    rationale,
    valueBefore,
    valueAfter,
    bluffBefore,
    bluffAfter,
    valueBlockRate,
    bluffBlockRate,
    bluffFracBefore,
    bluffFracAfter,
    need,
    call,
    potWithBet,
  };
}

// ---- scenarios -----------------------------------------------------------

export interface BlockerScenario extends Omit<BlockerInput, 'hero' | 'board'> {
  id: string;
  title: string;
  villain: string; // plain-English description of villain's betting range
  heroCards: string[]; // 'Ah', '5s'
  boardCards: string[];
}

/** Parse a scenario's card strings and grade it. */
export function gradeScenario(s: BlockerScenario): BlockerVerdict {
  return decideBlocker({
    hero: s.heroCards.map(parseCard),
    board: s.boardCards.map(parseCard),
    value: s.value,
    bluff: s.bluff,
    pot: s.pot,
    bet: s.bet,
  });
}

// 10 spots across: hero blocks the nuts (→ bluff-raise), hero blocks villain's
// bluffs (→ fold), clean bluff-catcher at a good price (→ call), bad price (→
// fold). Value/bluff are 169-codes on THAT board; the verdict is computed, never
// stored — change a hero card and the grade moves.
export const SCENARIOS: BlockerScenario[] = [
  {
    id: 'ace-block',
    title: 'You hold the case-ace blocker',
    villain: 'A tight villain jams the river only with a set or top two pair (AA / AQ / QQ / 99), plus his busted broadway draws as bluffs (KJ / JT / T8).',
    heroCards: ['Ah', '5s'],
    boardCards: ['As', 'Qs', '9d', '4c', '2h'],
    value: ['AA', 'AQs', 'AQo', 'QQ', '99'],
    bluff: ['KJs', 'KJo', 'JTs', 'JTo', 'T8s', 'T8o'],
    pot: 20,
    bet: 15,
  },
  {
    id: 'straight-block',
    title: 'You block the nut straight',
    villain: 'Villain value-bets the T-high straight (T9) and sets (88 / 66); his bluffs are the missed overcards (AK / AQ / KQ / KJ).',
    heroCards: ['Td', '8c'],
    boardCards: ['8h', '7s', '6d', '3c', '2h'],
    value: ['T9s', 'T9o', '88', '66'],
    bluff: ['AKs', 'AKo', 'AQs', 'AQo', 'KQs', 'KQo', 'KJs', 'KJo'],
    pot: 24,
    bet: 18,
  },
  {
    id: 'king-block',
    title: 'Your king blocks his nut two-pair',
    villain: 'On A-K-high, villain bets top two pair and sets (AK / AA / KK / 77); bluffs are the busted draws (QJ / JT / T9).',
    heroCards: ['Kc', '5s'],
    boardCards: ['Ah', 'Kd', '7s', '4c', '2h'],
    value: ['AKs', 'AKo', 'AA', 'KK', '77'],
    bluff: ['QJs', 'QJo', 'JTs', 'JTo', 'T9s', 'T9o'],
    pot: 26,
    bet: 20,
  },
  {
    id: 'topset-block',
    title: 'You block top set AND top two',
    villain: 'Villain only bets the nutted part of his range — top two pair (JT) and sets (JJ / TT) — bluffing his busted straight draws (Q9 / 98 / 87).',
    heroCards: ['Jd', '5h'],
    boardCards: ['Js', 'Td', '6c', '3s', '2h'],
    value: ['JTs', 'JTo', 'JJ', 'TT'],
    bluff: ['Q9s', 'Q9o', '98s', '98o', '87s', '87o'],
    pot: 22,
    bet: 18,
  },
  {
    id: 'block-bluffs',
    title: 'Your jacks eat his bluffs',
    villain: 'A balanced villain bets a wide value range (AK / KQ / KT / KK / QQ / 88 / K8) and bluffs his missed jack-high draws (JT / J9 / J7).',
    heroCards: ['Jc', 'Jd'],
    boardCards: ['Kh', 'Qd', '8s', '5c', '2h'],
    value: ['AKs', 'AKo', 'KQs', 'KQo', 'KTs', 'KTo', 'KK', 'QQ', '88', 'K8s', 'K8o'],
    bluff: ['JTs', 'JTo', 'J9s', 'J9o', 'J7s', 'J7o'],
    pot: 20,
    bet: 20,
  },
  {
    id: 'bad-price-overbet',
    title: 'Overbet, and he barely bluffs',
    villain: 'A polar villain overbets a value-heavy range (every Ax two-pair/top-pair plus KK / 99) with only a couple of busted draws (QJ / JT).',
    heroCards: ['7c', '7d'],
    boardCards: ['As', 'Kd', '9c', '6h', '2s'],
    value: ['AKs', 'AKo', 'AQs', 'AQo', 'AJs', 'AJo', 'ATs', 'ATo', 'A9s', 'A9o', 'KK', '99'],
    bluff: ['QJs', 'QJo', 'JTs', 'JTo'],
    pot: 20,
    bet: 40,
  },
  {
    id: 'bad-price-2',
    title: 'Big bet, too much value',
    villain: 'Villain fires a big bet with a value-dense range (AQ / KQ / QT / QJ / QQ / JJ) and only two busted-draw bluffs (T9 / 98).',
    heroCards: ['3c', '3d'],
    boardCards: ['Qh', 'Js', '6d', '4c', '2h'],
    value: ['AQs', 'AQo', 'KQs', 'KQo', 'QTs', 'QTo', 'QJs', 'QJo', 'QQ', 'JJ'],
    bluff: ['T9s', 'T9o', '98s', '98o'],
    pot: 24,
    bet: 50,
  },
  {
    id: 'good-price',
    title: 'Clean bluff-catch, tiny price',
    villain: 'Villain bets small with thin value (KQ / KJ / 88) but a lot of missed draws (AQ / AJ / JT / T9). You block none of it.',
    heroCards: ['6c', '6h'],
    boardCards: ['Ks', '8d', '4s', '3h', '2c'],
    value: ['KQs', 'KQo', 'KJs', 'KJo', '88'],
    bluff: ['AQs', 'AQo', 'AJs', 'AJo', 'JTs', 'JTo', 'T9s', 'T9o'],
    pot: 30,
    bet: 8,
  },
  {
    id: 'medium-price',
    title: 'Bluff-catch at a fair price',
    villain: 'Villain bets two-thirds pot with value (QJ / QQ / 99 / KQ) and a bluff-heavy load of busted draws (JT / T8 / 86 / AK).',
    heroCards: ['7c', '7d'],
    boardCards: ['Qh', '9d', '5s', '3c', '2h'],
    value: ['QJs', 'QJo', 'QQ', '99', 'KQs', 'KQo'],
    bluff: ['JTs', 'JTo', 'T8s', 'T8o', '86s', '86o', 'AKs', 'AKo'],
    pot: 20,
    bet: 12,
  },
  {
    id: 'ace-catch',
    title: 'Ace-high catch, ace blocks value',
    villain: 'Villain bets two pair / sets (KQ / AK / KK / QQ) and bluffs his busted draws (JT / T9 / 98). Your ace both bluff-catches and blocks his AK.',
    heroCards: ['Ac', '5s'],
    boardCards: ['Kh', 'Qd', '7s', '4c', '2h'],
    value: ['KQs', 'KQo', 'AKs', 'AKo', 'KK', 'QQ'],
    bluff: ['JTs', 'JTo', 'T9s', 'T9o', '98s', '98o'],
    pot: 20,
    bet: 14,
  },
];

// ---- component -----------------------------------------------------------

interface ActionBand {
  id: BlockerAction;
  label: string;
  tag: string;
}
const ACTIONS: ActionBand[] = [
  { id: 'call', label: '📞 Call', tag: 'bluff-catch' },
  { id: 'fold', label: '🚮 Fold', tag: 'give up' },
  { id: 'bluff-raise', label: '🔨 Bluff-raise', tag: 'blocker raise' },
];

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ACTION_LABEL: Record<BlockerAction, string> = {
  call: 'Call',
  fold: 'Fold',
  'bluff-raise': 'Bluff-raise',
};

// The teaching sentence for a verdict, tied to THIS spot's actual combo counts.
function whyText(v: BlockerVerdict): string {
  const bf = pct(v.bluffFracAfter);
  const nd = pct(v.need);
  const vRemoved = v.valueBefore - v.valueAfter;
  switch (v.rationale) {
    case 'block-value-raise':
      return `Your cards remove ${vRemoved} of villain's ${v.valueBefore} value combos (${pct(v.valueBlockRate)}) while leaving all ${v.bluffAfter} of his bluffs in his range. When you raise, he almost never has a hand strong enough to continue — so turn your hand into a bluff-raise and make his air fold. Blocking the nuts ⇒ raise, not just call.`;
    case 'price-call':
      return `After removing the combos your cards account for, villain's river bet is ${bf} bluffs, and at this price you only need ${nd} equity to break even. ${bf} ≥ ${nd} ⇒ your bluff-catcher shows a profit — call.`;
    case 'block-bluffs-fold':
      return `You hold the very cards that make up villain's missed draws, so he has only ${v.bluffAfter} of his ${v.bluffBefore} bluff combos left. That drops his bluffing frequency to ${bf} — below the ${nd} you need — so the hand that would be a call WITHOUT your blockers (${pct(v.bluffFracBefore)}) is now a fold. Blocking his bluffs ⇒ fold.`;
    case 'price-fold':
      return `At this price you need ${nd} equity, but villain's range is only ${bf} bluffs — too value-heavy. You aren't being laid enough to bluff-catch ⇒ fold.`;
  }
}

const FIRST = SCENARIOS[0];

export function BlockerDrill() {
  const [scenario, setScenario] = useState<BlockerScenario>(FIRST);
  const [chosen, setChosen] = useState<BlockerAction | null>(null);
  const [score, setScore] = useState(() => loadDrillScore('blocker'));

  const hero = useMemo(() => scenario.heroCards.map(parseCard), [scenario]);
  const board = useMemo(() => scenario.boardCards.map(parseCard), [scenario]);
  const verdict = useMemo(() => gradeScenario(scenario), [scenario]);
  const handLabel = useMemo(() => classifyHandClass(hero, board).label, [hero, board]);

  const revealed = chosen != null;
  const correct = revealed && chosen === verdict.action;
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const betPct = Math.round((100 * scenario.bet) / scenario.pot);

  function pick(id: BlockerAction) {
    if (revealed) return;
    const ok = id === verdict.action;
    setChosen(id);
    setScore(recordDrillScore('blocker', ok));
    playGrade(ok);
  }
  function next() {
    let n = scenario;
    while (n.id === scenario.id) n = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    setScenario(n);
    setChosen(null);
  }

  useDrillKeys({ choices: ACTIONS.length, onPick: (i) => pick(ACTIONS[i].id), onNext: next, revealed });

  return (
    <div className="card">
      <h2>Blocker Decision Drill</h2>
      <p className="sub">
        Counting combos tells you <i>how many</i> hands villain has. This drills the next step: do
        <b> your two cards</b> make the river a <b>call</b>, a <b>fold</b>, or a <b>bluff-raise</b>?
        Holding a card of his value class deletes his nut combos (raise); holding his busted-draw
        cards deletes his bluffs (fold). Every answer is honest combinatorics — villain's combos are
        enumerated and the ones your hand blocks are removed, then compared to your pot-odds price.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          <span className="note" style={{ alignSelf: 'center' }}>River · pick your line</span>
        </div>
        <div className="quiz-score">
          Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore('blocker'))} title="Reset this drill's saved score">↺</button>
          )}
        </div>
      </div>
      <p className="note">{drillKeysHint(ACTIONS.length)} · score is saved across sessions.</p>

      <SpotBoard
        hero={hero}
        board={board}
        handLabel={handLabel}
        boardTag={<>River · pot {scenario.pot}bb · villain bets {scenario.bet}bb ({betPct}% pot)</>}
      />

      <div className="lab-why" style={{ marginTop: '0.6rem' }}>
        <div className="lab-why-row">
          <span className="lab-why-tag">Villain</span>
          <p>{scenario.villain}</p>
        </div>
      </div>

      {!revealed && <div className="lab-prompt">Villain bets. Your line — call, fold, or bluff-raise?</div>}

      <div className="rd-bands bsd-sizes">
        {ACTIONS.map((a) => {
          const isBest = a.id === verdict.action;
          return (
            <button
              key={a.id}
              className={`rd-band ${chosen === a.id ? 'chosen' : ''} ${revealed && isBest ? 'is-best' : ''} ${revealed && chosen === a.id && !isBest ? 'is-wrong' : ''}`}
              onClick={() => pick(a.id)}
            >
              <span className="rd-band-lbl">{a.label}</span>
              <span className="rd-band-sub">{a.tag}</span>
            </button>
          );
        })}
      </div>

      <div className="hr-controls">
        <button className="btn btn-deal" onClick={next}>
          New hand ⟳
        </button>
      </div>

      {revealed && (
        <>
          {/* Combo accounting — the honest math behind the verdict. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '0.5rem',
              margin: '0.7rem 0',
            }}
          >
            <ComboStat label="Value combos" before={verdict.valueBefore} after={verdict.valueAfter} kind="value" />
            <ComboStat label="Bluff combos" before={verdict.bluffBefore} after={verdict.bluffAfter} kind="bluff" />
            <div className="lab-eq" style={{ padding: '0.4rem 0.6rem' }}>
              <div className="big-stat gold">{pct(verdict.bluffFracAfter)}</div>
              <div className="stat-lbl">villain bluffs (after blockers)</div>
            </div>
            <div className="lab-eq" style={{ padding: '0.4rem 0.6rem' }}>
              <div className="big-stat">{pct(verdict.need)}</div>
              <div className="stat-lbl">equity you need to call</div>
            </div>
          </div>

          <div className="lab-why">
            <div className="lab-why-row">
              <span className="lab-why-tag best">Best · {ACTION_LABEL[verdict.action]}</span>
              <p>{whyText(verdict)}</p>
              <div className="bsd-rule">
                <b>💡 Price:</b> you call {verdict.call}bb to win {verdict.potWithBet}bb ⇒ break-even {pct(verdict.need)}. Villain is {pct(verdict.bluffFracAfter)} bluffs after your blockers — {verdict.bluffFracAfter >= verdict.need ? 'enough' : 'not enough'} to bluff-catch.
              </div>
            </div>
          </div>

          <div className={`lab-feedback ${correct ? 'good' : 'bad'}`}>
            {correct ? `✓ ${ACTION_LABEL[verdict.action]} is the play.` : `✗ Best was ${ACTION_LABEL[verdict.action]}, not ${ACTION_LABEL[chosen!]}.`}
          </div>

          <div className="bsd-lesson">
            <span className="bsd-lesson-tag">📌 Remember</span>
            <p>{scenario.title}. {whyText(verdict)}</p>
          </div>
        </>
      )}

      <div className="bsd-cheat">
        <h4>Blockers on the river — the rule</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill polar">Block value ⇒ raise</span> Hold a card of villain's nut class (nut flush ace, a card of his straight / top two / set) and he rarely has it. Raise: your blocker becomes fold equity, and you unblock the bluffs that fold.</div>
          <div><span className="bsd-pill check">Block bluffs ⇒ fold</span> Hold the cards of his busted draws and he has fewer bluffs than the board suggests. His range is now value-heavy — your bluff-catcher gets there less often. Fold.</div>
          <div><span className="bsd-pill small">Good price ⇒ call</span> When you block neither, it's pure pot odds: call if his bluff% (after removals) ≥ what you need. Small bet = cheap price = call wider.</div>
          <div><span className="bsd-pill big">Bad price ⇒ fold</span> Big bet / overbet ⇒ you need more bluffs to call. A value-heavy jammer with few bluffs doesn't lay you the price. Fold.</div>
          <div><span className="bsd-pill pos">The maths</span> Need = call ÷ (pot + call). Villain bluff% = bluffs ÷ (value + bluffs), counted AFTER deleting the combos your hand + the board remove. bluff% ≥ need ⇒ call, else fold.</div>
          <div><span className="bsd-pill polar">Same card, opposite jobs</span> An ace can BLOCK his value (⇒ raise) or, on another board, BE his missing bluff (⇒ fold). Read what your specific cards remove, not just the raw combo count.</div>
        </div>
        <p className="bsd-note">
          Core idea: <b>combos aren't fixed — your hand edits them</b>. Before you price a river call,
          ask which of villain's combos your two cards delete. Deleting his <b>value</b> pushes toward a
          <b> bluff-raise</b>; deleting his <b>bluffs</b> pushes toward a <b>fold</b>; deleting neither
          leaves a pure <b>pot-odds</b> call/fold.
        </p>
      </div>
    </div>
  );
}

// Small value/bluff before→after tile. Green for value, red for bluffs; shows the
// combo count the blocker removed so the effect of your cards is explicit.
function ComboStat({ label, before, after, kind }: { label: string; before: number; after: number; kind: 'value' | 'bluff' }) {
  const removed = before - after;
  const color = kind === 'value' ? '#4ea1ff' : '#ff6b6b';
  return (
    <div className="lab-eq" style={{ padding: '0.4rem 0.6rem' }}>
      <div className="big-stat" style={{ color }}>
        {before} <span style={{ opacity: 0.6, fontSize: '0.7em' }}>→</span> {after}
      </div>
      <div className="stat-lbl">
        {label}{removed > 0 ? ` · you blocked ${removed}` : ' · none blocked'}
      </div>
    </div>
  );
}
