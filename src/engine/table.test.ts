import { describe, it, expect } from 'vitest';
import {
  biasHoleCards,
  createGame,
  startHand,
  liveSeatCount,
  potTotal,
  tournamentLevel,
  handsToNextLevel,
  TOURNEY_HANDS_PER_LEVEL,
} from './table';
import { cardId, makeDeck, parseCard } from './cards';
import { handCode } from '../ai/preflop';

const PROFILES = ['tag', 'tag', 'tag', 'tag', 'tag'];

// Deal a specific hand number on a fresh full-stack table, so blind escalation
// can be checked at any level without stacks depleting over many real hands.
function dealHandNumber(n: number, tournament: boolean, seats = 6) {
  const g = createGame(seats, 100, 2, PROFILES.slice(0, seats - 1), tournament);
  g.handNumber = n - 1; // startHand increments to n
  return startHand(g);
}

describe('tournamentLevel / handsToNextLevel', () => {
  it('steps up every TOURNEY_HANDS_PER_LEVEL hands (hand 1 = level 0)', () => {
    expect(TOURNEY_HANDS_PER_LEVEL).toBe(5);
    expect(tournamentLevel(1)).toBe(0);
    expect(tournamentLevel(5)).toBe(0);
    expect(tournamentLevel(6)).toBe(1);
    expect(tournamentLevel(10)).toBe(1);
    expect(tournamentLevel(11)).toBe(2);
    expect(tournamentLevel(16)).toBe(3);
  });

  it('counts hands left until the blinds rise', () => {
    expect(handsToNextLevel(1)).toBe(5);
    expect(handsToNextLevel(5)).toBe(1);
    expect(handsToNextLevel(6)).toBe(5);
  });
});

describe('createGame', () => {
  it('starts everyone on an equal stack with clean blind/ante state', () => {
    const g = createGame(6, 100, 2, PROFILES, true);
    expect(g.players).toHaveLength(6);
    expect(g.bigBlind).toBe(2);
    expect(g.smallBlind).toBe(1);
    expect(g.baseBigBlind).toBe(2);
    expect(g.ante).toBe(0);
    expect(g.handNumber).toBe(0);
    expect(g.tournament).toBe(true);
    expect(new Set(g.players.map((p) => p.stack))).toEqual(new Set([200])); // 100bb × 2
  });
});

describe('biasHoleCards — focus borderline hands', () => {
  // A borderline hand class covering a pair, a suited hand, and an offsuit hand.
  // None use ranks 2 or 3, so a villain holding 2c/3d never blocks them and
  // placement is deterministic (biasHoleCards no-ops only if the exact cards are
  // already dealt — a best-effort fallback that random deals can trigger).
  const CODES = ['77', 'AJs', 'K9o', 'T9s', 'A5o', 'QQ', '54s'];

  // A controlled heads-up state: hero + one villain whose cards can't block the
  // test codes, deck = the remaining 48. Avoids the flakiness of a random deal.
  const controlled = () => {
    const g = createGame(2, 100, 2, ['tag'], false);
    g.players[0].holeCards = [parseCard('Ah'), parseCard('Kd')];
    g.players[1].holeCards = [parseCard('2c'), parseCard('3d')];
    const out = new Set([...g.players[0].holeCards, ...g.players[1].holeCards].map(cardId));
    g.deck = makeDeck().filter((c) => !out.has(cardId(c)));
    return g;
  };

  it('gives the hero the requested hand class and keeps the deck valid', () => {
    for (const code of CODES) {
      const g = controlled();
      biasHoleCards(g, 0, code);
      // hero holds exactly the requested class
      expect(g.players[0].holeCards).toHaveLength(2);
      expect(handCode(g.players[0].holeCards)).toBe(code);
      // deck + every hole card together form the full 52-card deck, no duplicates
      const all = [...g.deck, ...g.players.flatMap((p) => p.holeCards)];
      const ids = all.map(cardId);
      expect(ids).toHaveLength(52);
      expect(new Set(ids).size).toBe(52);
    }
  });

  it('never collides the hero hand with another seat or the board', () => {
    const g = dealHandNumber(1, false);
    biasHoleCards(g, 0, 'AKs');
    const heroIds = new Set(g.players[0].holeCards.map(cardId));
    // no other seat holds a hero card, and the deck (future board) is disjoint too
    for (let i = 1; i < g.players.length; i++) {
      for (const c of g.players[i].holeCards) expect(heroIds.has(cardId(c))).toBe(false);
    }
    for (const c of g.deck) expect(heroIds.has(cardId(c))).toBe(false);
  });

  it('is a no-op when the hero has no cards (folded/sitting out)', () => {
    const g = dealHandNumber(1, false);
    g.players[0].holeCards = [];
    const deckLen = g.deck.length;
    biasHoleCards(g, 0, 'AA');
    expect(g.players[0].holeCards).toHaveLength(0);
    expect(g.deck).toHaveLength(deckLen);
  });
});

