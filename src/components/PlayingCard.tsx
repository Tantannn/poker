import type { Card } from '../engine/cards';
import { rankToChar, SUIT_SYMBOLS, isRed } from '../engine/cards';

interface Props {
  card?: Card | null;
  hidden?: boolean;
  size?: 'sm' | 'md' | 'lg';
  dim?: boolean;
}

export function PlayingCard({ card, hidden, size = 'md', dim }: Props) {
  if (hidden || !card) {
    return <div className={`pcard back ${size}`} aria-label="hidden card" />;
  }
  const red = isRed(card);
  return (
    <div className={`pcard ${size} ${red ? 'red' : 'black'} ${dim ? 'dim' : ''}`}>
      <span className="r">{rankToChar(card.rank)}</span>
      <span className="s">{SUIT_SYMBOLS[card.suit]}</span>
    </div>
  );
}
