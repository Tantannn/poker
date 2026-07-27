# Solver preflop charts (`solverPreflop.json`)

Per-hand mixed preflop strategies that **override the app's built-in heuristic charts** —
for the bots, the Range Chart grid, the Preflop Trainer, and live preflop feedback.
Anything absent falls back to the heuristic, so a partial chart set is fine.

- **`solverPreflop.json`** — the live file. **Ships populated** with 12 hand-authored
  charts (see below). Regenerate with `node scripts/authored-preflop.mjs`.
- **`solverPreflop.example.json`** — a filled sample showing the format. Not loaded.

Charts are bundled at build time, so **rebuild (`npm run build`) / restart the dev
server** to apply changes.

## What ships, and what it is not

The shipped charts are **hand-authored ~100bb 6-max equilibrium approximations, not
solver output** — `meta.source` says so and the app must keep saying so. They exist
because the heuristic they replace stores a *binary* range set plus one global
`bluffFreq` per scenario: every bluff-region hand mixed at the same rate, so the
grader had no per-hand resolution. The authored charts give each hand its own
frequency, split value/bluff per hand, and encode the suited/offsuit and blocker
structure the token sets flatten.

Populated (11 of 33 scenario ids — the highest-volume spots):

| scenario | played% | 3-bet/open% |
| --- | --- | --- |
| `rfi-UTG` `rfi-MP` `rfi-CO` `rfi-BTN` `rfi-SB` | 15.5 / 18.6 / 28.1 / 46.2 / 40.6 | same (open) |
| `bb-vs-utg` `bb-vs-mp` `bb-vs-co` `bb-vs-btn` `bb-vs-sb` | 25.3 / 37.8 / 44.8 / 54.1 / 77.6 | 4.5 / 6.2 / 7.4 / 8.6 / 11.7 |
| `sb-vs-btn` (3-bet or fold) | 15.5 | 14.1 |

Everything else — the vs-3bet / vs-4bet / squeeze / iso / heads-up trees — is still on
the heuristic.

### Never override the opponent-range ids

`bb-defend` and `threebet` are **not** trainer scenarios. They are projected to a
*binary* set and used as the range a player holds **postflop**. A defend chart's
non-fold projection is the whole ~54% defend range, most of which is a flatting tail
that folds the flop immediately — feed that in as a postflop range and every villain
read gets too wide and too weak. Deriving `bb-defend` from `bb-vs-btn` did exactly
that and made an underpair on a paired board value-bet ¾-pot four-way, which
`crossCheck.test.ts`'s bluff-catcher sweep caught. `threebet` additionally feeds
`diffSet` when the app builds flat-call ranges, so overriding it reshapes every flat
range as a side effect.

`authored-preflop.mjs` prunes both on every full run and `solverCharts.test.ts` asserts
they stay empty. Only populate them from a real solve of the postflop node, never from
a preflop defend chart.

Related: the projection threshold (`DEFAULT_MIN_PLAY` in `solverCharts.ts`) is **0.6,
not 0.5**. A binary set admits a hand at full weight, so a ½ cut-off gives a hand
opened 55% of the time the same presence as one opened always, and over-represents the
mixed tail — which is exactly where the wide, weak hands live.

Run the coverage report any time:

```bash
node scripts/solver-to-preflop.mjs --report
```

## Replacing a chart with a real solve

Overrides are **per scenario**, so real solves and authored charts coexist — drop in
one spot at a time and the rest is untouched.

```bash
node scripts/solver-to-preflop.mjs --in utg.json --scenario rfi-UTG
node scripts/solver-to-preflop.mjs --in bb.json  --scenario bb-vs-btn --format simple
node scripts/solver-to-preflop.mjs --report      # confirm it landed
```

Then update `meta.source` so the file stops describing itself as hand-authored for
the parts that are now solved.

## Format

```jsonc
{
  "meta": { "source": "…", "stackBB": 100, "notes": "…" },
  "charts": {
    "<scenario-id>": {
      "<hand-code>": [ { "a": "<action>", "f": <freq 0..1>, "k": "<kind?>", "ev": <bb?> }, … ]
    }
  }
}
```

- **hand-code** — canonical 169 notation: `AA`, `AKs`, `AJo`, `T9s`, `72o`.
- **f** — frequency for that action; a hand's actions should sum to ~1.
- **a** (action id): `open` `fold` `call` `raise` `allin`. Use `raise` for a 3-bet/4-bet/5-bet/
  squeeze/iso — the label is derived from the scenario.
- **k** (optional kind, drives grid colour): `value` `bluff` `call` `fold`. Both scripts
  infer it from the mix: a raise mixed with a **fold** is `bluff` (at equilibrium you
  don't fold part of a value hand preflop); a pure raise, or a raise mixed only with a
  **call**, is `value`. Pass `--kinds off` to the converter to leave it out.
- **ev** (optional, bb) — shown in the trainer/feedback if present.

A chart that omits hands is a *partial* override: `solverActions` returns `null` for an
absent hand and the caller drops back to the heuristic for that hand alone, mixing two
engines inside one scenario. The authored charts therefore emit all 169 codes, folds
included. `--report` flags partial charts.

## Scenario ids

**RFI (opening):** `rfi-UTG` `rfi-MP` `rfi-CO` `rfi-BTN` `rfi-SB` — and `hu-sb-rfi` (heads-up).

**Vs a raise / other spots** (same ids as the app's scenarios): `btn-vs-utg` `co-vs-utg`
`bb-vs-btn` `bb-vs-sb` `bb-vs-utg` `bb-vs-mp` `co-vs-mp` `btn-vs-co` `btn-vs-mp` `bb-vs-co`
`sb-vs-btn` `btn-vs-3bet` `co-vs-3bet` `utg-vs-3bet` `btn-vs-4bet` `co-vs-4bet` `utg-vs-4bet`
`sq-btn` `sq-bb` `iso-btn` `cold-vs-3bet` `hu-bb-vs-sb` `hu-sb-vs-3bet` `hu-bb-vs-limp`
`hu-bb-vs-4bet`.

**Opponent-range ids** (used to build the villain ranges the bots & Postflop Lab face — the
binary range is projected as *every hand whose non-fold frequency ≥ 0.5*):
- `rfi-UTG` … `rfi-SB` — also feed each seat's opening range.
- `threebet` — the generic 3-bet value range.
- `bb-defend` — the BB flat-defence range.

`scripts/solver-to-preflop.mjs --report` lists all of them with their current status;
`KNOWN_IDS` in that script is the list to update when a scenario is added.

## Getting real data

- **TexasSolver** (free, open-source, CLI, JSON output) — solve each spot, then convert its
  output to the shape above. Self-generated solves are yours to ship.
- **PioSolver / GTO+** — export node strategies; convert similarly.
- **GTO Wizard** — great for *reading* charts; note their ToS on redistributing solutions in a
  shipped app. Fine for your own local use.
