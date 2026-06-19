import { useEffect, useState } from 'react';
import { useGame, NUM_PLAYERS, BIG_BLIND } from '../hooks/useGame';
import { positionLabel } from '../engine/table';
import { getProfile } from '../ai/profiles';
import { Seat } from './Seat';
import { PlayingCard } from './PlayingCard';
import { Controls } from './Controls';
import { Hud } from './Hud';
import { ScoreCard } from './ScoreCard';
import { StrategyPanel } from './StrategyPanel';
import { SituationPanel } from './SituationPanel';
import { OpponentPanel } from './OpponentPanel';
import { Feedback } from './Feedback';
import { ScenarioBar } from './ScenarioBar';

type G = ReturnType<typeof useGame>;

interface Props {
  g: G;
  hudEnabled: boolean;
  onToggleHud: () => void;
}

export function PokerTable({ g, hudEnabled, onToggleHud }: Props) {
  const { game, legal, isHeroTurn, handOver, feedback, hud, hudLoading, hero, pot, strategy, rng, villain } = g;
  const reveal = game.street === 'complete' || game.street === 'showdown';
  const winnerIds = new Set(game.winners.map((w) => w.playerId));
  const started = game.handNumber > 0;
  const [infoEnabled, setInfoEnabled] = useState(true);
  const [oppEnabled, setOppEnabled] = useState(true);
  const [supportsHidden, setSupportsHidden] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // let browser shortcuts (Ctrl/Cmd+C/V/F, etc.) through — don't act on them
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (handOver || !started) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          g.deal();
        }
        return;
      }
      if (!isHeroTurn) return;
      if (e.key === 'f' || e.key === 'F') g.heroAct({ type: 'fold' });
      else if (e.key === 'c' || e.key === 'C') {
        if (legal.canCheck) g.heroAct({ type: 'check' });
        else if (legal.canCall) g.heroAct({ type: 'call' });
      } else if (e.key === 'r' || e.key === 'R') {
        if (legal.canRaise) g.heroAct({ type: legal.canCall ? 'raise' : 'bet', amount: legal.minRaiseTo });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [g, legal, isHeroTurn, handOver, started]);

  return (
    <div className="play-layout">
      <div className="table-col">
        <ScenarioBar g={g} />
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
                position={positionLabel(p.id, game.buttonIndex, NUM_PLAYERS)}
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
              <div className="deal-btns">
                <button className="btn btn-deal" onClick={g.deal}>
                  {started ? 'Next Hand' : 'Deal Hand'} <kbd>Space</kbd>
                </button>
                {started && (
                  <button className="btn btn-repeat" onClick={g.repeatHand} title="Replay the same hole cards & board">
                    ↺ Repeat Hand
                  </button>
                )}
              </div>
              <button className="link-btn reset-game" onClick={g.resetGame}>
                ⟲ Reset game (fresh 100bb stacks)
              </button>
            </div>
          ) : isHeroTurn ? (
            <Controls
              legal={legal}
              pot={pot}
              currentBet={game.currentBet}
              heroCommitted={hero.committed}
              bigBlind={BIG_BLIND}
              onAction={g.heroAct}
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
          {!supportsHidden && <Feedback fb={feedback} />}
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

        {supportsHidden ? (
          <div className="guides-hidden-note">
            Pure-play mode — HUD, solver, situation &amp; opponent reads hidden. Decide blind like a real table.
            Hands play out to showdown (even after you fold) and only players who reach showdown reveal their
            cards. Your moves are still graded; the session score stays live above.
          </div>
        ) : (
          <>
            <Hud hud={hud} loading={hudLoading} street={game.street} enabled={hudEnabled} onToggle={onToggleHud} />
            <SituationPanel board={game.board} heroCards={hero.holeCards} street={game.street} active={isHeroTurn} villain={villain} />
            <StrategyPanel
              strategy={strategy}
              rng={rng}
              enabled={infoEnabled}
              loading={hudLoading}
              onToggle={() => setInfoEnabled((v) => !v)}
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
            <li><b>🧠 Solver</b> = per-action frequency &amp; EV; <b>ⓘ Explain</b> shows the reason + EV calc, <b>📊 Chart</b> the range.</li>
            <li><b>🎭 Opponent</b> = archetype tendencies, IP/OOP read, and how to exploit them.</li>
            <li><b>RNG roll</b> picks which branch of a mixed strategy to take; each action is scored by <b>EV loss</b> (bb).</li>
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
    </div>
  );
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
