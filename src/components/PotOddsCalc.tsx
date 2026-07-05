import { useMemo, useState } from 'react';
import { potOdds, requiredEquityForBet, mdf } from '../engine/potOdds';
import { ruleOf2and4 } from '../engine/equity';
import { CalcLabel } from './CalcTip';

const DRAWS: [string, number][] = [
  ['Gutshot straight', 4],
  ['Two overcards', 6],
  ['Open-ended straight (OESD)', 8],
  ['Flush draw', 9],
  ['Flush + gutshot', 12],
  ['OESD + flush draw', 15],
  ['Set → full house / quads', 7],
  ['Pair → trips / two pair', 5],
];

const BET_SIZES: [string, number][] = [
  ['¼ pot', 0.25],
  ['⅓ pot', 0.33],
  ['½ pot', 0.5],
  ['⅔ pot', 0.67],
  ['¾ pot', 0.75],
  ['Full pot', 1],
  ['1.5× pot (overbet)', 1.5],
  ['2× pot', 2],
];

export function PotOddsCalc() {
  const [pot, setPot] = useState(100);
  const [call, setCall] = useState(50);
  const [outs, setOuts] = useState(9);
  const [street, setStreet] = useState(2);

  const odds = useMemo(() => potOdds(pot, call), [pot, call]);
  const equity = useMemo(() => ruleOf2and4(outs, street), [outs, street]);

  return (
    <>
      <div className="card">
        <h2>Pot Odds &amp; Equity</h2>
        <p className="sub">
          If your equity beats the pot odds you're offered, calling is +EV. Plug in real numbers from
          a hand.
        </p>
        <div className="calc-grid">
          <div>
            <h3>Pot Odds Calculator</h3>
            <label>Pot size before you call</label>
            <input type="number" value={pot} onChange={(e) => setPot(Math.max(0, +e.target.value))} />
            <label>Amount you must call</label>
            <input type="number" value={call} onChange={(e) => setCall(Math.max(0, +e.target.value))} />
            <div className="result">
              <div className="stat-lbl"><CalcLabel id="potOdds">Required equity to break even</CalcLabel></div>
              <div className="big-stat gold">{(odds.requiredEquity * 100).toFixed(1)}%</div>
              <div className="stat-lbl" style={{ marginTop: 8 }}>
                <CalcLabel id="oddsRatio">Pot odds (pot : call)</CalcLabel>
              </div>
              <div className="ratio">{call > 0 ? `${odds.oddsRatio.toFixed(2)} : 1` : '—'}</div>
            </div>
          </div>
          <div>
            <h3>Equity from Outs</h3>
            <label>Number of outs</label>
            <input type="number" value={outs} onChange={(e) => setOuts(Math.max(0, +e.target.value))} />
            <label>Cards still to come</label>
            <select value={street} onChange={(e) => setStreet(+e.target.value)}>
              <option value={2}>Flop → River (2 cards)</option>
              <option value={1}>Turn → River (1 card)</option>
            </select>
            <div className="result">
              <div className="stat-lbl"><CalcLabel id="ruleOf24">Approx. equity (Rule of 2 &amp; 4)</CalcLabel></div>
              <div className="big-stat gold">{equity}%</div>
              <div className={`verdict ${equity >= odds.requiredEquity * 100 ? 'good' : 'bad'}`}>
                {equity >= odds.requiredEquity * 100
                  ? `✓ Call is +EV — ${equity}% beats the ${(odds.requiredEquity * 100).toFixed(1)}% needed.`
                  : `✗ Fold on pot odds — ${equity}% < ${(odds.requiredEquity * 100).toFixed(
                      1,
                    )}% needed (unless implied odds are good).`}
              </div>
            </div>
          </div>
        </div>
        <div className="info-block" style={{ marginTop: 18 }}>
          <b>Rule of 2 and 4:</b> on the flop (2 cards to come) multiply outs × 4; on the turn (1 card)
          multiply outs × 2. With ≥9 outs on the flop, subtract (outs − 8) — the figures shown here already
          include that correction.
        </div>
      </div>

      <div className="card">
        <h3>Common Drawing Odds</h3>
        <table>
          <thead>
            <tr>
              <th>Draw</th>
              <th>Outs</th>
              <th>Flop→River</th>
              <th>Turn→River</th>
            </tr>
          </thead>
          <tbody>
            {DRAWS.map(([name, o]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{o}</td>
                <td className="num">{ruleOf2and4(o, 2)}%</td>
                <td className="num">{ruleOf2and4(o, 1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Pot Geometry Quick Reference</h3>
        <table>
          <thead>
            <tr>
              <th>Bet size (of pot)</th>
              <th>You're getting</th>
              <th><CalcLabel id="potGeometry" pos="bottom">Equity to call</CalcLabel></th>
              <th><CalcLabel id="potGeometry" pos="bottom">Bluffs needed</CalcLabel></th>
              <th><CalcLabel id="mdf" pos="bottom">MDF</CalcLabel></th>
            </tr>
          </thead>
          <tbody>
            {BET_SIZES.map(([name, frac]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{((1 + frac) / frac).toFixed(2)} : 1</td>
                <td className="num">{(requiredEquityForBet(frac) * 100).toFixed(1)}%</td>
                <td className="num">{(requiredEquityForBet(frac) * 100).toFixed(1)}%</td>
                <td className="num">{(mdf(1, frac) * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          <b>One number, two jobs:</b> equity-to-call = bluffs-needed = f ÷ (1 + 2f). Hover any header
          for the formula. Quick hooks: ½ pot → 25%, pot → 33%, 2× → 40%. All ignore implied odds.
        </p>
      </div>
    </>
  );
}
