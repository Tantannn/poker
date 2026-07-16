// Flop Heatmap — a GTO-Wizard-style aggregate report, scaled to run LIVE in the
// browser. Pick a hand; it solves the model's best line (first to act) across a
// curated, texture-bucketed set of flops and colours each cell by the recommended
// action + size. You read, at a glance, how the same holding wants a small bet on
// dry boards, a big/polar bet on wet ones, and a check where it has no edge — the
// pattern the Bet-Sizing drill teaches, shown all at once.
//
// NOT a full range-vs-range solve (that would hang the tab) — it's the heuristic
// model (solvePostflop) for one hand across representative boards, deconflicted so
// the hand never shares a card with the board.

import { useMemo, useState } from 'react';
import { parseCard, suitClass, rankToChar, SUIT_SYMBOLS, type Card } from '../engine/cards';
import { rangeFromSet } from '../engine/range';
import { RFI_RANGES } from '../ai/preflop';
import { solvePostflop } from '../strategy/postflopModel';

const BB = 2;
const POT = 12;
const VILLAIN = rangeFromSet(RFI_RANGES.BTN);
const ITERS = 600; // modest so ~19 live solves stay snappy

type Pos = 'ip' | 'oop';

// preset hands spanning the archetypes — suits chosen to rarely collide; any
// collision is fixed by deconflict() before solving.
const HANDS: { id: string; label: string; cards: [string, string] }[] = [
  { id: 'AA', label: 'AA · overpair', cards: ['As', 'Ah'] },
  { id: 'KK', label: 'KK · overpair', cards: ['Ks', 'Kh'] },
  { id: 'AKs', label: 'AKs · big broadway', cards: ['As', 'Ks'] },
  { id: 'AQo', label: 'AQo · broadway', cards: ['Ah', 'Qs'] },
  { id: 'QJs', label: 'QJs · broadway+draws', cards: ['Qh', 'Jh'] },
  { id: 'T9s', label: 'T9s · connector', cards: ['Th', '9h'] },
  { id: '76s', label: '76s · low connector', cards: ['7h', '6h'] },
  { id: '55', label: '55 · small pair', cards: ['5s', '5c'] },
  { id: 'A5s', label: 'A5s · wheel/bluff', cards: ['Ah', '5h'] },
];

// texture-bucketed flops. Each is a distinct strategic shape.
const BUCKETS: { name: string; flops: [string, string, string][] }[] = [
  { name: 'Dry high (rainbow)', flops: [['As', 'Kd', '7h'], ['Ks', '8d', '3h'], ['Ah', '7c', '2d']] },
  { name: 'Dry low (rainbow)', flops: [['8s', '5d', '2h'], ['9c', '6d', '3s'], ['7h', '4d', '2c']] },
  { name: 'Paired', flops: [['Ks', 'Kd', '5h'], ['9s', '9d', '4c'], ['Ts', 'Th', '2d']] },
  { name: 'Broadway connected', flops: [['As', 'Qd', 'Jh'], ['Ks', 'Qd', 'Th'], ['Qs', 'Jd', 'Ts']] },
  { name: 'Wet two-tone', flops: [['Ts', '9s', '5d'], ['8h', '7h', '3c'], ['Jd', 'Td', '4s']] },
  { name: 'Monotone', flops: [['Js', '8s', '3s'], ['Qh', '9h', '5h']] },
  { name: 'Low connected', flops: [['7s', '6d', '5h'], ['6s', '5d', '4c']] },
];

// action → colour + short label. First-to-act, so only check / bet sizes appear.
const ACT: Record<string, { label: string; color: string }> = {
  check: { label: 'Check', color: '#6b7a72' },
  bet33: { label: '⅓', color: '#3aa0e0' },
  bet50: { label: '½', color: '#5bb8a0' },
  bet75: { label: '¾', color: '#e7c873' },
  betpot: { label: 'Pot', color: '#2ec27e' },
  allin: { label: 'Jam', color: '#e0573a' },
};

const key = (c: Card) => c.rank * 4 + c.suit;

// Ensure the hero hand never shares a card with the board (impossible in reality
// and it corrupts the equity sim). Preserves rank; preserves suitedness for suited
// hands by moving both cards to a free suit; fixes offsuit/pairs card-by-card.
function deconflict(hero: Card[], board: Card[]): Card[] {
  const dead = new Set(board.map(key));
  const boardSuits = new Set(board.map((c) => c.suit));
  const suited = hero[0].suit === hero[1].suit;
  if (suited) {
    if (!hero.some((c) => dead.has(key(c)))) return hero;
    const free = [0, 1, 2, 3].find((s) => !boardSuits.has(s));
    return free == null ? hero : hero.map((c) => ({ rank: c.rank, suit: free }));
  }
  return hero.map((c, i) => {
    if (!dead.has(key(c))) return c;
    const other = hero[1 - i];
    for (const s of [0, 1, 2, 3]) {
      if (dead.has(c.rank * 4 + s)) continue;
      if (c.rank === other.rank && s === other.suit) continue;
      return { rank: c.rank, suit: s };
    }
    return c;
  });
}

