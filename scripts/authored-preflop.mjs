#!/usr/bin/env node
// Generate the hand-authored preflop charts into src/data/solverPreflop.json.
//
// THESE ARE NOT SOLVER OUTPUT. They are hand-authored ~100bb 6-max equilibrium
// APPROXIMATIONS — mixed per-hand frequencies in the shape a solve would produce,
// but authored, not solved. `meta.source` says so, and the app must keep saying so
// (see CLAUDE.md "Product intent"). Overwrite any single scenario with a real
// export via scripts/solver-to-preflop.mjs; the override is per-scenario, so real
// solves and authored charts coexist without conflict.
//
// Why authored charts still beat the built-in heuristic: the heuristic stores a
// BINARY range set plus one global `bluffFreq` per scenario, so every bluff-region
// hand mixes at the same rate and there is no per-hand grading resolution. These
// charts give each hand its own frequency, split value/bluff per hand, and encode
// the suited/offsuit and blocker structure the token sets flatten.
//
// Usage:
//   node scripts/authored-preflop.mjs                # write all charts
//   node scripts/authored-preflop.mjs --only rfi-BTN # one scenario
//   node scripts/authored-preflop.mjs --dry          # print coverage, write nothing
//   node scripts/authored-preflop.mjs --out /tmp/x.json
//
// Every chart emits all 169 codes, folds included. That is deliberate: solverActions
// returns null for an ABSENT hand and the caller then falls back to the heuristic,
// so an omitted junk hand would silently inherit the heuristic's (possibly opening)
// line. Explicit folds make the override total.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ---------------- token grammar (mirrors src/ai/preflop.ts) ----------------
const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const rankVal = (r) => RANKS.indexOf(r);

function expandPlus(tok) {
  const [hi, lo, suf] = [tok[0], tok[1], tok[2]];
  const out = [];
  for (let lv = rankVal(lo); lv > rankVal(hi); lv--) out.push(hi + RANKS[lv] + suf);
  return out;
}

function expandDash(a, b) {
  if (a[0] === a[1]) {
    const hi = Math.min(rankVal(a[0]), rankVal(b[0]));
    const lo = Math.max(rankVal(a[0]), rankVal(b[0]));
    const out = [];
    for (let i = hi; i <= lo; i++) out.push(RANKS[i] + RANKS[i]);
    return out;
  }
  const suf = a[2];
  const top = Math.min(rankVal(a[1]), rankVal(b[1]));
  const bot = Math.max(rankVal(a[1]), rankVal(b[1]));
  const out = [];
  for (let i = top; i <= bot; i++) out.push(a[0] + RANKS[i] + suf);
  return out;
}

function expandToken(tok) {
  tok = tok.trim();
  if (tok.includes('-')) return expandDash(...tok.split('-'));
  const plus = tok.endsWith('+');
  if (plus) tok = tok.slice(0, -1);
  if (tok.length === 2 && tok[0] === tok[1]) {
    if (!plus) return [tok];
    const out = [];
    for (let i = rankVal(tok[0]); i >= 0; i--) out.push(RANKS[i] + RANKS[i]);
    return out;
  }
  return plus ? expandPlus(tok) : [tok];
}

/** All 169 canonical codes, pairs then suited then offsuit. */
const ALL_169 = (() => {
  const out = [];
  for (let i = 0; i < 13; i++) out.push(RANKS[i] + RANKS[i]);
  for (let i = 0; i < 13; i++)
    for (let j = i + 1; j < 13; j++) out.push(RANKS[i] + RANKS[j] + 's');
  for (let i = 0; i < 13; i++)
    for (let j = i + 1; j < 13; j++) out.push(RANKS[i] + RANKS[j] + 'o');
  return out;
})();

const comboCount = (code) => (code.length === 2 ? 6 : code.endsWith('s') ? 4 : 12);

// ---------------- chart data ----------------
// Row shape: [token, freq]                    → all of `freq` on the chart's main action
//            [token, { raise: x, call: y }]   → explicit per-action split
// Whatever is left after the listed actions goes to `rest` (default 'fold').
// Later rows WIN over earlier ones for the same code, so a broad row can be stated
// first and then refined ('A2s+' then 'A5s-A4s').
//
// The `played%` / `raise%` targets each chart is tuned to are in its comment; run
// `--dry` to print the actuals.

const RFI = (rows) => ({ main: 'open', rest: 'fold', rows });
const VS_OPEN = (rows) => ({ main: 'raise', rest: 'fold', rows });

