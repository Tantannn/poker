// Reads the opponent the hero is currently up against: archetype, key
// tendencies (as bars), their estimated range at this node, and a one-line
// exploit plan. Helps the player attach a "why" to the villain's actions.
//
// Anonymous mode hides the archetype and exploit plan — the hero sees only
// OBSERVED stats (VPIP/PFR/AF from the action log) and must guess the villain's
// type. A guess reveals the truth for that seat. This trains real profiling:
// building a read from behavior instead of being handed the answer.

import type { VillainInfo } from '../hooks/useGame';
import { getProfile, PROFILE_LIST } from '../ai/profiles';
import type { ObservedStats } from '../analysis/observed';
import { readShifts } from '../analysis/observed';
import type { VillainLock, VillainModel } from '../strategy/villainModel';

interface Props {
  villain: VillainInfo | null;
  enabled: boolean;
  onToggle: () => void;
  loading: boolean;
  /** anonymous-villains mode: hide archetype until the hero guesses it */
  anonymous?: boolean;
  /** observed stats for this villain (from the action log), for anonymous mode */
  observed?: ObservedStats | null;
  /** the hero's OWN recent lead frequency (obsCounters[0]'s betFreqRecent) — lets the
   *  "he's adjusting" read tell drift apart from LEVELING (a fight-back aimed at you). */
  heroAggro?: number | null;
  /** the hero's archetype guess for this seat (profileId), if made */
  guessedId?: string;
  onGuess?: (profileId: string) => void;
  /** the model the strategy engine is currently solving this villain against */
  model?: VillainModel | null;
  /** manual node lock for this seat, if set */
  lock?: VillainLock | null;
  /** null clears the lock */
  onLock?: (lock: VillainLock | null) => void;
}

/** What a balanced opponent does — the slider anchor, and what the engine assumes
 *  with no read. Mirrors REF in strategy/villainModel.ts. */
const BALANCED_REF = { foldToBet: 0.45, betFreq: 0.55 };

/** Preflop equivalents — mirrors PF_BALANCED in strategy/preflopModel.ts. */
const PF_REF = { openFreq: 0.26, threeBetFreq: 0.08, foldToThreeBet: 0.55 };

const TAG_BLURB: Record<string, string> = {
  TAG: 'Tight-Aggressive',
  LAG: 'Loose-Aggressive',
  LP: 'Loose-Passive',
  MANIAC: 'Maniac',
  NIT: 'Nit',
  GTO: 'Balanced (GTO-ish)',
  REG: 'Reg (adjusts to you)',
};

