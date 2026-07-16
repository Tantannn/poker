import type { Card } from '../engine/cards';
import { rankToChar, SUIT_SYMBOLS, suitClass } from '../engine/cards';

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
  return (
    <div className={`pcard ${size} ${suitClass(card.suit)} ${dim ? 'dim' : ''}`}>
      <span className="r">{rankToChar(card.rank)}</span>
      <span className="s">{SUIT_SYMBOLS[card.suit]}</span>
    </div>
  );
}
