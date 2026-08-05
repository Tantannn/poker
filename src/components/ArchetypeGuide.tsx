// Anonymous-mode recognition aid: rank the archetypes against what you've actually observed,
// name what would separate the top two, and list every archetype's signature. All of it is
// derived from the dial table (analysis/archetypeSignature.ts) — no authored signatures, so
// retuning a bot retunes this guide with it.

import { useState } from 'react';
import type { ObservedStats } from '../analysis/observed';
import type { ArchetypeMatch } from '../analysis/archetypeSignature';
import { SIGNATURE_AXES, discriminator, rankArchetypes, signatureFor } from '../analysis/archetypeSignature';
import { PROFILE_LIST, getProfile } from '../ai/profiles';

export function ArchetypeGuide({ observed }: { observed: ObservedStats | null }) {
  const [showTable, setShowTable] = useState(false);
  const ranked = rankArchetypes(observed);
  const top = ranked[0];
  const runnerUp = ranked[1];
  const sep = top && runnerUp ? discriminator(getProfile(top.id), getProfile(runnerUp.id)) : null;
  const noSample = !top || top.usedAxes.length === 0;

  return (
    <div className="arch-guide">
      <div className="arch-head">🔍 Closest match</div>

      {noSample ? (
        <div className="gp-muted">
          Nothing observed yet — every archetype is equally likely. Watch one seat per orbit and count the three
          things below.
        </div>
      ) : (
        <>
          <div className="arch-rank">
            {ranked.map((m, i) => (
              <MatchRow key={m.id} m={m} rank={i} />
            ))}
          </div>
          <div className="arch-conf gp-muted">
            {top.usedAxes.length} of {SIGNATURE_AXES.length} axes have sample ·{' '}
            {top.confidence < 0.4
              ? '⚠ thin — this is a lean, not a read. Inventing an adjustment from four hands is the expensive mistake.'
              : `${Math.round(top.confidence * 100)}% of full weight`}
          </div>
          {sep && (
            <div className="arch-sep">
              <span className="arch-sep-lbl">
                {top.tag} vs {runnerUp.tag} — what tells them apart
              </span>
              <p>{sep.watch}</p>
            </div>
          )}
        </>
      )}

      <div className="arch-axes">
        <span className="arch-axes-lbl">What to count</span>
        {SIGNATURE_AXES.map((a) => (
          <div key={a.id} className="arch-axis">
            <b>{a.label}</b>
            <span className="gp-muted"> {a.watch}</span>
          </div>
        ))}
      </div>

      <button className="toggle" onClick={() => setShowTable((v) => !v)}>
        {showTable ? 'Hide' : 'Show'} all {PROFILE_LIST.length} signatures
      </button>

      {showTable && (
        <div className="arch-table">
          {PROFILE_LIST.map((p) => {
            const s = signatureFor(p);
            return (
              <div key={p.id} className="arch-card">
                <div className="arch-card-head">
                  <span className={`opp-tag tag-${p.tag.toLowerCase()}`}>{p.tag}</span>
                  <span className="arch-quad">{s.quadrant}</span>
                </div>
                <div className="arch-dials">
                  {s.dials.map((d) => (
                    <div key={d.axis.id} className="arch-dial">
                      <span className="arch-dial-lbl">
                        {d.axis.loLabel} → {d.axis.hiLabel}
                      </span>
                      <div className="arch-dial-bar">
                        <div className="arch-dial-fill" style={{ width: `${Math.round(d.v * 100)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="arch-give">
                  {s.giveaway
                    ? `Gives himself away on: ${s.giveaway.axis.label.toLowerCase()} — he is the ${s.giveaway.high ? s.giveaway.axis.hiLabel : s.giveaway.axis.loLabel} end of the table.`
                    : 'No extreme dial — he shows up as unremarkable, which is itself the read: play him straight.'}
                </p>
                <p className="arch-give gp-muted">
                  Easiest to confuse with <b>{s.nearest.tag}</b>. {s.tellApart.watch}
                </p>
                <p className="arch-give">💡 {p.exploit}</p>
              </div>
            );
          })}
        </div>
      )}

      <div className="arch-disclose gp-muted">
        A similarity <b>rank</b>, not a stat prediction — the bots' dials aren't VPIP/PFR/AF, so both sides are
        normalised into their own span before comparing. The live stat ranges used for that normalisation are
        authored live-poker bands; the archetype side is read straight off the dial table.
      </div>
    </div>
  );
}

function MatchRow({ m, rank }: { m: ArchetypeMatch; rank: number }) {
  const fit = Math.round((1 - m.distance) * 100);
  return (
    <div className={`arch-row ${rank === 0 ? 'top' : ''}`}>
      <span className={`opp-tag tag-${m.tag.toLowerCase()}`}>{m.tag}</span>
      <div className="arch-fit-bar">
        <div className="arch-fit-fill" style={{ width: `${Math.max(2, fit)}%` }} />
      </div>
      <span className="arch-fit-num">{fit}%</span>
    </div>
  );
}