export function OpponentPanel({
  villain,
  enabled,
  onToggle,
  loading,
  anonymous,
  observed,
  heroAggro,
  guessedId,
  onGuess,
  model,
  lock,
  onLock,
}: Props) {
  return (
    <div className="opp-panel">
      <div className="hud-head">
        <span>🎭 Opponent</span>
        <button className="toggle" onClick={onToggle}>
          {enabled ? 'Hide' : 'Show'}
        </button>
      </div>

      {!enabled ? (
        <div className="hud-hidden">Opponent read hidden — toggle to see who you're up against.</div>
      ) : loading ? (
        <div className="hud-loading">Reading the table…</div>
      ) : !villain ? (
        <div className="hud-hidden">Waiting for your turn — no single opponent in focus yet.</div>
      ) : (
        (() => {
          const p = getProfile(villain.profileId);
          const hidden = anonymous && !guessedId;
          const guessed = anonymous && guessedId ? getProfile(guessedId) : null;
          const correct = guessed !== null && guessed.id === p.id;
          return (
            <>
              <div className="opp-id">
                <span className="opp-name">{villain.name}</span>
                {!hidden && <span className={`opp-tag tag-${villain.tag.toLowerCase()}`}>{villain.tag}</span>}
                {hidden && <span className="opp-tag tag-unknown">?</span>}
                <span className="opp-pos">{villain.position}</span>
              </div>

              {guessed && (
                <div className={`opp-guess-verdict ${correct ? 'ok' : 'bad'}`}>
                  {correct
                    ? `✓ Nailed it — ${p.name}.`
                    : `✗ You said ${guessed.name} — actually ${p.name}.`}
                </div>
              )}

              {hidden ? (
                <>
                  <div className="opp-arch">Unknown player — build a read from what you've seen.</div>
                  <div className="opp-bars">
                    <Bar label={`VPIP (plays hands)`} v={observed?.vpip ?? 0} />
                    <Bar label={`PFR (raises pre)`} v={observed?.pfr ?? 0} />
                    <Bar
                      label={`Aggression (AF ${observed?.af === null || observed === undefined || observed === null ? '—' : observed.af.toFixed(1)})`}
                      v={observed?.af == null ? 0 : Math.min(1, observed.af / 4)}
                    />
                  </div>
                  <div className="opp-sample gp-muted">
                    {observed && observed.hands >= 10
                      ? `${observed.hands} hands observed`
                      : `Small sample (${observed?.hands ?? 0} hands) — reads firm up around 10+.`}
                  </div>
                  {onGuess && (
                    <div className="opp-guess">
                      <span className="opp-guess-lbl">Who is this? Guess to reveal:</span>
                      <div className="opp-guess-btns">
                        {PROFILE_LIST.map((prof) => (
                          <button key={prof.id} className="toggle" title={prof.blurb} onClick={() => onGuess(prof.id)}>
                            {prof.tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="opp-arch">
                    {TAG_BLURB[villain.tag] ?? p.name} — {p.blurb}
                  </div>

                  <div className="opp-bars">
                    <Bar label="Opens (looseness)" v={p.openLooseness} />
                    <Bar label="3-bet frequency" v={p.threeBetFreq} />
                    <Bar label="Aggression" v={p.aggression} />
                    <Bar label="Bluff frequency" v={p.bluffFreq} />
                    <Bar label="C-bet frequency" v={p.cbetFreq} />
                    <Bar label="Calls too much" v={p.callStation} danger />
                  </div>
                </>
              )}

              <ShiftAlerts stats={observed} heroAggro={heroAggro} />

              <div className={`opp-pos ${villain.heroInPosition ? 'ip' : 'oop'}`}>
                <span className="opp-pos-badge">
                  {villain.heroInPosition ? '▸ You are IN POSITION' : '◂ You are OUT OF POSITION'}
                </span>
                <p>
                  {villain.heroInPosition
                    ? 'You act after this villain postflop — you can check back for a free card, bluff-catch cheaply, and value bet thinly. Use it: bet more, realise more equity.'
                    : 'You act before this villain postflop — you realise less of your equity (they can pressure you off hands). Be more proactive (bet / check-raise) and call tighter.'}
                </p>
              </div>

              <div className="opp-range">
                <span className="opp-range-lbl">Likely holding</span>
                <span className="opp-range-val">
                  {villain.rangeNote}
                  {villain.wasAggressor ? ' · was the preflop aggressor' : ' · was not the aggressor'}
                </span>
              </div>

              {!hidden && (
                <div className="opp-exploit">
                  <span className="opp-exploit-lbl">💡 How to exploit</span>
                  <p>{p.exploit}</p>
                </div>
              )}

              {onLock && <NodeLock observed={observed} model={model} lock={lock} onLock={onLock} />}
            </>
          );
        })()
      )}
    </div>
  );
}

/**
 * Node lock: assert what this villain does and make the strategy engine solve
 * against that instead of the observed read.
 *
 * This is the exploit loop the app is for. The engine has exactly two knobs that
 * move the recommended line — how often villain folds to a bet, and how often he
 * fires when checked to — so those are the two things worth locking. Everything
 * downstream (the recommended action, its EV, the "Exploit:" delta on the strategy
 * panel) recomputes from them.
 *
 * Sliders start from the observed read when there is one, else from the balanced
 * reference, so opening the control never silently changes the advice.
 */
function NodeLock({
  observed,
  model,
  lock,
  onLock,
}: {
  observed?: ObservedStats | null;
  model?: VillainModel | null;
  lock?: VillainLock | null;
  onLock: (lock: VillainLock | null) => void;
}) {
  const obsFold = observed?.foldToBet ?? null;
  const obsBet = observed?.betFreq ?? null;
  const foldVal = lock?.foldToBet ?? obsFold ?? BALANCED_REF.foldToBet;
  const betVal = lock?.betFreq ?? obsBet ?? BALANCED_REF.betFreq;
  const openVal = lock?.openFreq ?? observed?.openFreq ?? PF_REF.openFreq;
  const threeBetVal = lock?.threeBetFreq ?? observed?.threeBetFreq ?? PF_REF.threeBetFreq;
  const foldTo3Val = lock?.foldToThreeBet ?? observed?.foldToThreeBet ?? PF_REF.foldToThreeBet;
  const on = !!lock?.enabled;

  const set = (patch: Partial<VillainLock>) =>
    onLock({
      enabled: true,
      foldToBet: foldVal,
      betFreq: betVal,
      openFreq: openVal,
      threeBetFreq: threeBetVal,
      foldToThreeBet: foldTo3Val,
      ...patch,
    });

  return (
    <div className="opp-lock">
      <div className="opp-lock-head">
        <span className="opp-exploit-lbl">🔒 Node lock</span>
        <label className="opp-lock-toggle">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => (e.target.checked ? set({}) : onLock(null))}
          />
          Solve against my read
        </label>
      </div>

      <div className="opp-lock-obs gp-muted">
        Observed: folds to a bet{' '}
        <b>{obsFold == null ? '—' : `${Math.round(obsFold * 100)}%`}</b>
        {observed?.facedBetSample ? ` (${observed.facedBetSample} spots)` : ''} · bets when checked to{' '}
        <b>{obsBet == null ? '—' : `${Math.round(obsBet * 100)}%`}</b>
        {observed?.betChanceSample ? ` (${observed.betChanceSample} spots)` : ''}
      </div>

      <div className="opp-lock-obs gp-muted">
        River bets{' '}
        <b>{observed?.riverBetFreq == null ? '—' : `${Math.round(observed.riverBetFreq * 100)}%`}</b>
        {observed?.riverBetChanceSample ? ` (${observed.riverBetChanceSample} spots)` : ''} · barrels flop→river{' '}
        <b>{observed?.barrelThrough == null ? '—' : `${Math.round(observed.barrelThrough * 100)}%`}</b>
        {observed?.ledFlopSample ? ` (${observed.ledFlopSample} led flops)` : ''}
        <div className="gp-muted">
          Barrelling through a lot is a bluff read on its own — no range holds enough value
          hands to fire three streets that often. Low → a river bet is value; fold your
          bluff-catchers.
        </div>
      </div>

      <div className="opp-lock-obs gp-muted">
        Preflop — opens{' '}
        <b>{observed?.openFreq == null ? '—' : `${Math.round(observed.openFreq * 100)}%`}</b>
        {observed?.openSample ? ` (${observed.openSample} unopened)` : ''} · 3-bets{' '}
        <b>{observed?.threeBetFreq == null ? '—' : `${Math.round(observed.threeBetFreq * 100)}%`}</b>
        {observed?.threeBetSample ? ` (${observed.threeBetSample} spots)` : ''} · folds his open to a 3-bet{' '}
        <b>{observed?.foldToThreeBet == null ? '—' : `${Math.round(observed.foldToThreeBet * 100)}%`}</b>
        {observed?.foldToThreeBetSample ? ` (${observed.foldToThreeBetSample} spots)` : ''}
        <div className="gp-muted">
          These move the preflop charts and the range the postflop engine inherits for him —
          a 20% 3-bettor is re-raising hands the chart has him folding.
        </div>
      </div>

      {on && (
        <div className="opp-lock-sliders">
          <LockSlider
            label="Folds to a bet"
            v={foldVal}
            hint={`${Math.round(BALANCED_REF.foldToBet * 100)}% is balanced. Higher → your bluffs print and thin value stops getting paid.`}
            onChange={(v) => set({ foldToBet: v })}
          />
          <LockSlider
            label="Bets when checked to"
            v={betVal}
            hint={`${Math.round(BALANCED_REF.betFreq * 100)}% is balanced. Higher → his bet range is air-heavy, so call down lighter.`}
            onChange={(v) => set({ betFreq: v })}
          />
          <LockSlider
            label="Opens (unopened pots)"
            v={openVal}
            hint={`${Math.round(PF_REF.openFreq * 100)}% is balanced. Higher → his opening range is weak, so defend wider against it.`}
            onChange={(v) => set({ openFreq: v })}
          />
          <LockSlider
            label="3-bets facing an open"
            v={threeBetVal}
            hint={`${Math.round(PF_REF.threeBetFreq * 100)}% is balanced. Higher → his 3-bet is far wider than the chart assumes: 4-bet for value and continue more.`}
            onChange={(v) => set({ threeBetFreq: v })}
          />
          <LockSlider
            label="Folds his open to a 3-bet"
            v={foldTo3Val}
            hint={`${Math.round(PF_REF.foldToThreeBet * 100)}% is balanced. Higher → light 3-bets print against his opens.`}
            onChange={(v) => set({ foldToThreeBet: v })}
          />
          <button className="toggle" onClick={() => onLock(null)}>
            Clear lock
          </button>
        </div>
      )}

      {model?.label && (
        <div className="opp-lock-read">
          <b>Engine is solving against:</b> {model.label}
        </div>
      )}
      {model?.preflop?.label && (
        <div className="opp-lock-read">
          <b>Preflop:</b> {model.preflop.label}
        </div>
      )}
      {!model?.label && !model?.preflop?.label && (
        <div className="opp-lock-read gp-muted">
          No exploitable deviation yet — the engine is solving this node balanced.
        </div>
      )}
    </div>
  );
}

function LockSlider({
  label,
  v,
  hint,
  onChange,
}: {
  label: string;
  v: number;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="opp-lock-slider" title={hint}>
      <span className="opp-bar-lbl">
        {label} <b>{Math.round(v * 100)}%</b>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(v * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    </label>
  );
}

function Bar({ label, v, danger }: { label: string; v: number; danger?: boolean }) {
  return (
    <div className="opp-bar-row">
      <span className="opp-bar-lbl">{label}</span>
      <span className="opp-bar-track">
        <span className={`opp-bar-fill ${danger ? 'danger' : ''}`} style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      <span className="opp-bar-pct">{Math.round(v * 100)}%</span>
    </div>
  );
}

/** "He just changed" — mid-session playstyle shifts detected from a recent-vs-baseline window.
 *  The hardest opponents (regs / low-pros) don't leak a static number, they ADJUST to you; the
 *  lifetime average hides it, so this is the read that actually beats them. */
function ShiftAlerts({ stats, heroAggro }: { stats?: ObservedStats | null; heroAggro?: number | null }) {
  const shifts = stats ? readShifts(stats, { heroAggro }) : [];
  if (!shifts.length) return null;
  const leveling = shifts.some((s) => s.leveling);
  return (
    <div className={`opp-shift ${leveling ? 'leveling' : ''}`}>
      <span className="opp-shift-lbl">{leveling ? '🎯 He’s levelling YOU' : '⚠ He’s adjusting'}</span>
      {shifts.map((s) => (
        <div key={s.stat} className="opp-shift-row">
          <div className="opp-shift-head">
            {s.headline} <b>{s.fromPct}% → {s.toPct}%</b>
          </div>
          <p className="opp-shift-advice">{s.advice}</p>
        </div>
      ))}
    </div>
  );
}
