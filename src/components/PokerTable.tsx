import { useEffect, useState } from 'react';
import { useGame } from '../hooks/useGame';
import { positionLabel, tournamentLevel, handsToNextLevel } from '../engine/table';
import type { Action } from '../engine/table';
import { icmRead, payoutTable } from '../engine/icm';
import { getProfile } from '../ai/profiles';
import { Seat } from './Seat';
import { PositionHint } from './PositionHint';
import { PlayingCard } from './PlayingCard';
import { Controls } from './Controls';
import { Hud } from './Hud';
import { ScoreCard } from './ScoreCard';
import { StrategyPanel } from './StrategyPanel';
import { RangeChartModal } from './RangeChartModal';
import { SituationPanel } from './SituationPanel';
import { OpponentPanel } from './OpponentPanel';
import { Feedback } from './Feedback';
import { DecisionChecklist } from './DecisionChecklist';
import { ScenarioBar } from './ScenarioBar';
import type { AggroWarning } from '../analysis/aggression';
import type { TiltState } from '../analysis/tilt';
import { toStats } from '../analysis/observed';

type G = ReturnType<typeof useGame>;

interface Props {
  g: G;
  hudEnabled: boolean;
  onToggleHud: () => void;
}

export function PokerTable({ g, hudEnabled, onToggleHud }: Props) {
  const { game, legal, isHeroTurn, handOver, feedback, hud, hudLoading, hero, pot, strategy, rng, villain, aggroWarning, tilt } = g;
  const reveal = game.street === 'complete' || game.street === 'showdown';
  // A genuine showdown means 2+ players still hold cards at the end. An
  // uncontested win (everyone folded to one player) also lands on 'complete'
  // but never exposes cards at a real table — so in pure-play we only reveal
  // when this is true. Folded/busted seats (0 cards) don't count.
  const wasShowdown = game.players.filter((p) => !p.folded && p.holeCards.length === 2).length >= 2;
  const winnerIds = new Set(game.winners.map((w) => w.playerId));
  const started = game.handNumber > 0;
  const [infoEnabled, setInfoEnabled] = useState(true);
  const [oppEnabled, setOppEnabled] = useState(true);
  // Tournament bundles the "pure play" feel — hide every guide for a real-table
  // experience. Start hidden when launching straight into a (restored) tournament.
  const [supportsHidden, setSupportsHidden] = useState(g.isTournament);
  const [showChart, setShowChart] = useState(false);
  // Study mode: hide the ANSWER (solver mix + decision verdict) while it's your
  // turn so you commit first, then the Feedback box reveals it after you act.
  // Reads/math (equity, pot odds, outs, situation, opponent) stay visible — those
  // you'd have at a real table. Per-node "peek" lets you give up and look.
  const [studyMode, setStudyMode] = useState(() => {
    try { return localStorage.getItem('poker.studyMode') !== '0'; } catch { return true; }
  });
  const [peeked, setPeeked] = useState(false);
  // Think-first checklist: optional gate — a postflop bet/raise is parked as
  // "pending" and a short graded quiz (hand class, texture, equity, purpose,
  // plan-vs-raise) must be completed before it commits. Persisted like study
  // mode; ON by default. Pure-play mode and preflop bypass it.
  const [checklistOn, setChecklistOn] = useState(() => {
    try { return localStorage.getItem('poker.thinkFirst') !== '0'; } catch { return true; }
  });
  const [pendingBet, setPendingBet] = useState<Action | null>(null);
  // a new node = a fresh hero turn; drop any peek from the previous decision.
  // Reset during render (not in an effect) on the turn-ends transition — avoids
  // the cascading-render warning from setState-in-effect.
  const [prevTurn, setPrevTurn] = useState(isHeroTurn);
  if (isHeroTurn !== prevTurn) {
    setPrevTurn(isHeroTurn);
    if (!isHeroTurn) {
      setPeeked(false);
      setPendingBet(null);
    }
  }
  // entering tournament → hide guides (pure play); leaving → show them again.
  // Synced during render (local state only) so there's no setState-in-effect.
  const [prevTourney, setPrevTourney] = useState(g.isTournament);
  if (g.isTournament !== prevTourney) {
    setPrevTourney(g.isTournament);
    setSupportsHidden(g.isTournament);
  }
  const hideAnswer = studyMode && !peeked && isHeroTurn;
  // Stamp whether the hero peeked at the solver onto each decision, so the
  // feedback box can flag a peeked rep as not unaided.
  const [lastDecisionPeeked, setLastDecisionPeeked] = useState(false);
  const postflop = game.street === 'flop' || game.street === 'turn' || game.street === 'river';
  const heroAct = (a: Action) => {
    if (checklistOn && !supportsHidden && postflop && (a.type === 'bet' || a.type === 'raise')) {
      setPendingBet(a);
      return;
    }
    setLastDecisionPeeked(peeked);
    g.heroAct(a);
  };
  // checklist passed (or at least completed) — fire the parked bet/raise
  const commitPending = () => {
    if (!pendingBet) return;
    setLastDecisionPeeked(peeked);
    g.heroAct(pendingBet);
    setPendingBet(null);
  };

  // Tilt cool-off gate: after a big swing, intercept the NEXT deal once and force
  // a breath/break. Re-arms only when a fresh swing changes the signature, so it
  // doesn't nag on every subsequent hand once you've acknowledged it.
  const tiltSig = tilt?.gate ? `${Math.round(tilt.bigLossBB)}:${tilt.lossStreak}` : null;
  const [tiltAck, setTiltAck] = useState<string | null>(null);
  const gateActive = !!tiltSig && tiltSig !== tiltAck;
  const passTilt = () => {
    setTiltAck(tiltSig);
    g.deal();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // let browser shortcuts (Ctrl/Cmd+C/V/F, etc.) through — don't act on them
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (handOver || !started) {
        if (e.key === ' ' || e.key === 'Enter') {
          if (gateActive) return; // cool-off gate: must use the on-screen buttons
          if (g.tournamentEnd) return; // freezeout decided — must click New tournament
          e.preventDefault();
          g.deal();
        }
        return;
      }
      if (!isHeroTurn) return;
      if (pendingBet) return; // think-first modal open — it owns the keyboard
      // heroAct stamps the peek state and applies the think-first gate
      const act = heroAct;
      if (e.key === 'f' || e.key === 'F') act({ type: 'fold' });
      else if (e.key === 'c' || e.key === 'C') {
        if (legal.canCheck) act({ type: 'check' });
        else if (legal.canCall) act({ type: 'call' });
      } else if (e.key === 'r' || e.key === 'R') {
        if (legal.canRaise) act({ type: legal.canCall ? 'raise' : 'bet', amount: legal.minRaiseTo });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="play-layout">
      <div className="table-col">
        <ScenarioBar g={g} />
        {g.isTournament && started && (
          <div className="tourney-status">
            🏆 Tournament — <b>{g.playersLeft}</b> of {g.fieldSize} left
            {' · '}Lvl <b>{tournamentLevel(game.handNumber) + 1}</b> blinds <b>{game.smallBlind}/{game.bigBlind}</b>
            {game.ante > 0 && <> ante <b>{game.ante}</b></>}
            {' '}<span className="tourney-next">(up in {handsToNextLevel(game.handNumber)})</span>
            {hero.stack > 0 && <> · your stack <b>{(hero.stack / game.bigBlind).toFixed(0)}bb</b></>}
          </div>
        )}
        {g.isTournament && started && hero.stack > 0 && (
          <IcmBanner
            stacks={game.players.map((p) => p.stack + p.committed)}
            heroIdx={hero.id}
            field={g.fieldSize}
          />
        )}
        <TiltBanner t={tilt} />
        <AggroBanner w={aggroWarning} />
        <div className="poker-table">
          <div className="felt">
            <div className="table-center">
              <div className="pot-display">
                <span className="pot-label">POT</span>
                <span className="pot-amount">{pot}</span>
                <span className="pot-bb">{(pot / game.bigBlind).toFixed(1)} bb</span>
              </div>
              <div className="board">
                {[0, 1, 2, 3, 4].map((i) => (
                  <PlayingCard key={i} card={game.board[i]} size="md" />
                ))}
              </div>
              {reveal && game.winners.length > 0 && <div className="winner-banner">{game.message}</div>}
              <StreetBreadcrumb street={game.street} started={started} />
            </div>

            {game.players.map((p) => (
              <Seat
                key={p.id}
                player={p}
                position={positionLabel(p.id, game.buttonIndex, game.players.length)}
                isButton={p.id === game.buttonIndex && started}
                isToAct={game.toAct === p.id && !handOver}
                reveal={reveal && (!supportsHidden || (wasShowdown && !p.folded))}
                isWinner={winnerIds.has(p.id)}
                profileName={p.isHero ? undefined : getProfile(p.profileId).tag}
                slot={p.id}
                bigBlind={game.bigBlind}
              />
            ))}
          </div>
        </div>

        {!supportsHidden && strategy && (
          <div className="chart-access">
            <button className="btn-chart-seat" onClick={() => setShowChart(true)} title="Open the range chart for your current seat">
              📊 Range chart — your seat
            </button>
          </div>
        )}

        <PositionHint buttonIndex={game.buttonIndex} n={game.players.length} started={started} />

        <div className="action-area">
          {!started || handOver ? (
            <div className="deal-area">
              {handOver && (
                <div className="hand-result">
                  {game.message} <span className={resultDeltaClass(g)}>{deltaText(g)}</span>
                  {g.history[0] && (() => {
                    const last = g.history[0];
                    const tagged = g.journal.some((e) => e.id === last.id);
                    return (
                      <button
                        className={`tag-btn ${tagged ? 'on' : ''}`}
                        onClick={() => g.toggleTag(last)}
                        title="Mark this hand for later review in Hand Review"
                      >
                        {tagged ? '★ Tagged for review' : '☆ Tag for review'}
                      </button>
                    );
                  })()}
                </div>
              )}
              {g.tournamentEnd ? (
                <TournamentEnd g={g} heroName={hero.name} />
              ) : started && handOver && gateActive && tilt ? (
                <TiltCoolOff t={tilt} onProceed={passTilt} />
              ) : (
                <div className="deal-btns">
                  <button className="btn btn-deal" onClick={g.deal}>
                    {started ? 'Next Hand' : 'Deal Hand'} <kbd>Space</kbd>
                  </button>
                  {started && !g.isTournament && (
                    <button className="btn btn-repeat" onClick={g.repeatHand} title="Replay the same hole cards & board">
                      ↺ Repeat Hand
                    </button>
                  )}
                </div>
              )}
              {!g.tournamentEnd && (
                <button className="link-btn reset-game" onClick={g.resetGame}>
                  {g.isTournament ? '⟲ New tournament (fresh equal stacks)' : '⟲ Reset game (fresh 100bb stacks)'}
                </button>
              )}
            </div>
          ) : isHeroTurn ? (
            <Controls
              legal={legal}
              pot={pot}
              currentBet={game.currentBet}
              heroCommitted={hero.committed}
              bigBlind={game.bigBlind}
              onAction={heroAct}
              onSkip={g.skipHand}
            />
          ) : hero.folded && !handOver ? (
            <div className="waiting folded-wait">
              <span>You folded — watching the hand play out…</span>
              <button className="link-btn" onClick={g.finishHand}>Skip to end →</button>
            </div>
          ) : (
            <div className="waiting">Opponents acting…</div>
          )}
          {!supportsHidden && <Feedback fb={feedback} peeked={lastDecisionPeeked} />}
        </div>
      </div>

      <div className="hud-col">
        <ScoreCard stats={g.stats} onReset={g.doResetStats} />

        <button
          className={`guides-master ${supportsHidden ? 'off' : 'on'}`}
          onClick={() => {
            const next = !supportsHidden;
            setSupportsHidden(next);
            // pure play = real table: watch the hand run out after a fold so you
            // see how it would've gone (winners show down).
            if (next) g.setWatchAfterFold(true);
          }}
          title="Hide every decision aid for a real-table feel — decide blind, then watch it play out"
        >
          {supportsHidden ? '👁 Show all guides' : '🙈 Hide all guides (pure play)'}
        </button>

        {!supportsHidden && (
          <button
            className={`study-toggle ${studyMode ? 'on' : ''}`}
            onClick={() => {
              const next = !studyMode;
              setStudyMode(next);
              try { localStorage.setItem('poker.studyMode', next ? '1' : '0'); } catch { /* ignore */ }
            }}
            title="Hide the solver's answer until you act — you keep equity, pot odds, situation & opponent reads, but decide for yourself first. The answer reveals after every move."
          >
            {studyMode ? '🎓 Study mode: ON — answer hidden until you act' : '🎓 Study mode: OFF — answer shown live'}
          </button>
        )}

        {!supportsHidden && (
          <button
            className={`study-toggle ${checklistOn ? 'on' : ''}`}
            onClick={() => {
              const next = !checklistOn;
              setChecklistOn(next);
              try { localStorage.setItem('poker.thinkFirst', next ? '1' : '0'); } catch { /* ignore */ }
            }}
            title="Gate every postflop bet/raise behind a quick graded checklist — what you hold, board texture, your equity, why you're betting, and your plan if raised — before the chips go in"
          >
            {checklistOn
              ? '🧠 Think-first: ON — checklist before postflop bets/raises'
              : '🧠 Think-first: OFF — bet/raise directly'}
          </button>
        )}

        {supportsHidden ? (
          <div className="guides-hidden-note">
            Pure-play mode — HUD, solver, situation &amp; opponent reads hidden. Decide blind like a real table.
            Hands play out to showdown (even after you fold) and only players who reach showdown reveal their
            cards. Your moves are still graded; the session score stays live above.
          </div>
        ) : (
          <>
            <Hud hud={hud} loading={hudLoading} street={game.street} enabled={hudEnabled} onToggle={onToggleHud} strategy={strategy} hideAnswer={hideAnswer} onPeek={() => setPeeked(true)} />
            <SituationPanel
              board={game.board}
              heroCards={hero.holeCards}
              street={game.street}
              active={isHeroTurn}
              villain={villain}
              opponents={game.players.filter((p) => !p.folded && !p.isHero).length}
              spr={pot > 0 ? Math.min(hero.stack, ...game.players.filter((p) => !p.folded && !p.isHero).map((p) => p.stack), Infinity) / pot : 0}
            />
            <StrategyPanel
              strategy={strategy}
              rng={rng}
              enabled={infoEnabled}
              loading={hudLoading}
              onToggle={() => setInfoEnabled((v) => !v)}
              heroStack={hero.stack}
              heroCommitted={hero.committed}
              bigBlind={game.bigBlind}
              hideAnswer={hideAnswer}
              onPeek={() => setPeeked(true)}
            />
            <OpponentPanel
              villain={villain}
              enabled={oppEnabled}
              loading={hudLoading}
              onToggle={() => setOppEnabled((v) => !v)}
              anonymous={g.anonymousVillains}
              observed={villain ? toStats(g.obsCounters[villain.seat]) : null}
              guessedId={villain ? g.villainGuesses[villain.seat] : undefined}
              onGuess={villain ? (pid) => g.guessVillain(villain.seat, pid) : undefined}
            />
            <details className="mini-tips">
          <summary>ℹ️ Reading the panels &amp; bet types</summary>
          <h4>Reading the panels</h4>
          <ul>
            <li><b>🧭 Situation</b> reads the spot in words — position, board texture, your hand class — before you act.</li>
            <li><b>📊 HUD</b> = equity vs villain's range, pot odds &amp; outs. Hit <b>ⓘ Explain</b> for the math.</li>
            <li><b>🧠 Solver</b> = per-action frequency &amp; EV; <b>ⓘ Explain</b> shows the reason + EV calc. The <b>📊 Range chart — your seat</b> button under the table opens the range.</li>
            <li><b>🎭 Opponent</b> = archetype tendencies, IP/OOP read, and how to exploit them.</li>
            <li><b>RNG roll</b> picks which branch of a mixed strategy to take; each action is scored by <b>EV loss</b> (bb).</li>
            <li><b>🎓 Study mode</b> (on by default) hides the <i>answer</i> — the solver mix &amp; the 🧭 decision verdict — until you act, so you commit your own read first. You keep equity, pot odds, situation &amp; opponent. The answer reveals in the feedback box the moment you move; hit <b>👁 Reveal</b> to peek (peeking is flagged so your score stays honest). Toggle it off to see everything live.</li>
            <li><b>🧠 Think-first</b> (on by default) gates postflop <i>bets &amp; raises</i> behind a 5-question checklist — what you hold, board texture, your equity, <i>why</i> you're betting, and your plan if raised. Answers are graded against the app's reads before the chips commit, and you can still back out. Fold/check/call stay instant; preflop and pure-play skip it.</li>
          </ul>
          <h4>Bet types (in the Explain text)</h4>
          <ul>
            <li><b>Value</b> (≥62% eq) — ahead, bet to get called by worse.</li>
            <li><b>Thin value</b> (50–62%) — slight favourite; bet smaller.</li>
            <li><b>Semi-bluff</b> (a draw) — fold equity now + outs to improve.</li>
            <li><b>Pure bluff</b> (drawing thin) — only wins if villain folds; needs blockers &amp; a story. On the river the Explain text shows the <b>value:bluff ratio</b> for each size.</li>
          </ul>
            </details>
          </>
        )}
      </div>

      {showChart && strategy && (
        <RangeChartModal strategy={strategy} onClose={() => setShowChart(false)} />
      )}

      {pendingBet && isHeroTurn && (
        <DecisionChecklist
          hero={hero.holeCards}
          board={game.board}
          equity={!hudLoading && hud ? hud.equity : null}
          actionLabel={pendingBet.type === 'bet' ? `Bet ${pendingBet.amount ?? 0}` : `Raise to ${pendingBet.amount ?? 0}`}
          onConfirm={commitPending}
          onCancel={() => setPendingBet(null)}
        />
      )}
    </div>
  );
}

// Rolling "your big bets keep getting called/raised and losing" warning. Shows
// while the leak persists; dismiss hides it until the leak type changes or clears.
function AggroBanner({ w }: { w: AggroWarning | null }) {
  const [dismissed, setDismissed] = useState(false);
  const [prevSig, setPrevSig] = useState<string | null>(null);
  const sig = w ? w.headline : null;
  if (sig !== prevSig) {
    setPrevSig(sig);
    setDismissed(false); // a new (or cleared) leak un-dismisses
  }
  if (!w || dismissed) return null;
  return (
    <div className={`aggro-banner ${w.level}`}>
      <div className="aggro-text">
        <div className="aggro-head">{w.headline}</div>
        <p className="aggro-detail">{w.detail}</p>
      </div>
      <button className="aggro-dismiss" onClick={() => setDismissed(true)} title="Dismiss until it changes">✕</button>
    </div>
  );
}

// Persistent tilt read: a meter + the signals that tripped it + a grounding
// checklist. Shows for medium AND high; dismissible until the pressure changes.
function TiltBanner({ t }: { t: TiltState | null }) {
  const [dismissed, setDismissed] = useState(false);
  const [prevSig, setPrevSig] = useState<string | null>(null);
  const sig = t ? `${t.level}:${Math.round(t.bigLossBB)}:${t.lossStreak}` : null;
  if (sig !== prevSig) {
    setPrevSig(sig);
    setDismissed(false); // a fresh / escalating swing un-dismisses
  }
  if (!t || dismissed) return null;
  return (
    <div className={`tilt-banner ${t.level}`}>
      <div className="tilt-text">
        <div className="tilt-head">{t.headline}</div>
        <div className="tilt-meter" title={`Tilt pressure: ${t.score}/100`}>
          <div className="tilt-meter-fill" style={{ width: `${t.score}%` }} />
          <span className="tilt-meter-num">{t.score}</span>
        </div>
        <p className="tilt-detail">{t.detail}</p>
        <ul className="tilt-signals">
          {t.signals.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        <details className="tilt-steps-wrap">
          <summary>How to reset</summary>
          <ul className="tilt-steps">
            {t.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      </div>
      <button className="tilt-dismiss" onClick={() => setDismissed(true)} title="Dismiss until it changes">
        ✕
      </button>
    </div>
  );
}

// The actual control: after a big swing, the next deal is gated behind this. You
// either take a short timed break or explicitly choose to play on — either way
// you pause and decide instead of auto-firing the next hand on tilt.
function TiltCoolOff({ t, onProceed }: { t: TiltState; onProceed: () => void }) {
  const BREAK_SECONDS = 30;
  const [left, setLeft] = useState<number | null>(null); // null = not on a break
  useEffect(() => {
    if (left === null || left <= 0) return;
    const id = setTimeout(() => setLeft((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(id);
  }, [left]);
  const onBreak = left !== null && left > 0;
  const breakDone = left === 0;
  return (
    <div className="tilt-cooloff">
      <div className="tilt-cooloff-head">{t.headline}</div>
      <ul className="tilt-steps">
        {t.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      {onBreak ? (
        <div className="tilt-break">
          <span className="tilt-break-timer">{left}s</span>
          <span className="tilt-break-msg">Breathe. Eyes off the table.</span>
        </div>
      ) : (
        <div className="tilt-cooloff-btns">
          {!breakDone && (
            <button className="btn btn-break" onClick={() => setLeft(BREAK_SECONDS)}>
              ⏸ Take a 30s break
            </button>
          )}
          <button className="btn btn-deal" onClick={onProceed}>
            {breakDone ? '✓ Reset — deal next hand' : "I'm focused — deal anyway"}
          </button>
        </div>
      )}
    </div>
  );
}

// ICM advisory strip under the tournament banner: your prize equity in buy-ins
// (Malmuth–Harville, from engine/icm) plus a bubble / in-the-money read. Display
// only — it teaches WHY chip EV ≠ $EV without changing how the bots play.
function IcmBanner({ stacks, heroIdx, field }: { stacks: number[]; heroIdx: number; field: number }) {
  const r = icmRead(stacks, heroIdx, field);
  const chipShare = (() => {
    const total = stacks.reduce((a, b) => a + b, 0);
    return total > 0 ? (stacks[heroIdx] ?? 0) / total : 0;
  })();
  const tax = chipShare - r.equityShare; // >0 → chips worth less than linear ($ capped per place)
  return (
    <div className={`icm-banner ${r.onBubble ? 'bubble' : r.inTheMoney ? 'itm' : ''}`}>
      💠 ICM: your equity ≈ <b>{r.equityBuyins.toFixed(2)}</b> buy-ins
      {' '}<span className="muted">({(r.equityShare * 100).toFixed(0)}% of pool · {(chipShare * 100).toFixed(0)}% of chips)</span>
      {r.onBubble && <> · <b>🫧 BUBBLE</b> — one bust from the money: fold marginal spots, shove wider on shorter stacks, never call off light</>}
      {r.inTheMoney && !r.onBubble && <> · 💰 in the money — ladder value shrinks, play for the win</>}
      {!r.onBubble && !r.inTheMoney && tax > 0.02 && <> · big stack: chips above average are worth <i>less</i> per chip — pressure, don't gamble</>}
    </div>
  );
}

// Freezeout end screen: your finishing place, whether you cashed, and the payout
// (in buy-ins) — champion, runner-up, or busted while bots play on. The only way
// forward is starting a new tournament.
function TournamentEnd({ g, heroName }: { g: G; heroName: string }) {
  const heroWon = g.championName === heroName;
  // place: champion = 1, lost heads-up = 2, else the busted-out place.
  const place = heroWon ? 1 : g.tournamentOver ? 2 : g.heroPlace;
  const table = payoutTable(g.fieldSize);
  const paid = table.length; // places that cash
  const itm = place <= paid;
  const wonBuyIns = itm ? table[place - 1] * g.fieldSize : 0; // share × pool
  const net = wonBuyIns - 1; // minus your own buy-in
  const fmtNet = `${net >= 0 ? '+' : ''}${net.toFixed(2)} buy-ins`;

  return (
    <div className="tourney-end">
      {heroWon ? (
        <div className="tourney-champ win">🏆 You win the tournament — last player standing!</div>
      ) : g.tournamentOver ? (
        <div className="tourney-champ">🏁 {g.championName} takes it. You finished <b>{ordinal(2)}</b> of {g.fieldSize}.</div>
      ) : (
        <div className="tourney-champ out">
          💀 You busted — <b>{ordinal(g.heroPlace)}</b> of {g.fieldSize}. {g.playersLeft} still in.
        </div>
      )}
      <div className={`tourney-payout ${itm ? 'itm' : 'oom'}`}>
        {itm ? (
          <>
            <span className="tp-badge">💰 In the money</span>
            <span>Finished {ordinal(place)} of {g.fieldSize} · paid top {paid}</span>
            <span>Won <b>{wonBuyIns.toFixed(2)}</b> buy-ins · net <b className={net >= 0 ? 'pos' : 'neg'}>{fmtNet}</b></span>
          </>
        ) : (
          <>
            <span className="tp-badge oom">Out of the money</span>
            <span>{ordinal(place)} of {g.fieldSize} · only top {paid} cashed · net <b className="neg">−1.00 buy-ins</b></span>
          </>
        )}
      </div>
      <button className="btn btn-deal" onClick={g.resetGame}>♻ New tournament</button>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;

function StreetBreadcrumb({ street, started }: { street: string; started: boolean }) {
  // map showdown/complete back onto "river" for the indicator
  const active = street === 'preflop' || street === 'flop' || street === 'turn' ? street : 'river';
  const activeIdx = STREETS.indexOf(active as (typeof STREETS)[number]);
  if (!started) return <div className="street-tag">Press Deal</div>;
  return (
    <div className="street-breadcrumb">
      {STREETS.map((s, i) => (
        <span key={s} className={`sb-step ${i === activeIdx ? 'on' : ''} ${i < activeIdx ? 'done' : ''}`}>
          {s.toUpperCase()}
        </span>
      ))}
    </div>
  );
}

function deltaText(g: G): string {
  const last = g.history[0];
  if (!last) return '';
  const d = last.deltaBB;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)} bb`;
}

function resultDeltaClass(g: G): string {
  const last = g.history[0];
  if (!last) return '';
  return last.deltaBB > 0 ? 'pos' : last.deltaBB < 0 ? 'neg' : '';
}
