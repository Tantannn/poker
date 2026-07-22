// Bet-sizing drill — teaches WHEN to bet ⅓ vs ¾ vs pot, and WHETHER to bet at
// all. The size buttons in the game don't explain themselves; this does. A real
// board + hand is solved, you pick a line, and it reveals the solver's EV for
// every option plus WHY it fits the texture. Three modes: "Sizing" drills pure
// size selection on always-bet spots; "Bet or check" adds the check option so
// the rep is honest — not every spot is a bet; "Trap" concentrates the one
// anti-aggression spot — a near-nut hand checked to you vs an aggressor who bets
// FOR you, where the exploit (check to induce his barrels) beats the static
// solver's lead. A texture read and a persistent cheat-sheet make the rule stick.

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard, describeTexture, boardWetness } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { classifyHandClass } from '../strategy/handClass';
import { evLoss } from '../strategy/types';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { actionRule, KIND_COLOR } from '../strategy/actionRules';
import { getProfile } from '../ai/profiles';
import { playGrade } from '../sound';
import { SpotBoard } from './SpotBoard';
import { useDrillKeys, drillKeysHint } from '../hooks/useDrillKeys';
import { loadDrillScore, recordDrillScore, resetDrillScore } from '../store/drillScore';

const BB = 2;
const POT = 12;

type Mode = 'sizing' | 'decide' | 'trap';

// Opponent-type lens. Correct sizing shifts with WHO you're betting into, not just
// the board — a station wants bigger value & zero bluffs, a nit folds to pressure.
// range width feeds hero's equity; contBias is the villain-stickiness knob the model
// already exposes (+ = calls wider, − = folds wider; see postflopModel.PostflopInput).
type Villain = { id: string; label: string; contBias: number; range: ReturnType<typeof rangeFromSet>; note: string };
const VILLAINS: Villain[] = [
  { id: 'gto', label: '⚖ Balanced', contBias: 0, range: rangeFromSet(RFI_RANGES.BTN), note: 'Balanced ranges — read the size straight off the board texture; no read-based adjustment.' },
  { id: 'lp', label: '🐟 Station', contBias: 0.22, range: rangeFromSet(RFI_RANGES.SB), note: 'Calls far too wide. Size UP your value — thin value prints because they pay off — and never bluff; they don\'t fold.' },
  { id: 'nit', label: '🗿 Nit', contBias: -0.16, range: rangeFromSet(RFI_RANGES.UTG), note: 'Folds too much. Bet/bluff bigger for fold equity; but value gets no action, so give up when called instead of barrelling into a strong continue.' },
  { id: 'maniac', label: '🤪 Maniac', contBias: 0.06, range: rangeFromSet(RFI_RANGES.SB), note: 'Bets & bluffs relentlessly. Lean to CHECK strong hands and let them bluff into you; when you do bet, size for value, not protection.' },
  { id: 'lag', label: '🔥 LAG', contBias: 0.05, range: rangeFromSet(RFI_RANGES.BTN), note: 'Wide & aggressive — bluffs a lot and bets when checked to. Trap your strong hands and let them barrel, call down lighter, and don\'t bloat pots out of position.' },
];

// Trap mode drills only aggressors — the trap needs an opponent who BETS when
// checked to. A station / nit won't bet for you, so checking them just skips a
// street of value. (Maniac + LAG are the two "bets for you" archetypes here.)
const TRAP_VILLAINS = ['maniac', 'lag'];

interface Band { id: ActionId; label: string; tag: string; pct: string }

// the four sizes we drill, in order. all-in is excluded — this is about
// reading texture for a normal bet, not stack-off math.
const SIZES: Band[] = [
  { id: 'bet33', label: '⅓ pot', tag: 'Small', pct: '~33%' },
  { id: 'bet50', label: '½ pot', tag: 'Medium', pct: '~50%' },
  { id: 'bet75', label: '¾ pot', tag: 'Big', pct: '~75%' },
  { id: 'betpot', label: 'Pot', tag: 'Polar', pct: '100%' },
];
const CHECK: Band = { id: 'check', label: 'Check', tag: 'Pot control', pct: '0%' };
const SIZE_IDS = SIZES.map((s) => s.id);
// rank used to tell the user "too small" vs "too big" when they miss a size.
const SIZE_RANK: Record<string, number> = { bet33: 0, bet50: 1, bet75: 2, betpot: 3 };

