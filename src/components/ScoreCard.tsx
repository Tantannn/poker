// Live session scorecard (GTOW-style): hands, moves, weighted score, the
// five decision tiers, and EV-loss totals. Reads the running SessionStats.

import { useState } from 'react';
import type { SessionStats } from '../store/stats';
import { scoreBuckets, gtowScore, totalEvLoss, avgEvLossPerHand, downswing, bbPer100, moneyStats } from '../store/stats';
import { isSoundEnabled, setSoundEnabled } from '../sound';
import { CalcLabel } from './CalcTip';

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
  const ds = downswing(stats);
  const winrate = bbPer100(stats);
  const money = moneyStats(stats);
  const enoughMoney = money.winHands >= 5 && money.lossHands >= 5;
  const bleedy = enoughMoney && money.ratio >= 1.3;
  const moneyNote = !enoughMoney
    ? 'Play more hands for a read on your win/loss sizing.'
    : bleedy
      ? `You lose ${money.ratio.toFixed(1)}× bigger than you win (avg −${money.avgLoss.toFixed(1)} vs +${money.avgWin.toFixed(1)} bb). That's the big-pot bleed — marrying hands and calling down. The fix is smaller losses in the pots you're behind, not more volume.`
      : `Win and loss sizes are balanced (avg +${money.avgWin.toFixed(1)} vs −${money.avgLoss.toFixed(1)} bb) — no big-pot bleed. 👍`;
  const dsNote =
    stats.handsPlayed < 15
      ? 'Play more hands for a meaningful read on your swings.'
      : ds.currentBB > Math.max(150, ds.stdPer100 * 2)
        ? 'You are in a downswing — normal variance, not necessarily bad play. Judge skill by EV loss above, not by net.'
        : 'Swings of this size are normal variance. Judge skill by EV loss, not by net result.';

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
            <div className="sc-num">{(stats.movesTotal ?? buckets.moves).toLocaleString()}</div>
            <div className="sc-lbl" title={`Lifetime moves. The GTOW score is weighted over your most recent ${buckets.moves} of them.`}>Moves</div>
          </div>
        </div>
        <div className={`sc-score ${scoreCls}`}>
          <div className="sc-score-num">{score}%</div>
          <div className="sc-lbl"><CalcLabel id="gtowScore" pos="bottom">GTOW Score</CalcLabel></div>
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
          <CalcLabel id="evLoss">Total EV loss</CalcLabel>
          <b>{evLoss.toFixed(2)} bb</b>
        </div>
        <div className="hud-row">
          <CalcLabel id="evLoss">Avg. EV loss / hand</CalcLabel>
          <b>{avgLoss.toFixed(2)} bb</b>
        </div>
      </div>

      <div className="sc-variance">
        <div className="hud-row">
          <CalcLabel id="netBB">Net result</CalcLabel>
          <b className={stats.netBB > 0 ? 'good' : stats.netBB < 0 ? 'bad' : ''}>
            {stats.netBB >= 0 ? '+' : ''}{stats.netBB.toFixed(0)} bb
            <span className="sc-sub"> ({winrate >= 0 ? '+' : ''}{winrate.toFixed(0)} bb/100)</span>
          </b>
        </div>
        <div className="hud-row">
          <span className="tip-label" title="How far below your session peak you are right now (1 buy-in = 100bb)">
            Current downswing
          </span>
          <b className={ds.currentBB > 0 ? 'bad' : ''}>
            {ds.currentBB.toFixed(0)} bb{ds.currentBB > 0 ? ` (${ds.buyins.toFixed(1)} buy-ins)` : ''}
          </b>
        </div>
        <div className="hud-row">
          <span className="tip-label" title="Worst peak-to-trough drop you have ridden through this session">
            Worst downswing
          </span>
          <b>{ds.maxBB.toFixed(0)} bb</b>
        </div>
        <div className="hud-row">
          <span className="tip-label" title="Standard deviation per 100 hands — how big your normal swings are. Higher = bumpier ride.">
            Swing size (bb/100)
          </span>
          <b>{ds.stdPer100.toFixed(0)}</b>
        </div>
        <div className="sc-variance-note">{dsNote}</div>
      </div>

      <div className="sc-money">
        <div className="sc-money-h">Win vs loss sizing</div>
        <div className="hud-row">
          <span className="tip-label" title="Lifetime bb won across winning hands">Total won</span>
          <b className="good">+{money.won.toFixed(0)} bb</b>
        </div>
        <div className="hud-row">
          <span className="tip-label" title="Lifetime bb lost across losing hands">Total lost</span>
          <b className="bad">−{money.lost.toFixed(0)} bb</b>
        </div>
        <div className="hud-row">
          <span className="tip-label" title="Average size of a winning vs a losing hand (recent hands)">Avg win / loss</span>
          <b>
            <span className="good">+{money.avgWin.toFixed(1)}</span> / <span className="bad">−{money.avgLoss.toFixed(1)}</span> bb
          </b>
        </div>
        <div className="hud-row">
          <span className="tip-label" title="Worst single hand in the recent window">Biggest pot lost</span>
          <b className="bad">−{money.biggestLoss.toFixed(0)} bb</b>
        </div>
        <div className="hud-row">
          <span className="tip-label" title="Times your stack hit zero at hand end — a rebuy in cash, elimination in a tournament">Times busted</span>
          <b className={stats.busts > 0 ? 'bad' : ''}>{stats.busts}{stats.handsPlayed > 0 && stats.busts > 0 ? ` (1 per ${Math.round(stats.handsPlayed / stats.busts)} hands)` : ''}</b>
        </div>
        <div className={`sc-variance-note ${bleedy ? 'bad' : ''}`}>{moneyNote}</div>
      </div>
    </div>
  );
}
