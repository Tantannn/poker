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
    </>
  );
}