// player-count lens: sizing shifts multiway. Nutted hands barely lose equity (size
// UP for value), one pair below top dies (check more), and a bet thins the field.
// opps = live opponents; oppRanges feeds the model N copies so hero must beat the
// whole field, and the pot starts bigger as dead money piles in (mirror of PostflopLab).
const FIELDS: { opps: number; label: string }[] = [
  { opps: 1, label: 'Heads-up' },
  { opps: 2, label: '3-way' },
  { opps: 4, label: '5-way' },
  { opps: 5, label: '6-way' },
];
const fieldPot = (opps: number) => Math.round(POT * (1 + 0.6 * (opps - 1)));

type Pos = 'ip' | 'oop';

interface Spot { hero: Card[]; board: Card[]; strategy: NodeStrategy; label: string; pos: Pos }

function dealHero(): Card[] {
  const a = randomCard([]);
  let b = randomCard([a]);
  while (b.rank === a.rank && b.suit === a.suit) b = randomCard([a]);
  return [a, b];
}

function solve(hero: Card[], board: Card[], position: Pos, villain: Villain, opps: number): NodeStrategy {
  return solvePostflop({
    hero, board, oppRange: villain.range,
    oppRanges: opps > 1 ? Array.from({ length: opps }, () => villain.range) : undefined,
    contBias: villain.contBias, pot: fieldPot(opps), toCall: 0, heroCommitted: 0, currentBet: 0,
    minRaiseTo: BB, maxRaiseTo: 188, canCheck: true, canRaise: true, bigBlind: BB,
    iterations: 1500, rangeNote: `${villain.label} range · ${opps + 1}-way`, position,
  });
}

// Deal + solve until the solver's best line is one of the allowed options — so
// the question is always well-posed. Sizing mode allows only the three sizes
// ("which size"); decide mode also allows check ("bet or check, then how big").
// Position is randomised per spot — it shifts the right size, so you train the
// read: in position you bet smaller & more often, out of position you polarise.
function genSpot(allow: ActionId[], villain: Villain, opps: number, trap = false): Spot {
  for (let a = 0; a < 700; a++) {
    const hero = dealHero();
    let board = randomFlop('any', hero);
    if (Math.random() < 0.45) board = [...board, randomCard([...hero, ...board])];
    // Trap: hero is OOP (checks first, the aggressor bets behind) and the deal is
    // gated to a near-nut hand so protection is moot and the trap is unambiguous —
    // no "bet to charge the draw" grey area.
    const pos: Pos = trap ? 'oop' : Math.random() < 0.5 ? 'ip' : 'oop';
    const cls = classifyHandClass(hero, board);
    if (trap && cls.strength < 4) continue; // straight / flush / set / full+ only
    const strategy = solve(hero, board, pos, villain, opps);
    if (trap) {
      if ((strategy.equity ?? 0) < 0.88) continue; // near-unbeatable only
      return { hero, board, strategy, label: cls.label, pos };
    }
    if (allow.includes(strategy.bestId)) {
      return { hero, board, strategy, label: cls.label, pos };
    }
  }
  const hero = dealHero();
  const board = randomFlop('any', hero);
  return { hero, board, strategy: solve(hero, board, 'oop', villain, opps), label: classifyHandClass(hero, board).label, pos: 'oop' };
}

// First spot generated at module load, not during render — a useState lazy
// initializer runs in the render phase, where React forbids Math.random.
const FIRST_SPOT = genSpot(SIZE_IDS, VILLAINS[0], 1);

