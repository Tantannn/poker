// Shared hero+board+equity display for the postflop drills (Postflop Lab and
// Bet-Sizing Drill). The two pages framed the same block slightly differently;
// this folds it into one component so the layout, texture tooltip, and the
// equity-hide affordance live in one place. The board tag text differs per
// page, so it's passed in as `boardTag`.

import type { ReactNode } from 'react';
import type { Card } from '../engine/cards';
import { describeTexture } from '../engine/board';
import { PlayingCard } from './PlayingCard';
import { InfoTip } from './CalcTip';

type Pos = 'ip' | 'oop';

const POS_TIP: Record<Pos, string> = {
  ip: 'In position you realise equity well — check back marginal hands, bet smaller and more often.',
  oop: 'Out of position you realise equity worse — check more, and polarise (bigger) when you do bet.',
};

/** Texture read tooltip; pass `pos` to also surface the in/out-of-position read. */
export function TextureTip({ board, pos }: { board: Card[]; pos?: Pos }) {
  const tex = describeTexture(board);
  return (
    <InfoTip
      content={
        <span className="tip-body">
          <b className="tip-title">Texture read · {tex.label}</b>
          <span className="tip-what">{tex.sentence}</span>
          {tex.favours && <span className="tip-remember"><b>Edge:</b> {tex.favours}</span>}
          {pos && <span className="tip-what">{POS_TIP[pos]}</span>}
        </span>
      }
    />
  );
}

export function SpotBoard(props: {
  hero: Card[];
  board: Card[];
  handLabel: string;
  boardTag: ReactNode; // text shown before the texture tip in the board's lab-tag
  equity?: number | null;
  equityHidden?: boolean; // render 🙈 instead of the number (pre-answer spoiler guard)
  posNote?: Pos; // include the position read in the texture tip
}) {
  const { hero, board, handLabel, boardTag, equity, equityHidden, posNote } = props;
  return (
    <div className="lab-board">
      <div className="lab-hero">
        <span className="lab-tag">Your hand · {handLabel}</span>
        <div className="lab-cards">{hero.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
      </div>
      <div className="lab-flop">
        <span className="lab-tag">{boardTag}<TextureTip board={board} pos={posNote} /></span>
        <div className="lab-cards">{board.map((c, i) => <PlayingCard key={i} card={c} size="lg" />)}</div>
      </div>
      {equity != null && (
        <div className="lab-eq">
          {equityHidden ? (
            <>
              <div className="big-stat dim">🙈</div>
              <div className="stat-lbl">equity hidden — read the board</div>
            </>
          ) : (
            <>
              <div className="big-stat gold">{(equity * 100).toFixed(1)}%</div>
              <div className="stat-lbl">equity vs range</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
