# Solver preflop charts (`solverPreflop.json`)

Drop true-GTO preflop solutions here (PioSolver / TexasSolver / GTO Wizard exports) and
they **override the app's built-in heuristic charts** — for the bots, the Range Chart grid,
the Preflop Trainer, and live preflop feedback. Anything you don't provide falls back to the
heuristic, so a partial chart is fine.

- **`solverPreflop.json`** — the live file. Ships **empty** (`"charts": {}`), so out of the box
  the app behaves exactly as before.
- **`solverPreflop.example.json`** — a filled sample showing the format. Not loaded.

Charts are bundled at build time, so **rebuild (`npm run build`) / restart the dev server** to
apply changes.

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
- **k** (optional kind, drives grid colour): `value` `bluff` `call` `fold`. Defaults sensibly
  from the action if omitted.
- **ev** (optional, bb) — shown in the trainer/feedback if present.

## Scenario ids

**RFI (opening):** `rfi-UTG` `rfi-MP` `rfi-CO` `rfi-BTN` `rfi-SB` — and `hu-sb-rfi` (heads-up).

**Vs a raise / other spots** (same ids as the app's scenarios): `btn-vs-utg` `co-vs-utg`
`bb-vs-btn` `bb-vs-sb` `bb-vs-utg` `bb-vs-mp` `co-vs-mp` `btn-vs-co` `btn-vs-mp` `bb-vs-co`
`sb-vs-btn` `btn-vs-3bet` `co-vs-3bet` `utg-vs-3bet` `btn-vs-4bet` `co-vs-4bet` `utg-vs-4bet`
`sq-btn` `sq-bb` `iso-btn` `cold-vs-3bet` `hu-bb-vs-sb` `hu-sb-vs-3bet`.

**Opponent-range ids** (used to build the villain ranges the bots & Postflop Lab face — the
binary range is projected as *every hand whose non-fold frequency ≥ 0.5*):
- `rfi-UTG` … `rfi-SB` — also feed each seat's opening range.
- `threebet` — the generic 3-bet value range.
- `bb-defend` — the BB flat-defence range.

## Getting the data

- **TexasSolver** (free, open-source, CLI, JSON output) — solve each spot, then convert its
  output to the shape above. Self-generated solves are yours to ship.
- **PioSolver / GTO+** — export node strategies; convert similarly.
- **GTO Wizard** — great for *reading* charts; note their ToS on redistributing solutions in a
  shipped app. Fine for your own local use.

A small converter script (solver JSON → this shape) is the natural next step — ask and it can
be scaffolded.
