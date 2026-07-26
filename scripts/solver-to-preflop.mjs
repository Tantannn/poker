#!/usr/bin/env node
// Convert a solver export into the app's preflop-chart JSON and MERGE it into
// src/data/solverPreflop.json (see src/data/README.md for the target format).
//
// Two input formats:
//   --format texassolver  (default)  TexasSolver strategy JSON for ONE node. Shape:
//       { "strategy": { "actions": ["FOLD","RAISE 2.5", ...],
//                       "strategy": { "AhKh": [0.1, 0.9, ...], ... } } }
//     Per-combo frequencies (AhKh) are aggregated up to 169 codes (AKs) by simple
//     averaging across the combos of each code.
//   --format simple                  Hand-transcribed / generic. Either shape:
//       { "AA": { "open": 1 }, "AJo": { "open": 0.62, "fold": 0.38 }, ... }
//     or already-normalised app actions:
//       { "AA": [ { "a": "open", "f": 1 } ], ... }
//
// Usage:
//   node scripts/solver-to-preflop.mjs --in utg.json --scenario rfi-UTG
//   node scripts/solver-to-preflop.mjs --in bb.json  --scenario bb-vs-btn --format simple
//   node scripts/solver-to-preflop.mjs --in x.json   --scenario rfi-CO --out /tmp/out.json
//   node scripts/solver-to-preflop.mjs --report      # coverage of the chart file, converts nothing
//
// Flags:
//   --in <file>        required (except --report) — the solver export
//   --scenario <id>    required (except --report) — target scenario id (see README)
//   --format <fmt>     texassolver | simple   (default texassolver)
//   --facing <f>       rfi | raise            (default inferred from the scenario id)
//   --out <file>       target chart file      (default src/data/solverPreflop.json)
//   --min <freq>       drop actions below this frequency (default 0.005)
//   --kinds <on|off>   infer the value/bluff colour kind `k` (default on)
//   --report           print per-scenario coverage for --out and exit

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ---- args ----
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const inPath = arg('in');
const scenario = arg('scenario');
const format = arg('format', 'texassolver');
const outPath = arg('out', 'src/data/solverPreflop.json');
const minFreq = parseFloat(arg('min', '0.005'));
const inferKinds = arg('kinds', 'on') !== 'off';
const reportOnly = argv.includes('--report');
if (!reportOnly && (!inPath || !scenario)) {
  console.error('Missing --in and/or --scenario. See the header of this file for usage.');
  process.exit(1);
}
// rfi scenarios open (raise → "open"); everything else raises (3-bet/4-bet/squeeze/iso).
const facing = arg('facing', /^(rfi|hu-sb-rfi)/.test(scenario) ? 'rfi' : 'raise');

// ---- card / code helpers ----
const RANKS = 'AKQJT98765432';
const rankChar = (c) => c.toUpperCase();
const suitOk = (s) => 'cdhs'.includes(s.toLowerCase());

/** "AhKh" | "AsAd" → 169 code "AKs" | "AA". */
function comboToCode(combo) {
  const m = combo.trim().match(/^([2-9TJQKA])([cdhs])([2-9TJQKA])([cdhs])$/i);
  if (!m) return null;
  let [, r1, s1, r2, s2] = m;
  r1 = rankChar(r1);
  r2 = rankChar(r2);
  if (!suitOk(s1) || !suitOk(s2)) return null;
  const hi = RANKS.indexOf(r1) <= RANKS.indexOf(r2) ? r1 : r2;
  const lo = RANKS.indexOf(r1) <= RANKS.indexOf(r2) ? r2 : r1;
  if (hi === lo) return hi + lo; // pair
  const suited = s1.toLowerCase() === s2.toLowerCase();
  return hi + lo + (suited ? 's' : 'o');
}

/** Solver action string → app action id (+ default undefined kind). */
function mapAction(raw) {
  const word = String(raw).trim().toUpperCase().split(/\s+/)[0];
  if (word === 'FOLD' || word === 'F') return 'fold';
  if (word === 'CHECK' || word === 'X') return 'check';
  if (word === 'CALL' || word === 'C') return 'call';
  if (word === 'ALLIN' || word === 'ALL_IN' || word === 'ALL-IN' || word === 'JAM') return 'allin';
  if (word === 'RAISE' || word === 'R' || word === 'BET' || word === 'B' || word === 'OPEN')
    return facing === 'rfi' ? 'open' : 'raise';
  return null; // unknown → skip
}

