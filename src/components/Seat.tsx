import type { Player, Position } from '../engine/table';
import { PlayingCard } from './PlayingCard';
import { BIG_BLIND } from '../hooks/useGame';

interface Props {
  player: Player;
  position: Position;
  isButton: boolean;
  isToAct: boolean;
  reveal: boolean;
  isWinner: boolean;
  profileName?: string;
  slot: number;
}

export function Seat({ player, position, isButton, isToAct, reveal, isWinner, profileName, slot }: Props) {
  const showCards = player.isHero || reveal;
  const folded = player.folded;
  // hero's own cards are shown larger for readability; opponents stay small
  const cardSize = player.isHero ? 'md' : 'sm';
  return (
    <div className={`seat slot-${slot} ${player.isHero ? 'hero-seat' : ''} ${isToAct ? 'active' : ''} ${folded ? 'folded' : ''} ${isWinner ? 'winner' : ''}`}>
      <div className="seat-cards">
        {player.holeCards.length === 0 ? (
          <>
            <div className={`pcard placeholder ${cardSize}`} />
            <div className={`pcard placeholder ${cardSize}`} />
          </>
        ) : (
          player.holeCards.map((c, i) => (
            <PlayingCard key={i} card={c} hidden={!showCards} size={cardSize} dim={folded} />
          ))
        )}
      </div>
      <div className="seat-info">
        <div className="seat-top">
          <span className="seat-name">{player.name}</span>
          <span className="seat-pos">{position}</span>
          {isButton && <span className="dealer-btn" title="Dealer button">D</span>}
        </div>
        <div className="seat-stack">
          {player.stack} <span className="muted">({(player.stack / BIG_BLIND).toFixed(0)}bb)</span>
        </div>
        {profileName && !player.isHero && <div className="seat-profile">{profileName}</div>}
        {player.lastAction && (
          <div className={`seat-action ${player.allIn ? 'allin' : ''}`}>
            {player.allIn ? 'ALL-IN' : player.lastAction}
          </div>
        )}
      </div>
      {player.committed > 0 && (
        <div className="seat-bet">
          <span className="chip-dot" /> {player.committed}
        </div>
      )}
    </div>
  );
}
