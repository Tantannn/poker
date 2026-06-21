export function Reference() {
  return (
    <>
      <div className="card">
        <h2>Reference</h2>
        <div className="two-col">
          <div>
            <h3>Hand Rankings (high → low)</h3>
            <table>
              <tbody>
                <tr><td>1. Royal Flush</td><td>A K Q J T, same suit</td></tr>
                <tr><td>2. Straight Flush</td><td>5 in a row, same suit</td></tr>
                <tr><td>3. Four of a Kind</td><td>quads</td></tr>
                <tr><td>4. Full House</td><td>trips + pair</td></tr>
                <tr><td>5. Flush</td><td>5 same suit</td></tr>
                <tr><td>6. Straight</td><td>5 in a row</td></tr>
                <tr><td>7. Three of a Kind</td><td>trips / set</td></tr>
                <tr><td>8. Two Pair</td><td></td></tr>
                <tr><td>9. One Pair</td><td></td></tr>
                <tr><td>10. High Card</td><td></td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3>Common Preflop All-in Match-ups</h3>
            <table>
              <thead><tr><th>Match-up</th><th>Equity</th></tr></thead>
              <tbody>
                <tr><td>Pair vs 2 lower cards (88 vs JT)</td><td className="num">~53 / 47</td></tr>
                <tr><td>Pair vs over+under (KQ vs JJ)</td><td className="num">~57 / 43</td></tr>
                <tr><td>Overpair vs underpair (KK vs 88)</td><td className="num">~82 / 18</td></tr>
                <tr><td>Two overs vs two unders (AK vs QJ)</td><td className="num">~60 / 40</td></tr>
                <tr><td>Dominated (AK vs AQ)</td><td className="num">~72 / 28</td></tr>
                <tr><td>AA vs KK</td><td className="num">~82 / 18</td></tr>
                <tr><td>Coin flip (AK vs QQ)</td><td className="num">~57 / 43</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Reading equity fast</h3>
        <p className="sub">
          Equity = your share of the pot if all chips went in now. The HUD gets it by dealing the
          run-out thousands of times and counting — but you can ballpark it at the table.
        </p>
        <div className="two-col">
          <div>
            <h4>The formula</h4>
            <ul className="tips">
              <li><b>equity = win% + ½ × tie%</b></li>
              <li><b>win%</b> = how often you end with the best hand. <b>tie%</b> = how often you chop.</li>
              <li>A tie only returns half the pot, so it counts <b>half</b>. Ties are already baked in —
                never add them on top.</li>
              <li>Example: won 924, tied 0, lost 476 of 1400 → 924/1400 = <b>66%</b>.</li>
            </ul>
            <h4>Drawing hands — Rule of 2 &amp; 4</h4>
            <ul className="tips">
              <li><b>Flop (2 cards to come):</b> outs × 4.</li>
              <li><b>Turn (1 card to come):</b> outs × 2.</li>
              <li>With <b>9+ outs on the flop</b>, shave ~1–2% — the ×4 slightly over-counts.</li>
            </ul>
          </div>
          <div>
            <h4>Out counts to memorize</h4>
            <table>
              <tbody>
                <tr><td>Flush draw</td><td className="num">9 → ~36% flop</td></tr>
                <tr><td>Open-ender (OESD)</td><td className="num">8 → ~32%</td></tr>
                <tr><td>Two overcards</td><td className="num">6 → ~24%</td></tr>
                <tr><td>Gutshot</td><td className="num">4 → ~16%</td></tr>
                <tr><td>Flush + gutshot</td><td className="num">12 → ~45%</td></tr>
              </tbody>
            </table>
            <h4>Then check the price</h4>
            <p className="sub">
              Call when your equity ≥ <b>call ÷ (pot + call)</b>. By bet size:
            </p>
            <ul className="tips">
              <li>⅓-pot → need <b>20%</b> · ½ → <b>25%</b> · ¾ → <b>30%</b> · pot → <b>33%</b> · 2× → <b>40%</b>.</li>
              <li>Hook: <b>count outs → ×4 (or ×2) → compare to the price.</b></li>
            </ul>
          </div>
        </div>

        <h4>Eyeballing equity vs a range</h4>
        <p className="sub">
          You can't compute it exactly in your head — it's an average over <i>every</i> hand they can
          hold. The hook: <b>"what fraction of their range am I ahead of right now — plus my draw?"</b>
        </p>
        <div className="two-col">
          <div>
            <p className="sub"><b>Method — "Ahead? then Outs":</b></p>
            <ul className="tips">
              <li><b>1. Ahead or behind</b> their range? Made hand that beats most of it → start high; behind → start low.</li>
              <li><b>2. Add the draw</b> — clean outs × 2 per card to come, but <b>halve weak outs</b> (pairs that don't beat a bettor).</li>
              <li><b>3. Land on the ladder</b> → read off the rough %.</li>
            </ul>
            <p className="sub">
              Made-hand equity comes from the <b>ladder</b>; draw equity from <b>outs</b> — discounted. That's
              why 14 outs can still be only ~25% when half are weak pairs.
            </p>
          </div>
          <div>
            <h4>The equity ladder</h4>
            <table>
              <tbody>
                <tr><td>Nuts / near-nuts</td><td className="num">85%+</td></tr>
                <tr><td>Two pair, sets, strong made</td><td className="num">70–80%</td></tr>
                <tr><td>Top pair good kicker</td><td className="num">55–65%</td></tr>
                <tr><td>Middle / weak top pair</td><td className="num">40–50%</td></tr>
                <tr><td>Flush or open-ender</td><td className="num">30–40%</td></tr>
                <tr><td>Gutshot / two overcards</td><td className="num">15–25%</td></tr>
                <tr><td>Air, no draw</td><td className="num">&lt;15% → fold</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Remembering the charts vs each position</h3>
        <p className="sub">
          Don't memorize 169 cells per chart — memorize the <b>skeleton</b>, then adjust by who you're
          facing. Every chart is built from the same parts; only the width changes.
        </p>
        <div className="two-col">
          <div>
            <h4>Opening (RFI) — one range, stretched by seat</h4>
            <p className="sub">
              The base is always <b>pairs (22+)</b> + <b>suited aces</b> + <b>suited Broadways</b>. As you
              move later, you add a layer outward — never reshuffle, just widen:
            </p>
            <ul className="tips">
              <li><b>UTG / MP</b> — premiums only: 22+, A9s+/ATo+, KTs+/AJo+, top suited connectors.</li>
              <li><b>CO</b> — add <b>all suited aces (A2s+)</b> + more suited gappers + offsuit Broadways.</li>
              <li><b>BTN</b> — add the offsuit junk: K2s+, any Ax-offsuit, T8o/98o. Widest.</li>
              <li><b>SB</b> — BTN-ish width but mixed/3-bet flavored (no one acts after you).</li>
            </ul>
            <p className="sub">
              Hook: <b>"the later you sit, the more offsuit + small-suited gets unlocked."</b> Pairs and
              suited aces are in every seat; offsuit hands are the last to join.
            </p>
          </div>
          <div>
            <h4>Facing a raise — three buckets</h4>
            <p className="sub">Whether vs an open (3-bet) or vs a 3-bet (4-bet), every hand sorts into one of three:</p>
            <ul className="tips">
              <li><b>Value (raise):</b> hands that beat their range. Tight vs early opens (QQ+/AK vs UTG),
                wider vs late opens (TT+/AJs/KQs vs BTN/CO).</li>
              <li><b>Bluffs = blockers:</b> almost always <b>suited wheel aces (A5s–A2s)</b> + suited Broadway
                gappers (KJs, QTs, J9s). They block villain's AA/AK and have backup equity.</li>
              <li><b>Calls = playability:</b> medium pairs, suited Broadways, suited connectors — hands that
                flop well rather than raw blockers.</li>
            </ul>
            <p className="sub">
              Two dials to remember the rest: <b>value &amp; call ranges widen the looser the opener is</b>
              (BTN/CO/SB open → you defend wider), and <b>bluffs are the same blocker family every time.</b>
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Why position wins (and how to open)</h3>
        <div className="two-col">
          <div>
            <h4>Position = free equity</h4>
            <p className="sub">
              Acting last every street, the same hand is worth more. You see their action first, control
              the final pot size, get thin value, and fold less to bets you saw coming.
            </p>
            <ul className="tips">
              <li>Rough rule: in position a hand realizes <b>~110%</b> of its raw equity; out of position
                <b> ~85%</b>. That swing is why late seats open so much wider.</li>
              <li>It's a ballpark, not a constant — but it's why <b>IP &gt; OOP</b> with the identical hand.</li>
            </ul>
          </div>
          <div>
            <h4>Open sizing</h4>
            <ul className="tips">
              <li><b>6-max online:</b> 2.5bb. <b>9-max online:</b> 2.5–3bb.</li>
              <li><b>Live cash:</b> 3bb minimum, often 4–5bb (callers are looser, so charge more).</li>
              <li><b>+1bb per limper</b> — limpers don't fold, so size up to punish.</li>
              <li><b>Never limp first in</b> — it caps your range and surrenders initiative.</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>3-betting & facing a 3-bet</h3>
        <div className="two-col">
          <div>
            <h4>Why 3-bet light at all?</h4>
            <p className="sub">
              If you only 3-bet QQ+/AK, opponents fold trash and play perfectly against you — your AA wins
              a measly 3bb. Adding <b>bluff 3-bets (blockers)</b> creates fold equity, gets your value paid,
              and scoops dead money preflop.
            </p>
            <h4>Sizing</h4>
            <ul className="tips">
              <li><b>In position:</b> ~3× the open (3bb → 9bb).</li>
              <li><b>Out of position:</b> ~4× the open (3bb → 12bb) — more fold equity / higher SPR to simplify.</li>
              <li><b>Squeeze (raiser + caller):</b> 4–5× the raise, +1× per caller.</li>
            </ul>
          </div>
          <div>
            <h4>Facing a 3-bet — four buckets</h4>
            <ul className="tips">
              <li><b>4-bet value:</b> AA, KK, AKs always; add QQ/AKo as they 3-bet wider; JJ vs aggressive 3-bettors.</li>
              <li><b>4-bet bluff:</b> A5s–A3s — block AA/AK, have a flush backup, unblock their folds.</li>
              <li><b>Call (playability):</b> pairs that set-mine, suited connectors IP, suited Broadways.</li>
              <li><b>Fold dominated junk:</b> AQo vs UTG, AJs/AJo vs early, KQo vs almost any 3-bet.</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Blind defense, multiway & short stacks</h3>
        <div className="two-col">
          <div>
            <h4>Blind defense</h4>
            <p className="sub">
              BB has the worst position but the best price (1bb already in) — so defend wide, mostly by
              <b> calling</b>. Tighten the earlier the opener sat:
            </p>
            <ul className="tips">
              <li><b>vs BTN open (2.5bb):</b> defend ~40%+ · <b>vs CO:</b> ~33% · <b>vs MP:</b> ~25% · <b>vs UTG:</b> ~18%.</li>
              <li><b>SB:</b> mostly <b>3-bet or fold</b> — flat-calling OOP vs the BB is a long-term loser.</li>
            </ul>
          </div>
          <div>
            <h4>Multiway (3+ players)</h4>
            <ul className="tips">
              <li>Tighten value, widen <b>implied-odds</b> hands: suited + connectors gain (flushes/straights), set-mining gains.</li>
              <li>High-card hands (AQo) and <b>bluffs</b> lose almost all value — someone always has a piece.</li>
            </ul>
            <h4>Short stack (≤40bb)</h4>
            <ul className="tips">
              <li>Suited connectors lose value (can't realize implied odds); pairs &amp; big cards gain.</li>
              <li>3-bet becomes <b>3-bet-or-fold</b>; open-<b>shoving</b> is correct under ~15bb.</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="two-col">
          <div>
            <h3>Postflop in three questions</h3>
            <ul className="tips">
              <li><b>Whose range is this board better for?</b> Aggressor or caller?</li>
              <li><b>What's my plan?</b> Value, bluff, pot control, or give up.</li>
              <li><b>What does betting accomplish?</b> Called by worse, fold out better/equity, or build the pot.</li>
            </ul>
            <h3>C-bet quick rules</h3>
            <ul className="tips">
              <li><b>Dry boards</b> (K72r): bet small (⅓), high frequency.</li>
              <li><b>Wet boards</b> (987ss): polarize, bet bigger with value + draws.</li>
              <li><b>In position</b> c-bet wider; out of position check more.</li>
              <li>Check more when the board favors the caller (low connected from the blinds).</li>
            </ul>
          </div>
          <div>
            <h3>SPR (Stack-to-Pot Ratio)</h3>
            <ul className="tips">
              <li><b>Low (&lt;3):</b> commit with top pair+ / overpairs.</li>
              <li><b>Medium (3–6):</b> two pair+ wants it in; one pair plays 1–2 streets.</li>
              <li><b>High (&gt;6):</b> need stronger hands to stack off; pot-control more.</li>
            </ul>
            <h3>Glossary</h3>
            <p><span className="pill">RFI</span> Raise First In.</p>
            <p><span className="pill">EV</span> Expected Value.</p>
            <p><span className="pill">Outs</span> Cards that improve you.</p>
            <p><span className="pill">Equity</span> % chance to win now.</p>
            <p><span className="pill">MDF</span> Minimum Defense Frequency.</p>
            <p><span className="pill">SPR</span> Stack-to-Pot Ratio.</p>
            <p><span className="pill">3-bet</span> A re-raise of the open.</p>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Board texture playbook</h3>
        <p className="sub">
          Before any flop decision, read the texture. It sets who has <b>range advantage</b> (more equity
          overall) and <b>nut advantage</b> (more of the very best hands) — which together set your size.
        </p>
        <div className="two-col">
          <div>
            <h4>The five textures</h4>
            <ul className="tips">
              <li><b>Dry / high</b> (K72r, A84r): raiser's range advantage. Small bets, high frequency.</li>
              <li><b>Wet / dynamic</b> (T98ss, 765): equities swing; caller often catches up. Polarize.</li>
              <li><b>Monotone</b> (K♠7♠2♠): flushes made, draws everywhere. Bet smaller / less often.</li>
              <li><b>Paired high</b> (KK4, AA7): huge range advantage — they rarely have trips. Bet small, often.</li>
              <li><b>Connected middling</b> (765, 987): favors BB defender. Check most, bet only strong.</li>
            </ul>
            <p className="sub">
              <b>Size follows advantage:</b> range+nut → any size (small is fine) · range only → small to deny
              equity · nut only → big &amp; polar (or check) · neither → check most.
            </p>
          </div>
          <div>
            <h4>C-bet by texture (IP vs BB)</h4>
            <table>
              <thead><tr><th>Board</th><th>Freq</th><th>Size</th></tr></thead>
              <tbody>
                <tr><td>Dry high (K72r)</td><td className="num">70–85%</td><td className="num">25–33%</td></tr>
                <tr><td>Paired high (KK4)</td><td className="num">80–90%</td><td className="num">25–33%</td></tr>
                <tr><td>Low dry (532r)</td><td className="num">60–70%</td><td className="num">25–33%</td></tr>
                <tr><td>Wet/dynamic (T98ss)</td><td className="num">40–55%</td><td className="num">66–80%</td></tr>
                <tr><td>Monotone</td><td className="num">30–40%</td><td className="num">33–50%</td></tr>
                <tr><td>Connected (765)</td><td className="num">30–40%</td><td className="num">33–50%</td></tr>
              </tbody>
            </table>
            <p className="sub">
              <b>OOP:</b> c-bet less, build a check-range. <b>Multiway:</b> drop to ~30–40% and only with real
              value or strong draws — bluffs barely work when someone always has a piece.
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>The turn: pivot street</h3>
        <p className="sub">
          One question runs the turn: <b>did this card help my range or theirs?</b> Bet bigger than the flop
          (66–80%) — the pot's grown and you're charging draws with one street left.
        </p>
        <div className="two-col">
          <div>
            <h4>Barrel (second bullet)</h4>
            <ul className="tips">
              <li><b>Always:</b> you improved; the card hits your range &amp; misses theirs (K on K72r); scare
                cards that favor you (A on K72r).</li>
              <li><b>Sometimes:</b> card changes little but you have equity (overcards + backdoor); their flop
                call range is weak.</li>
              <li><b>Give up:</b> the card brings draws <i>they</i> have (J on K72r → JT/QJ); low cards on low
                boards; they check-raised the flop.</li>
            </ul>
          </div>
          <div>
            <h4>Facing a turn check-raise</h4>
            <p className="sub">
              A flop-call → turn-check-raise is one of the strongest lines: slowplayed sets, turned two pair,
              draws that got there. <b>Fold marginal hands</b>; continue only with strong value (top pair top
              kicker minimum) or big draws.
            </p>
            <h4>Floating &amp; probing</h4>
            <ul className="tips">
              <li><b>Float</b> (call to steal later) only <b>in position</b>, with backdoors/blockers, when the
                board fits your story.</li>
              <li><b>Probe</b> the turn ~30–40% when the raiser checks the flop behind (50–66% sizing).</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>River: value, bluff, or fold</h3>
        <p className="sub">
          No more cards — you have <b>0% equity unless you hold the best hand</b>. Only two reasons to bet:
          <b> value</b> (worse calls) or <b>bluff</b> (better folds). "Protection" and "for info" aren't reasons.
        </p>
        <div className="two-col">
          <div>
            <h4>Betting</h4>
            <ul className="tips">
              <li><b>Value:</b> bet only if you beat ≥50% of their calling range. Capped at one pair → 50–66%;
                they can have monsters → thin 33–50% or check-call.</li>
              <li><b>Calling station?</b> Size up (75–100%+); they call anyway. <b>Never bluff a station.</b></li>
              <li><b>Bluff</b> only if your line tells a credible story <i>and</i> you hold blockers to their value.</li>
              <li><b>Match sizes:</b> bluff the same size you'd value-bet — mixed sizes are a tell.</li>
            </ul>
          </div>
          <div>
            <h4>Facing a bet (bluff-catching)</h4>
            <ul className="tips">
              <li>Check three things: <b>MDF</b> (am I folding too much?), <b>blockers</b> (do I block their
                value?), <b>story</b> (where are the bluffs?).</li>
              <li><b>Low/mid stakes:</b> villains under-bluff → fold more than MDF says.</li>
            </ul>
            <h4>Sunk-cost discipline</h4>
            <p className="sub">
              The #1 river leak: "I've put so much in, I have to call." The pot isn't yours anymore. Only the
              <b> current</b> decision matters: a 200 call to win 1000 needs <b>17%</b> equity — if you have
              10%, fold, no matter what you put in earlier.
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Bluff frequency &amp; blockers</h3>
        <div className="two-col">
          <div>
            <h4>How often to bluff (river, balanced)</h4>
            <p className="sub">
              <b>bluff% = bet ÷ (pot + 2 × bet)</b>. Bigger bets allow more bluffs:
            </p>
            <table>
              <thead><tr><th>Bet size</th><th>Bluff %</th></tr></thead>
              <tbody>
                <tr><td>⅓ pot</td><td className="num">20%</td></tr>
                <tr><td>½ pot</td><td className="num">25%</td></tr>
                <tr><td>¾ pot</td><td className="num">30%</td></tr>
                <tr><td>Pot</td><td className="num">33%</td></tr>
                <tr><td>1.5× pot</td><td className="num">38%</td></tr>
                <tr><td>2× pot</td><td className="num">40%</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <h4>Combos &amp; blockers</h4>
            <ul className="tips">
              <li><b>6</b> combos per pocket pair · <b>16</b> per unpaired hand (<b>4</b> suited + <b>12</b> offsuit).</li>
              <li><b>Good bluff blockers:</b> hold a card that kills their value — the A♠ on a spade board
                (blocks the nut flush), a straight card, top-pair kicker.</li>
              <li><b>Unblock their folds:</b> bluffing a <i>missed</i> draw is great — they can't hold it, so
                your bluff doesn't fold out their busted hands.</li>
              <li><b>Read by elimination:</b> put them on a <i>range</i>, then remove hands their line rules out
                — never one specific hand.</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Coolers: when one pair is in trouble</h3>
        <p className="sub">
          The fastest way to lose a stack is paying off a <b>set</b> (a pocket pair that flopped trips)
          with one pair. You can't dodge every cooler — but you can stop them from costing 100bb.
        </p>
        <div className="two-col">
          <div>
            <h4>Why sets cost so much</h4>
            <ul className="tips">
              <li>A pocket pair flops a set <b>~1 in 8.5 (11.8%)</b> — rare enough to forget, common enough to sting.</li>
              <li><b>Disguised:</b> dry boards (K-7-2) make top pair / overpair feel huge while a set hides underneath.</li>
              <li>One pair — <b>even an overpair</b> — is still one pair. It's a 1–2 street hand, not a stack-off hand on a raised board.</li>
            </ul>
            <h4>Read the aggression</h4>
            <ul className="tips">
              <li>A <b>passive player who suddenly raises / check-raises a dry board</b> rarely bluffs — believe sets & two pair.</li>
              <li>Min-raises and "weird" lines on boards with no draws scream made hand. Slow down.</li>
            </ul>
          </div>
          <div>
            <h4>Lose less to coolers</h4>
            <ul className="tips">
              <li><b>Pot control:</b> high SPR + one pair → keep the pot small, don't bloat it to 100bb.</li>
              <li><b>SPR plan up front:</b> decide on the flop whether one pair is stacking off — usually only at SPR &lt; 3.</li>
              <li>Top pair good kicker vs a big turn/river raise on a dry board is often a <b>fold</b>, not a crying call.</li>
            </ul>
            <h4>Set-mining (the other side)</h4>
            <ul className="tips">
              <li>Call a small pair to flop your own set only with <b>implied odds ≈ 10–15× the call</b> sitting in the stacks.</li>
              <li>You'll miss ~88% of the time — so the 12% has to pay big, or fold preflop.</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
