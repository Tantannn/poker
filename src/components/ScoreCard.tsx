// Live session scorecard (GTOW-style): hands, moves, weighted score, the
// five decision tiers, and EV-loss totals. Reads the running SessionStats.

import { useState } from 'react';
import type { SessionStats } from '../store/stats';
import { scoreBuckets, gtowScore, totalEvLoss, avgEvLossPerHand } from '../store/stats';
import { isSoundEnabled, setSoundEnabled } from '../sound';

interface Props {
  stats: SessionStats;
  onReset: () => void;
}

const TIERS: { key: keyof ReturnType<typeof scoreBuckets>; label: string; cls: string }[] = [
  { key: 'best', label: 'Best move', cls: 'best' },
  { key: 'correct', label: 'Correct move', cls: 'correct' },
  { key: 'inaccuracy', label: 'Inaccuracy', cls: 'inacc' },
  { key: 'wrong', label: 'Wrong move', cls: 'wrong' },
  { key: 'blunder', label: 'Blunder', cls: 'blunder' },
];

export function ScoreCard({ stats, onReset }: Props) {
  const [sound, setSound] = useState(isSoundEnabled());
  const buckets = scoreBuckets(stats);
  const score = gtowScore(stats);
  const evLoss = totalEvLoss(stats);
  const avgLoss = avgEvLossPerHand(stats);
  const scoreCls = score >= 85 ? 'good' : score >= 65 ? 'okv' : 'bad';

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
  };

  return (
    <div className="scorecard">
      <div className="hud-head">
        <span>🎯 Session score</span>
        <div className="strat-head-btns">
          <button className="toggle" onClick={toggleSound} title="Toggle sound effects">
            {sound ? '🔊' : '🔇'}
          </button>
          <button className="toggle" onClick={onReset} title="Reset session stats">
            Reset
          </button>
        </div>
      </div>

      <div className="sc-top">
        <div className="sc-counts">
          <div className="sc-count">
            <div className="sc-num">{stats.handsPlayed}</div>
            <div className="sc-lbl">Hands</div>
          </div>
          <div className="sc-count">
            <div className="sc-num">{buckets.moves}</div>
            <div className="sc-lbl">Moves</div>
          </div>
        </div>
        <div className={`sc-score ${scoreCls}`}>
          <div className="sc-score-num">{score}%</div>
          <div className="sc-lbl">GTOW Score</div>
        </div>
      </div>

      <div className="sc-tiers">
        {TIERS.map((t) => (
          <div key={t.key} className={`sc-tier ${t.cls}`}>
            <span className="sc-tier-dot" />
            <span className="sc-tier-lbl">{t.label}</span>
            <span className="sc-tier-num">{buckets[t.key]}</span>
          </div>
        ))}
      </div>

      <div className="sc-ev">
        <div className="hud-row">
          <span>Total EV loss</span>
          <b>{evLoss.toFixed(2)} bb</b>
        </div>
        <div className="hud-row">
          <span>Avg. EV loss / hand</span>
          <b>{avgLoss.toFixed(2)} bb</b>
        </div>
      </div>
    </div>
  );
}
