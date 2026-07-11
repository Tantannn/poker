// Settings — one place for every knob. The game controls (table size, seat,
// speed, stack, bot difficulty, opponents) live in the ScenarioBar, which used
// to render only on the Play tab; the sound toggle was buried in the mid-game
// score card. This tab surfaces all of them from anywhere, reusing the SAME
// components/state so nothing can drift out of sync.

import { useState } from 'react';
import type { useGame } from '../hooks/useGame';
import { ScenarioBar } from './ScenarioBar';
import { isSoundEnabled, setSoundEnabled } from '../sound';

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