interface Cell {
  board: Card[];
  bestId: string;
  ev: number;
  sizePct?: number;
  equity: number;
}

function MiniCard({ c }: { c: Card }) {
  return (
    <span className={`fh-card ${suitClass(c.suit)}`}>
      {rankToChar(c.rank)}{SUIT_SYMBOLS[c.suit]}
    </span>
  );
}

export function FlopHeatmap() {
  const [handId, setHandId] = useState('AA');
  const [pos, setPos] = useState<Pos>('oop');

  const hand = HANDS.find((h) => h.id === handId) ?? HANDS[0];

  // solve every flop for the selected hand. Same in-render solve pattern as
  // PostflopLab (the model uses a seeded MC internally). Re-runs on hand/pos change.
  const groups = useMemo(() => {
    const heroBase = hand.cards.map(parseCard);
    return BUCKETS.map((b) => ({
      name: b.name,
      cells: b.flops.map<Cell>((f) => {
        const board = f.map(parseCard);
        const hero = deconflict(heroBase, board);
        const s = solvePostflop({
          hero, board, oppRange: VILLAIN, pot: POT, toCall: 0, heroCommitted: 0, currentBet: 0,
          minRaiseTo: BB, maxRaiseTo: 200, canCheck: true, canRaise: true, bigBlind: BB,
          iterations: ITERS, rangeNote: 'BTN range', position: pos,
        });
        const best = s.options.find((o) => o.id === s.bestId);
        return { board, bestId: s.bestId, ev: best?.ev ?? 0, sizePct: best?.sizePct, equity: s.equity ?? 0 };
      }),
    }));
  }, [hand, pos]);

  return (
    <div className="card">
      <h2>Flop Heatmap</h2>
      <p className="sub">
        An aggregate report: how <b>one hand</b> wants to play across board textures, solved live. Read the
        pattern — <b>small</b> on dry boards, <b>big/polar</b> on wet ones, <b>check</b> where it has no edge.
        Heuristic model (one hand, not a full range solve), first to act, {POT}bb pot.
      </p>

      <div className="quiz-bar">
        <div className="fh-hands">
          {HANDS.map((h) => (
            <button key={h.id} className={`fh-hand ${handId === h.id ? 'active' : ''}`} onClick={() => setHandId(h.id)}>
              {h.id}
            </button>
          ))}
        </div>
        <div className="quiz-drills">
          <button className={pos === 'oop' ? 'active' : ''} onClick={() => setPos('oop')}>OOP</button>
          <button className={pos === 'ip' ? 'active' : ''} onClick={() => setPos('ip')}>IP</button>
        </div>
      </div>
      <p className="note">Showing <b>{hand.label}</b> · {pos === 'ip' ? 'in position' : 'out of position'}. Cell colour = best action; number = EV (bb).</p>

      <div className="fh-legend">
        {Object.entries(ACT).map(([id, a]) => (
          <span key={id} className="fh-leg"><span className="fh-swatch" style={{ background: a.color }} /> {a.label}</span>
        ))}
      </div>

      {groups.map((g) => (
        <div key={g.name} className="fh-bucket">
          <div className="fh-bucket-name">{g.name}</div>
          <div className="fh-cells">
            {g.cells.map((c, i) => {
              const a = ACT[c.bestId] ?? { label: c.bestId, color: '#6b7a72' };
              return (
                <div key={i} className="fh-cell" style={{ borderColor: a.color }} title={`${a.label}${c.sizePct ? ` (${c.sizePct}% pot)` : ''} · EV ${c.ev.toFixed(2)}bb · equity ${Math.round(c.equity * 100)}%`}>
                  <div className="fh-board">
                    {c.board.map((card, j) => <MiniCard key={j} c={card} />)}
                  </div>
                  <div className="fh-act" style={{ background: a.color }}>{a.label}</div>
                  <div className="fh-ev">{c.ev >= 0 ? '+' : ''}{c.ev.toFixed(1)}bb · {Math.round(c.equity * 100)}%</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="bsd-cheat">
        <h4>Reading the map</h4>
        <div className="bsd-cheat-grid">
          <div><span className="bsd-pill small">Dry boards</span> Range advantage → small (⅓) & often. Little to protect, keep worse hands in.</div>
          <div><span className="bsd-pill big">Wet boards</span> Draws present → bigger (¾) to charge equity; polarise when you hold the nut advantage.</div>
          <div><span className="bsd-pill check">No edge</span> Marginal made hands / air with no value or fold-equity case → check, realise equity free.</div>
          <div><span className="bsd-pill pos">Position</span> Flip OOP↔IP: in position you realise more, so you bet smaller & check back more marginal hands.</div>
        </div>
        <p className="bsd-note">Same holding, different boards — that's the whole point. For the full decision + multi-street play, use <b>Postflop Lab</b>; to drill sizing one spot at a time, use <b>Bet Sizing</b>.</p>
      </div>
    </div>
  );
}
