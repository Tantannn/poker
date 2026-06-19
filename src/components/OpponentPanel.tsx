// Reads the opponent the hero is currently up against: archetype, key
// tendencies (as bars), their estimated range at this node, and a one-line
// exploit plan. Helps the player attach a "why" to the villain's actions.

import type { VillainInfo } from '../hooks/useGame';
import { getProfile } from '../ai/profiles';

interface Props {
  villain: VillainInfo | null;
  enabled: boolean;
  onToggle: () => void;
  loading: boolean;
}

const TAG_BLURB: Record<string, string> = {
  TAG: 'Tight-Aggressive',
  LAG: 'Loose-Aggressive',
  LP: 'Loose-Passive',
  MANIAC: 'Maniac',
  NIT: 'Nit',
  GTO: 'Balanced (GTO-ish)',
};

export function OpponentPanel({ villain, enabled, onToggle, loading }: Props) {
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
          return (
            <>
              <div className="opp-id">
                <span className="opp-name">{villain.name}</span>
                <span className={`opp-tag tag-${villain.tag.toLowerCase()}`}>{villain.tag}</span>
                <span className="opp-pos">{villain.position}</span>
              </div>
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

              <div className="opp-range">
                <span className="opp-range-lbl">Likely holding</span>
                <span className="opp-range-val">
                  {villain.rangeNote}
                  {villain.wasAggressor ? ' · was the preflop aggressor' : ' · was not the aggressor'}
                </span>
              </div>

              <div className="opp-exploit">
                <span className="opp-exploit-lbl">💡 How to exploit</span>
                <p>{p.exploit}</p>
              </div>
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