const CHARTS = {
  // ================= RFI (opening) =================
  // UTG ~16%. Four seats behind and out of position postflop, so this is card
  // strength and playability only — no steal equity to lean on.
  'rfi-UTG': RFI([
    ['TT+', 1], ['55-99', 1], ['22-44', 0.85],
    ['ATs+', 1], ['A6s-A9s', 0.8], ['A5s-A4s', 1], ['A3s-A2s', 0.5],
    ['KJs+', 1], ['KTs', 0.9], ['K9s', 0.6],
    ['QJs', 1], ['QTs', 0.9], ['Q9s', 0.35],
    ['JTs', 1], ['J9s', 0.6],
    ['T9s', 0.9], ['T8s', 0.3],
    ['98s', 0.5], ['87s', 0.3], ['76s', 0.2],
    ['AQo+', 1], ['AJo', 0.85], ['ATo', 0.45],
    ['KQo', 0.8], ['KJo', 0.15],
  ]),
  // MP ~19%. One seat fewer behind: the mixed tail thickens rather than new
  // categories appearing.
  'rfi-MP': RFI([
    ['99+', 1], ['66-88', 1], ['22-55', 0.85],
    ['A9s+', 1], ['A6s-A8s', 0.85], ['A5s-A4s', 1], ['A3s-A2s', 0.6],
    ['KTs+', 1], ['K9s', 0.8], ['K8s', 0.4],
    ['QTs+', 1], ['Q9s', 0.7], ['Q8s', 0.3],
    ['JTs', 1], ['J9s', 0.8], ['J8s', 0.35],
    ['T9s', 1], ['T8s', 0.6],
    ['98s', 0.8], ['87s', 0.5], ['76s', 0.4], ['65s', 0.3], ['54s', 0.3],
    ['AJo+', 1], ['ATo', 0.85],
    ['KQo', 1], ['KJo', 0.7], ['KTo', 0.2],
    ['QJo', 0.5], ['JTo', 0.15],
  ]),
  // CO ~28%. Suited hands go pure; the offsuit broadways become the mixing region.
  'rfi-CO': RFI([
    ['66+', 1], ['22-55', 0.85],
    ['A2s+', 1],
    ['K9s+', 1], ['K8s', 0.8], ['K5s-K7s', 0.45], ['K2s-K4s', 0.25],
    ['Q9s+', 1], ['Q8s', 0.8], ['Q6s-Q7s', 0.35], ['Q2s-Q5s', 0.15],
    ['J9s+', 1], ['J8s', 0.8], ['J7s', 0.35], ['J5s-J6s', 0.15],
    ['T8s+', 1], ['T7s', 0.55], ['T6s', 0.15],
    ['98s', 1], ['97s', 0.6], ['96s', 0.2],
    ['87s', 1], ['86s', 0.5], ['85s', 0.15],
    ['76s', 1], ['75s', 0.45],
    ['65s', 1], ['64s', 0.35],
    ['54s', 1],
    ['ATo+', 1], ['A9o', 0.8], ['A8o', 0.35], ['A7o', 0.2],
    ['KTo+', 1], ['K9o', 0.35],
    ['QTo+', 1], ['Q9o', 0.3],
    ['JTo', 1], ['J9o', 0.2],
    ['T9o', 0.2],
  ]),
  // BTN ~46%. Last to act every street, so everything suited plays and the offsuit
  // tail is where the mixing lives.
  'rfi-BTN': RFI([
    ['22+', 1],
    ['A2s+', 1], ['K2s+', 1],
    ['Q6s+', 1], ['Q2s-Q5s', 0.6],
    ['J7s+', 1], ['J5s-J6s', 0.6], ['J2s-J4s', 0.25],
    ['T7s+', 1], ['T6s', 0.65], ['T5s', 0.25],
    ['96s+', 1], ['95s', 0.5], ['94s', 0.1],
    ['86s+', 1], ['85s', 0.6], ['84s', 0.2],
    ['75s+', 1], ['74s', 0.5],
    ['64s+', 1], ['63s', 0.2],
    ['53s+', 1], ['43s', 1],
    ['A5o+', 1], ['A2o-A4o', 0.35],
    ['K9o+', 1], ['K7o-K8o', 0.75], ['K5o-K6o', 0.4],
    ['QTo+', 1], ['Q8o-Q9o', 0.7], ['Q7o', 0.35],
    ['JTo+', 1], ['J8o-J9o', 0.75], ['J7o', 0.15],
    ['T9o', 1], ['T8o', 0.7],
    ['98o', 0.8], ['97o', 0.1],
    ['87o', 0.5], ['76o', 0.2],
  ]),
  // SB ~40%. RAISE OR FOLD — never flat. Flatting the SB plays a capped range out
  // of position with the BB live behind, which is why it is a losing habit even
  // though the price looks good. Suited-heavy vs BTN's shape: SB will be OOP
  // postflop and needs playability, not raw card strength.
  'rfi-SB': RFI([
    ['22+', 1],
    ['A2s+', 1],
    ['K4s+', 1], ['K2s-K3s', 0.5],
    ['Q6s+', 1], ['Q4s-Q5s', 0.45],
    ['J7s+', 1], ['J6s', 0.4],
    ['T7s+', 1], ['T6s', 0.4],
    ['96s+', 1], ['95s', 0.3],
    ['85s+', 1], ['84s', 0.15],
    ['75s+', 1], ['74s', 0.25],
    ['64s+', 1], ['54s', 1], ['53s', 0.45], ['43s', 0.25],
    ['A7o+', 1], ['A4o-A6o', 0.7], ['A2o-A3o', 0.4],
    ['KTo+', 1], ['K8o-K9o', 0.8], ['K6o-K7o', 0.35], ['K5o', 0.1],
    ['QTo+', 1], ['Q9o', 0.7], ['Q8o', 0.35],
    ['JTo+', 1], ['J9o', 0.75], ['J8o', 0.3],
    ['T9o', 0.85], ['T8o', 0.2],
    ['98o', 0.4], ['87o', 0.15],
  ]),

  // ================= BB defence (facing one open, closing the action) =================
  // The BB gets a price and closes the action, so it defends far wider than any
  // other seat — but the 3-BET region is what actually prints, and it is POLAR:
  // premiums plus suited-wheel-ace / suited-broadway blockers, NOT the second-best
  // hands. Those flat, where they realise fine and dominate nothing.
  // Target: ~55% defend, ~9% 3-bet.
  'bb-vs-btn': VS_OPEN([
    ['QQ+', { raise: 1 }],
    ['JJ', { raise: 0.85, call: 0.15 }],
    ['TT', { raise: 0.6, call: 0.4 }],
    ['99', { raise: 0.25, call: 0.75 }],
    ['88', { raise: 0.2, call: 0.8 }],
    ['77', { raise: 0.15, call: 0.85 }],
    ['22-66', { raise: 0.1, call: 0.9 }],
    ['AKs', { raise: 1 }], ['AQs', { raise: 0.85, call: 0.15 }],
    ['AJs', { raise: 0.65, call: 0.35 }], ['ATs', { raise: 0.5, call: 0.5 }],
    ['A6s-A9s', { raise: 0.15, call: 0.85 }],
    ['A5s-A2s', { raise: 0.85, call: 0.15 }],
    ['AKo', { raise: 1 }], ['AQo', { raise: 0.7, call: 0.3 }],
    ['AJo', { raise: 0.4, call: 0.6 }], ['ATo', { raise: 0.15, call: 0.85 }],
    ['A2o-A9o', { call: 1 }],
    ['KQs', { raise: 0.5, call: 0.5 }], ['KJs', { raise: 0.45, call: 0.55 }],
    ['KTs', { raise: 0.4, call: 0.6 }], ['K5s-K9s', { raise: 0.25, call: 0.75 }],
    ['K2s-K4s', { call: 1 }],
    ['KQo', { raise: 0.25, call: 0.75 }], ['KJo', { raise: 0.1, call: 0.9 }], ['KTo', { call: 1 }],
    ['K7o-K9o', { call: 0.85 }], ['K4o-K6o', { call: 0.6 }],
    ['QJs', { raise: 0.35, call: 0.65 }], ['QTs', { raise: 0.35, call: 0.65 }],
    ['Q9s', { raise: 0.2, call: 0.8 }], ['Q2s-Q8s', { call: 1 }],
    ['QTo+', { call: 1 }], ['Q8o-Q9o', { call: 0.8 }], ['Q7o', { call: 0.6 }],
    ['JTs', { raise: 0.3, call: 0.7 }], ['J9s', { raise: 0.3, call: 0.7 }],
    ['J6s-J8s', { call: 1 }], ['J4s-J5s', { call: 0.8 }],
    ['JTo', { call: 1 }], ['J8o-J9o', { call: 0.8 }], ['J7o', { call: 0.6 }],
    ['T9s', { raise: 0.25, call: 0.75 }], ['T6s-T8s', { call: 1 }], ['T5s', { call: 0.8 }],
    ['T9o', { call: 1 }], ['T8o', { call: 0.8 }], ['T7o', { call: 0.4 }],
    ['98s', { raise: 0.2, call: 0.8 }], ['95s-97s', { call: 1 }], ['94s', { call: 0.7 }],
    ['98o', { call: 1 }], ['97o', { call: 0.6 }],
    ['87s', { raise: 0.2, call: 0.8 }], ['85s-86s', { call: 1 }], ['84s', { call: 0.7 }],
    ['87o', { call: 0.8 }], ['76o', { call: 0.65 }], ['65o', { call: 0.4 }],
    ['76s', { raise: 0.2, call: 0.8 }], ['74s-75s', { call: 1 }],
    ['65s', { raise: 0.2, call: 0.8 }], ['64s', { call: 1 }], ['63s', { call: 0.8 }],
    ['54s', { raise: 0.2, call: 0.8 }], ['53s', { call: 1 }], ['43s', { call: 1 }],
    ['42s', { call: 0.6 }], ['32s', { call: 0.6 }],
  ]),
  // vs the SB's ~40% open the BB is heads-up with the widest opening range at the
  // table and getting 2:1 — the widest defence in the game, and the highest 3-bet
  // frequency, because SB's range cannot withstand pressure.
  // Target: ~77% defend, ~13% 3-bet.
  'bb-vs-sb': VS_OPEN([
    ['QQ+', { raise: 1 }], ['JJ', { raise: 0.9, call: 0.1 }], ['TT', { raise: 0.75, call: 0.25 }],
    ['88-99', { raise: 0.45, call: 0.55 }], ['66-77', { raise: 0.25, call: 0.75 }],
    ['22-55', { raise: 0.15, call: 0.85 }],
    ['AKs', { raise: 1 }], ['AQs', { raise: 0.9, call: 0.1 }], ['AJs', { raise: 0.75, call: 0.25 }],
    ['ATs', { raise: 0.6, call: 0.4 }], ['A6s-A9s', { raise: 0.3, call: 0.7 }],
    ['A5s-A2s', { raise: 0.9, call: 0.1 }],
    ['AKo', { raise: 1 }], ['AQo', { raise: 0.85, call: 0.15 }], ['AJo', { raise: 0.6, call: 0.4 }],
    ['ATo', { raise: 0.35, call: 0.65 }], ['A2o-A9o', { raise: 0.1, call: 0.9 }],
    ['KQs', { raise: 0.7, call: 0.3 }], ['KJs', { raise: 0.6, call: 0.4 }],
    ['KTs', { raise: 0.5, call: 0.5 }], ['K5s-K9s', { raise: 0.3, call: 0.7 }],
    ['K2s-K4s', { raise: 0.15, call: 0.85 }],
    ['KQo', { raise: 0.45, call: 0.55 }], ['KJo', { raise: 0.2, call: 0.8 }], ['K2o-KTo', { call: 1 }],
    ['QJs', { raise: 0.45, call: 0.55 }], ['QTs', { raise: 0.4, call: 0.6 }],
    ['Q6s-Q9s', { raise: 0.2, call: 0.8 }], ['Q2s-Q5s', { call: 1 }],
    ['Q6o+', { call: 1 }], ['Q2o-Q5o', { call: 0.7 }],
    ['JTs', { raise: 0.4, call: 0.6 }], ['J6s-J9s', { raise: 0.15, call: 0.85 }], ['J2s-J5s', { call: 1 }],
    ['J6o+', { call: 1 }], ['J4o-J5o', { call: 0.6 }],
    ['T9s', { raise: 0.3, call: 0.7 }], ['T2s-T8s', { call: 1 }],
    ['T6o+', { call: 1 }], ['T5o', { call: 0.6 }],
    ['98s', { raise: 0.25, call: 0.75 }], ['92s-97s', { call: 1 }],
    ['96o+', { call: 1 }], ['95o', { call: 0.6 }],
    ['87s', { raise: 0.25, call: 0.75 }], ['82s-86s', { call: 1 }],
    ['86o+', { call: 1 }], ['85o', { call: 0.6 }],
    ['76s', { raise: 0.25, call: 0.75 }], ['72s-75s', { call: 1 }], ['75o+', { call: 1 }],
    ['65s', { raise: 0.25, call: 0.75 }], ['62s-64s', { call: 1 }], ['64o+', { call: 0.85 }],
    ['54s', { raise: 0.25, call: 0.75 }], ['52s-53s', { call: 1 }], ['54o', { call: 0.75 }],
    ['42s+', { call: 1 }], ['32s', { call: 1 }],
  ]),
  // Target: ~46% defend, ~8.5% 3-bet.
  'bb-vs-co': VS_OPEN([
    ['QQ+', { raise: 1 }], ['JJ', { raise: 0.8, call: 0.2 }], ['TT', { raise: 0.5, call: 0.5 }],
    ['99', { raise: 0.2, call: 0.8 }], ['22-88', { raise: 0.1, call: 0.9 }],
    ['AKs', { raise: 1 }], ['AQs', { raise: 0.8, call: 0.2 }], ['AJs', { raise: 0.55, call: 0.45 }],
    ['ATs', { raise: 0.4, call: 0.6 }], ['A6s-A9s', { raise: 0.1, call: 0.9 }],
    ['A5s-A2s', { raise: 0.8, call: 0.2 }],
    ['AKo', { raise: 1 }], ['AQo', { raise: 0.6, call: 0.4 }], ['AJo', { raise: 0.3, call: 0.7 }],
    ['ATo', { call: 1 }], ['A5o-A9o', { call: 1 }], ['A2o-A4o', { call: 0.6 }],
    ['KQs', { raise: 0.45, call: 0.55 }], ['KJs', { raise: 0.4, call: 0.6 }],
    ['KTs', { raise: 0.3, call: 0.7 }], ['K5s-K9s', { raise: 0.2, call: 0.8 }], ['K2s-K4s', { call: 1 }],
    ['KQo', { raise: 0.15, call: 0.85 }], ['KTo-KJo', { call: 1 }], ['K8o-K9o', { call: 0.7 }],
    ['K7o', { call: 0.35 }],
    ['QJs', { raise: 0.3, call: 0.7 }], ['QTs', { raise: 0.25, call: 0.75 }],
    ['Q4s-Q9s', { call: 1 }], ['Q2s-Q3s', { call: 0.7 }],
    ['QTo+', { call: 1 }], ['Q9o', { call: 0.7 }], ['Q8o', { call: 0.35 }],
    ['JTs', { raise: 0.25, call: 0.75 }], ['J9s', { raise: 0.2, call: 0.8 }],
    ['J5s-J8s', { call: 1 }], ['J4s', { call: 0.6 }],
    ['JTo', { call: 1 }], ['J9o', { call: 0.7 }], ['J8o', { call: 0.35 }],
    ['T9s', { raise: 0.2, call: 0.8 }], ['T6s-T8s', { call: 1 }], ['T5s', { call: 0.6 }],
    ['T9o', { call: 0.9 }], ['T8o', { call: 0.5 }],
    ['98s', { raise: 0.15, call: 0.85 }], ['95s-97s', { call: 1 }],
    ['98o', { call: 0.7 }], ['87o', { call: 0.4 }],
    ['87s', { raise: 0.15, call: 0.85 }], ['85s-86s', { call: 1 }], ['84s', { call: 0.5 }],
    ['76s', { raise: 0.15, call: 0.85 }], ['74s-75s', { call: 1 }],
    ['65s', { raise: 0.15, call: 0.85 }], ['64s', { call: 1 }], ['63s', { call: 0.5 }],
    ['54s', { raise: 0.15, call: 0.85 }], ['53s', { call: 1 }], ['43s', { call: 0.8 }],
  ]),
  // Target: ~38% defend, ~7.5% 3-bet.
  'bb-vs-mp': VS_OPEN([
    ['QQ+', { raise: 1 }], ['JJ', { raise: 0.75, call: 0.25 }], ['TT', { raise: 0.45, call: 0.55 }],
    ['22-99', { raise: 0.1, call: 0.9 }],
    ['AKs', { raise: 1 }], ['AQs', { raise: 0.7, call: 0.3 }], ['AJs', { raise: 0.45, call: 0.55 }],
    ['ATs', { raise: 0.25, call: 0.75 }], ['A6s-A9s', { call: 1 }],
    ['A5s-A2s', { raise: 0.7, call: 0.3 }],
    ['AKo', { raise: 1 }], ['AQo', { raise: 0.5, call: 0.5 }], ['AJo', { raise: 0.2, call: 0.8 }],
    ['ATo', { call: 1 }], ['A7o-A9o', { call: 0.7 }], ['A2o-A6o', { call: 0.45 }],
    ['KQs', { raise: 0.4, call: 0.6 }], ['KJs', { raise: 0.3, call: 0.7 }],
    ['KTs', { raise: 0.2, call: 0.8 }], ['K5s-K9s', { raise: 0.15, call: 0.85 }], ['K2s-K4s', { call: 0.8 }],
    ['KJo-KQo', { call: 1 }], ['KTo', { call: 0.8 }], ['K9o', { call: 0.35 }], ['K8o', { call: 0.3 }],
    ['QJs', { raise: 0.2, call: 0.8 }], ['QTs', { raise: 0.2, call: 0.8 }],
    ['Q6s-Q9s', { call: 1 }], ['Q4s-Q5s', { call: 0.6 }], ['Q2s-Q3s', { call: 0.5 }],
    ['QJo', { call: 1 }], ['QTo', { call: 0.7 }], ['Q9o', { call: 0.3 }], ['Q8o', { call: 0.25 }],
    ['JTs', { raise: 0.2, call: 0.8 }], ['J7s-J9s', { call: 1 }], ['J6s', { call: 0.6 }],
    ['J4s-J5s', { call: 0.5 }],
    ['JTo', { call: 0.8 }], ['J9o', { call: 0.3 }], ['J8o', { call: 0.25 }],
    ['T9s', { raise: 0.15, call: 0.85 }], ['T7s-T8s', { call: 1 }], ['T6s', { call: 0.6 }],
    ['T5s', { call: 0.5 }],
    ['T9o', { call: 0.6 }], ['T8o', { call: 0.3 }],
    ['98s', { raise: 0.15, call: 0.85 }], ['96s-97s', { call: 1 }], ['95s', { call: 0.6 }],
    ['98o', { call: 0.5 }], ['87o', { call: 0.3 }],
    ['87s', { raise: 0.15, call: 0.85 }], ['85s-86s', { call: 1 }], ['84s', { call: 0.5 }],
    ['76s', { raise: 0.1, call: 0.9 }], ['75s', { call: 1 }], ['74s', { call: 0.5 }],
    ['65s', { raise: 0.1, call: 0.9 }], ['64s', { call: 0.8 }], ['63s', { call: 0.5 }],
    ['54s', { call: 1 }], ['53s', { call: 0.6 }], ['43s', { call: 0.6 }],
  ]),
  // vs UTG's ~16% the BB faces the strongest opening range at the table: flat
  // narrow, and 3-bet almost only what beats or blocks that range. This is the
  // chart low-stakes players violate most — they defend the BB the same width
  // against UTG as against the button.
  // Target: ~30% defend, ~6% 3-bet.
  'bb-vs-utg': VS_OPEN([
    ['QQ+', { raise: 1 }], ['JJ', { raise: 0.6, call: 0.4 }], ['TT', { raise: 0.3, call: 0.7 }],
    ['22-99', { raise: 0.08, call: 0.92 }],
    ['AKs', { raise: 1 }], ['AQs', { raise: 0.55, call: 0.45 }], ['AJs', { raise: 0.25, call: 0.75 }],
    ['ATs', { call: 1 }], ['A7s-A9s', { call: 0.8 }], ['A6s', { call: 0.5 }],
    ['A5s-A4s', { raise: 0.55, call: 0.35 }], ['A3s-A2s', { raise: 0.35, call: 0.3 }],
    ['AKo', { raise: 1 }], ['AQo', { raise: 0.35, call: 0.65 }], ['AJo', { call: 0.9 }],
    ['ATo', { call: 0.5 }],
    ['A7o-A9o', { call: 0.35 }], ['A2o-A6o', { call: 0.25 }],
    ['KQs', { raise: 0.3, call: 0.7 }], ['KJs', { raise: 0.15, call: 0.85 }],
    ['K9s-KTs', { call: 1 }], ['K5s-K8s', { call: 0.5 }], ['K2s-K4s', { call: 0.25 }],
    ['KQo', { call: 0.85 }], ['KJo', { call: 0.5 }], ['KTo', { call: 0.25 }], ['K9o', { call: 0.25 }],
    ['QJs', { raise: 0.1, call: 0.9 }], ['Q9s-QTs', { call: 1 }], ['Q6s-Q8s', { call: 0.5 }],
    ['Q2s-Q5s', { call: 0.2 }],
    ['QJo', { call: 0.5 }], ['Q9o-QTo', { call: 0.2 }],
    ['JTs', { call: 1 }], ['J8s-J9s', { call: 0.8 }], ['J7s', { call: 0.4 }], ['J5s-J6s', { call: 0.3 }],
    ['JTo', { call: 0.25 }], ['J9o', { call: 0.2 }],
    ['T9s', { call: 1 }], ['T7s-T8s', { call: 0.7 }], ['T6s', { call: 0.4 }], ['T5s', { call: 0.2 }],
    ['T9o', { call: 0.3 }],
    ['98s', { call: 1 }], ['97s', { call: 0.6 }], ['96s', { call: 0.4 }], ['95s', { call: 0.2 }],
    ['98o', { call: 0.2 }],
    ['87s', { call: 1 }], ['86s', { call: 0.5 }], ['85s', { call: 0.3 }],
    ['76s', { call: 0.9 }], ['75s', { call: 0.4 }],
    ['65s', { call: 0.8 }], ['64s', { call: 0.3 }],
    ['54s', { call: 0.8 }], ['53s', { call: 0.3 }],
  ]),

  // ================= SB vs a BTN steal =================
  // 3-BET OR FOLD. Flatting here is the classic low-stakes leak: it plays a capped
  // range out of position against the widest opener at the table, with the BB still
  // live behind. The flat region is kept tiny, and only for hands that flop well
  // enough to justify the position penalty.
  // Target: ~15% total, ~13.5% 3-bet.
  'sb-vs-btn': VS_OPEN([
    ['TT+', { raise: 1 }], ['88-99', { raise: 0.8, call: 0.15 }],
    ['66-77', { raise: 0.45, call: 0.25 }], ['22-55', { raise: 0.25, call: 0.2 }],
    ['AJs+', { raise: 1 }], ['ATs', { raise: 0.8, call: 0.15 }],
    ['A5s-A2s', { raise: 0.7 }], ['A6s-A9s', { raise: 0.4, call: 0.2 }],
    ['AJo+', { raise: 1 }], ['ATo', { raise: 0.55 }], ['A9o', { raise: 0.25 }],
    ['KJs+', { raise: 1 }], ['KTs', { raise: 0.65, call: 0.15 }], ['K7s-K9s', { raise: 0.3 }],
    ['K5s-K6s', { raise: 0.2 }],
    ['KQo', { raise: 1 }], ['KJo', { raise: 0.45 }], ['KTo', { raise: 0.2 }],
    ['QJs', { raise: 0.75, call: 0.15 }], ['QTs', { raise: 0.55, call: 0.15 }], ['Q9s', { raise: 0.3 }],
    ['QJo', { raise: 0.25 }],
    ['JTs', { raise: 0.65, call: 0.2 }], ['J9s', { raise: 0.3 }],
    ['T9s', { raise: 0.55, call: 0.2 }], ['T8s', { raise: 0.2 }],
    ['98s', { raise: 0.45, call: 0.15 }], ['87s', { raise: 0.3 }], ['76s', { raise: 0.3 }],
    ['65s', { raise: 0.3 }], ['54s', { raise: 0.25 }],
  ]),
};

