import { useEffect, useState } from 'react';
import { useGame, NUM_PLAYERS, BIG_BLIND } from '../hooks/useGame';
import { positionLabel } from '../engine/table';
import { getProfile } from '../ai/profiles';
import { Seat } from './Seat';
import { PlayingCard } from './PlayingCard';
import { Controls } from './Controls';
import { Hud } from './Hud';
import { StrategyPanel } from './StrategyPanel';
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
              <div className="street-tag">{started ? game.street.toUpperCase() : 'Press Deal'}</div>
            </div>

            {game.players.map((p) => (
              <Seat
                key={p.id}
                player={p}
                position={positionLabel(p.id, game.buttonIndex, NUM_PLAYERS)}
                isButton={p.id === game.buttonIndex && started}
                isToAct={game.toAct === p.id && !handOver}
                reveal={reveal}
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
                </div>
              )}
              <button className="btn btn-deal" onClick={g.deal}>
                {started ? 'Next Hand' : 'Deal Hand'} <kbd>Space</kbd>
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
          ) : (
            <div className="waiting">Opponents acting…</div>
          )}
          <Feedback fb={feedback} />
        </div>
      </div>

      <div className="hud-col">
        <Hud hud={hud} loading={hudLoading} street={game.street} enabled={hudEnabled} onToggle={onToggleHud} />
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
        <div className="mini-tips">
          <h4>How feedback works</h4>
          <ul>
            <li><b>Equity vs range</b> = win% against villain's whole realistic range (Monte-Carlo).</li>
            <li><b>Solver strategy</b> = per-action frequency &amp; EV from the heuristic model.</li>
            <li><b>RNG roll</b> tells you which branch of a mixed strategy to take.</li>
            <li>Each action is scored by <b>EV loss</b> (bb) vs the best line — tracked in Analytics.</li>
          </ul>
        </div>
      </div>
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
