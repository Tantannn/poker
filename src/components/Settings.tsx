// Settings — one place for every knob. The game controls (table size, seat,
// speed, stack, bot difficulty, opponents) live in the ScenarioBar, which used
// to render only on the Play tab; the sound toggle was buried in the mid-game
// score card. This tab surfaces all of them from anywhere, reusing the SAME
// components/state so nothing can drift out of sync.

import { useState } from 'react';
import type { useGame } from '../hooks/useGame';
import { ScenarioBar } from './ScenarioBar';
import { isSoundEnabled, setSoundEnabled } from '../sound';
import { RAKE_PROFILES, rakeProfile, type RakeProfileId } from '../engine/rake';
import type { StraddleMode } from '../engine/table';

type G = ReturnType<typeof useGame>;

export function Settings({ g }: { g: G }) {
  const [sound, setSound] = useState(() => isSoundEnabled());
  const toggleSound = (v: boolean) => {
    setSoundEnabled(v);
    setSound(v);
  };

  return (
    <div className="card">
      <h2>⚙ Settings</h2>
      <p className="sub">
        Everything in one place. Game setup (players, seat, speed, stacks, bots) applies to the live
        table — changes that affect the deal take effect on the <b>next hand</b>.
      </p>

      <div className="set-block">
        <div className="an-h">Game setup</div>
        <ScenarioBar g={g} />
      </div>

      <div className="set-block">
        <div className="an-h">Feedback</div>
        <label
          className="sc-check"
          title="Exam mode: withhold every decision's graded answer until the hand is over, then show a full per-decision review. Stops early-street feedback from leaking into your later-street reads."
        >
          <input
            type="checkbox"
            checked={g.feedbackMode === 'deferred'}
            onChange={(e) => g.setFeedbackMode(e.target.checked ? 'deferred' : 'immediate')}
          />
          Hold answers until the hand is over <span className="sc-hint">(exam mode — review the whole hand at the end instead of one answer per move)</span>
        </label>
      </div>

      <div className="set-block">
        <div className="an-h">Live straddle</div>
        <label className="sc-check" title="A blind posted before the cards by a seat that then acts LAST preflop. Cash games only; takes effect on the next deal.">
          🎲 Straddle:
          <select value={g.straddle} onChange={(e) => g.setStraddle(e.target.value as StraddleMode)}>
            <option value="off">Off</option>
            <option value="utg">UTG (2× blind)</option>
            <option value="double">UTG + re-straddle (4× blind)</option>
            <option value="button">Mississippi — button (2× blind)</option>
          </select>
        </label>
        <p className="note">
          The most distorting thing in a live game, and it costs the straddler nothing to
          create: nobody moves seats, but the bet that matters doubles, so a 100bb stack is
          suddenly <b>50 bets deep</b> and plays like it. The trainer counts depth in straddles
          (push/fold and the chart depth notes shift with it) and the bots open in multiples of
          the straddle. A UTG straddle also makes the straddler act <b>last</b> preflop, like a
          second big blind; Mississippi does the same for the button and starts the action with
          the small blind. The preflop charts themselves stay a ~100bb no-straddle baseline —
          the strategy note says so on every straddled hand.
        </p>
      </div>

      <div className="set-block">
        <div className="an-h">House rake</div>
        <label className="sc-check" title="Taken off every pot that sees a flop (no flop, no drop). It also nets every EV the trainer quotes, so a thin value bet or a marginal call is graded at the price your room actually charges.">
          💵 Rake:
          <select value={g.rake} onChange={(e) => g.setRake(e.target.value as RakeProfileId)}>
            {RAKE_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <p className="note">
          {rakeProfile(g.rake).note} The house takes it off any pot that sees a flop — and the same
          number nets every EV the trainer quotes, so calls need more equity and thin value bets get
          thinner. The cap is what bites: rake is a heavy tax on small pots and near-nothing on a
          stacks-in cooler. Preflop charts are ~100bb rake-free approximations and do not move with
          this setting.
        </p>
      </div>

      <div className="set-block">
        <div className="an-h">App</div>
        <label className="sc-check" title="Synthesised action/grade tones — 100% local WebAudio, no assets">
          <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} />
          Sound effects
        </label>
      </div>

      <p className="note">
        Data (hands, stats, journal, spaced-repetition progress, drill scores) lives only in this
        browser — export a backup from the <b>Analytics</b> tab before clearing site data or moving
        devices. Keyboard shortcuts: <b>F</b>/<b>C</b>/<b>R</b> + <b>Space</b> at the table; number
        keys + <b>Space</b> in the drills.
      </p>
    </div>
  );
}