// NOTHING is derived into an opponent-range id, and that is deliberate.
//
// `bb-defend` and `threebet` are OPPONENT-RANGE ids, not trainer scenarios: the
// villain-range builder and the bots project them to a BINARY set and use them as
// the range a player shows up with postflop. A defend chart's non-fold projection is
// the whole ~54% DEFEND range — most of which is a flatting tail that folds the flop
// immediately — so feeding it in as a postflop range makes every villain read too
// wide and too weak. Deriving `bb-defend` from `bb-vs-btn` did exactly that: it
// widened BB_DEFEND_RANGE past the tuned token set the postflop EV model was
// calibrated against, and an underpair on a paired board started value-betting
// four-way (crossCheck.test.ts's bluff-catcher sweep caught it).
//
// Same reasoning already keeps `threebet` on the heuristic. Both stay there until
// there is a chart whose projection actually means "the range this player has
// postflop" — a real solve of the node, not a defend range collapsed to binary.
const DERIVED = {};

// Opponent-range ids this script must never leave populated. Pruned on a full run so
// an earlier version's output can't linger in the JSON (an override here silently
// reshapes bot play and every postflop villain read, which is the whole reason they
// are excluded). Not pruned on `--only`, which is a targeted merge.
const NEVER_AUTHOR = ['bb-defend', 'threebet'];

