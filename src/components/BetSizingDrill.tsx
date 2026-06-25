// Bet-sizing drill — teaches WHEN to bet ⅓ vs ¾ vs pot, and WHETHER to bet at
// all. The size buttons in the game don't explain themselves; this does. A real
// board + hand is solved, you pick a line, and it reveals the solver's EV for
// every option plus WHY it fits the texture. Two modes: "Sizing" drills pure
// size selection on always-bet spots; "Bet or check" adds the check option so
// the rep is honest — not every spot is a bet. A texture read and a persistent
// cheat-sheet make the rule stick even when you're wrong.

import { useMemo, useState } from 'react';
import type { Card } from '../engine/cards';
import { randomFlop, randomCard, describeTexture } from '../engine/board';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';
import { classifyHandClass } from '../strategy/handClass';
import { evLoss } from '../strategy/types';
import type { ActionId, NodeStrategy } from '../strategy/types';
import { PlayingCard } from './PlayingCard';
import { InfoTip } from './CalcTip';

const BB = 2;
const POT = 12;
const VILLAIN = rangeFromSet(RFI_RANGES.BTN);

type Mode = 'sizing' | 'decide';

interface Band { id: ActionId; label: string; tag: string; pct: string }

// the three sizes we drill, in order. all-in is excluded — this is about
// reading texture for a normal bet, not stack-off math.
const SIZES: Band[] = [
  { id: 'bet33', label: '⅓ pot', tag: 'Small', pct: '~33%' },
  { id: 'bet75', label: '¾ pot', tag: 'Big', pct: '~75%' },
  { id: 'betpot', label: 'Pot', tag: 'Polar', pct: '100%' },
];
const CHECK: Band = { id: 'check', label: 'Check', tag: 'Pot control', pct: '0%' };
const SIZE_IDS = SIZES.map((s) => s.id);
// rank used to tell the user "too small" vs "too big" when they miss a size.
const SIZE_RANK: Record<string, number> = { bet33: 0, bet75: 1, betpot: 2 };

const KIND_COLOR: Record<string, string> = { value: '#2ec27e', bluff: '#e0843a', passive: '#3aa0e0', aggressive: '#2ec27e', call: '#3aa0e0', fold: '#2a3a31' };

// One-line memorable rule for why the solver picked this line — no math, the
// kind of thing you can actually recall mid-hand.
const SIZE_HOOK: Record<string, string> = {
  bet33: 'Dry, static board — bet small, bet often. You can bet your whole range and deny little. 💡 Dry board → small.',
  bet75: 'Wet, dynamic board — bet big to charge their draws and build the pot. 💡 Wet board → big.',
  betpot: 'You hold the nut edge / a polar range — bet pot for max value and max fold equity. 💡 Nut edge → pot.',
  check: 'No edge here — check, control the pot, take a free card and realize equity. 💡 No edge → check.',
};

type Pos = 'ip' | 'oop';

interface Spot { hero: Card[]; board: Card[]; strategy: NodeStrategy; label: string; pos: Pos }

function dealHero(): Card[] {
  const a = randomCard([]);
  let b = randomCard([a]);
  while (b.rank === a.rank && b.suit === a.suit) b = randomCard([a]);
  return [a, b];
}

function solve(hero: Card[], board: Card[], position: Pos): NodeStrategy {
  return solvePostflop({
    hero, board, oppRange: VILLAIN, pot: POT, toCall: 0, heroCommitted: 0, currentBet: 0,
    minRaiseTo: BB, maxRaiseTo: 188, canCheck: true, canRaise: true, bigBlind: BB,
    iterations: 1500, rangeNote: 'BTN range', position,
  });
}

// Deal + solve until the solver's best line is one of the allowed options — so
// the question is always well-posed. Sizing mode allows only the three sizes
// ("which size"); decide mode also allows check ("bet or check, then how big").
// Position is randomised per spot — it shifts the right size, so you train the
// read: in position you bet smaller & more often, out of position you polarise.
function genSpot(allow: ActionId[]): Spot {
  for (let a = 0; a < 700; a++) {
    const hero = dealHero();
    let board = randomFlop('any', hero);
    if (Math.random() < 0.45) board = [...board, randomCard([...hero, ...board])];
    const pos: Pos = Math.random() < 0.5 ? 'ip' : 'oop';
    const strategy = solve(hero, board, pos);
    if (allow.includes(strategy.bestId)) {
      return { hero, board, strategy, label: classifyHandClass(hero, board).label, pos };
    }
  }
  const hero = dealHero();
  const board = randomFlop('any', hero);
  return { hero, board, strategy: solve(hero, board, 'oop'), label: classifyHandClass(hero, board).label, pos: 'oop' };
}