// ---- readers → { code: { actionId: freq } } accumulator ----
function fromTexasSolver(raw) {
  const node = raw.strategy ?? raw; // tolerate a bare node
  const actions = node.actions;
  const strat = node.strategy;
  if (!Array.isArray(actions) || !strat || typeof strat !== 'object')
    throw new Error('Not a TexasSolver node: expected { strategy: { actions:[], strategy:{} } }');
  const ids = actions.map(mapAction);
  // sum + count per code so we can average across combos
  const sums = {}; // code -> {actionId: total}
  const counts = {}; // code -> number of combos
  for (const [combo, freqs] of Object.entries(strat)) {
    const code = comboToCode(combo);
    if (!code || !Array.isArray(freqs)) continue;
    counts[code] = (counts[code] ?? 0) + 1;
    sums[code] ??= {};
    freqs.forEach((f, i) => {
      const id = ids[i];
      if (!id || !(f > 0)) return;
      sums[code][id] = (sums[code][id] ?? 0) + f;
    });
  }
  const out = {};
  for (const code of Object.keys(sums)) {
    const n = counts[code] || 1;
    out[code] = {};
    for (const [id, total] of Object.entries(sums[code])) out[code][id] = total / n;
  }
  return out;
}

function fromSimple(raw) {
  const out = {};
  for (const [code, val] of Object.entries(raw)) {
    if (Array.isArray(val)) {
      out[code] = {};
      for (const x of val) {
        const id = /^(fold|check|call|raise|open|allin)$/.test(x.a) ? x.a : mapAction(x.a);
        if (id && x.f > 0) out[code][id] = (out[code][id] ?? 0) + x.f;
      }
    } else if (val && typeof val === 'object') {
      out[code] = {};
      for (const [a, f] of Object.entries(val)) {
        const id = /^(fold|check|call|raise|open|allin)$/.test(a) ? a : mapAction(a);
        if (id && f > 0) out[code][id] = (out[code][id] ?? 0) + f;
      }
    }
  }
  return out;
}

// ---- kind (grid colour) inference ----
/** Which colour-kind an action gets when the export doesn't say. Inferred from the
 *  MIX, which is the one thing a solve reliably tells us:
 *    • fold → fold, call → call
 *    • a raise mixed with a FOLD is the BLUFF region — at equilibrium you never fold
 *      part of a value hand preflop, so any raise/fold mix marks a hand raised for
 *      fold equity rather than for value.
 *    • a pure raise, or a raise mixed only with a CALL, is VALUE — strong enough to
 *      always continue; the mix is about line, not about whether the hand is good.
 *  Without this every converted raise defaulted to `value` in solverCharts'
 *  defaultKind and the range grid lost its value/bluff split entirely.
 *  scripts/authored-preflop.mjs applies the identical rule, so authored and
 *  converted charts colour the same way. --kinds off to skip. */
function kindFor(id, normalised) {
  if (id === 'fold') return 'fold';
  if (id === 'call') return 'call';
  if (id === 'check') return 'passive';
  return (normalised.fold ?? 0) > 0.02 ? 'bluff' : 'value';
}

// ---- normalise { code: {id: freq} } → chart { code: [{a,f,k}] } ----
function toChart(acc) {
  const chart = {};
  let warned = 0;
  for (const [code, byId] of Object.entries(acc)) {
    let entries = Object.entries(byId).filter(([, f]) => f >= minFreq);
    if (!entries.length) continue;
    const sum = entries.reduce((a, [, f]) => a + f, 0);
    if (Math.abs(sum - 1) > 0.02 && warned < 5) {
      console.warn(`  ⚠ ${code}: frequencies sum to ${sum.toFixed(3)} — renormalising to 1.`);
      warned++;
    }
    // renormalise so each hand's actions sum to exactly 1, round to 3dp
    const norm = {};
    for (const [a, f] of entries) norm[a] = Math.round((f / sum) * 1000) / 1000;
    chart[code] = Object.entries(norm)
      .map(([a, f]) => (inferKinds ? { a, f, k: kindFor(a, norm) } : { a, f }))
      .sort((x, y) => y.f - x.f);
  }
  return chart;
}