export function BetSizingDrill() {
  const [mode, setMode] = useState<Mode>('sizing');
  const [villainId, setVillainId] = useState<string>(VILLAINS[0].id);
  const villain = useMemo(() => VILLAINS.find((v) => v.id === villainId) ?? VILLAINS[0], [villainId]);
  const [opps, setOpps] = useState(1);
  const potChips = fieldPot(opps);
  const fieldLabel = FIELDS.find((f) => f.opps === opps)?.label ?? 'Heads-up';
  // decide + trap both add the check option; only pure "sizing" omits it.
  const allow = useMemo<ActionId[]>(() => (mode === 'sizing' ? SIZE_IDS : ['check', ...SIZE_IDS]), [mode]);
  const bands = mode === 'sizing' ? SIZES : [CHECK, ...SIZES];
  const trapMode = mode === 'trap';
  // Trap needs an aggressor who bets for you — hide the passive villain chips.
  const shownVillains = trapMode ? VILLAINS.filter((v) => TRAP_VILLAINS.includes(v.id)) : VILLAINS;

  const [spot, setSpot] = useState<Spot>(FIRST_SPOT);
  const [chosen, setChosen] = useState<ActionId | null>(null);
  // lifetime score, persisted per mode — survives reloads (store/drillScore).
  const [score, setScore] = useState(() => loadDrillScore(`bsd-${mode}`));
  // hide the equity number so you read the BOARD, not the solver. Still revealed
  // after you answer, so it stays a teaching aid — just not a pre-answer spoiler.
  const [hideEq, setHideEq] = useState(false);

  const best = spot.strategy.options.find((o) => o.id === spot.strategy.bestId);
  const optById = useMemo(() => {
    const m = new Map<ActionId, NodeStrategy['options'][number]>();
    for (const o of spot.strategy.options) m.set(o.id, o);
    return m;
  }, [spot]);

  const revealed = chosen != null;
  const loss = chosen ? evLoss(spot.strategy, chosen) : 0;
  // Sizing/decide grade on solver EV (within 0.15bb). Trap grades on finding the
  // exploit — check — because the static solver can't see the aggressor bets for
  // you, so its EV would mark a lead "correct" and miss the trap entirely.
  const good = revealed && (trapMode ? chosen === 'check' : loss <= 0.15);
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const street = spot.board.length === 3 ? 'Flop' : 'Turn';
  const tex = useMemo(() => describeTexture(spot.board), [spot]);
  const chosenBandLabel = bands.find((b) => b.id === chosen)?.label ?? '';

  function pick(id: ActionId) {
    if (revealed) return;
    const l = evLoss(spot.strategy, id);
    const correct = trapMode ? id === 'check' : l <= 0.15;
    setChosen(id);
    setScore(recordDrillScore(`bsd-${mode}`, correct));
    playGrade(correct);
  }
  function next() { setSpot(genSpot(allow, villain, opps, trapMode)); setChosen(null); }
  function switchMode(m: Mode) {
    if (m === mode) return;
    const isTrap = m === 'trap';
    // Trap only makes sense vs an aggressor who bets for you; if the current
    // villain can't be trapped (a station / nit), force to Maniac.
    const v = isTrap && !TRAP_VILLAINS.includes(villainId)
      ? (VILLAINS.find((x) => x.id === 'maniac') ?? VILLAINS[0])
      : villain;
    if (v.id !== villainId) setVillainId(v.id);
    setMode(m);
    setScore(loadDrillScore(`bsd-${m}`)); // each mode keeps its own lifetime score
    setChosen(null);
    const al: ActionId[] = m === 'sizing' ? SIZE_IDS : ['check', ...SIZE_IDS];
    setSpot(genSpot(al, v, opps, isTrap));
  }
  function switchVillain(id: string) {
    if (id === villainId) return;
    const v = VILLAINS.find((x) => x.id === id) ?? VILLAINS[0];
    setVillainId(id);
    setChosen(null);
    setSpot(genSpot(allow, v, opps, trapMode)); // re-solve the SAME kind of spot vs the new type
  }
  function switchField(o: number) {
    if (o === opps) return;
    setOpps(o);
    setChosen(null);
    setSpot(genSpot(allow, villain, o, trapMode)); // same spot kind, now N-way
  }

  // keyboard: 1..N picks the Nth size button, Space/Enter deals the next spot.
  useDrillKeys({
    choices: bands.length,
    onPick: (i) => pick(bands[i].id),
    onNext: next,
    revealed,
  });

  // wrong-answer feedback, adapted to mode and the gap between chosen and best.
  function badMsg(): string {
    const lossTxt = `EV loss −${loss.toFixed(2)} bb.`;
    if (chosen === 'check') return `✗ Too passive — best was ${best?.label}. ${lossTxt}`;
    if (spot.strategy.bestId === 'check') return `✗ Don't bet here — checking is best. ${lossTxt}`;
    if (chosen && best && SIZE_RANK[chosen] != null && SIZE_RANK[spot.strategy.bestId] != null) {
      const dir = SIZE_RANK[chosen] < SIZE_RANK[spot.strategy.bestId] ? 'small' : 'big';
      return `✗ Too ${dir} here. Best was ${best.label} — ${lossTxt}`;
    }
    return `✗ Best was ${best?.label} — ${lossTxt}`;
  }

  // The "what to remember" lesson on a miss — ties the abstract rule to THIS
  // board's texture and your seat, and names what your wrong pick actually costs.
  function wrongLesson(): string {
    const bestId = spot.strategy.bestId;
    const posTip =
      spot.pos === 'ip'
        ? 'In position you realise equity well — lean smaller & more often.'
        : 'Out of position you realise less — check more, and polarise when you bet.';

    if (chosen === 'check')
      return `You checked a spot the solver bets. This ${tex.label} board wants ${bestId === 'bet33' ? `a small range bet — ${best?.label} takes thin value and denies little` : `a bigger bet — ${best?.label} charges their equity and builds the pot`}.${tex.favours ? ` ${tex.favours}` : ''} Checking hands a free card and wins less. ${posTip} 💡 With an edge, bet — don't give free cards.`;

    if (bestId === 'check') {
      const eq = spot.strategy.equity ?? 0;
      // A strong-but-vulnerable made hand can be a check even though you're ahead —
      // don't tell the user they have "no edge / are a bluff-catcher" when they're not.
      if (eq >= 0.55)
        return `You bet, but the solver checks — even though you're ahead (~${Math.round(eq * 100)}%). On a board this dangerous, betting a hand with no redraw folds out the worse hands you beat and gets called or raised by what beats or outdraws you. Check to pot-control and keep his bluffs in — you don't need to bet to win this pot. ${posTip} 💡 Strong but vulnerable & no redraw → check, don't bloat the pot.`;
      return `You bet a spot with no edge. Worse hands won't call and better hands won't fold — the bet just bloats the pot while you're a bluff-catcher. Check, control the pot, realise your equity for free. ${posTip} 💡 No edge → check.`;
    }

    if (chosen && SIZE_RANK[chosen] != null && SIZE_RANK[bestId] != null) {
      const tooSmall = SIZE_RANK[chosen] < SIZE_RANK[bestId];
      const wet = boardWetness(spot.board) !== 'dry';
      if (tooSmall) {
        // best is BIGGER than your pick — why bigger? wet → charge draws; dry → value/build pot.
        return wet
          ? `Too small on a ${tex.label} board. It's draw-heavy — a small bet lets their draws and overcards peel cheap, so you fail to charge equity that's drawing against you. Size up to ${best?.label} to make them pay. ${posTip} 💡 Wet / dynamic board → bet big.`
          : `Too small here. The board is dry, but your hand is strong enough to bet big for value and build the pot — size up to ${best?.label}. ${posTip} 💡 Strong hand → bet big for value, even on a dry board.`;
      }
      // best is SMALLER than your pick — over-sizing folds out the worse hands you want calls from.
      return wet
        ? `Too big on a ${tex.label} board. Over-sizing folds out the worse hands and draws you want calls from — you get called only by what's ahead. Drop to ${best?.label}. ${posTip} 💡 A value bet wants calls from worse — don't blast them out.`
        : `Too big on a ${tex.label} board. It's dry and static, so pot-sizing folds out everything you beat and you get called only by what beats you. Drop to ${best?.label} to keep worse hands in. ${posTip} 💡 Dry / static board → small & often; a value hand wants calls, not folds.`;
    }
    return `Best was ${best?.label}. ${posTip}`;
  }

  // Trap-mode lesson — the exploit rationale. Grading is check=correct even when
  // the static solver's EV favours a lead, because the solver can't model the
  // aggressor barrelling when checked to; the check's REALIZED EV is higher.
  function trapLesson(): string {
    const air = Math.round(getProfile(villain.id).bluffFreq * 100);
    return spot.strategy.bestId === 'check'
      ? `Even the static solver checks this near-nut hand — a lead folds out worse and is called only by better. Vs ${villain.label} it's worth more still: he fires his air when you show weakness, so check-raise / check-call and stack him.`
      : `The static solver leads (${best?.label}) — but it can't see that ${villain.label} bets FOR you. Realized EV: check, let him barrel his ~${air}% air, and take a bigger pot by check-raising / check-calling than a lead that only folds worse hands out. Slow-play = near-nut + an aggressor who bets for you; everywhere else, bet.`;
  }

  return (
    <div className="card">
      <h2>Bet-Sizing Drill</h2>
      <p className="sub">
        Focused size curriculum: the game's ⅓ / ¾ / Pot buttons don't tell you which to press — or
        whether to bet at all. This does. Read the board, pick a line, see the solver's EV for each and
        <b>why</b> the texture wants it. For full spot exploration + multi-street play, use the
        {' '}<b>Postflop Lab</b> tab.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          <button className={mode === 'sizing' ? 'active' : ''} onClick={() => switchMode('sizing')}>💰 Sizing</button>
          <button className={mode === 'decide' ? 'active' : ''} onClick={() => switchMode('decide')}>🤔 Bet or check</button>
          <button className={mode === 'trap' ? 'active' : ''} onClick={() => switchMode('trap')} title="Near-nut hand checked to you vs an aggressor who bets for you — the anti-aggression trap. Check to induce; graded on finding it.">🪤 Trap</button>
        </div>
        <button
          className={`bsd-eqtoggle ${hideEq ? 'on' : ''}`}
          onClick={() => setHideEq((v) => !v)}
          title="Hide the equity number before you answer, so you read the board — not the solver. Revealed after."
        >
          {hideEq ? '🙈 Equity hidden' : '👁 Equity shown'}
        </button>
        <div className="quiz-score">
          Score: <b>{score.correct}/{score.total}</b> ({pctScore}%)
          {score.total > 0 && (
            <button className="btn-small qs-reset" onClick={() => setScore(resetDrillScore(`bsd-${mode}`))} title="Reset this mode's saved score">↺</button>
          )}
        </div>
      </div>
      <p className="note">{drillKeysHint(bands.length)} · score is saved across sessions.</p>

      <div className="quiz-drills bsd-villains">
        <span className="bsd-vs">{trapMode ? 'Trapping:' : 'Betting into:'}</span>
        {shownVillains.map((v) => (
          <button key={v.id} className={villainId === v.id ? 'active' : ''} onClick={() => switchVillain(v.id)} title={v.note}>
            {v.label}
          </button>
        ))}
      </div>

      <div className="quiz-drills bsd-villains">
        <span className="bsd-vs">Players:</span>
        {FIELDS.map((f) => (
          <button key={f.opps} className={opps === f.opps ? 'active' : ''} onClick={() => switchField(f.opps)}>
            {f.label}
          </button>
        ))}
      </div>

      <SpotBoard
        hero={spot.hero}
        board={spot.board}
        handLabel={spot.label}
        boardTag={<>{street} · {tex.label} · {fieldLabel} · pot {potChips}bb · {spot.pos === 'ip' ? 'in position (checked to you)' : 'out of position (you act first)'}</>}
        equity={spot.strategy.equity}
        equityHidden={hideEq && !revealed}
        posNote={spot.pos}
      />

      {!revealed && (
        <div className="lab-prompt">{trapMode ? 'Near-nut, checked to you OOP — bet, or check and trap?' : mode === 'decide' ? 'Bet or check — what\'s your line?' : "You're betting — how big?"}</div>
      )}

      <div className="rd-bands bsd-sizes">
        {bands.map((s) => {
          const o = optById.get(s.id);
          // In trap mode the graded-correct answer is the CHECK (the exploit), so
          // it wears the green "best" highlight and any bet you picked is "wrong"
          // — the solver's static bestId is shown only via the raw EV numbers.
          const isBest = trapMode ? s.id === 'check' : s.id === spot.strategy.bestId;
          const isWrong = trapMode
            ? chosen === s.id && s.id !== 'check'
            : chosen === s.id && !isBest && loss > 0.15;
          return (
            <button
              key={s.id}
              className={`rd-band ${chosen === s.id ? 'chosen' : ''} ${revealed && isBest ? 'is-best' : ''} ${revealed && isWrong ? 'is-wrong' : ''}`}
              onClick={() => pick(s.id)}
            >
              <span className="rd-band-lbl">{s.label}</span>
              <span className="rd-band-sub">{s.tag} · {s.pct}</span>
              {revealed && o && (
                <span className={`la-ev ${o.ev >= 0 ? 'pos' : 'neg'}`}>{o.ev >= 0 ? '+' : ''}{o.ev.toFixed(2)} bb</span>
              )}
              {revealed && o && (
                <span className="la-bar" style={{ width: `${Math.round(o.freq * 100)}%`, background: KIND_COLOR[o.kind ?? 'value'] }} />
              )}
            </button>
          );
        })}
      </div>

      {revealed && (
        <>
          {best?.why && (
            <div className="lab-why">
              <div className="lab-why-row">
                <span className="lab-why-tag best">{trapMode ? 'Solver (static)' : 'Best'} · {best.label}</span>
                <p>{best.why}</p>
                {actionRule(spot.strategy.bestId, spot.board) && (
                  <div className="bsd-rule"><b>💡 Rule:</b> {actionRule(spot.strategy.bestId, spot.board)}</div>
                )}
                <div className="bsd-rule"><b>🎯 vs {villain.label}:</b> {villain.note}</div>
              </div>
            </div>
          )}
          <div className={`lab-feedback ${good ? 'good' : 'bad'}`}>
            {good
              ? trapMode
                ? `✓ Trap — you checked and let ${villain.label} bet for you. A lead folds out his bluffs; the check keeps his air firing so you check-raise / check-call for more.`
                : `✓ Good line — ${best?.label} is the solver's pick (within 0.15bb).`
              : trapMode
                ? `✗ You bet (${chosenBandLabel}) — that folds out the bluffs that are your profit and caps your range. Check: ${villain.label} bets when checked to, so hand him the lead.`
                : badMsg()}
            <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
          </div>
          {!good && (
            <div className="bsd-lesson">
              <span className="bsd-lesson-tag">📌 Remember</span>
              <p>{trapMode ? trapLesson() : wrongLesson()}</p>
            </div>
          )}
        </>
      )}

      <div className="bsd-cheat">
        <h4>When each size — the rule</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill small">⅓ Small</span> Dry/static boards (K72r, A84r), range bets, thin value. You bet often, deny little equity, keep worse hands in.</div>
          <div><span className="bsd-pill small">½ Medium</span> Semi-wet / medium boards, or thin value that still wants a call. The middle gear — more than a range bet, less than a polar charge.</div>
          <div><span className="bsd-pill big">¾ Big</span> Wet/dynamic boards (T98ss, 654), value + draws. Charge their equity, build the pot, polarize.</div>
          <div><span className="bsd-pill polar">Pot</span> You have the nut advantage — strong, polar range. Max value / max fold equity. Also low SPR / commitment spots.</div>
          <div><span className="bsd-pill check">Check</span> Neither edge — marginal made hands and air with no value/fold-equity case. Pot control, realize equity for free. Drilled in <b>Bet or check</b> mode.</div>
          <div><span className="bsd-pill pos">Position</span> <b>In position</b> you realise equity well → bet smaller, bet more often, check back marginal hands. <b>Out of position</b> you realise less → check more, and go bigger / more polar when you do bet.</div>
          <div><span className="bsd-pill polar">Don't over-bet value</span> A one-pair overpair is <i>not</i> a jam. Size to the <b>worst hand that still calls</b> — over-bet/shove and you fold out everything you beat and get called only by what beats you. Get the stack in across streets, not all at once. <b>Overbet/jam = polar nuts &amp; air, or low SPR — never a one-pair hand that needs calls from worse.</b></div>
          <div><span className="bsd-pill polar">vs Opponent type</span> Texture sets the baseline; the read shifts it. <b>Station</b> → size UP value, never bluff (they don't fold). <b>Nit</b> → bet/bluff bigger for fold equity, but give up when called. <b>Maniac</b> → check strong hands and induce their bluffs. <b>Balanced</b> → size purely off the board. Switch the <i>Betting into</i> chip and watch the best size move.</div>
          <div><span className="bsd-pill big">Multiway</span> More players in the pot: <b>size UP with value</b> (nutted hands barely lose equity and you must beat everyone), <b>check marginal one-pair</b> (it dies against a field), and a bet also <b>thins the field</b>. <b>Bluff far less</b> — someone usually has a piece. Compare your equity to the <b>fair share</b> (33% 3-way, 20% 5-way), not 50%.</div>
        </div>
        <p className="bsd-note">
          Core idea: <b>size follows board advantage</b>. Range advantage → small &amp; often · nut advantage →
          big &amp; polar · neither → check. Position layers on top: <b>IP smaller &amp; more often, OOP
          polarise</b>. Value and bluffs use the <i>same</i> size so villain can't tell them apart.
          And a value hand wants <b>calls from worse</b> — don't confuse protection with the urge to shove.
        </p>
      </div>
    </div>
  );
}
