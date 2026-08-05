// "Spot the read" — the live-table half of the exploit loop.
//
// The engine's exploits all come from six numbers, but a player at a casino has no
// HUD: he has to build them by WATCHING. Each row here is one thing you can actually
// see from your seat, tied to the number it moves and the line it changes, so ticking
// what you observed assembles a node lock instead of a vibe.
//
// Values are deliberately coarse (one "wide" number, one "tight" number per stat).
// A tell is evidence that a rate is far from balanced, not a measurement of it —
// pretending otherwise would teach false precision, and the sliders underneath are
// there for anyone who wants to fine-tune.

import { useState } from 'react';
import type { VillainLock } from '../strategy/villainModel';

type Knob = 'openFreq' | 'threeBetFreq' | 'foldToThreeBet' | 'foldToBet' | 'betFreq' | 'foldToRaise';

interface Tell {
  id: string;
  street: 'pre' | 'post';
  /** what you literally see him do */
  seen: string;
  /** what it says about him, and what it changes for you */
  means: string;
  sets: Partial<Record<Knob, number>>;
}

const BALANCED: Record<Knob, number> = {
  openFreq: 0.26,
  threeBetFreq: 0.08,
  foldToThreeBet: 0.55,
  foldToBet: 0.45,
  betFreq: 0.55,
  foldToRaise: 0.28,
};

const TELLS: Tell[] = [
  {
    id: 'opens-wide',
    street: 'pre',
    seen: 'Raises first in twice or more in one orbit — including from early seats',
    means: 'His opening range is weak on average, so your defence gets cheaper. Flat more, and 3-bet the hands that dominate his junk.',
    sets: { openFreq: 0.44 },
  },
  {
    id: 'opens-tight',
    street: 'pre',
    seen: 'A full orbit (or two) with no raise-first-in — he limps or folds instead',
    means: "His raise is a real range. Fold your marginal defends and stop bluff-3-betting him — you're only ever running into a hand.",
    sets: { openFreq: 0.13 },
  },
  {
    id: 'limps',
    street: 'pre',
    seen: 'Open-limps regularly, then calls a raise behind him',
    means: 'Classic low-stakes recreational. He rarely raises first in, and his calling range is wide and weak — isolate him wide in position and value-bet relentlessly postflop.',
    sets: { openFreq: 0.12, foldToBet: 0.3 },
  },
  {
    id: 'threebets-often',
    street: 'pre',
    seen: 'Has re-raised an open more than once in the last orbit',
    means: "He's 3-betting hands the chart has him folding, so his re-raise is not a premium. 4-bet him for value wider and stop folding your good-but-not-great hands.",
    sets: { threeBetFreq: 0.16 },
  },
  {
    id: 'threebets-never',
    street: 'pre',
    seen: 'Has never re-raised an open — he only cold-calls',
    means: 'When he finally 3-bets, it is the top of his range. Fold the marginal continues and never 4-bet-bluff him.',
    sets: { threeBetFreq: 0.035 },
  },
  {
    id: 'folds-open-to-3bet',
    street: 'pre',
    seen: 'Has folded his own open to a 3-bet (any time you saw it)',
    means: 'Fold equity preflop. Light 3-bets print against his opens — the exploit lives in the hands just below the chart threshold, not in junk.',
    sets: { foldToThreeBet: 0.72 },
  },
  {
    id: 'never-folds-open',
    street: 'pre',
    seen: 'Calls or 4-bets every 3-bet — never gives up his open',
    means: 'No fold equity preflop. 3-bet him for value only, and expect to play a big pot out of position when you do.',
    sets: { foldToThreeBet: 0.3 },
  },
  {
    id: 'fit-or-fold',
    street: 'post',
    seen: 'Folds the flop to a c-bet when he misses — gives up quickly',
    means: 'Your bluffs print and your thin value stops getting paid. Bet more flops, smaller, and value-bet only what beats a real hand.',
    sets: { foldToBet: 0.62 },
  },
  {
    id: 'station',
    street: 'post',
    seen: 'Calls a street with any pair — "I have to see it"',
    means: 'A calling station. Stop bluffing entirely, and value-bet two streets thinner than feels comfortable — that is where the money is.',
    sets: { foldToBet: 0.28, foldToRaise: 0.12 },
  },
  {
    id: 'stabs',
    street: 'post',
    seen: 'Bets almost every pot that gets checked to him',
    means: 'His betting range is air-heavy, so your bluff-catchers go up in value. Check-call more, and check-raise him with your strong hands.',
    sets: { betFreq: 0.75 },
  },
  {
    id: 'passive',
    street: 'post',
    seen: 'Checks back a lot when checked to — only bets when he has it',
    means: 'His bet means a hand. Fold your bluff-catchers to it and take the free cards he gives you.',
    sets: { betFreq: 0.35 },
  },
  {
    id: 'folds-to-raise',
    street: 'post',
    seen: 'His bet got raised and he folded',
    means: 'Raising his bets is the highest-EV bluff you have — he prices it himself. The engine reads your raise off this number directly.',
    sets: { foldToRaise: 0.5 },
  },
  {
    id: 'barrels',
    street: 'post',
    seen: 'Fires flop, turn and river a lot — barrels through',
    means: 'No range holds enough value hands to fire three streets that often, so his river bet is bluff-heavy. Call down with bluff-catchers instead of folding them.',
    sets: { betFreq: 0.72, foldToBet: 0.5 },
  },
];

