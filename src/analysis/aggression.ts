// "Your aggression isn't working" detector. Watches the hand log for the leak
// the EV-per-decision grade doesn't surface directly: you keep firing BIG
// postflop bets and the bots keep CALLING or RE-RAISING — i.e. your bets buy no
// fold equity AND you're losing on those lines. That's either bluffing into a
// station (no folds) or value-owning yourself (called only by better). The fix
// is the same lesson either way: if they won't fold, stop bluffing big — value
// bet what beats their CALLING range and check your air.

import type { ActionRecord, Street } from '../engine/table';

export interface AggroWarning {
  level: 'high' | 'medium';
  headline: string;
  detail: string;
  sample: number; // # of big postflop hero bets/raises counted
  callRaiseRate: number; // fraction of them villains called OR raised (no fold)
  raiseRate: number; // fraction of them villains RE-RAISED (punished)
  netBB: number; // your net bb across the hands where you fired big
}

const RECENT_HANDS = 14; // rolling window
const BIG_PCT = 0.6; // a bet/raise ≥60% pot counts as "big"
const MIN_EPISODES = 5; // need a real sample before nagging
const POSTFLOP: Street[] = ['flop', 'turn', 'river'];

/**
 * Scan the cumulative game log (most recent RECENT_HANDS hands) for hero big
 * postflop bets/raises and how the bots responded. Returns a warning only when
 * the aggression is BOTH getting called/raised a lot AND losing money — so a
 * value bet that gets paid and wins never trips it.
 *
 * @param deltaByHand  handNumber → hero's bb result that hand (from history)
 */
export function aggressionWarning(
  log: ActionRecord[],
  deltaByHand: Map<number, number>,
  heroId = 0,
): AggroWarning | null {
  if (log.length === 0) return null;
  const maxHand = log[log.length - 1].handNumber;
  const minHand = maxHand - RECENT_HANDS + 1;

  // collect recent entries grouped by hand, preserving order (single backward
  // pass so we never touch the whole log on a long session).
  const byHand = new Map<number, ActionRecord[]>();
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.handNumber < minHand) break;
    const arr = byHand.get(e.handNumber);
    if (arr) arr.unshift(e);
    else byHand.set(e.handNumber, [e]);
  }

  let episodes = 0;
  let calledOrRaised = 0;
  let raised = 0;
  const handsWithBigBet = new Set<number>();

  for (const [hand, entries] of byHand) {
    for (let j = 1; j < entries.length; j++) {
      const e = entries[j];
      if (e.playerId !== heroId) continue;
      if (e.type !== 'bet' && e.type !== 'raise') continue;
      if (!POSTFLOP.includes(e.street)) continue;

      // size relative to the pot BEFORE this bet (potAfter deltas — each action
      // only adds its own chips, so the gap is what hero just put in).
      const potBefore = entries[j - 1].potAfter;
      const added = e.potAfter - potBefore;
      if (potBefore <= 0 || added / potBefore < BIG_PCT) continue;

      // outcome: scan villain responses on the SAME street until it comes back
      // to hero (a re-raise) or the street ends. Did anyone NOT fold?
      let responders = 0;
      let continued = false;
      let reraised = false;
      for (let k = j + 1; k < entries.length; k++) {
        const r = entries[k];
        if (r.street !== e.street) break; // street advanced
        if (r.playerId === heroId) break; // action folded back to hero
        responders++;
        if (r.type === 'raise') { reraised = true; continued = true; }
        else if (r.type === 'call') continued = true;
      }
      if (responders === 0) continue; // nobody could respond — not an episode

      episodes++;
      handsWithBigBet.add(hand);
      if (continued) calledOrRaised++;
      if (reraised) raised++;
    }
  }

  if (episodes < MIN_EPISODES) return null;

  const callRaiseRate = calledOrRaised / episodes;
  let netBB = 0;
  for (const h of handsWithBigBet) netBB += deltaByHand.get(h) ?? 0;

  // only warn when aggression buys few folds AND it's costing you.
  if (callRaiseRate < 0.7 || netBB >= 0) return null;

  const raiseRate = raised / episodes;
  const pct = Math.round(callRaiseRate * 100);
  const level: AggroWarning['level'] = callRaiseRate >= 0.85 || raiseRate >= 0.4 ? 'high' : 'medium';

  const headline =
    raiseRate >= 0.4
      ? '⚠ Your big bets keep getting raised'
      : '⚠ Your big bets aren\'t folding anyone out';

  let detail =
    `Last ${episodes} big postflop bets: villains called or raised ${pct}% of them, and you're ` +
    `${netBB.toFixed(0)} bb on those hands. Bets that never fold anyone out buy no fold equity — ` +
    `you're either bluffing a station or getting called only by better. ` +
    `Fix: value bet hands that beat their CALLING range, bet smaller for thin value, and check your air instead of barrelling.`;
  if (raiseRate >= 0.4) {
    detail +=
      ` They also RE-RAISED ${Math.round(raiseRate * 100)}% of your bets — your bluffs are getting punished and your ` +
      `thin value is running into stronger hands. Slow down, pot-control, and let them bluff into you.`;
  }

  return { level, headline, detail, sample: episodes, callRaiseRate, raiseRate, netBB };
}
