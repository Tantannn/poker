// Always-visible "what range is my seat" reminder so you don't open Reference
// mid-hand. Shows the open-width ladder (tight → wide) and, on a short table,
// your current seat's 6-max equivalent — the SAME mapping the solver uses
// (sixMaxRfiEquivalent), so the hint and the graded line always agree.

import { positionLabel, sixMaxRfiEquivalent, type Position } from '../engine/table';

// the 6-max opening ladder, widest-acting last. The chip matching your seat's
// equivalent lights up — that's the range to open.
const LADDER: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB'];

const SIZE_LABEL: Record<number, string> = { 2: 'HU', 3: '3-max', 4: '4-max', 5: '5-max', 6: '6-max' };

export function PositionHint({ buttonIndex, n, started }: { buttonIndex: number; n: number; started: boolean }) {
  const heroPos = started ? positionLabel(0, buttonIndex, n) : null;
  const equiv = heroPos ? sixMaxRfiEquivalent(heroPos, n) : null;
  const remapped = !!equiv && !!heroPos && equiv !== heroPos;

  return (
    <div
      className="pos-hint"
      title="Opening ranges scale with how many players act behind you. A short table reads the SAME 6-max ranges by seats-behind — 5-max UTG opens like 6-max MP, etc."
    >
      <span className="ph-size">{SIZE_LABEL[n] ?? `${n}-max`}</span>
      {heroPos && (
        <span className="ph-seat">
          You: <b>{heroPos}</b>
          {remapped ? (
            <> → open the 6-max <b>{equiv}</b> range</>
          ) : equiv ? (
            <> open</>
          ) : (
            <> — defend / no first-in open</>
          )}
        </span>
      )}
      <span className="ph-ladder" aria-label="open width by seat: tight to wide">
        <span className="ph-end">tight</span>
        {LADDER.map((s) => (
          <span key={s} className={`ph-rung ${equiv === s ? 'active' : ''}`}>
            {s}
          </span>
        ))}
        <span className="ph-end">wide</span>
      </span>
    </div>
  );
}