const KNOB_LABEL: Record<Knob, string> = {
  openFreq: 'Opens (RFI)',
  threeBetFreq: '3-bets',
  foldToThreeBet: 'Folds open to 3-bet',
  foldToBet: 'Folds to a bet',
  betFreq: 'Bets when checked to',
  foldToRaise: 'Folds when raised',
};

/** Average the ticked assertions per knob. Two tells that disagree about the same
 *  knob land near balanced, which is the honest answer: you have seen him do both. */
function mergeTells(ticked: Set<string>): { values: Partial<Record<Knob, number>>; conflicts: Knob[] } {
  const buckets = new Map<Knob, number[]>();
  for (const t of TELLS) {
    if (!ticked.has(t.id)) continue;
    for (const [k, v] of Object.entries(t.sets) as [Knob, number][]) {
      buckets.set(k, [...(buckets.get(k) ?? []), v]);
    }
  }
  const values: Partial<Record<Knob, number>> = {};
  const conflicts: Knob[] = [];
  for (const [k, vs] of buckets) {
    values[k] = vs.reduce((a, b) => a + b, 0) / vs.length;
    const above = vs.some((v) => v - BALANCED[k] > 0.08);
    const below = vs.some((v) => BALANCED[k] - v > 0.08);
    if (above && below) conflicts.push(k);
  }
  return { values, conflicts };
}

/** Name the shape the ticked boxes describe. Identification is the skill being
 *  trained, so the label is derived from the same numbers the engine uses rather
 *  than from the bot's hidden archetype. */
function archetypeOf(v: Partial<Record<Knob, number>>): { name: string; plan: string } | null {
  const open = v.openFreq;
  const three = v.threeBetFreq;
  const fold = v.foldToBet;
  if (fold != null && fold <= 0.33)
    return {
      name: 'Calling station',
      plan: 'Never bluff him. Value-bet one street thinner than usual and size UP — he pays the same price either way.',
    };
  if (open != null && open <= 0.17 && (three == null || three <= 0.06))
    return { name: 'Nit', plan: 'Steal his blinds relentlessly, fold to his aggression, and never pay off his big bets.' };
  if ((open != null && open >= 0.38) || (three != null && three >= 0.14))
    return {
      name: 'LAG / maniac',
      plan: 'Let him bluff. Widen your calls, trap with strong hands, and stop trying to out-aggress him.',
    };
  if (fold != null && fold >= 0.58)
    return { name: 'Fit-or-fold reg', plan: 'C-bet everything, barrel turns, and give up only when he actually raises.' };
  if (open != null && open >= 0.2 && open <= 0.34 && fold != null && fold >= 0.4)
    return { name: 'TAG', plan: 'Few free edges. Attack the specific spot he is off — his turn give-ups and his fold-to-raise.' };
  return null;
}