describe('startHand — blinds', () => {
  it('posts SB/BB and sets the current bet to the big blind (6-max)', () => {
    const g = dealHandNumber(1, false);
    // button advances to seat 0 → SB seat 1, BB seat 2
    expect(g.players[1].committed).toBe(g.smallBlind);
    expect(g.players[2].committed).toBe(g.bigBlind);
    expect(g.currentBet).toBe(g.bigBlind);
    expect(potTotal(g)).toBe(g.smallBlind + g.bigBlind);
  });

  it('heads-up: the button posts the small blind', () => {
    const g = dealHandNumber(1, false, 2);
    // 2 seats, button advances to seat 0 → button == SB
    expect(g.players[0].committed).toBe(g.smallBlind);
    expect(g.players[1].committed).toBe(g.bigBlind);
  });
});

describe('startHand — tournament blind escalation', () => {
  it('scales the big blind by the level multiplier', () => {
    expect(dealHandNumber(1, true).bigBlind).toBe(2); // level 0 → ×1
    expect(dealHandNumber(6, true).bigBlind).toBe(4); // level 1 → ×2
    expect(dealHandNumber(11, true).bigBlind).toBe(6); // level 2 → ×3
    expect(dealHandNumber(16, true).bigBlind).toBe(10); // level 3 → ×5
  });

  it('keeps the small blind at half the big blind', () => {
    const g = dealHandNumber(16, true);
    expect(g.smallBlind).toBe(5);
  });

  it('never escalates in cash mode, no matter how many hands pass', () => {
    const g = dealHandNumber(40, false);
    expect(g.bigBlind).toBe(2);
    expect(g.ante).toBe(0);
  });
});

describe('startHand — antes', () => {
  it('are zero before the ante level (level 0-2)', () => {
    expect(dealHandNumber(1, true).ante).toBe(0);
    expect(dealHandNumber(15, true).ante).toBe(0);
  });

  it('kick in at level 3 as roughly an eighth of the big blind', () => {
    const g = dealHandNumber(16, true); // bb 10 → ante round(10/8) = 1
    expect(g.ante).toBe(1);
  });

  it('are dead money: in the pot but the current bet stays at the big blind', () => {
    const g = dealHandNumber(16, true);
    // pot = SB + BB + one ante per live seat (all 6 alive)
    expect(potTotal(g)).toBe(g.smallBlind + g.bigBlind + g.ante * 6);
    expect(g.currentBet).toBe(g.bigBlind);
  });
});

describe('liveSeatCount', () => {
  it('counts only seats that still hold chips', () => {
    const g = createGame(6, 100, 2, PROFILES, true);
    expect(liveSeatCount(g)).toBe(6);
    g.players[3].stack = 0;
    g.players[4].stack = 0;
    expect(liveSeatCount(g)).toBe(4);
  });
});
