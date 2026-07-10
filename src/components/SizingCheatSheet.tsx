// Postflop decision cheat sheet — the memorizable rules the solver-model grades by.
// Rendered in three places (one source of truth): a toggle in the live Situation panel,
// a toggle in the Feedback panel (while drilling), and a section in the Reference tab.
import { useState } from 'react';

const BLOCKS: { n: string; title: string; rows: [string, string][] }[] = [
  {
    n: '1',
    title: 'SPR — are you committed?',
    rows: [
      ['≤ 1', 'Committed. Made hand (≥ ~50% vs range) → jam or bet ≥ 75% (all get stacks in — size barely matters). Weak → fold. No token bets.'],
      ['1–4', 'Normal. One street of stacking — size by the board below.'],
      ['> 4 deep', 'Bet 33–50%, or overbet only with the nuts. Position & later streets matter more than this bet.'],
    ],
  },
  {
    n: '2',
    title: 'Board texture → size & how often to bet (SPR 1–4)',
    rows: [
      ['Dry (K72r)', 'Rainbow, disconnected. Bet 25–33%, ~70–85% of the time — range-bet, little to protect.'],
      ['Paired (KK4)', 'Bet 25–33%, ~80–90% — few draws, huge range edge.'],
      ['Low dry (532r)', 'Bet 25–33%, ~60–70%.'],
      ['Semi (one draw axis)', 'ONE draw type only — a flush draw (K♠9♠4♦) or a straight axis (9♥7♦2♣), not both. Bet ~50%, ~55–65%.'],
      ['Wet (T97, two-tone)', 'Two draw types (straights + flush draw). Bet 66–75%, but only ~40–55% — check more, equities run close.'],
      ['Monotone / flush out, you have none', '3+ of one suit, none in your hand (K♠7♠2♠, no spade). Bet 33–50% only ~30–40%; mostly check — a bet folds worse & gets called by flushes.'],
    ],
  },
  {
    n: '3',
    title: 'Sizes — pick one',
    rows: [
      ['25–33% pot', 'Dry / paired boards, thin value, range bets.'],
      ['~50% pot', 'Semi-wet, medium-strength value.'],
      ['66–75% pot', 'Wet boards, polar (strong value + bluffs).'],
      ['~pot (85–125%)', 'Very polar rivers — nutted value + bluffs, make them pay max.'],
      ['125%+ overbet', 'Max polar, you have the nut advantage, deep only.'],
      ['All-in / jam', 'SPR ≤ 1 with a committing hand.'],
    ],
  },
  {
    n: '4',
    title: 'Hand strength — bet / check / give up (equity vs their range)',
    rows: [
      ['≥ 65%', 'Value bet BIG. Size = the board rule above.'],
      ['55–65%', 'Bet, but thinner / a size down.'],
      ['40–55%', 'Check — pot control / bluff-catch. Don’t bloat.'],
      ['< 40%, no draw', 'Check / give up. Bluff only with blockers + a story, not “maybe I’m good.”'],
      ['Draw', 'Semi-bluff flop/turn (big on wet). Missed on the river = pure bluff-or-give-up.'],
    ],
  },
  {
    n: '5',
    title: 'Players — multiway modifier',
    rows: [
      ['3+ in', 'Need ~10% more equity to value-bet, and lean a size bigger (protect vs field, isolate). Bluffs die — someone always has it.'],
      ['Heads-up', 'Sizing matters less; villain rarely folds a made hand.'],
    ],
  },
  {
    n: '6',
    title: 'Facing a bet — equity you need to CALL (pot odds)',
    rows: [
      ['vs 33% bet', 'Need ~20%.'],
      ['vs 50% bet', 'Need ~25%.'],
      ['vs 75% bet', 'Need ~30%.'],
      ['vs pot bet', 'Need ~33%.'],
      ['vs 2× overbet', 'Need ~40%.'],
      ['Rule', 'Have more than that → continue; less → fold, unless a draw with implied odds or a bluff-catch read.'],
    ],
  },
  {
    n: '7',
    title: 'Raise / call / fold (facing a bet)',
    rows: [
      ['Value-raise', 'Two pair+, sets, strong overpair on a dry board (~top 10–15% of your range).'],
      ['Bluff-raise', 'Strong draw + blockers (nut-flush / straight blocker).'],
      ['Just call', 'Medium made hand, or a draw getting the price above.'],
      ['Multiway', 'Value-raise only — drop the bluff-raises.'],
    ],
  },
  {
    n: '8',
    title: 'River & position',
    rows: [
      ['River bet', 'Only if MORE worse hands call than better ones (thin value). Else check — no protection to buy.'],
      ['River call', 'Pure bluff-catch: ask “how often is he bluffing?” vs the pot-odds need above, not “am I ahead?”'],
      ['In position', 'Check back for a free card; bet thinner.'],
      ['Out of position', 'Bet proactively (you realize less equity); fewer thin bets/calls.'],
    ],
  },
  {
    n: '9',
    title: '🧠 Think-first — what each question tests',
    rows: [
      ['(Betting / raising)', 'The gate quizzes these before a bet or raise commits.'],
      ['What do I have?', 'Hand strength — block 4.'],
      ['Board texture?', 'Wet / dry — block 2.'],
      ['Did the turn change it?', 'Re-read texture: barrel value + picked-up draws, slow down bluffs that just got outdrawn.'],
      ['Why chips in?', 'Value / semi-bluff / bluff / protection — block 4. On the river: value or bluff only.'],
      ['How big?', 'Size by board — block 3 (dry ⅓, semi ½, wet ⅔–¾, SPR ≤ 1 jam).'],
      ['If I get raised?', 'Decide the plan NOW — fold / call / get-it-in — not under pressure after it lands.'],
      ['(Calling)', 'A call is defensive — the gate quizzes the price, not your size.'],
      ['Price — equity to call?', 'Pot odds — block 6 (⅓→20%, ½→25%, ⅔→29%, pot→33%).'],
      ['My equity?', 'HUD equity vs his range — do you clear the price?'],
      ['Call / fold / raise?', 'Equity vs price + block 7. A made hand near the price still calls (implied odds + can improve); air short of it folds.'],
      ['River: how often bluffing?', 'Bluff-catch — you need him bluffing ≥ the price (block 6). Rarely bluffs → fold; often → call.'],
    ],
  },
];

export function SizingCheatSheet() {
  // Each category collapses so the card stays short; open only what you need.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (n: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const allOpen = open.size === BLOCKS.length;
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(BLOCKS.map((b) => b.n)));

  return (
    <div className="cheat">
      <p className="cheat-hook">
        SPR ≤ 1 → jam · Dry → 33% · Wet → 66–75% · Multiway → +10% equity & bigger · River → thin value or check
      </p>
      <div className="cheat-top">
        <span className="cheat-order">Read in order: SPR → board → players → hand.</span>
        <button type="button" className="cheat-all" onClick={toggleAll}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {BLOCKS.map((b) => {
        const isOpen = open.has(b.n);
        return (
          <div key={b.n} className={`cheat-block ${isOpen ? 'open' : 'closed'}`}>
            <button type="button" className="cheat-h" aria-expanded={isOpen} onClick={() => toggle(b.n)}>
              <span className="cheat-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="cheat-n">{b.n}</span>
              {b.title}
            </button>
            {isOpen && (
              <dl className="cheat-rows">
                {b.rows.map(([k, v]) => (
                  <div key={k} className="cheat-row">
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}
