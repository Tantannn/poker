// Popup anchor sheet for the equity-vs-range drill. Calibrating equity from a blank
// mind is hard; anchoring to a handful of reference points and nudging is not. These
// are the memorize-these numbers: made-hand baselines (vs a wide vs a tight range),
// the Rule-of-2-&-4 draw ladder, and the shift rules for facing a bet / going
// multiway. Rough by design — the drill shows the exact %; this is the gut anchor.

export interface MadeRow {
  hero: string;
  wide: number;
  tight: number;
}

// Made-hand equity heads-up vs a normal opening range. Memorize the WIDE column; a
// tight range knocks ~15 off. Ballparks, not solver output — anchors to nudge from.
// Exported so the equity-drill "💡 Why" can reproduce the 3-step anchor read against
// the true equity (single source — the sheet and the drill can't drift apart).
export const MADE: MadeRow[] = [
  { hero: 'Air (no pair, no draw)', wide: 30, tight: 15 },
  { hero: 'Weak / 2nd pair', wide: 50, tight: 35 },
  { hero: 'Top pair', wide: 72, tight: 55 },
  { hero: 'Overpair / two pair', wide: 80, tight: 65 },
  { hero: 'Set / straight+', wide: 90, tight: 80 },
];

export interface DrawRow {
  draw: string;
  outs: number;
  river: number; // flop→river, Rule of 4
  oneCard: number; // one card, Rule of 2
}

export const DRAWS: DrawRow[] = [
  { draw: 'Flush draw', outs: 9, river: 35, oneCard: 18 },
  { draw: 'Open-ender', outs: 8, river: 32, oneCard: 16 },
  { draw: 'Two overcards', outs: 6, river: 24, oneCard: 12 },
  { draw: 'Gutshot', outs: 4, river: 16, oneCard: 8 },
];

interface MwRow {
  tier: string;
  hu: number; // heads-up (1 opp)
  w3: number; // 3-way (2 opps)
  w5: number; // 5-way (4 opps)
}

// Multiway decay: same hand vs 1 / 2 / 4 RANDOM opponents (20k-sim Monte Carlo). Random
// hands make it a universal anchor — a tighter range lowers the start, but the DROP per
// player is the point. Nutted hands barely move; one pair below top falls off a cliff.
const MW: MwRow[] = [
  { tier: 'Set / straight+', hu: 98, w3: 95, w5: 90 },
  { tier: 'Two pair', hu: 94, w3: 89, w5: 80 },
  { tier: 'Top pair / overpair', hu: 88, w3: 80, w5: 63 },
  { tier: 'Middle pair', hu: 73, w3: 56, w5: 35 },
  { tier: 'Bottom / weak pair', hu: 56, w3: 34, w5: 18 },
  { tier: 'Overcards (air)', hu: 54, w3: 33, w5: 16 },
  { tier: 'Flush draw', hu: 68, w3: 53, w5: 43 },
];

// color a cell by equity band, so the sheet is scannable (same thresholds as the
// position cheat sheet: ≥55 good, ≥45 mid, else behind).
function cell(e: number): string {
  if (e >= 55) return 'cs-good';
  if (e >= 45) return 'cs-mid';
  return 'cs-bad';
}