export function BetSizingDrill() {
  const [mode, setMode] = useState<Mode>('sizing');
  const allow = useMemo<ActionId[]>(() => (mode === 'decide' ? ['check', ...SIZE_IDS] : SIZE_IDS), [mode]);
  const bands = mode === 'decide' ? [CHECK, ...SIZES] : SIZES;

  const [spot, setSpot] = useState<Spot>(() => genSpot(SIZE_IDS));
  const [chosen, setChosen] = useState<ActionId | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });

  const best = spot.strategy.options.find((o) => o.id === spot.strategy.bestId);
  const optById = useMemo(() => {
    const m = new Map<ActionId, NodeStrategy['options'][number]>();
    for (const o of spot.strategy.options) m.set(o.id, o);
    return m;
  }, [spot]);

  const revealed = chosen != null;
  const loss = chosen ? evLoss(spot.strategy, chosen) : 0;
  const good = revealed && loss <= 0.15; // within 0.15bb of best = a fine line
  const pctScore = score.total ? Math.round((100 * score.correct) / score.total) : 0;
  const street = spot.board.length === 3 ? 'Flop' : 'Turn';
  const tex = useMemo(() => describeTexture(spot.board), [spot]);

  function pick(id: ActionId) {
    if (revealed) return;
    setChosen(id);
    setScore((s) => ({ correct: s.correct + (evLoss(spot.strategy, id) <= 0.15 ? 1 : 0), total: s.total + 1 }));
  }
  function next() { setSpot(genSpot(allow)); setChosen(null); }
  function switchMode(m: Mode) {
    if (m === mode) return;
    setMode(m);
    setScore({ correct: 0, total: 0 });
    setChosen(null);
    setSpot(genSpot(m === 'decide' ? ['check', ...SIZE_IDS] : SIZE_IDS));
  }

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

  return (
    <div className="card">
      <h2>Bet-Sizing Drill</h2>
      <p className="sub">
        The game's ⅓ / ¾ / Pot buttons don't tell you which to press — or whether to bet at all. This
        does. Read the board, pick a line, then see the solver's EV for each and <b>why</b> the texture
        wants it.
      </p>

      <div className="quiz-bar">
        <div className="quiz-drills">
          <button className={mode === 'sizing' ? 'active' : ''} onClick={() => switchMode('sizing')}>💰 Sizing</button>
          <button className={mode === 'decide' ? 'active' : ''} onClick={() => switchMode('decide')}>🤔 Bet or check</button>
        </div>
        <div className="quiz-score">Streak: <b>{score.correct}/{score.total}</b> ({pctScore}%)</div>
      </div>

      <div className="lab-board">
        <div className="lab-hero">
          <span className="lab-tag">Your hand · {spot.label}</span>
          <div className="lab-cards">{spot.hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        <div className="lab-flop">
          <span className="lab-tag">
            {street} · {tex.label} · pot {POT}bb · {spot.pos === 'ip' ? 'in position (checked to you)' : 'out of position (you act first)'}
            <InfoTip
              content={
                <span className="tip-body">
                  <b className="tip-title">Texture read · {tex.label}</b>
                  <span className="tip-what">{tex.sentence}</span>
                  {tex.favours && <span className="tip-remember"><b>Edge:</b> {tex.favours}</span>}
                  <span className="tip-what">
                    {spot.pos === 'ip'
                      ? 'In position you realise equity well — check back marginal hands, bet smaller and more often.'
                      : 'Out of position you realise equity worse — check more, and polarise (bigger) when you do bet.'}
                  </span>
                </span>
              }
            />
          </span>
          <div className="lab-cards">{spot.board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
        </div>
        {spot.strategy.equity != null && (
          <div className="lab-eq">
            <div className="big-stat gold">{(spot.strategy.equity * 100).toFixed(1)}%</div>
            <div className="stat-lbl">equity vs range</div>
          </div>
        )}
      </div>

      {!revealed && (
        <div className="lab-prompt">{mode === 'decide' ? 'Bet or check — what\'s your line?' : "You're betting — how big?"}</div>
      )}

      <div className="rd-bands bsd-sizes">
        {bands.map((s) => {
          const o = optById.get(s.id);
          const isBest = s.id === spot.strategy.bestId;
          return (
            <button
              key={s.id}
              className={`rd-band ${chosen === s.id ? 'chosen' : ''} ${revealed && isBest ? 'is-best' : ''} ${revealed && chosen === s.id && !isBest && loss > 0.15 ? 'is-wrong' : ''}`}
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
                <span className="lab-why-tag best">Best · {best.label}</span>
                <p>{best.why}</p>
                {SIZE_HOOK[spot.strategy.bestId] && (
                  <div className="bsd-rule"><b>💡 Rule:</b> {SIZE_HOOK[spot.strategy.bestId]}</div>
                )}
              </div>
            </div>
          )}
          <div className={`lab-feedback ${good ? 'good' : 'bad'}`}>
            {good
              ? `✓ Good line — ${best?.label} is the solver's pick (within 0.15bb).`
              : badMsg()}
            <button className="btn btn-deal lab-next" onClick={next}>Next spot →</button>
          </div>
        </>
      )}

      <div className="bsd-cheat">
        <h4>When each size — the rule</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill small">⅓ Small</span> Dry/static boards (K72r, A84r), range bets, thin value. You bet often, deny little equity, keep worse hands in.</div>
          <div><span className="bsd-pill big">¾ Big</span> Wet/dynamic boards (T98ss, 654), value + draws. Charge their equity, build the pot, polarize.</div>
          <div><span className="bsd-pill polar">Pot</span> You have the nut advantage — strong, polar range. Max value / max fold equity. Also low SPR / commitment spots.</div>
          <div><span className="bsd-pill check">Check</span> Neither edge — marginal made hands and air with no value/fold-equity case. Pot control, realize equity for free. Drilled in <b>Bet or check</b> mode.</div>
          <div><span className="bsd-pill pos">Position</span> <b>In position</b> you realise equity well → bet smaller, bet more often, check back marginal hands. <b>Out of position</b> you realise less → check more, and go bigger / more polar when you do bet.</div>
          <div><span className="bsd-pill polar">Don't over-bet value</span> A one-pair overpair is <i>not</i> a jam. Size to the <b>worst hand that still calls</b> — over-bet/shove and you fold out everything you beat and get called only by what beats you. Get the stack in across streets, not all at once. <b>Overbet/jam = polar nuts &amp; air, or low SPR — not a hand that wants calls.</b></div>
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
