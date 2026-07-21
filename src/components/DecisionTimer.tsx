// Live decision timer. Mounts when it becomes the hero's turn and unmounts when
// the turn ends, so each mount == one decision — no external reset needed. Counts
// UP (a thinking aid, never a hard clock: no auto-fold), colours the elapsed time
// against live-poker tempo norms, and records each decision into a persisted
// average so the hero learns their own pace. Consistent tempo matters — the Tells
// trainer teaches that uneven timing (slow bluffs, snap value) is a read.

import { useEffect, useRef, useState } from 'react';
import { loadThinkTime, recordThinkTime, resetThinkTime, avgThinkMs, type ThinkTime } from '../store/thinkTime';

// Ignore sub-threshold turns: instant auto-checks and React StrictMode's dev
// double-mount (which unmounts near-instantly) shouldn't pollute the average.
const MIN_RECORD_MS = 300;

type Band = 'snap' | 'ok' | 'slow' | 'tank';
function band(sec: number): Band {
  if (sec < 5) return 'snap';
  if (sec <= 15) return 'ok';
  if (sec <= 30) return 'slow';
  return 'tank';
}
const BAND_LABEL: Record<Band, string> = {
  snap: 'snap decision',
  ok: 'good tempo',
  slow: 'thinking…',
  tank: 'tanking — a clock could be called',
};

export function DecisionTimer() {
  const startRef = useRef(0);
  const recordedRef = useRef(false);
  const [ms, setMs] = useState(0);
  // loaded once at mount → shows the average BEFORE this decision; refreshes next turn.
  const [stats, setStats] = useState<ThinkTime>(() => loadThinkTime());

  useEffect(() => {
    startRef.current = performance.now();
    recordedRef.current = false;
    const id = setInterval(() => setMs(performance.now() - startRef.current), 100);
    return () => {
      clearInterval(id);
      const elapsed = performance.now() - startRef.current;
      if (!recordedRef.current && elapsed >= MIN_RECORD_MS) {
        recordedRef.current = true;
        recordThinkTime(elapsed); // persist only — component is unmounting
      }
    };
  }, []);

  const sec = ms / 1000;
  const b = band(sec);
  const avg = avgThinkMs(stats) / 1000;

  return (
    <div className={`dtimer ${b}`}>
      <div className="dtimer-main">
        <span className="dtimer-clock">⏱ {sec.toFixed(1)}s</span>
        <span className="dtimer-band">{BAND_LABEL[b]}</span>
      </div>
      <div className="dtimer-sub">
        {stats.count > 0 && (
          <span>
            your avg <b>{avg.toFixed(1)}s</b> · {stats.count} decisions
          </span>
        )}
        <span className="dtimer-guide">live: snap &lt;5s · standard 5–15s · tough ≤30s</span>
        {stats.count > 0 && (
          <button className="btn-small" onClick={() => setStats(resetThinkTime())} title="Reset your tempo average">
            ↺
          </button>
        )}
      </div>
    </div>
  );
}
