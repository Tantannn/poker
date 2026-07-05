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

interface Props {
  villain: VillainInfo | null;
  enabled: boolean;
  onToggle: () => void;
  loading: boolean;
  /** anonymous-villains mode: hide archetype until the hero guesses it */
  anonymous?: boolean;
  /** observed stats for this villain (from the action log), for anonymous mode */
  observed?: ObservedStats | null;
  /** the hero's archetype guess for this seat (profileId), if made */
  guessedId?: string;
  onGuess?: (profileId: string) => void;
}

const TAG_BLURB: Record<string, string> = {
  TAG: 'Tight-Aggressive',
  LAG: 'Loose-Aggressive',
  LP: 'Loose-Passive',
  MANIAC: 'Maniac',
  NIT: 'Nit',
  GTO: 'Balanced (GTO-ish)',
};

export function OpponentPanel({ villain, enabled, onToggle, loading, anonymous, observed, guessedId, onGuess }: Props) {
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
            </>
          );
        })()
      )}
    </div>
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
