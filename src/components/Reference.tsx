import { useState, type ReactNode } from 'react';
import { SizingCheatSheet } from './SizingCheatSheet';

// Section table-of-contents — drives the sticky jump nav and the collapse-all
// control. Order here = render order below; each id matches a <Section id>.
const SECTIONS: { id: string; title: string }[] = [
  { id: 'tilt', title: '🧊 Tilt control — protect your stack' },
  { id: 'rankings', title: 'Hand rankings & all-in match-ups' },
  { id: 'equity', title: 'Reading equity fast' },
  { id: 'memorize', title: 'Memorizing the charts by position' },
  { id: 'shorthanded', title: 'Short-handed: one ladder' },
  { id: 'position', title: 'Why position wins' },
  { id: 'threebet', title: '3-betting & facing a 3-bet' },
  { id: 'blinds', title: 'Blind defense, multiway & short stacks' },
  { id: 'postflop', title: 'Postflop fundamentals & glossary' },
  { id: 'cheatsheet', title: '📐 Postflop decision cheat sheet' },
  { id: 'texture', title: 'Board texture playbook' },
  { id: 'turn', title: 'The turn: pivot street' },
  { id: 'river', title: 'River: value, bluff, or fold' },
  { id: 'bluffing', title: '🃏 How to bluff — semi-bluff, fold equity & blockers' },
  { id: 'coolers', title: 'Coolers: one pair in trouble' },
  { id: 'reverse', title: 'Reverse implied odds' },
  { id: 'shape', title: 'Range shape, capping & foundations' },
  { id: 'bots', title: 'How the bots play' },
];

function Section({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`card ref-section ${open ? 'open' : 'closed'}`}>
      <button type="button" className="ref-sec-head" onClick={onToggle} aria-expanded={open}>
        <span className="ref-caret">{open ? '▾' : '▸'}</span>
        <h2>{title}</h2>
      </button>
      {open && <div className="ref-sec-body">{children}</div>}
    </section>
  );
}

