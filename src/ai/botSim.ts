// Bots-only table simulator: every seat is a bot, stacks are topped up to 100bb each hand,
// and each archetype's HUD stats are tallied the way a tracker would. It is the measuring
// stick for "does a nit play like a nit" — archetypePostflop.test.ts pins its bands, and
// _sim.test.ts prints the full table on demand (SIM=1).

import { createGame, startHand, legalActions, applyAction, type GameState } from '../engine/table';
import { makeRng } from '../engine/cards';
import { decideAction } from './decide';
import { DIFFICULTIES, type Difficulty, type DifficultyParams } from './difficulty';

export const SIM_ARCHETYPES = ['tag', 'lag', 'lp', 'maniac', 'nit', 'gto', 'reg'] as const;

/** Percentages (0..100) except `af` (bets+raises ÷ calls, postflop) and `bb100`. */
export interface ArchStats {
  vpip: number;
  pfr: number;
  threeBet: number;
  foldTo3Bet: number;
  cbet: number;
  foldToCbet: number;
  af: number;
  wtsd: number;
  wsd: number;
  foldToRaise: number;
  riverCall: number;
  bb100: number;
}

type Tally = Record<string, number>;
const blank = (): Tally => ({
  hands: 0, vpip: 0, pfr: 0, tbOpp: 0, tb: 0, f3Opp: 0, f3: 0, cbOpp: 0, cb: 0, fcbOpp: 0, fcb: 0,
  pBR: 0, pC: 0, sawF: 0, wtsd: 0, wsd: 0, net: 0, rbOpp: 0, rb: 0, frOpp: 0, fr: 0,
});

const TABLE_HANDS = 200;

/** Deck and bot randomness come from Math.random (the engine's own source) — stub it for a
 *  reproducible run. `seed` only drives the seating. */
export function simulateBots(
  diffId: Difficulty,
  hands: number,
  seed: number,
  /** e.g. `{ iters: 120 }` — a cheaper equity read for a fast pinned test */
  overrides: Partial<DifficultyParams> = {},
): Record<string, ArchStats> {
  const tally: Record<string, Tally> = Object.fromEntries(SIM_ARCHETYPES.map((a) => [a, blank()]));
  const r = makeRng(seed);
  const diff = { ...DIFFICULTIES[diffId], ...overrides };
  for (let table = 0; table < Math.ceil(hands / TABLE_HANDS); table++) {
    const seats = [...SIM_ARCHETYPES].sort(() => r() - 0.5).slice(0, 6);
    let st: GameState = createGame(6, 100, 2, seats.slice(1));
    st.players[0].isHero = false;
    st.players[0].profileId = seats[0];
    for (let h = 0; h < TABLE_HANDS; h++) playHand();

    function playHand() {
      for (const p of st.players) p.stack = 200;
      st = startHand(st);
      const start = st.players.map((p) => p.stack + p.committed);
      const prof = (i: number) => st.players[i].profileId;
      const vp = new Set<number>();
      const pr = new Set<number>();
      const sawF = new Set<number>();
      const betThisStreet = new Set<number>();
      let raises = 0;
      let pfRaiser = -1;
      let lastStreet = 'preflop';
      let flopBetMade = false;
      let cbettor = -1;
      let streetAggressor = -1;
      for (const i of st.players.keys()) tally[prof(i)].hands++;
      let guard = 0;
      while (st.street !== 'complete' && st.street !== 'showdown' && st.toAct >= 0 && guard++ < 500) {
        const i = st.toAct;
        const t = tally[prof(i)];
        const la = legalActions(st);
        const a = decideAction(st, { diff });
        const agg = a.type === 'raise' || a.type === 'bet';
        if (st.street !== lastStreet) {
          lastStreet = st.street;
          streetAggressor = -1;
          betThisStreet.clear();
          if (st.street === 'flop') for (const p of st.players) if (!p.folded) sawF.add(p.id);
        }
        if (st.street === 'preflop') {
          if (agg || a.type === 'call') vp.add(i);
          if (agg) pr.add(i);
          if (raises === 1 && i !== pfRaiser) { t.tbOpp++; if (agg) t.tb++; }
          if (raises === 2 && i === pfRaiser) { t.f3Opp++; if (a.type === 'fold') t.f3++; }
          if (agg && ++raises === 1) pfRaiser = i;
        } else {
          if (agg) t.pBR++;
          else if (a.type === 'call') t.pC++;
          if (st.street === 'flop') {
            if (i === pfRaiser && !flopBetMade && la.callAmount === 0) { t.cbOpp++; if (agg) { t.cb++; cbettor = i; } }
            if (cbettor >= 0 && i !== cbettor && la.callAmount > 0 && streetAggressor === cbettor) { t.fcbOpp++; if (a.type === 'fold') t.fcb++; }
            if (agg) flopBetMade = true;
          }
          if (betThisStreet.has(i) && la.callAmount > 0) { t.frOpp++; if (a.type === 'fold') t.fr++; }
          if (st.street === 'river' && la.callAmount > 0 && !betThisStreet.has(i)) { t.rbOpp++; if (a.type !== 'fold') t.rb++; }
          if (agg) { betThisStreet.add(i); streetAggressor = i; }
        }
        applyAction(st, a);
      }
      for (const i of vp) tally[prof(i)].vpip++;
      for (const i of pr) tally[prof(i)].pfr++;
      const contested = st.players.filter((p) => !p.folded).length > 1;
      for (const id of sawF) {
        const t = tally[prof(id)];
        t.sawF++;
        if (contested && !st.players[id].folded) {
          t.wtsd++;
          if (st.players[id].stack > start[id]) t.wsd++;
        }
      }
      st.players.forEach((p, i) => (tally[prof(i)].net += (p.stack - start[i]) / st.bigBlind));
    }
  }
  const pct = (a: number, b: number) => (b ? (100 * a) / b : NaN);
  return Object.fromEntries(
    SIM_ARCHETYPES.map((a) => {
      const t = tally[a];
      return [a, {
        vpip: pct(t.vpip, t.hands), pfr: pct(t.pfr, t.hands), threeBet: pct(t.tb, t.tbOpp), foldTo3Bet: pct(t.f3, t.f3Opp),
        cbet: pct(t.cb, t.cbOpp), foldToCbet: pct(t.fcb, t.fcbOpp), af: t.pBR / Math.max(1, t.pC), wtsd: pct(t.wtsd, t.sawF),
        wsd: pct(t.wsd, t.wtsd), foldToRaise: pct(t.fr, t.frOpp), riverCall: pct(t.rb, t.rbOpp), bb100: (100 * t.net) / t.hands,
      }];
    }),
  );
}
