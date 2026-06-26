import { useState } from 'react';
import { useGame, type HeroPositionPref, type Speed } from '../hooks/useGame';
import { tablePositions } from '../engine/table';
import { PROFILE_LIST } from '../ai/profiles';
import { DIFFICULTY_LIST } from '../ai/difficulty';

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
  const handInProgress = g.game.handNumber > 0 && !g.handOver;
  // which seat labels actually exist at the current table size
  const validSeats = new Set(tablePositions(g.tableSize));

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
        <button className="sc-config-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide opponents' : 'Configure opponents'}
        </button>
      </div>

      {open && (
        <div className="sc-opponents">
          <p className="sc-hint">
            Set each opponent's archetype (applies on the next hand). Practice vs a maniac, a calling
            station, or a balanced GTO-ish field.
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
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