interface Props {
  lock?: VillainLock | null;
  onLock: (lock: VillainLock | null) => void;
}

export function PlayerReadChecklist({ lock, onLock }: Props) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const { values, conflicts } = mergeTells(ticked);
  const entries = Object.entries(values) as [Knob, number][];
  const archetype = archetypeOf(values);

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = () => onLock({ ...(lock ?? {}), ...values, enabled: true });

  return (
    <div className="read-check">
      <div className="read-check-head">
        <span className="opp-exploit-lbl">🔎 Spot the read</span>
        <button className="toggle" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Open checklist'}
        </button>
      </div>

      {!open ? (
        <div className="gp-muted">
          No HUD at a live table — tick what you have actually watched him do and it becomes a node lock.
        </div>
      ) : (
        <>
          <div className="read-check-intro gp-muted">
            Watch <b>one seat per orbit</b>, not the whole table. Two tells about the same habit beat six
            guesses. Tick only what you have <b>seen</b> — an unticked box costs you nothing, a wrong one
            makes the engine confidently wrong.
          </div>

          <div className="read-check-group">
            <span className="read-check-group-lbl">Before the flop</span>
            {TELLS.filter((t) => t.street === 'pre').map((t) => (
              <TellRow key={t.id} t={t} on={ticked.has(t.id)} onToggle={() => toggle(t.id)} />
            ))}
          </div>

          <div className="read-check-group">
            <span className="read-check-group-lbl">After the flop</span>
            {TELLS.filter((t) => t.street === 'post').map((t) => (
              <TellRow key={t.id} t={t} on={ticked.has(t.id)} onToggle={() => toggle(t.id)} />
            ))}
          </div>

          {entries.length > 0 && (
            <div className="read-check-out">
              <span className="read-check-out-lbl">This adds up to</span>
              {archetype && (
                <div className="read-check-arch">
                  <b>{archetype.name}</b> — {archetype.plan}
                </div>
              )}
              <div className="read-check-nums">
                {entries.map(([k, v]) => (
                  <span key={k} className={`read-check-num ${v > BALANCED[k] ? 'up' : 'down'}`}>
                    {KNOB_LABEL[k]} <b>{Math.round(v * 100)}%</b>
                    <i> (bal {Math.round(BALANCED[k] * 100)}%)</i>
                  </span>
                ))}
              </div>
              {conflicts.length > 0 && (
                <div className="read-check-conflict">
                  ⚠ You ticked opposite tells for {conflicts.map((k) => KNOB_LABEL[k]).join(', ')} — the read
                  lands back near balanced. That is the right answer if he really does both; otherwise keep the
                  one you saw most recently.
                </div>
              )}
              <div className="read-check-btns">
                <button className="toggle" onClick={apply}>
                  🔒 Solve against this read
                </button>
                <button className="toggle" onClick={() => setTicked(new Set())}>
                  Clear ticks
                </button>
              </div>
              <div className="gp-muted">
                Applying sets the sliders below; anything you didn't tick keeps whatever the table has already
                shown you.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TellRow({ t, on, onToggle }: { t: Tell; on: boolean; onToggle: () => void }) {
  return (
    <label className={`read-check-row ${on ? 'on' : ''}`}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <span className="read-check-text">
        <span className="read-check-seen">{t.seen}</span>
        <span className="read-check-means">{t.means}</span>
      </span>
    </label>
  );
}