export function EquityAnchors({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>🎯 Equity anchors</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <p className="modal-note">
          Don't guess blind — anchor, then nudge. Numbers are ballparks; the drill shows the exact %.
        </p>

        <h4 className="cs-subhead">The 3-step read</h4>
        <ol className="cs-rules">
          <li><b>Your hand</b> → find its row below (top pair, draw…) = your base %.</li>
          <li><b>Wide or tight?</b> → pick the column (seat table ↓).</li>
          <li><b>Did he bet?</b> → subtract (bet table ↓). Done.</li>
        </ol>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>villain seat</th>
                <th>his range</th>
                <th>use column</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">BTN · CO · SB · BB</td><td className="cs-good">WIDE — plays lots</td><td>big (WIDE)</td></tr>
              <tr><td className="cs-hero">UTG · MP (early)</td><td className="cs-bad">TIGHT — plays few</td><td>small (TIGHT)</td></tr>
              <tr><td className="cs-hero">raised / 3-bet you</td><td className="cs-bad">SUPER TIGHT</td><td>smaller still</td></tr>
            </tbody>
          </table>
        </div>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>he bet? subtract…</th>
                <th>knock off</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">Made hand (one pair / bluff-catcher)</td><td className="cs-bad">−15</td></tr>
              <tr><td className="cs-hero">Draw</td><td className="cs-bad">cut ⅓ (dirty outs)</td></tr>
            </tbody>
          </table>
        </div>
        <p className="modal-note">
          Bigger bet = bigger cut (⅓ pot small · pot+ big). A bet just means <b>"he got tighter."</b>
        </p>

        <h4 className="cs-subhead">Made hands (heads-up vs an opening range)</h4>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>your hand</th>
                <th>vs WIDE<span className="cs-width">loose open</span></th>
                <th>vs TIGHT<span className="cs-width">UTG / 3-bet</span></th>
              </tr>
            </thead>
            <tbody>
              {MADE.map((r) => (
                <tr key={r.hero}>
                  <td className="cs-hero">{r.hero}</td>
                  <td className={cell(r.wide)}>{r.wide}</td>
                  <td className={cell(r.tight)}>{r.tight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="modal-note">Memorize the <b>WIDE</b> column; a tight range → knock ~15 off.</p>

        <h4 className="cs-subhead">Draws (Rule of 2 &amp; 4)</h4>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>draw</th>
                <th>outs</th>
                <th>flop→river<span className="cs-width">×4</span></th>
                <th>one card<span className="cs-width">×2</span></th>
              </tr>
            </thead>
            <tbody>
              {DRAWS.map((r) => (
                <tr key={r.draw}>
                  <td className="cs-hero">{r.draw}</td>
                  <td>{r.outs}</td>
                  <td className={cell(r.river)}>{r.river}</td>
                  <td className={cell(r.oneCard)}>{r.oneCard}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="modal-note">
          Then <b>+3–5 vs a wide range</b> (you scoop their air too), <b>−⅓ vs a value bet</b> (dirty
          outs — overcards especially, halve them).
        </p>

        <h4 className="cs-subhead">Multiway — 3-way, 5-way (equity vs random hands)</h4>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>your hand</th>
                <th>heads-up<span className="cs-width">fair 50%</span></th>
                <th>3-way<span className="cs-width">fair 33%</span></th>
                <th>5-way<span className="cs-width">fair 20%</span></th>
              </tr>
            </thead>
            <tbody>
              {MW.map((r) => (
                <tr key={r.tier}>
                  <td className="cs-hero">{r.tier}</td>
                  <td className={cell(r.hu)}>{r.hu}</td>
                  <td className={cell(r.w3)}>{r.w3}</td>
                  <td className={cell(r.w5)}>{r.w5}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cs-who">
          <span><b className="cs-good">Nutted hands barely drop</b> — sets / two pair stay ~80–90% even 5-way. Value up, bet bigger.</span>
          <span><b className="cs-bad">One pair below top is a cliff</b> — middle pair 73→35, bottom 56→18. Don't stack off one pair multiway.</span>
          <span><b className="cs-mid">Draws hold their value</b> — flush draw 68→43; a field pays your price, so draws love multiway.</span>
        </div>
        <p className="modal-note">
          "Fair share" = an even split, <b>100 ÷ players</b> (HU 50% · 3-way 33% · 5-way 20%). Beat that and
          you're the favourite of the field. A tighter range lowers every number, but the DROP per player holds.
        </p>

        <ol className="cs-rules">
          <li><b>Facing a bet?</b> His range is value-weighted → drop a bluff-catcher ~15 pts, draws ~⅓. No pair + no strong draw vs a bet ≈ under 30% = fold.</li>
          <li><b>Multiway?</b> See the table above — every extra player grinds you down, and <b>one pair below top dies multiway.</b> Compare to the fair share (33% 3-way, 20% 5-way), not to 50%.</li>
          <li><b>Range width is the big dial.</b> Wide → more air you beat (+equity); tight → few weak hands (−15). Position is just a proxy for width.</li>
        </ol>

        <h4 className="cs-subhead">Turn &amp; river — recalc LESS, not more</h4>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>street</th>
                <th>cards left</th>
                <th>draw math</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">Flop</td><td>2</td><td className="cs-good">outs × 4</td></tr>
              <tr><td className="cs-hero">Turn</td><td>1</td><td className="cs-mid">outs × 2</td></tr>
              <tr><td className="cs-hero">River</td><td>0</td><td className="cs-bad">dead — missed draw = 0%</td></tr>
            </tbody>
          </table>
        </div>
        <ol className="cs-rules">
          <li><b>Made hands: reuse the anchor.</b> Top pair is top pair every street — same 72 / 55 row. Just shade DOWN ~5 each time he bets again (more streets = he reps more).</li>
          <li><b>Draws: only the multiplier changes</b> — ×4 flop → ×2 turn → dead river. Nothing new to memorize.</li>
          <li><b>Re-read only on a card that CHANGES your hand</b> — a scare card (A drops, flush lands, straight completes) or your draw hitting. A blank = same read as last street.</li>
          <li><b>River is the easiest street.</b> No outs, no draws. Made hand → "am I ahead of the hands he VALUE-bets?" yes call / no fold. No pair → you're a bluff-catcher = a <b>pot-odds</b> question, not equity.</li>
        </ol>

        <p className="cs-gut">
          💡 The one anchor: the <b>50% line</b> ≈ one decent pair vs a wide range, OR a big draw (flush +
          overs) vs a made hand. Read everything else as "better than that" or "worse than that."
        </p>
      </div>
    </div>
  );
}
