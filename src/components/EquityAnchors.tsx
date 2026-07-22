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

// Villain bluff rates — the SAME profiles the drill's opponents use (single source,
// so the sheet's "~8%" and the read's "~8%" can't drift). A bluff-catcher facing a
// bet keeps ≈ this, so it belongs on the anchor sheet.
import { getProfile } from '../ai/profiles';
const BLUFFERS = [
  { id: 'lp', label: '🐟 Station' },
  { id: 'tag', label: '🎯 TAG' },
  { id: 'gto', label: '⚖ Balanced' },
  { id: 'maniac', label: '🔥 Maniac' },
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
          <span>🎯 How to measure your equity</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <p className="modal-note">
          Measuring equity = 3 moves: <b>① build his range → ② count what you beat → ③ compare to the pot-odds line.</b>
          Work them in order.
        </p>

        <h4 className="cs-subhead">① Build his range — 3 questions</h4>
        <p className="modal-note">
          Before you can measure, you need his hands. Don't invent them — read them off 3 things:
        </p>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr><th>ask…</th><th>what it tells you</th></tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">1. Where's he sitting?</td><td>BTN / CO / BB = <b>wide</b> (weaker) · UTG / MP = <b>tight</b> (strong). <span className="muted">memorise a preflop chart once</span></td></tr>
              <tr><td className="cs-hero">2. What did he do?</td><td>called pre = medium hands · called flop = has a piece · <b>bets = strong + draws</b></td></tr>
              <tr><td className="cs-hero">3. What does the board give that range?</td><td>which cards he <b>paired</b> · what <b>draws</b> fit · the rest = <b>air</b></td></tr>
            </tbody>
          </table>
        </div>
        <p className="cs-gut">
          💡 You only need the SHAPE — "mostly pairs + some draws + a little air" — not exact combos. Then list one hand
          from each category and tick it (step ②). <b>10-sec shortcut:</b> "what does he have MOST often — do I beat it?"
        </p>
        <p className="cs-gut">
          Ex — <b>T♣ 7♥ 5♣ 2♥</b>, he's BB &amp; bets the turn: wide range → paired cards (Tx, 7x, 5x, small pockets) +
          club/straight draws + missed AK/KQ air. Shape = <b>mostly pairs, some draws, a little air</b>.
        </p>

        <h4 className="cs-subhead">② Measure YOUR equity — the tick method</h4>
        <p className="modal-note">
          Your equity = <b>how many of his hands you beat.</b> Picture the hands he'd bet, and go by feel:
        </p>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr><th>of his betting hands, I beat…</th><th>my equity ≈</th></tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">most of them</td><td className="cs-good">~75%</td></tr>
              <tr><td className="cs-hero">about half</td><td className="cs-mid">~50%</td></tr>
              <tr><td className="cs-hero">only a few (he mostly has me)</td><td className="cs-bad">~25%</td></tr>
              <tr><td className="cs-hero">almost none (I'm drawing)</td><td className="cs-bad">~15%</td></tr>
            </tbody>
          </table>
        </div>

        <p className="cs-step"><b>Unsure? Tick it out.</b> List ~6 hands he'd bet, mark each beat ✓ / lose ✗ / flip ~, then count. <span className="muted">equity ≈ (✓ + ½·~) ÷ total</span></p>
        <p className="cs-gut">
          <b>Ex — you hold 9♠6♣ on Q♣ 6♦ 2♠ (middle pair), he bets:</b><br />
          AQ ✗ · KQ ✗ · JJ ✗ · TT ✗ · A-high bluff ✓ · 55/44 ✓ · 32 bluff ✓<br />
          Beat 3, lose 4, flip 0 → <b>3 of 7 ≈ ~35%.</b> Middle pair = bluff-catcher: you beat his air + worse pairs,
          lose to every Q and overpair.
        </p>
        <p className="modal-note">
          Two rules: <b>(1) list the COMMON hands, skip the rare monsters</b> — he <i>could</i> have a set, but that's
          1 hand of many; don't fold scared. <b>(2) a draw = half a tick</b> (wins ~half the time). Then compare to
          what you need to call ↓.
        </p>

        <h4 className="cs-subhead">③ What do you NEED? (pot odds)</h4>
        <p className="modal-note">
          Compare your equity to what the bet lays you: <b>equity ≥ the number below → call</b>, under → fold.
          <span className="muted"> need = bet ÷ (pot + 2·bet)</span>
        </p>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr><th>he bets…</th><th>you need to call</th></tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">¼ pot</td><td className="cs-good">17%</td></tr>
              <tr><td className="cs-hero">⅓ pot</td><td className="cs-good">20%</td></tr>
              <tr><td className="cs-hero">½ pot</td><td className="cs-good">25%</td></tr>
              <tr><td className="cs-hero">⅔ pot</td><td className="cs-mid">29%</td></tr>
              <tr><td className="cs-hero">¾ pot</td><td className="cs-mid">30%</td></tr>
              <tr><td className="cs-hero">pot</td><td className="cs-mid">33%</td></tr>
              <tr><td className="cs-hero">1½ pot</td><td className="cs-bad">37%</td></tr>
              <tr><td className="cs-hero">2× pot (overbet)</td><td className="cs-bad">40%</td></tr>
            </tbody>
          </table>
        </div>
        <p className="cs-gut">
          💡 Putting it together — your 9♠6♣ read (~35%): he bets ⅓ (need 20) → <b>call</b>. He bets ⅔ (need 29) →
          close; <b>fold</b> vs a value-heavy bettor, call vs a bluffy one (his bluffs swell the hands you beat).
        </p>

        <h4 className="cs-subhead">The bucket anchor <span className="cs-width">rough gut-check — the tick method above is the real one</span></h4>
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
                <th>he bet? your hand…</th>
                <th>facing the bet</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">Strong made (two pair+, overpair, top pair TOP kicker)</td><td className="cs-bad">−15 · only −½ vs a WIDE range</td></tr>
              <tr><td className="cs-hero">Marginal made (weak-kicker top pair, 2nd pair on a pair)</td><td className="cs-bad">FULL −15 — dominated, even vs WIDE</td></tr>
              <tr><td className="cs-hero">Pure bluff-catcher (weak / 2nd pair, air)</td><td className="cs-bad">≈ his bluff % (table ↓)</td></tr>
              <tr><td className="cs-hero">Draw</td><td className="cs-bad">cut ⅓ (dirty outs)</td></tr>
            </tbody>
          </table>
        </div>
        <p className="modal-note">
          Bigger bet = bigger cut (⅓ pot small · pot+ big). A bet just means <b>"he got tighter."</b> The <b>−½ vs WIDE</b>
          discount is for <b>STRONG</b> hands only — two pair beats a wide range's weak value, so it barely drops (a station's
          wide ⅔ bet takes two pair down just ~4, not 15). A <b>marginal</b> hand (weak-kicker top pair, 2nd pair) is
          <b>dominated</b> by the better kickers/pairs he value-bets, so it takes the <b>FULL</b> cut even vs a wide range.
          A <b>bluffy villain</b> (maniac) narrows less → cut less.
        </p>

        <h4 className="cs-subhead">Made-hand cut, exact — base × width × (1−bluff)</h4>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>factor</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">base — bet ⅓ / ⅔ / pot+</td><td>10 / 15 / 20</td></tr>
              <tr><td className="cs-hero">× width — WIDE / TIGHT <span className="cs-width">STRONG hands only; marginal = ×1</span></td><td className="cs-mid">×0.5 / ×1.0</td></tr>
              <tr>
                <td className="cs-hero">× (1−bluff) — {BLUFFERS.map((b) => b.label.split(' ')[0]).join(' / ')}</td>
                <td className="cs-mid">{BLUFFERS.map((b) => `×${(1 - getProfile(b.id).bluffFreq).toFixed(2)}`).join(' / ')}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="modal-note">
          Ex (strong): two pair vs a <b>WIDE</b> range = 80, 🐟 station bets ⅔ → cut = <b>15 × 0.5 × 0.92 ≈ 7</b> → <b>73</b>.
          Ex (marginal): weak-kicker top pair = 72, same bet → NO ½ → cut = <b>15 × 1 × 0.92 ≈ 14</b> → <b>58</b>.
          Round each factor — it's a gut anchor. (Bluff-catchers skip this — they keep ≈ his bluff %, table above.)
        </p>

        <h4 className="cs-subhead">Villain bluff rate — a bluff-catcher's ceiling facing a bet</h4>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>villain type</th>
                <th>bluff rate</th>
                <th>weak pair vs a ⅔ bet ≈</th>
              </tr>
            </thead>
            <tbody>
              {BLUFFERS.map((b) => {
                const bf01 = getProfile(b.id).bluffFreq;
                const bf = Math.round(bf01 * 100);
                // Mirror the drill's weak-pair-vs-⅔-bet estimate (12 + bluffFreq·40 +
                // 9 wide-range air) so this column and the read stay one source.
                const keep = Math.min(99, Math.round(12 + bf01 * 40 + 9));
                return (
                  <tr key={b.id}>
                    <td className="cs-hero">{b.label}</td>
                    <td className={cell(bf + 30)}>~{bf}%</td>
                    <td className={cell(keep)}>~{keep}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="modal-note">
          A <b>pure bluff-catcher</b> (weak/2nd pair, air) beats none of his value, so facing a bet it does NOT take
          the flat −15 — it holds ≈ <b>his bluff rate + the worse pairs/air he still bets</b>. A <b>station bluffs
          ~8%</b> → near a fold; a <b>maniac ~70%</b> → you're fine. Smaller bet = wider, thinner range = a touch more.
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

        <h4 className="cs-subhead">Board texture — the made-hand rows assume a DRY board</h4>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr>
                <th>board (hand doesn't beat it)</th>
                <th>knock off</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">Connected — straight ONE card away (3-4-5-7, 6-7-8-T)</td><td className="cs-bad">−22 (a set −11)</td></tr>
              <tr><td className="cs-hero">Connected — 2-card straights live (3 in a 5-span)</td><td className="cs-bad">−10 (a set −5)</td></tr>
              <tr><td className="cs-hero">3-flush board you hold no card of</td><td className="cs-bad">−8</td></tr>
              <tr><td className="cs-hero">4-flush board you hold no card of</td><td className="cs-bad">−18</td></tr>
            </tbody>
          </table>
        </div>
        <p className="modal-note">
          The made-hand rows are <b>dry-board</b> numbers. On a wet board a hand that can't beat a straight/flush (two pair,
          one pair, even a set) is worth far less — a wide range holds the straight/flush cards. <b>Facing a bet, scale the
          hazard by (1−bluff)</b> — only a value bettor's range is loaded with the nut hands; a bluffy villain bets air you
          beat, so cut less. Checked = full hazard.
        </p>
        <p className="modal-note">
          Ex: 7-4 two pair on <b>4-3-7-5</b> (any 6 = a straight), ⅔ bet. vs 🐟 <b>station</b> (bluff 8%): −7 bet, connected
          −22×0.92 ≈ −20 → ~53. vs ⚖ <b>balanced</b> (bluff 33%): −5 bet, connected −22×0.67 ≈ −15 → ~60. The bluffs he adds
          are the ~11 pts of equity you gain.
        </p>

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

        <h4 className="cs-subhead">Slow-play (trap) — the 3 green lights <span className="cs-width">default is BET; check only when it earns MORE</span></h4>
        <p className="modal-note">
          Aggression is the default because your opponents are too passive — they don't bluff, so a check just hands a
          free card to a range that would have <i>paid</i> a bet. <b>Slow-play ONLY when a check earns more than a bet</b>,
          which needs one of these three. Vs a typical passive mid-stakes player, none hold — so you bet.
        </p>
        <div className="cs-tablewrap">
          <table className="cs-table">
            <thead>
              <tr><th>green light</th><th>why a check beats a bet</th></tr>
            </thead>
            <tbody>
              <tr><td className="cs-hero">① He bets when you check</td><td className="cs-good">An aggressor / maniac barrels his air into you. Checking hands him the lead so he bluffs the chips in — a bet folds those very bluffs out. <b>Check-raise / check-call.</b></td></tr>
              <tr><td className="cs-hero">② A bet gets zero calls from worse</td><td className="cs-good">Near-nut hand + you hold his outs / block his strong continues. A lead only folds out the hands you beat and is called by the few that beat you. Checking keeps his weak hands in.</td></tr>
              <tr><td className="cs-hero">③ Induce a bluff</td><td className="cs-mid">You look capped, he stabs at weakness. Check to let a bluffer fire, then snap. Works on a bluffer — <b>never</b> on a station.</td></tr>
            </tbody>
          </table>
        </div>
        <p className="cs-gut">
          💡 The trap costs you when you're wrong about it: a set on a wet board still <b>bets</b> — protection
          outweighs the trap, because a blank can outdraw you and a passive villain won't bet it for you. Slow-play =
          near-nut <b>+</b> an opponent who does the betting for you. Everywhere else, bet.
        </p>
        <ol className="cs-rules">
          <li><b>Check only if you can name who bets for you.</b> No aggressor behind = no trap, you're just giving free cards. This is the maniac's one gift — take it.</li>
          <li><b>Protection kills the trap.</b> If a blank flips you from ahead to behind (one pair, a bare set on a draw-heavy board), bet to deny the equity. Trap only what nothing outdraws.</li>
          <li><b>Never slow-play a station.</b> A caller won't bet for you, so a check just skips a street of value. Bet, and bet big.</li>
        </ol>

        <p className="cs-gut">
          💡 The one anchor: the <b>50% line</b> ≈ one decent pair vs a wide range, OR a big draw (flush +
          overs) vs a made hand. Read everything else as "better than that" or "worse than that."
        </p>
      </div>
    </div>
  );
}
