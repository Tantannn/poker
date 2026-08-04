// Spot generation for the Leveling War drill. Kept out of the component so the generator can
// be unit-tested without tripping react-refresh.
//
// The whole point: every answer is derived from the LIVE read pipeline (emptyObs → toStats →
// readShifts), never hand-authored. So the drill teaches exactly the thresholds the table
// applies — the sample a shift needs before it's trustworthy, the magnitude that separates a
// real adjustment from variance, and whether a fight-back is aimed at the hero. Hard-coding the
// answers would let the drill drift away from the coach and train the wrong trigger.

import type { ObsCounters, ObservedStats, ShiftAlert } from '../analysis/observed';
import { emptyObs, readShifts, toStats } from '../analysis/observed';

export type Stat = 'foldToBet' | 'betFreq';
export type CounterId = 'stop-bluff' | 'barrel-more' | 'bluffcatch' | 'take-lead' | 'keep-watching';

export interface Counter {
  id: CounterId;
  label: string;
  hint: string;
}

export const COUNTERS: Record<CounterId, Counter> = {
  'stop-bluff': {
    id: 'stop-bluff',
    label: 'Stop bluffing — value-bet bigger',
    hint: 'He stopped folding, so fold equity is gone. Get paid with made hands and check your air.',
  },
  'barrel-more': {
    id: 'barrel-more',
    label: 'Barrel wider — bluff more',
    hint: 'He tightened up under pressure, so your fold equity went up. Fire more streets.',
  },
  bluffcatch: {
    id: 'bluffcatch',
    label: 'Bluff-catch wider',
    hint: 'His betting range just got air-heavy. Stop folding medium hands to him.',
  },
  'take-lead': {
    id: 'take-lead',
    label: 'Give his bets credit, take the lead yourself',
    hint: 'He went passive, so a bet from him means something — and nobody is contesting the pots.',
  },
  'keep-watching': {
    id: 'keep-watching',
    label: 'Nothing to act on yet — keep watching',
    hint: 'Either the sample is too thin or the move is inside normal variance. Acting here is a fantasy read.',
  },
};

/** The counter a detected shift calls for. Null alert = the read isn't actionable yet. */
export function counterFor(alert: ShiftAlert | null): CounterId {
  if (!alert) return 'keep-watching';
  const rising = alert.toPct > alert.fromPct;
  if (alert.stat === 'foldToBet') return rising ? 'barrel-more' : 'stop-bluff';
  return rising ? 'bluffcatch' : 'take-lead';
}

export interface Round {
  /** lifetime baseline and windowed recent rate, in % — what the read panel would show */
  fromPct: number;
  toPct: number;
  /** decisions behind the baseline. Below the pipeline's minimum there is no shift at all. */
  sample: number;
  alert: ShiftAlert | null;
  answer: CounterId;
}

export interface Spot {
  seat: string;
  stat: Stat;
  statLabel: string;
  /** hero's own recent lead frequency, %. High = he could be countering YOU, not drifting. */
  heroAggroPct: number;
  first: Round;
  /** After the hero counters, the seat moves BACK — the re-level. Null when round 1 wasn't
   *  actionable: there is no adjustment to re-level against. */
  second: Round | null;
}

export const STAT_LABEL: Record<Stat, string> = {
  foldToBet: 'folds facing a bet',
  betFreq: 'bets when checked to',
};

const SEATS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const pick = <T,>(a: T[], rng: () => number): T => a[Math.floor(rng() * a.length)];

/** Counters whose baseline rate is `base` over `sample` decisions with the window sitting at
 *  `recent`. Run through toStats so the real sample gate decides whether a shift exists. */
function statsFor(stat: Stat, base: number, recent: number, sample: number): ObservedStats {
  const c: ObsCounters = { ...emptyObs(), hands: Math.max(sample, 6) };
  if (stat === 'foldToBet') {
    c.facedBet = sample;
    c.foldedToBet = Math.round(base * sample);
    c.foldToBetRecent = recent;
  } else {
    c.betChances = sample;
    c.betTaken = Math.round(base * sample);
    c.betFreqRecent = recent;
  }
  return toStats(c);
}

function buildRound(stat: Stat, base: number, recent: number, sample: number, heroAggro: number): Round {
  const s = statsFor(stat, base, recent, sample);
  const alert = readShifts(s, { heroAggro }).find((a) => a.stat === stat) ?? null;
  // Quote the baseline off the stats object, not `base` — toStats rounds through an integer
  // numerator, so the displayed number has to be the one the alert was computed from.
  const shown = stat === 'foldToBet' ? s.foldToBet : s.betFreq;
  return {
    fromPct: Math.round((shown ?? base) * 100),
    toPct: Math.round(recent * 100),
    sample,
    alert,
    answer: counterFor(alert),
  };
}

// Round-1 shapes, in the proportions the drill should teach. `noise` and `thin` are half the
// deck on purpose: the most expensive leveling mistake is inventing an adjustment out of four
// hands, and a drill that only ever shows real shifts trains exactly that.
type Kind = 'shift' | 'thin' | 'noise';
const KINDS: Kind[] = ['shift', 'shift', 'shift', 'thin', 'noise', 'noise'];

export function genSpot(rng: () => number = Math.random): Spot {
  const stat: Stat = rng() < 0.5 ? 'foldToBet' : 'betFreq';
  const kind = pick(KINDS, rng);
  const heroAggro = rng() < 0.5 ? 0.2 + rng() * 0.2 : 0.6 + rng() * 0.25;
  const base = stat === 'foldToBet' ? 0.4 + rng() * 0.25 : 0.4 + rng() * 0.2;
  const down = rng() < 0.5;
  const mag = kind === 'noise' ? 0.04 + rng() * 0.13 : 0.26 + rng() * 0.22;
  const recent = Math.max(0.03, Math.min(0.97, down ? base - mag : base + mag));
  const sample = kind === 'thin' ? 2 + Math.floor(rng() * 5) : 12 + Math.floor(rng() * 26);

  const first = buildRound(stat, base, recent, sample, heroAggro);
  // The re-level: he moves BACK toward where he started, now off the recent number as his
  // baseline. Deliberately large and well-sampled — this round is about spotting the reversal,
  // not about re-testing the sample gate the first round already tested.
  const second =
    first.alert == null
      ? null
      : buildRound(stat, recent, Math.max(0.05, Math.min(0.95, down ? recent + 0.32 : recent - 0.32)), 20, heroAggro);

  return {
    seat: pick(SEATS, rng),
    stat,
    statLabel: STAT_LABEL[stat],
    heroAggroPct: Math.round(heroAggro * 100),
    first,
    second: second?.alert ? second : null,
  };
}