// ---------------- build ----------------
/** Kind for an action, by the same rule scripts/solver-to-preflop.mjs infers: a
 *  pure raise, or a raise mixed only with a call, is VALUE; a raise mixed with a
 *  FOLD is the bluff region (at equilibrium you do not fold part of a value hand
 *  preflop). Keeps grid colours consistent across authored and converted charts. */
function kindFor(id, byId) {
  if (id === 'fold') return 'fold';
  if (id === 'call') return 'call';
  return (byId.fold ?? 0) > 0.02 ? 'bluff' : 'value';
}

function buildChart(spec) {
  const byCode = new Map(); // code -> { actionId: freq }
  for (const [token, val] of spec.rows) {
    const freqs = typeof val === 'number' ? { [spec.main]: val } : val;
    for (const code of expandToken(token)) {
      const clean = {};
      for (const [a, f] of Object.entries(freqs)) if (f > 0) clean[a] = f;
      byCode.set(code, clean); // later rows win
    }
  }
  const chart = {};
  for (const code of ALL_169) {
    const byId = { ...(byCode.get(code) ?? {}) };
    const listed = Object.values(byId).reduce((a, f) => a + f, 0);
    if (listed > 1.0001) throw new Error(`${code}: listed frequencies sum to ${listed.toFixed(3)} > 1`);
    const rest = 1 - listed;
    if (rest > 0.0001) byId[spec.rest] = (byId[spec.rest] ?? 0) + rest;
    chart[code] = Object.entries(byId)
      .filter(([, f]) => f >= 0.005)
      .map(([a, f]) => ({ a, f: Math.round(f * 1000) / 1000, k: kindFor(a, byId) }))
      .sort((x, y) => y.f - x.f);
  }
  return chart;
}

