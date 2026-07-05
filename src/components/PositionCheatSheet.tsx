// Popup cheat sheet for the vs-Range drill: how the villain's POSITION (really:
// how wide their range is) swings your equity. Same hero hand, five villains.
// Numbers are preflop all-in equity (40k-sim Monte Carlo vs each range from
// ai/preflop.ts) — the board moves exact %s in the drill, but the direction and
// SIZE of the swing across positions is what's worth memorizing.

interface Row {
  hero: string;
  eq: [number, number, number, number, number]; // BB def, BTN, CO, UTG, 3-bet
}

// Columns, widest range → tightest. Width = % of all 1326 combos that range holds.
const COLS = [
  { lbl: 'BB defend', width: '~49%' },
  { lbl: 'BTN open', width: '~45%' },
  { lbl: 'CO open', width: '~25%' },
  { lbl: 'UTG open', width: '~14%' },
  { lbl: '3-bet', width: '~3.5%' },
];

const ROWS: Row[] = [
  { hero: 'AA', eq: [84, 84, 84, 83, 84] },
  { hero: 'AKs', eq: [66, 66, 62, 58, 50] },
  { hero: '99', eq: [65, 64, 59, 56, 43] },
  { hero: 'KQs', eq: [57, 56, 52, 45, 31] },
  { hero: '77', eq: [57, 57, 53, 50, 42] },
  { hero: 'KTo', eq: [52, 50, 45, 39, 26] },
  { hero: 'A5s', eq: [52, 52, 47, 42, 37] },
  { hero: 'T9s', eq: [45, 44, 40, 39, 33] },
  { hero: '22', eq: [47, 47, 43, 37, 38] },
  { hero: '72o', eq: [30, 30, 29, 26, 24] },
];

// color the cell by the equity band, so the swing is scannable left→right
function cell(e: number): string {
  if (e >= 55) return 'cs-good';
  if (e >= 45) return 'cs-mid';
  return 'cs-bad';
}

export function PositionCheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>📊 Villain position cheat sheet</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <p className="modal-note">
          Position is really a proxy for <b>range width</b>. Same hand, different villain → your equity
          swings. Numbers are preflop all-in % vs each range; the board shifts exact figures, but the
          shape of the swing holds.
        </p>

        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>hand</th>
                {COLS.map((c) => (
                  <th key={c.lbl}>{c.lbl}<span className="cs-width">{c.width}</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.hero}>
                  <td className="cs-hero">{r.hero}</td>
                  {r.eq.map((e, i) => (
                    <td key={i} className={cell(e)}>{e}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ol className="cs-rules">
          <li><b>BB ≈ BTN.</b> Both play ~half of all hands → equity within 1–2 pts. Treat them the same.</li>
          <li><b>Each tightening ≈ −5 pts.</b> BTN→CO and CO→UTG are steady stair-steps down.</li>
          <li><b>3-bet is a cliff, not a step.</b> Medium hands fall off a wall: KQs 45→31, KTo 39→26 (~−13 in that final jump, vs −5 per step before it).</li>
        </ol>

        <div className="cs-who">
          <span><b className="cs-good">AA flat ~84</b> everywhere — only the very top ignores range width (even AKs slides 66→50).</span>
          <span><b className="cs-mid">Medium hands swing hardest</b> (KQs, KTo, 99): ~25 pts wide→3-bet.</span>
          <span><b className="cs-bad">Trash barely moves</b> (72o ~30→24) — already behind, nowhere to fall.</span>
        </div>

        <p className="cs-gut">
          💡 Gut: vs wide (BB/BTN) any decent hand is a coinflip+; vs a 3-bet, only premiums survive —
          fold the middle.
        </p>
      </div>
    </div>
  );
}