// ---- report ----
// Every scenario id the app can ask for. Trainer scenarios come from
// src/strategy/preflopChart.ts SCENARIOS; the last two are OPPONENT-RANGE ids the
// bots and villain-range builder project to binary sets (src/data/README.md).
// Keep in sync when a scenario is added — an id here that the app doesn't know is
// dead data, and an app scenario missing here silently escapes the coverage report.
const KNOWN_IDS = [
  'rfi-UTG', 'rfi-MP', 'rfi-CO', 'rfi-BTN', 'rfi-SB',
  'btn-vs-utg', 'btn-vs-mp', 'btn-vs-co', 'co-vs-utg', 'co-vs-mp',
  'bb-vs-utg', 'bb-vs-mp', 'bb-vs-co', 'bb-vs-btn', 'bb-vs-sb', 'sb-vs-btn',
  'btn-vs-3bet', 'co-vs-3bet', 'utg-vs-3bet',
  'btn-vs-4bet', 'co-vs-4bet', 'utg-vs-4bet',
  'sq-btn', 'sq-bb', 'iso-btn', 'cold-vs-3bet',
  'hu-sb-rfi', 'hu-bb-vs-sb', 'hu-sb-vs-3bet', 'hu-bb-vs-limp', 'hu-bb-vs-4bet',
  'threebet', 'bb-defend',
];

const comboCount = (code) => (code.length === 2 ? 6 : code.endsWith('s') ? 4 : 12);

function chartStats(chart) {
  let played = 0;
  let raised = 0;
  const bad = [];
  for (const [code, acts] of Object.entries(chart)) {
    const n = comboCount(code);
    const sum = acts.reduce((a, x) => a + x.f, 0);
    if (Math.abs(sum - 1) > 0.02) bad.push(`${code}=${sum.toFixed(2)}`);
    played += acts.filter((x) => x.a !== 'fold').reduce((a, x) => a + x.f, 0) * n;
    raised += acts.filter((x) => x.a === 'raise' || x.a === 'open').reduce((a, x) => a + x.f, 0) * n;
  }
  const hands = Object.keys(chart).length;
  const kinds = Object.values(chart).flat().filter((x) => x.k != null).length;
  const total = Object.values(chart).flat().length;
  return {
    hands,
    played: (played / 1326) * 100,
    raised: (raised / 1326) * 100,
    bad,
    kinded: total ? (kinds / total) * 100 : 0,
  };
}

if (reportOnly) {
  if (!existsSync(outPath)) {
    console.error(`No chart file at ${outPath}.`);
    process.exit(1);
  }
  const f = JSON.parse(readFileSync(outPath, 'utf8'));
  const charts = f.charts ?? {};
  console.log(`${outPath}`);
  console.log(`source: ${f.meta?.source || '(unset)'}\n`);
  console.log('scenario         hands   played%   raise%   kind%   status');
  let present = 0;
  for (const id of KNOWN_IDS) {
    const c = charts[id];
    if (!c || !Object.keys(c).length) {
      console.log(`${id.padEnd(16)}     —         —        —       —   MISSING (heuristic fallback)`);
      continue;
    }
    present++;
    const s = chartStats(c);
    // A chart that omits hands is a PARTIAL override: solverActions returns null for
    // an absent hand and the caller drops back to the heuristic for it, so the two
    // engines are mixed inside one scenario. Worth flagging, not an error.
    const status = s.bad.length
      ? `BAD SUMS: ${s.bad.slice(0, 4).join(' ')}${s.bad.length > 4 ? ` +${s.bad.length - 4}` : ''}`
      : s.hands < 169
        ? `partial — ${169 - s.hands} hands fall back to heuristic`
        : 'ok';
    console.log(
      `${id.padEnd(16)} ${String(s.hands).padStart(5)}   ${s.played.toFixed(1).padStart(6)}   ${s.raised
        .toFixed(1)
        .padStart(6)}   ${s.kinded.toFixed(0).padStart(5)}   ${status}`,
    );
  }
  const unknown = Object.keys(charts).filter((id) => !KNOWN_IDS.includes(id));
  console.log(`\n${present}/${KNOWN_IDS.length} scenarios populated.`);
  if (unknown.length) console.log(`⚠ unknown ids (the app never reads these): ${unknown.join(', ')}`);
  process.exit(0);
}

// ---- run ----
if (!existsSync(inPath)) {
  console.error(`Input not found: ${inPath}`);
  process.exit(1);
}
const raw = JSON.parse(readFileSync(inPath, 'utf8'));
const acc = format === 'simple' ? fromSimple(raw) : fromTexasSolver(raw);
const chart = toChart(acc);
const codeCount = Object.keys(chart).length;
if (!codeCount) {
  console.error('Produced 0 hands — check --format and the input shape.');
  process.exit(1);
}

const file = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, 'utf8'))
  : { meta: {}, charts: {} };
file.charts ??= {};
file.charts[scenario] = chart;
writeFileSync(outPath, JSON.stringify(file, null, 2) + '\n');
console.log(`✓ ${scenario}: ${codeCount} hands → ${outPath}`);