/** Frequency-weighted % of all 1326 combos with a non-fold action. */
function playedPct(chart) {
  let combos = 0;
  for (const [code, acts] of Object.entries(chart))
    combos += acts.filter((x) => x.a !== 'fold').reduce((a, x) => a + x.f, 0) * comboCount(code);
  return (combos / 1326) * 100;
}

/** Frequency-weighted % of combos in the raise/open action (the open or 3-bet freq). */
function raisePct(chart) {
  let combos = 0;
  for (const [code, acts] of Object.entries(chart))
    combos += acts.filter((x) => x.a === 'raise' || x.a === 'open').reduce((a, x) => a + x.f, 0) * comboCount(code);
  return (combos / 1326) * 100;
}

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const only = arg('only');
const dry = argv.includes('--dry');
const outPath = arg('out', 'src/data/solverPreflop.json');

if (only && !CHARTS[only]) {
  console.error(`Unknown scenario "${only}". Known: ${Object.keys(CHARTS).join(', ')}`);
  process.exit(1);
}
const ids = only ? [only] : Object.keys(CHARTS);

const built = {};
for (const id of ids) built[id] = buildChart(CHARTS[id]);
if (!only) for (const [id, from] of Object.entries(DERIVED)) built[id] = built[from];

console.log('scenario        played%   raise%   hands');
for (const id of Object.keys(built)) {
  const c = built[id];
  console.log(
    `${id.padEnd(15)} ${playedPct(c).toFixed(1).padStart(6)}   ${raisePct(c).toFixed(1).padStart(6)}   ${Object.keys(c).length}`,
  );
}

