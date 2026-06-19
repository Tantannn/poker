import { useEffect, useState } from 'react';
import type { Action, LegalActions } from '../engine/table';

interface Props {
  legal: LegalActions;
  pot: number;
  currentBet: number;
  heroCommitted: number;
  bigBlind: number;
  onAction: (a: Action) => void;
  onSkip: () => void;
  disabled?: boolean;
}

export function Controls({ legal, pot, currentBet, heroCommitted, bigBlind, onAction, onSkip, disabled }: Props) {
  const [raiseTo, setRaiseTo] = useState(legal.minRaiseTo);

  useEffect(() => {
    setRaiseTo(clamp(legal.minRaiseTo, legal.minRaiseTo, legal.maxRaiseTo));
  }, [legal.minRaiseTo, legal.maxRaiseTo]);

  // mirrors the postflop model's sizing so the chosen amount maps to a solver option
  const sizeToFrac = (frac: number) => {
    const target =
      legal.callAmount === 0
        ? Math.round(heroCommitted + frac * pot)
        : Math.round(currentBet + frac * (pot + legal.callAmount));
    return clamp(target, legal.minRaiseTo, legal.maxRaiseTo);
  };

  const raiseWord = legal.canCall ? 'Raise' : 'Bet';

  return (
    <div className={`controls ${disabled ? 'disabled' : ''}`}>
      <div className="ctrl-row">
        <button className="btn btn-fold" disabled={disabled || !legal.canFold} onClick={() => onAction({ type: 'fold' })}>
          Fold<kbd>F</kbd>
        </button>
        {legal.canCheck ? (
          <button className="btn btn-check" disabled={disabled} onClick={() => onAction({ type: 'check' })}>
            Check<kbd>C</kbd>
          </button>
        ) : (
          <button className="btn btn-call" disabled={disabled || !legal.canCall} onClick={() => onAction({ type: 'call' })}>
            Call {legal.callAmount}
            {legal.isAllInCall && <span className="allin-tag">all-in</span>}
            <kbd>C</kbd>
          </button>
        )}
        <button
          className="btn btn-raise"
          disabled={disabled || !legal.canRaise}
          onClick={() => onAction({ type: legal.canCall ? 'raise' : 'bet', amount: raiseTo })}
        >
          {raiseWord} to {raiseTo}<kbd>R</kbd>
        </button>
      </div>

      {legal.canRaise && (
        <div className="ctrl-raise">
          <div className="size-btns">
            <button onClick={() => setRaiseTo(sizeToFrac(0.33))}>33%</button>
            <button onClick={() => setRaiseTo(sizeToFrac(0.75))}>75%</button>
            <button onClick={() => setRaiseTo(sizeToFrac(1))}>Pot</button>
            <button onClick={() => setRaiseTo(legal.maxRaiseTo)}>All-in</button>
          </div>
          <input
            type="range"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            step={bigBlind / 2}
            value={raiseTo}
            onChange={(e) => setRaiseTo(clamp(Number(e.target.value), legal.minRaiseTo, legal.maxRaiseTo))}
          />
          <input
            type="number"
            className="raise-num"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={raiseTo}
            onChange={(e) => setRaiseTo(clamp(Number(e.target.value), legal.minRaiseTo, legal.maxRaiseTo))}
          />
        </div>
      )}

      <div className="ctrl-skip">
        <button className="link-btn" onClick={onSkip} disabled={disabled}>
          Fold &amp; skip to next hand →
        </button>
      </div>
    </div>
  );
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
