import { useMemo, useState } from 'react';
import { useGame, type HeroPositionPref, type Speed } from '../hooks/useGame';
import { tablePositions } from '../engine/table';
import { PROFILE_LIST } from '../ai/profiles';
import { DIFFICULTY_LIST } from '../ai/difficulty';
import { coachDrill } from '../analysis/coach';

type G = ReturnType<typeof useGame>;

const POSITIONS: HeroPositionPref[] = ['random', 'UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const SPEEDS: Speed[] = ['1x', '2x', 'instant'];
const STACKS = [50, 100, 200];
// seat counts: 6-max down to heads-up
const TABLE_SIZES: { n: number; label: string }[] = [
  { n: 6, label: '6-max' },
  { n: 5, label: '5-max' },
  { n: 4, label: '4-max' },
  { n: 3, label: '3-max' },
  { n: 2, label: 'HU' },
];

export function ScenarioBar({ g }: { g: G }) {
  const [open, setOpen] = useState(false);
  // coach chip dismissal — per suggestion, so a new leak shows a new chip
  const [dismissed, setDismissed] = useState<string | null>(null);
  const handInProgress = g.game.handNumber > 0 && !g.handOver;
  // which seat labels actually exist at the current table size
  const validSeats = new Set(tablePositions(g.tableSize));
  // leak-targeted drill suggestion from the analytics engine
  const drill = useMemo(() => coachDrill(g.leaks), [g.leaks]);

  return (
    <div className="scenario-bar">
      <div className="sc-row">
        <span className="sc-label">Players:</span>
        <div className="sc-btns">
          {TABLE_SIZES.map((t) => (
            <button
              key={t.n}
              className={g.tableSize === t.n ? 'active' : ''}
              onClick={() => g.applyTableSize(t.n)}
              disabled={handInProgress}
              title={handInProgress ? 'Applies after this hand' : ''}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="sc-label sc-speed-label">Your seat:</span>
        <div className="sc-btns">
          {POSITIONS.map((p) => {
            // a position the current table size doesn't have (e.g. MP at 4-max)
            const unavailable = p !== 'random' && !validSeats.has(p);
            return (
              <button
                key={p}
                className={g.scenario === p ? 'active' : ''}
                onClick={() => g.setScenario(p)}
                disabled={handInProgress || unavailable}
                title={unavailable ? `No ${p} seat at ${g.tableSize}-handed` : handInProgress ? 'Applies next hand' : ''}
              >
                {p === 'random' ? 'Random' : p}
              </button>
            );
          })}
        </div>
        <span className="sc-label sc-speed-label">Speed:</span>
        <div className="sc-btns">
          {SPEEDS.map((s) => (
            <button key={s} className={g.speed === s ? 'active' : ''} onClick={() => g.setSpeed(s)}>
              {s === 'instant' ? 'Instant' : s}
            </button>
          ))}
        </div>
        <span className="sc-label sc-speed-label">Stack:</span>
        <div className="sc-btns">
          {STACKS.map((s) => (
            <button
              key={s}
              className={g.stackDepth === s ? 'active' : ''}
              onClick={() => g.applyStackDepth(s)}
              disabled={handInProgress}
              title={handInProgress ? 'Applies after this hand' : ''}
            >
              {s}bb
            </button>
          ))}
        </div>
        <span className="sc-label sc-speed-label">Bots:</span>
        <div className="sc-btns">
          {DIFFICULTY_LIST.map((d) => (
            <button
              key={d.id}
              className={g.difficulty === d.id ? 'active' : ''}
              onClick={() => g.setDifficulty(d.id)}
              title={d.blurb}
            >
              {d.label}
            </button>
          ))}
        </div>
        <label className="sc-check" title="When you fold, watch the bots finish the hand instead of skipping to the result">
          <input type="checkbox" checked={g.watchAfterFold} onChange={(e) => g.setWatchAfterFold(e.target.checked)} />
          Watch after fold
        </label>
        <label className="sc-check" title="Show the tilt-pressure banner and the post-swing cool-off gate. Off = no warnings and Repeat Hand stays available after a big swing">
          <input type="checkbox" checked={g.tiltWarnings} onChange={(e) => g.setTiltWarnings(e.target.checked)} />
          Tilt warnings
        </label>
        <label className="sc-check" title="Hide who the bots are — build your own read from their stats (VPIP/PFR/AF) and guess each villain's archetype. Guessing reveals the answer.">
          <input type="checkbox" checked={g.anonymousVillains} onChange={(e) => g.setAnonymousVillains(e.target.checked)} />
          Anonymous villains
        </label>
        <label className="sc-check" title="Bias your dealt hole cards toward mixed / range-edge hands so more spots are close decisions. Weights the preflop spot only — the hand still plays out fully.">
          <input type="checkbox" checked={g.edgeFocus} onChange={(e) => g.setEdgeFocus(e.target.checked)} />
          🎯 Focus borderline hands
        </label>
        {!g.isTournament && (
          <label className="sc-check" title="When any seat busts to 0, the next deal starts fresh equal stacks instead of the standard cash rebuy — keeps a drill table even.">
            <input type="checkbox" checked={g.autoResetOnBust} onChange={(e) => g.setAutoResetOnBust(e.target.checked)} />
            ♻ Reset on bust
          </label>
        )}
        <button className="sc-config-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide opponents' : 'Configure opponents'}
        </button>
      </div>

      {drill && dismissed !== drill.leak && (
        <div className="sc-coach">
          <span className="sc-coach-msg">🎯 Coach: {drill.why}</span>
          <button
            className="sc-coach-apply"
            disabled={handInProgress}
            title="Sets the villains, their skill, and your seat to drill this leak"
            onClick={() => {
              g.applyProfiles(drill.profiles);
              g.setSeatDiffs(drill.seatDiffs);
              g.setScenario(drill.scenario as HeroPositionPref);
            }}
          >
            Set up drill table
          </button>
          <button className="sc-coach-dismiss" onClick={() => setDismissed(drill.leak)} title="Hide this suggestion">
            ✕
          </button>
        </div>
      )}

      {open && (
        <div className="sc-opponents">
          <p className="sc-hint">
            Set each opponent's archetype and skill (archetype applies on the next hand). A mixed table —
            one fish, a couple of regs, a shark — plays like a real game: adjust per villain, not per table.
          </p>
          <div className="sc-presets">
            <span>Quick fill:</span>
            <button onClick={() => g.applyProfiles(['tag', 'tag', 'gto', 'gto', 'nit'])} disabled={handInProgress}>
              Reg-heavy
            </button>
            <button onClick={() => g.applyProfiles(['lp', 'lp', 'maniac', 'lag', 'lp'])} disabled={handInProgress}>
              Loose/wild
            </button>
            <button onClick={() => g.applyProfiles(['gto', 'gto', 'gto', 'gto', 'gto'])} disabled={handInProgress}>
              All GTO
            </button>
            <button onClick={() => g.applyProfiles(['tag', 'lag', 'lp', 'maniac', 'gto'])} disabled={handInProgress}>
              Mixed
            </button>
            <button
              onClick={() => {
                // realistic low-stakes lineup: a fish, regs of mixed skill, one shark
                g.applyProfiles(['lp', 'tag', 'maniac', 'gto', 'nit']);
                g.setSeatDiffs(['easy', 'hard', 'normal', 'extreme', 'normal']);
              }}
              disabled={handInProgress}
              title="Fish + mixed-skill regs + a shark — like a real table"
            >
              Real table
            </button>
          </div>
          <div className="sc-seat-grid">
            {g.profiles.slice(0, Math.max(0, g.tableSize - 1)).map((pid, idx) => (
              <label key={idx} className="sc-seat">
                <span>Seat {idx + 1}</span>
                <select
                  value={pid}
                  disabled={handInProgress}
                  onChange={(e) => {
                    const next = [...g.profiles];
                    next[idx] = e.target.value;
                    g.applyProfiles(next);
                  }}
                >
                  {PROFILE_LIST.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  value={g.seatDiffs[idx] ?? ''}
                  title="This seat's skill — overrides the table-wide Bots setting"
                  onChange={(e) => {
                    const next = [...g.seatDiffs];
                    while (next.length <= idx) next.push('');
                    next[idx] = e.target.value;
                    g.setSeatDiffs(next);
                  }}
                >
                  <option value="">Table skill</option>
                  {DIFFICULTY_LIST.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