if (dry) {
  console.log('\n--dry: nothing written.');
  process.exit(0);
}

const file = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { meta: {}, charts: {} };
file.charts ??= {};
for (const [id, chart] of Object.entries(built)) file.charts[id] = chart;
if (!only) {
  for (const id of NEVER_AUTHOR) {
    if (file.charts[id]) {
      delete file.charts[id];
      console.log(`  pruned ${id} — opponent-range id, must stay on the heuristic`);
    }
  }
}
file.meta = {
  ...file.meta,
  source: 'hand-authored ~100bb 6-max equilibrium approximations (scripts/authored-preflop.mjs) — NOT solver output',
  stackBB: 100,
  notes:
    'Per-hand mixed frequencies authored to approximate 100bb 6-max equilibrium. They are NOT a solve and must not be presented as one. Regenerate with `node scripts/authored-preflop.mjs`. Overwrite any single scenario with a real solver export via scripts/solver-to-preflop.mjs — overrides are per-scenario, so real solves and authored charts coexist. Run `node scripts/solver-to-preflop.mjs --report` for coverage. Bundled at build time: restart the dev server after editing.',
};
writeFileSync(outPath, JSON.stringify(file, null, 2) + '\n');
console.log(`\n✓ ${Object.keys(built).length} charts → ${outPath}`);