export function Reference() {
  // collapsed ids; everything open by default. A Set keeps toggle/expand-all simple.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isOpen = (id: string) => !collapsed.has(id);
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(SECTIONS.map((s) => s.id)));
  // jump nav: ensure the target is open, then scroll it into view.
  const jump = (id: string) => {
    setCollapsed((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <>
      <nav className="ref-nav">
        <div className="ref-nav-actions">
          <span className="ref-nav-label">Jump to</span>
          <button type="button" onClick={expandAll}>Expand all</button>
          <button type="button" onClick={collapseAll}>Collapse all</button>
        </div>
        <div className="ref-nav-links">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="ref-nav-link" onClick={() => jump(s.id)}>
              {s.title}
            </button>
          ))}
        </div>
      </nav>

      <Section id="tilt" title="🧊 Tilt control — protect your stack" open={isOpen('tilt')} onToggle={() => toggle('tilt')}>
        <p className="sub">
          Tilt is emotion overriding strategy after a swing — and it loses more money than any range leak.
          The classic pattern: you double up, feel invincible (or get cracked and go on the chase), then
          dump the whole stack in one hand trying to force a result. One bad ten minutes can erase a good
          session. The math doesn't change when you're losing — <b>only your discipline does.</b>
        </p>
        <div className="two-col">
          <div>
            <h4>Spot it early — the tells</h4>
            <ul className="tips">
              <li><b>Speeding up:</b> snap-calling and auto-dealing the next hand without reading the spot.</li>
              <li><b>Sizing up to get even:</b> firing bigger than the situation calls for to "win it back fast".</li>
              <li><b>Curiosity calls:</b> paying off rivers "to see if he has it" — you already know.</li>
              <li><b>Range creep:</b> opening junk, defending too wide, 4-betting light out of frustration.</li>
              <li><b>Ignoring the reads:</b> the HUD/solver says fold, the gut says "not this time."</li>
            </ul>
            <h4>The sunk-cost trap</h4>
            <p className="sub">
              The single biggest tilt leak: <b>"I've lost so much, I have to win it back this hand."</b> You
              can't. Last hand's chips are gone the instant the pot is pushed — they aren't on the table
              anymore. Every hand is independent: a 200 call to win 1000 needs <b>17% equity</b> whether you're
              up three buy-ins or down five. The pot doesn't know your session, and neither should you.
            </p>
          </div>
          <div>
            <h4>How to control it</h4>
            <ul className="tips">
              <li><b>Stop &amp; breathe:</b> 30–60 seconds away from the table breaks the impulse loop. Stand up.</li>
              <li><b>Standard sizing:</b> never bet bigger to force action — that's spew wearing a value mask.</li>
              <li><b>One hand at a time:</b> play the hand in front of you on its own merits. Read equity, pot
                odds and the solver before you act — let the math drive, not the gut.</li>
              <li><b>Set a stop-loss:</b> decide a number <i>before</i> you sit (e.g. 2–3 buy-ins). Hit it → quit
                for the day. The money doesn't know you're stuck; chasing only deepens the hole.</li>
              <li><b>Win-tilt is real too:</b> after a big win, players spew "house money." Treat your stack the
                same whether you just doubled or just got stacked.</li>
            </ul>
            <p className="sub">
              Hook: <b>"the result of the last hand is the worst possible input to the next one."</b> Reset to
              zero every deal.
            </p>
          </div>
        </div>

        <div className="note-block">
          <h4>The app's Tilt Guard (Play tab)</h4>
          <p className="sub">
            The trainer watches for tilt and steps in — so you practise the <i>discipline</i>, not just the
            strategy. It reads four signals off your session:
          </p>
          <ul className="tips">
            <li><b>A big single-hand loss</b> — you just got stacked or punted off a large pot.</li>
            <li><b>A losing streak</b> — several losing hands in a row, frustration building.</li>
            <li><b>A drawdown</b> — how far below your session peak you've dropped (in buy-ins).</li>
            <li><b>Quality slipping</b> — your error rate spiking right after a loss. The real behavioural tell.</li>
          </ul>
          <p className="sub">
            Those drive a <b>tilt meter</b> and a banner with a grounding checklist. After a big swing the
            <b> cool-off gate</b> blocks the next deal: you either take a timed 30-second break or explicitly
            choose to play on — so the next hand is a <i>decision</i>, not autopilot. Watch the
            <b> Current downswing</b> line on the session scorecard for the same signal in numbers.
          </p>
        </div>
      </Section>

      <Section id="rankings" title="Hand rankings & all-in match-ups" open={isOpen('rankings')} onToggle={() => toggle('rankings')}>
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
            <p className="sub">
              <b>Hook:</b> rarer = stronger. Only two trip people up — a <b>flush beats a straight</b> (five
              of a suit is rarer than five in a row) and a <b>full house beats a flush</b>. Chant the
              confusable middle: <i>straight → flush → full house → quads</i>.
            </p>
          </div>
          <div>
            <h3>Common Preflop All-in Match-ups</h3>
            <table>
              <thead><tr><th>Match-up</th><th>Equity</th></tr></thead>
              <tbody>
                <tr><td>Pair vs 2 overcards (88 vs JT)</td><td className="num">~53 / 47</td></tr>
                <tr><td>Pair vs over+under (JJ vs AT)</td><td className="num">~70 / 30</td></tr>
                <tr><td>Overpair vs underpair (KK vs 88)</td><td className="num">~82 / 18</td></tr>
                <tr><td>Two overs vs two unders (AK vs QJ)</td><td className="num">~60 / 40</td></tr>
                <tr><td>Dominated (AK vs AQ)</td><td className="num">~72 / 28</td></tr>
                <tr><td>AA vs KK</td><td className="num">~82 / 18</td></tr>
                <tr><td>Coin flip (QQ vs AK)</td><td className="num">~57 / 43</td></tr>
              </tbody>
            </table>
            <p className="sub">
              <b>Hook:</b> three landmarks and everything else falls between. A <b>race</b> (pair vs two
              overs) ≈ <b>55/45</b>; <b>domination</b> (a card shared, AK vs AQ) ≈ <b>70/30</b>; <b>pair over
              pair</b> (AA vs KK, KK vs 88) ≈ <b>80/20</b>.
            </p>
          </div>
        </div>
      </Section>

      <Section id="equity" title="Reading equity fast" open={isOpen('equity')} onToggle={() => toggle('equity')}>
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
            <p className="sub">
              <b>Hook:</b> memorize three out-counts — <b>9 = flush, 8 = OESD, 4 = gutshot</b> (two overcards
              ≈ 6). Then ×4 flop / ×2 turn. The flush draw is your yardstick: ~<b>2-to-1 against</b> (~36%) on
              the flop.
            </p>
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
            <h4>The equity ladder <span className="sub">(POSTFLOP — your hand vs the board)</span></h4>
            <p className="sub">
              These rungs describe a <b>made hand relative to the community cards</b>. They only exist once
              there's a flop — "top pair", "set", "two pair" all reference the board.
            </p>
            <table>
              <thead>
                <tr><th>Hand strength</th><th className="num">Equity</th><th>Example (your cards → board)</th></tr>
              </thead>
              <tbody>
                <tr><td>Nuts / near-nuts</td><td className="num">85%+</td><td>7♦7♠ → 7♣9♠2♦ (flopped set); nut flush</td></tr>
                <tr><td>Two pair, overpair, strong made</td><td className="num">70–80%</td><td>A♣K♦ → A♠K♣4♥ (two pair); T♥T♠ → 7♦5♣2♠ (overpair)</td></tr>
                <tr><td>Top pair good kicker</td><td className="num">55–65%</td><td>A♣K♦ → K♠8♦3♣ (pairs the <b>highest</b> board card, ace kicker)</td></tr>
                <tr><td>Middle / weak top pair</td><td className="num">40–50%</td><td>K♦J♠ → A♣J♦4♥ (pair <b>below</b> the top card); 7♦7♠ → 9♣4♦2♠ (pair below the top card)</td></tr>
                <tr><td>Flush draw or open-ender</td><td className="num">30–40%</td><td>A♥5♥ → K♥8♥2♣ (flush draw); 9♠8♠ → 7♦6♣2♥ (open-ended straight draw)</td></tr>
                <tr><td>Gutshot / two overcards</td><td className="num">15–25%</td><td>J♠T♠ → Q♦8♣3♥ (gutshot, need a 9); A♦Q♣ → 9♠5♦2♣ (two overcards)</td></tr>
                <tr><td>Air, no draw</td><td className="num">&lt;15% → fold</td><td>7♦2♣ → K♠9♦4♥ (missed everything)</td></tr>
              </tbody>
            </table>
            <p className="sub">
              <b>Hook:</b> each rung down ≈ <b>15% less</b>. Anchor three and interpolate: <b>top pair ≈
              60%</b>, a <b>big draw ≈ 35%</b>, a <b>gutshot ≈ 20%</b>. The draw rungs are <b>flop</b> numbers
              (two cards to come) — roughly halve them on the turn.
            </p>
          </div>
        </div>

        <div className="note-block">
          <h4>Pocket pairs: where do they land?</h4>
          <p className="sub">
            A pocket pair (e.g. <b>7♦7♠</b>) is <b>not</b> on the ladder by itself preflop — it's just one pair,
            roughly a coin-flip vs two overcards and often <i>behind</i> a tight opening range (which is heavy with
            bigger pairs and big aces). That's why 77 reads ~47% equity-vs-range preflop, not 70%. Which rung it
            climbs to is decided by the <b>flop</b>:
          </p>
          <table>
            <thead>
              <tr><th>Flop vs 7♦7♠</th><th>Becomes</th><th className="num">Rung</th></tr>
            </thead>
            <tbody>
              <tr><td>a 7 hits — 7♣K♦4♠</td><td><b>Set</b></td><td className="num">85%+</td></tr>
              <tr><td>all undercards — 5♣3♦2♠</td><td><b>Overpair</b></td><td className="num">70–80%</td></tr>
              <tr><td>one overcard — 9♣4♦2♠</td><td>pair below top card</td><td className="num">40–50%</td></tr>
              <tr><td>two+ overcards — K♠Q♦5♣</td><td><b>Underpair</b> (air-ish)</td><td className="num">&lt;40%</td></tr>
            </tbody>
          </table>
          <p className="sub">
            <b>Hook:</b> just <b>count the overcards</b> on the flop — <b>0</b> = overpair (70–80%), <b>1</b> =
            pair below top (40–50%), <b>2+</b> = underpair / air. Pairing your own card instead = a <b>set</b>
            (85%+).
          </p>
          <p className="sub">
            Same idea for "top pair good kicker": your hole card must pair the board's <b>highest</b> card. 77 can
            only be top pair if the biggest card on the board is a 7.
          </p>
        </div>
      </Section>

      <Section id="memorize" title="Memorizing the charts by position" open={isOpen('memorize')} onToggle={() => toggle('memorize')}>
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
              <li><b>UTG / MP</b> — premiums only: 22+, A9s+/AJo+, KTs+/KQo, top suited connectors.</li>
              <li><b>CO</b> — add <b>all suited aces (A2s+)</b> + more suited gappers + offsuit Broadways.</li>
              <li><b>BTN</b> — add the junk: any suited king (K2s+), any offsuit ace, T8o/98o. Widest.</li>
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
      </Section>

      <Section id="shorthanded" title="Short-handed: one ladder, not new charts" open={isOpen('shorthanded')} onToggle={() => toggle('shorthanded')}>
        <p className="sub">
          A position isn't a name — it's <b>how many players still act behind you</b>. So you only ever
          memorize the <b>6-max ladder once</b>; every shorter table (5-max down to heads-up) reads off the
          <b> same ranges</b> by behind-count. The trainer does exactly this and tells you the equivalent in
          the solver panel — e.g. <i>"UTG open (plays like MP)"</i>. <b>No new charts to learn.</b>
        </p>
        <div className="two-col">
          <div>
            <h4>The ladder — players behind → how wide you open</h4>
            <table>
              <thead><tr><th className="num">Behind</th><th>Seat</th><th>Open width</th></tr></thead>
              <tbody>
                <tr><td className="num">0</td><td>BB</td><td>defends, never opens (last to act)</td></tr>
                <tr><td className="num">1</td><td>SB</td><td>widest (no one behind)</td></tr>
                <tr><td className="num">2</td><td>BTN</td><td>very wide</td></tr>
                <tr><td className="num">3</td><td>CO</td><td>wide</td></tr>
                <tr><td className="num">4</td><td>MP / HJ</td><td>medium</td></tr>
                <tr><td className="num">5</td><td>UTG</td><td>tightest</td></tr>
              </tbody>
            </table>
            <p className="sub">
              Hook: <b>fewer players behind = open wider.</b> A short table just <b>deletes the front (early)
              rungs</b> — it never changes the ranges themselves.
            </p>
          </div>
          <div>
            <h4>Your seat → which 6-max range you read</h4>
            <table>
              <thead><tr><th>Table</th><th>Mapping (BB always defends)</th></tr></thead>
              <tbody>
                <tr><td><b>6-max</b></td><td>identical — UTG · MP · CO · BTN · SB</td></tr>
                <tr><td><b>5-max</b></td><td>UTG→<b>MP</b> · CO→CO · BTN→BTN · SB→SB</td></tr>
                <tr><td><b>4-max</b></td><td>UTG→<b>CO</b> · BTN→BTN · SB→SB</td></tr>
                <tr><td><b>3-max</b></td><td>BTN→BTN · SB→SB (button is first in)</td></tr>
                <tr><td><b>HU</b></td><td>button(=SB)→<b>widest open</b> · other→BB defend</td></tr>
              </tbody>
            </table>
            <p className="sub">
              <b>HU caveat:</b> a real heads-up button opens even wider (~80%+) than a 6-max BTN. The trainer
              uses the widest chart it has, so treat HU opens as <b>"even looser than the BTN range shows."</b>
            </p>
          </div>
        </div>
      </Section>

      <Section id="position" title="Why position wins (and how to open)" open={isOpen('position')} onToggle={() => toggle('position')}>
        <div className="two-col">
          <div>
            <h4>Position = free equity</h4>
            <p className="sub">
              Acting last every street, the same hand is worth more. You see their action first, control
              the final pot size, get thin value, and fold less to bets you saw coming.
            </p>
            <ul className="tips">
              <li>Rough rule: in position a hand realizes <b>~106%</b> of its raw equity; out of position
                <b> ~90%</b>. That swing is why late seats open so much wider.</li>
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
      </Section>

      <Section id="threebet" title="3-betting & facing a 3-bet" open={isOpen('threebet')} onToggle={() => toggle('threebet')}>
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
              <li><b>Out of position:</b> ~4× the open (3bb → 12bb) — more fold equity, and a lower SPR simplifies playing OOP.</li>
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
      </Section>

      <Section id="blinds" title="Blind defense, multiway & short stacks" open={isOpen('blinds')} onToggle={() => toggle('blinds')}>
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
            <h4>Deep stack (150bb+)</h4>
            <ul className="tips">
              <li><b>Implied-odds hands gain:</b> suited connectors, suited aces, small pairs (set-mine) — big
                stacks behind to win when you hit.</li>
              <li><b>Offsuit broadways lose</b> (AQo/KQo/AJo): they flop top pair with a <b>reverse-implied</b>
                problem — dominated by what stacks off. Size down, fold more OOP.</li>
              <li><b>Position &amp; nut advantage matter more</b> — deeper = more streets to be outplayed. Lean on
                IP and nutted hands; pot-control one pair.</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section id="postflop" title="Postflop fundamentals & glossary" open={isOpen('postflop')} onToggle={() => toggle('postflop')}>
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
      </Section>

      <Section id="cheatsheet" title="📐 Postflop decision cheat sheet" open={isOpen('cheatsheet')} onToggle={() => toggle('cheatsheet')}>
        <p className="sub">
          The fast decision order the trainer grades by. Read top-to-bottom; the first line that fits sets your play.
        </p>
        <SizingCheatSheet />
      </Section>

      <Section id="texture" title="Board texture playbook" open={isOpen('texture')} onToggle={() => toggle('texture')}>
        <p className="sub">
          Before any flop decision, read the texture. It sets who has <b>range advantage</b> (more equity
          overall) and <b>nut advantage</b> (more of the very best hands) — which together set your size.
        </p>
        <div className="two-col">
          <div>
            <h4>The five textures</h4>
            <ul className="tips">
              <li><b>Dry / high</b> (K72r, A84r): raiser's range advantage. Small bets, high frequency.</li>
              <li><b>Wet / dynamic</b> (T98ss, J98ss): equities swing; caller often catches up. Polarize.</li>
              <li><b>Monotone</b> (K♠7♠2♠): flushes made, draws everywhere. Bet smaller / less often.</li>
              <li><b>Paired high</b> (KK4, AA7): huge range advantage — they rarely have trips. Bet small, often.</li>
              <li><b>Connected middling</b> (765, 654): favors BB defender. Check most, bet only strong.</li>
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
      </Section>

      <Section id="turn" title="The turn: pivot street" open={isOpen('turn')} onToggle={() => toggle('turn')}>
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
      </Section>

      <Section id="river" title="River: value, bluff, or fold" open={isOpen('river')} onToggle={() => toggle('river')}>
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
      </Section>

      <Section id="bluffing" title="🃏 How to bluff — semi-bluff, fold equity & blockers" open={isOpen('bluffing')} onToggle={() => toggle('bluffing')}>
        <p className="sub">
          A bluff makes money exactly <b>one way — folds</b>. Before you fire, clear three gates:
          <b> fold equity</b> (will enough <i>better</i> hands actually fold?), a <b>credible story</b> (does
          your line represent a hand that beats what you're trying to fold out?), and <b>blockers</b> (do you
          hold cards that make their strong hands less likely?). Miss any one and a check usually beats the bet.
        </p>

        <div className="two-col">
          <div>
            <h4>Two kinds of bluff</h4>
            <ul className="tips">
              <li><b>Semi-bluff</b> — a draw with outs (flush/straight/overcards + backdoors). Wins <b>two
                ways:</b> they fold now, <i>or</i> you hit later. The workhorse — bet flop/turn draws; the equity
                is your safety net when called. <b>Keep barrelling cards that complete your draw.</b></li>
              <li><b>Pure bluff</b> — air, no outs. Wins <b>one way:</b> folds. Needs max fold equity, good
                blockers and a clean story. Best on the <b>river</b> (no cards to come) with <i>missed draws</i>
                — they have zero showdown value, so checking wins nothing anyway.</li>
            </ul>
            <p className="sub">
              Hook: <b>with outs, bet to win two ways; without outs, bet only when they'll fold.</b>
            </p>
          </div>
          <div>
            <h4>Fold equity — will THIS bluff profit? (exploitative)</h4>
            <p className="sub">
              Risk the bet to win the pot, so a bluff of size <i>s</i>×pot needs villain to fold at least
              <b> s ÷ (1 + s)</b>:
            </p>
            <table>
              <thead><tr><th>Bet size</th><th>Villain must fold ≥</th></tr></thead>
              <tbody>
                <tr><td>⅓ pot</td><td className="num">25%</td></tr>
                <tr><td>½ pot</td><td className="num">33%</td></tr>
                <tr><td>¾ pot</td><td className="num">43%</td></tr>
                <tr><td>Pot</td><td className="num">50%</td></tr>
                <tr><td>2× pot</td><td className="num">67%</td></tr>
              </tbody>
            </table>
            <p className="sub">
              Hook: <b>bigger bluff → more folds required.</b> If you can't name why they'd fold that often,
              don't fire.
            </p>
          </div>
        </div>

        <div className="two-col">
          <div>
            <h4>Board &amp; range fit — the story</h4>
            <ul className="tips">
              <li><b>Bluff boards that hit YOUR range, not theirs.</b> As the preflop raiser you hold more big
                cards — high/ace boards let you credibly rep the nuts.</li>
              <li><b>Barrel scare cards</b> that complete draws <i>you'd</i> have and miss their calling range
                (an A or a flush-completing card on the turn/river).</li>
              <li><b>Attack capped ranges</b> — a line that can't hold the nuts (flat preflop, checked the flop)
                folds to pressure. Overbet the hands they can't have.</li>
              <li><b>Don't bluff into a board that smashed them</b> — low connected boards vs a BB caller are
                <i>their</i> range, not yours.</li>
            </ul>
          </div>
          <div>
            <h4>When NOT to bluff <span className="sub">(the biggest leak)</span></h4>
            <ul className="tips">
              <li><b>Multiway.</b> Someone almost always has a piece, so fold equity collapses — bluff
                <b> heads-up, never into a field.</b> (Bottom pair 3-way is a check, not a bluff, even if a
                model shows a razor-thin edge.)</li>
              <li><b>Calling stations.</b> They don't fold — <b>value bet them, never bluff.</b></li>
              <li><b>No fold equity / low SPR.</b> A pot-committed villain can't be folded out; a bet just
                bloats a pot you'll have to show down.</li>
              <li><b>You block their folds.</b> Holding a card in their <i>folding</i> range is backwards — you
                want to block their <b>continues</b> (their value), and <b>unblock</b> the junk they'd fold.</li>
              <li><b>Your line makes no sense.</b> If you can't name the value hand you're repping, they'll call.</li>
            </ul>
          </div>
        </div>

        <div className="note-block">
          <h4>Combos &amp; blockers — picking the right air</h4>
          <div className="two-col">
            <div>
              <ul className="tips">
                <li><b>6</b> combos per pocket pair · <b>16</b> per unpaired hand (<b>4</b> suited + <b>12</b> offsuit).</li>
                <li><b>Good bluff blockers:</b> hold a card that kills their value — the <b>A♠ on a spade board</b>
                  (blocks the nut flush), a straight-completing card, a top-pair kicker.</li>
              </ul>
            </div>
            <div>
              <ul className="tips">
                <li><b>Unblock their folds:</b> the best bluff cards <i>don't</i> block the hands villain folds.
                  Missed draws make prime bluffs — zero showdown value, so a check gains nothing.</li>
                <li><b>Read by elimination:</b> put them on a <i>range</i>, then remove the hands their line rules
                  out — never one specific hand.</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="note-block">
          <h4>Called or raised — do I barrel again?</h4>
          <p className="sub">
            A flop c-bet that gets <b>called</b> or <b>raised</b> is normal — don't auto-give-up, and don't
            auto-fire. The flop bet is only <b>bullet one</b>; whether a second follows depends on <b>equity</b>
            (can this hand still improve?) and <b>story</b> (does the next card help my range or theirs?). This is
            why you should <b>pick flop bluffs that can keep barrelling</b> — draws, backdoors, overcards — not
            random air.
          </p>
          <table>
            <thead><tr><th>Villain does</th><th>You hold air (no equity)</th><th>You hold a draw / equity</th></tr></thead>
            <tbody>
              <tr><td><b>Calls</b></td><td>Give up — check/fold. One bullet, done.</td><td><b>Barrel the turn</b>, especially scare cards that favour your range.</td></tr>
              <tr><td><b>Raises</b></td><td>Fold — a raise is strong &amp; polar.</td><td><b>Continue as a semi-bluff</b> (call, sometimes re-raise): you have outs + fold equity.</td></tr>
            </tbody>
          </table>
          <p className="sub">
            Hook: <b>bluff with hands that can improve</b> — then a call or raise doesn't kill you, you still have
            outs. Pure air fires once, then let it go. (Vs a <b>calling station</b> or <b>multiway</b>, don't even
            fire bullet one — see "When NOT to bluff" above.)
          </p>
        </div>

        <div className="note-block">
          <h4>How many bluffs to <i>have</i> — balancing your betting range (GTO)</h4>
          <p className="sub">
            Separate question from "will this one profit". To stay unexploitable, a river bet of size <i>s</i>
            should be <b>bet ÷ (pot + 2 × bet)</b> bluffs — the frequency that makes a bluff-catcher exactly
            indifferent to calling. Bigger bets carry <b>more</b> bluffs:
          </p>
          <table>
            <thead><tr><th>Bet size</th><th>Bluff share</th><th>Value : bluff</th></tr></thead>
            <tbody>
              <tr><td>⅓ pot</td><td className="num">20%</td><td className="num">4 : 1</td></tr>
              <tr><td>½ pot</td><td className="num">25%</td><td className="num">3 : 1</td></tr>
              <tr><td>¾ pot</td><td className="num">30%</td><td className="num">2.3 : 1</td></tr>
              <tr><td>Pot</td><td className="num">33%</td><td className="num">2 : 1</td></tr>
              <tr><td>2× pot</td><td className="num">40%</td><td className="num">1.5 : 1</td></tr>
            </tbody>
          </table>
          <p className="sub">
            <b>Match sizes:</b> bluff the same size you value-bet — different sizes for value vs bluff is a tell.
            <b> Exploit note:</b> live low/mid-stakes players <b>under-bluff</b>, so overfold vs their big bets and
            bluff <i>them</i> a little less (they also under-fold).
          </p>
        </div>

        <p className="sub">
          Bottom line: <b>semi-bluff with equity as your net; pure-bluff only when the fold% and the blockers
          both line up; multiway or vs a station, just check.</b>
        </p>
      </Section>

      <Section id="coolers" title="Coolers: when one pair is in trouble" open={isOpen('coolers')} onToggle={() => toggle('coolers')}>
        <p className="sub">
          The fastest way to lose a stack is paying off a <b>set</b> (a pocket pair that flopped three of a kind)
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
      </Section>

      <Section id="reverse" title="Reverse implied odds — when hitting still loses" open={isOpen('reverse')} onToggle={() => toggle('reverse')}>
        <p className="sub">
          Implied odds = the extra you <i>win</i> when a draw hits. <b>Reverse</b> implied odds are the mirror:
          the extra you <b>lose</b> when you make second-best, or a hand you then can't fold. They quietly turn
          "good price" calls into long-term losers.
        </p>
        <div className="two-col">
          <div>
            <h4>The classic traps</h4>
            <ul className="tips">
              <li><b>Non-nut flush draws:</b> 7♥3♥ on a heart board — the flush comes and you still lose a stack
                to a bigger one. The 9 outs are real; the payoff isn't.</li>
              <li><b>Idiot-end straight draws:</b> 65 on 78x — hitting your 9 makes only the <i>bottom</i> straight
                (JT and T6 make higher ones). You bink your out and get stacked.</li>
              <li><b>Dominated top pair OOP:</b> KJ on K-Q-x out of position — you pair, then pay off AK/KQ/sets
                across three streets with no fold button.</li>
              <li><b>Weak kickers:</b> A5o flopping an ace — almost every other ace has you out-kicked.</li>
            </ul>
          </div>
          <div>
            <h4>How to adjust</h4>
            <ul className="tips">
              <li><b>Discount the draw</b> when it isn't to the nuts — a low flush draw is worth far less than its
                9 outs suggest. Prefer draws with <b>nut potential</b> or clean overcards.</li>
              <li><b>Position is the antidote</b> — IP you control the pot; OOP reverse-implied bites hardest, so
                fold these more.</li>
              <li><b>Don't stack off one pair on a dynamic board</b> — that's reverse-implied in action.</li>
              <li>Hook: <b>"will I be happy stacking off when I hit?"</b> If hitting still leaves you guessing, the
                implied odds are negative.</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section id="shape" title="Range shape, capping & two foundations" open={isOpen('shape')} onToggle={() => toggle('shape')}>
        <div className="two-col">
          <div>
            <h4>3-bet shape: polar vs linear/merged</h4>
            <ul className="tips">
              <li><b>Polar</b> (value + blocker-bluffs, flat the middle): <b>in position</b>, where you can
                profitably call the medium hands — so your 3-bet is nuts-or-air.</li>
              <li><b>Linear / merged</b> (all your best hands, no flatting): <b>out of position</b>, from the
                <b> SB</b>, and vs <b>weak / late opens</b> — flatting OOP realizes poorly, so raise or fold.</li>
              <li>Hook: <b>"can I comfortably flat here?"</b> Yes → 3-bet polar. No → 3-bet linear.</li>
            </ul>
            <h4>Capped vs uncapped ranges</h4>
            <ul className="tips">
              <li>A line that <b>can't hold the nuts</b> is <b>capped</b> — flat-calling preflop, checking back
                the flop, limping. Capped ranges get <b>barreled / overbet</b> off their hands.</li>
              <li>Stay <b>uncapped</b> by slowplaying a few strong hands in your checking/calling lines — and
                attack villains whose line caps them.</li>
            </ul>
          </div>
          <div>
            <h4>Geometric sizing — getting stacks in</h4>
            <p className="sub">
              To be all-in by the river <i>and</i> charge max, bet the <b>same fraction of the pot</b> each street
              instead of one huge bet. The pot grows geometrically, so equal fractions stack off smoothly and keep
              worse hands calling.
            </p>
            <ul className="tips">
              <li>Low SPR → one or two big bets. High SPR → three smaller, even bets.</li>
              <li>Rough: ~⅔–¾ pot ×3 streets gets a ~6–8 SPR all-in by the river.</li>
              <li>It's why a one-pair overbet shove is wrong — it skips the geometry and folds out worse.</li>
            </ul>
            <h4>Two foundations</h4>
            <ul className="tips">
              <li><b>Fundamental Theorem (Sklansky):</b> every time you'd play differently if you could see their
                cards, you lose — and they lose when they misread you. Play closest to their <i>actual</i> range.</li>
              <li><b>EV = Σ(outcome × probability)</b> — every decision is just each result times how often it
                happens, summed. Positive total → do it.</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section id="bots" title="How the bots play (the opponent model)" open={isOpen('bots')} onToggle={() => toggle('bots')}>
        <p className="sub">
          The villains aren't random — they read the spot the same way this guide teaches. Knowing
          their rules tells you exactly where their range is, and where they're exploitable.
        </p>
        <div className="two-col">
          <div>
            <h4>Preflop</h4>
            <ul className="tips">
              <li><b>Open (RFI):</b> the seat charts above, but <i>mixed</i> — premiums open ~always,
                borderline hands some of the time, a thin band steals. Looser archetypes widen it.</li>
              <li><b>vs an open (3-bet):</b> value = <b>QQ+/AK/KQs + TT/JJ</b>; bluff-3bets are the
                <b> A5s–A4s</b> blocker family. Small/medium pairs (≤99) <b>flat to set-mine</b>, not 3-bet.</li>
              <li><b>vs a 3-bet (4-bet):</b> <b>KK+/AK only</b> for value — everything else flats or folds.
                No light 4-bet spew.</li>
              <li><b>Short (≤15bb effective):</b> pure <b>push/fold</b> — open-jam / 3-bet-jam by strength,
                wider the shorter; no flatting or set-mining.</li>
            </ul>
            <h4>What it means for you</h4>
            <ul className="tips">
              <li>A bot 4-bet ≈ <b>KK+/AK</b>. Believe it — fold QQ/AK-marginal unless deep and set-mining.</li>
              <li>A bot that just <b>calls</b> your open with position keeps medium pairs / suited Broadways —
                low, connected flops are good for <i>them</i>.</li>
            </ul>
          </div>
          <div>
            <h4>Postflop</h4>
            <ul className="tips">
              <li><b>Equity vs your actual range</b> (their seat + your action), not vs random cards.</li>
              <li><b>Realization:</b> in position ×1.06, out of position ×0.90 — the same swing this page
                teaches. OOP they fold &amp; check more; IP they continue and value-bet thinner.</li>
              <li><b>Barrelling:</b> c-bet wide on the flop; turn/river barrel <i>less</i> often and only with
                equity or fold equity — a bricked bluff gives up instead of firing every street.</li>
              <li><b>Bluffs are heads-up only</b> (never into a field) and weighted by <b>blockers</b> — they
                bluff more holding an ace or a card of a 3-flush suit, less with no blocker.</li>
              <li><b>Draws use implied odds:</b> a ≥8-out draw with stacks behind calls a touch below raw pot
                odds; it gets paid when it hits.</li>
              <li><b>Stack-off discipline:</b> they only commit with genuine value — marginal hands size down
                at low SPR rather than punt the stack.</li>
            </ul>
          </div>
        </div>
        <p className="sub">
          <b>Difficulty</b> scales one skill knob: how often they err, how accurately they read equity, how
          hard they adapt to <i>your</i> leaks, and how sharp their call/fold line is. <b>Easy</b> calls too
          much and misreads hands; <b>Extreme</b> reads accurately and fully exploits your tendencies.
        </p>
      </Section>
    </>
  );
}
