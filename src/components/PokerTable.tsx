import { useEffect, useState } from 'react';
import { useGame, BIG_BLIND } from '../hooks/useGame';
import { positionLabel } from '../engine/table';
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
import { ScenarioBar } from './ScenarioBar';
import type { AggroWarning } from '../analysis/aggression';
import type { TiltState } from '../analysis/tilt';

type G = ReturnType<typeof useGame>;

interface Props {
  g: G;
  hudEnabled: boolean;
  onToggleHud: () => void;
}

export function PokerTable({ g, hudEnabled, onToggleHud }: Props) {
  const { game, legal, isHeroTurn, handOver, feedback, hud, hudLoading, hero, pot, strategy, rng, villain, aggroWarning, tilt } = g;
  const reveal = game.street === 'complete' || game.street === 'showdown';
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
  // a new node = a fresh hero turn; drop any peek from the previous decision.
  // Reset during render (not in an effect) on the turn-ends transition — avoids
  // the cascading-render warning from setState-in-effect.
  const [prevTurn, setPrevTurn] = useState(isHeroTurn);
  if (isHeroTurn !== prevTurn) {
    setPrevTurn(isHeroTurn);
    if (!isHeroTurn) setPeeked(false);
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
  const heroAct = (a: Parameters<typeof g.heroAct>[0]) => {
    setLastDecisionPeeked(peeked);
    g.heroAct(a);
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
      // mirror heroAct(): stamp the peek state, then act
      const act = (a: Parameters<typeof g.heroAct>[0]) => { setLastDecisionPeeked(peeked); g.heroAct(a); };
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
  }, [g, legal, isHeroTurn, handOver, started, peeked, gateActive]);

  return (
    <div className="play-layout">
      <div className="table-col">
        <ScenarioBar g={g} />
        {g.isTournament && started && (
          <div className="tourney-status">
            🏆 Tournament — <b>{g.playersLeft}</b> of {g.fieldSize} left
            {hero.stack > 0 && <> · your stack <b>{(hero.stack / BIG_BLIND).toFixed(0)}bb</b></>}
          </div>
        )}
        <TiltBanner t={tilt} />
        <AggroBanner w={aggroWarning} />
        <div className="poker-table">
          <div className="felt">
            <div className="table-center">
              <div className="pot-display">
                <span className="pot-label">POT</span>
                <span className="pot-amount">{pot}</span>
                <span className="pot-bb">{(pot / BIG_BLIND).toFixed(1)} bb</span>
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
                reveal={reveal && (!supportsHidden || !p.folded)}
                isWinner={winnerIds.has(p.id)}
                profileName={p.isHero ? undefined : getProfile(p.profileId).tag}
                slot={p.id}
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
              bigBlind={BIG_BLIND}
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

        {supportsHidden ? (
          <div className="guides-hidden-note">
            Pure-play mode — HUD, solver, situation &amp; opponent reads hidden. Decide blind like a real table.
            Hands play out to showdown (even after you fold) and only players who reach showdown reveal their
            cards. Your moves are still graded; the session score stays live above.
          </div>
        ) : (
          <>
            <Hud hud={hud} loading={hudLoading} street={game.street} enabled={hudEnabled} onToggle={onToggleHud} strategy={strategy} hideAnswer={hideAnswer} onPeek={() => setPeeked(true)} />
            <SituationPanel board={game.board} heroCards={hero.holeCards} street={game.street} active={isHeroTurn} villain={villain} />
            <StrategyPanel
              strategy={strategy}
              rng={rng}
              enabled={infoEnabled}
              loading={hudLoading}
              onToggle={() => setInfoEnabled((v) => !v)}
              heroStack={hero.stack}
              heroCommitted={hero.committed}
              hideAnswer={hideAnswer}
              onPeek={() => setPeeked(true)}
            />
            <OpponentPanel
              villain={villain}
              enabled={oppEnabled}
              loading={hudLoading}
              onToggle={() => setOppEnabled((v) => !v)}
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

// Freezeout end screen: champion (you or a bot), or your finishing place if you
// busted while bots play on. The only way forward is starting a new tournament.
function TournamentEnd({ g, heroName }: { g: G; heroName: string }) {
  const heroWon = g.championName === heroName;
  return (
    <div className="tourney-end">
      {heroWon ? (
        <div className="tourney-champ win">🏆 You win the tournament — last player standing!</div>
      ) : g.tournamentOver ? (
        <div className="tourney-champ">🏁 {g.championName} takes the tournament. You finished 2nd of {g.fieldSize}.</div>
      ) : (
        <div className="tourney-champ out">
          💀 You busted — {ordinal(g.heroPlace)} of {g.fieldSize}. {g.playersLeft} still in.
        </div>
      )}
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
