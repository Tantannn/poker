# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # vite dev server (http://localhost:5173)
npm run build          # tsc -b && vite build  → dist/
npm test               # vitest run (34 test files, jsdom)
npm run test:watch
npm run lint           # eslint .
npm run preview

npx vitest run src/strategy/handClass.test.ts      # one file
npx vitest run src/strategy -t "bluff-catcher"     # one test by name
```

CI (`.github/workflows/deploy.yml`) runs `npm test` then `npm run build` with
`BASE_PATH=/poker/` on every push to `main`, and publishes `dist/` to GitHub Pages.
A failing test blocks the deploy.

`tsconfig.app.json` is strict in ways that bite: `noUnusedLocals`,
`noUnusedParameters`, `verbatimModuleSyntax` (type-only imports **must** use
`import type`), `erasableSyntaxOnly`. `npm run build` type-checks; `npm test` does not.

## Architecture

Strict one-way dependency flow. Keep it: `engine → ai / strategy → analysis → store → hooks → components`.

### `src/engine/` — pure poker mechanics, no strategy opinions
`table.ts` is the state machine (`createGame` → `startHand` → `legalActions` →
`applyAction`), side pots, showdown, tournament levels. `evaluator.ts` packs a
7-card hand into one comparable score. `equity.ts` is Monte-Carlo + outs.
`range.ts` is the `WeightedRange = Map<169code, weight>` type plus combo sampling.
Everything here is deterministic given a seeded RNG (`cards.ts: makeRng`).

### `src/strategy/` — the recommendation engine, and the one seam that matters
**`getNodeStrategy(state, heroIdx, iterations?, equityOverride?)` in `index.ts` is
THE dispatch point.** Every consumer — HUD, strategy panel, grader, Postflop Lab,
drills — goes through it and receives a `NodeStrategy` (`types.ts`): a list of
`ActionOption`s each carrying `freq`, `ev` (bb), `why`, `math`, plus `bestEv` /
`bestId` and a `source` tag. Adding a new engine means routing inside
`getNodeStrategy` and mapping its output to `NodeStrategy` — never bypassing it.

There are **two** postflop engines behind that seam:

1. **`postflopModel.ts`** — per-hand heuristic: equity-vs-range + a fold-equity
   model → EV per action → softmax mix (`mixFromEv`). Fast, transparent, handles
   every node including multiway. Not a Nash solve.
2. **`solver/`** — real range-vs-range CFR. `riverSolver.ts` (vector CFR, exact
   showdown), `turnSolver.ts` (nests the river solver as leaf evaluator),
   `riverAdapter.ts` (expands ranges → combos, maps the solve onto `NodeStrategy`).
   Gated by `RIVER_SOLVER_ENABLED` in `index.ts` — flip to `false` to A/B against
   the per-hand model. Currently applies to heads-up hero-first turn/river nodes
   and hero-facing-a-bet on the river; multiway always falls back to (1).
   `docs/range-vs-range-ev-design.md` is the staged plan (flop = not built).

Preflop never uses either: `preflopChart.ts` holds mixed-frequency charts per
scenario id, and `pushFold.ts` takes over at ≤15bb effective (mirroring the bot's
own short-stack logic in `ai/decide.ts`, so the graded answer matches how the table
actually plays).

`hudCompute.ts` is the single entry point the worker calls (see below).

### Solver-chart override layer
`src/data/solverPreflop.json` (shipped **empty**) overrides the built-in heuristic
preflop charts when populated — per scenario, per hand, with heuristic fallback for
anything absent. `solverCharts.ts` reads it; `src/data/README.md` documents the
format and the full scenario-id list. `scripts/solver-to-preflop.mjs` converts
TexasSolver/hand-transcribed exports into it. **The JSON is bundled at build time —
restart the dev server after editing it.**

### `src/ai/` — the bots
`decide.ts` (`decideAction`) is the bot's single decision function; `profiles.ts`
holds archetypes (tag/lag/lp/gto/nit/fish), `difficulty.ts` layers easy→extreme
params and per-seat overrides, `blueprint.ts` holds frequency curves. Bots and the
grader read the same preflop charts, so keeping them in sync is a hard requirement,
not a nicety.

### `src/analysis/` — grading
`grade.ts: gradeNode` scores the hero's executed action as EV loss against
`NodeStrategy.bestEv`, then buckets it via `stats.ts: moveTier` into
`best | correct | inaccuracy | wrong | blunder`. **Grading is anchored on EV, not on
frequency** — the "best" line is the highest-EV option, even when a lower-EV action
is played more often in the mix. `buildSizingCoach` / `buildCheckLineCoach` produce
the prose. `observed.ts` derives live villain stats; `tilt.ts` and `aggression.ts`
produce session warnings.

### `src/store/` — localStorage persistence, no framework
Plain functions (`loadX` / `saveX`), no state library. **Every key must be prefixed
`poker-` or `poker.`** — `backup.ts` filters on that prefix to build the
export/import bundle, so an unprefixed key silently won't travel with a user's
backup. `history.ts` caps hand history (journal-tagged hands are protected),
`srs.ts` is the spaced-repetition weighting shared by all drills
(`weightOf` / `recordSrs` / `weightedIndex`), `stats.ts` computes bb/100, EV-loss/100
and the leak finder.

### `src/hooks/useGame.ts` + `src/workers/hudWorker.ts`
`useGame` is the deliberate god-hook (~940 lines) owning game state, bot turns,
feedback, history, journal, stats and every setting; `App.tsx` threads the whole
object into tabs as `g`. HUD/strategy computation runs off-thread in `hudWorker.ts`
because the Monte-Carlo runs used to hitch the UI on phones — requests carry a
`seq` so stale replies are dropped when state advances mid-compute.

### `src/components/` + `App.tsx`
31 tabs. `App.tsx` holds the `Tab` union, the `TABS` array (order = display order)
and `Cat` grouping for the nav dropdown; every tab except `PokerTable` is
`lazy()`-imported from a **named** export remapped to `{ default }`. Adding a tab =
add to the union, add a `TABS` entry with a category, add the `lazy` import, render
it in the switch.

## Test conventions

Colocated `*.test.ts(x)`, vitest + jsdom, `src/test/setup.ts` unmounts between
cases. Three unusual suites worth knowing before you "fix" them:

- **`strategy/crossCheck.test.ts`** — cross-module consistency sweep asserting
  `handClass.ts` and `postflopModel.ts` never *unambiguously* contradict each other
  (air value-bet, monster-as-bluff, bluff-catcher shoving). It deliberately tolerates
  close frequency calls, and documents known residuals as `it.todo`.
- **`strategy/spotRecheck.test.ts`** — pinned regressions for specific hands
  (paired-board bluff-catchers, board-driven outs). These encode past bugs; changing
  the expectation needs a reason.
- **`ai/_repro.test.ts`** — a logging harness, not an assertion suite.

`_winrate.6max.txt` at the repo root is a committed sim-output artifact, not config.

## Things that will bite you

- **PWA caching.** `vite-plugin-pwa` with `registerType: 'autoUpdate'` caches
  aggressively, so a stale page after a deploy looks like a code bug. The footer
  shows `__APP_VERSION__` / `__BUILD_SHA__` / `__BUILD_TIME__` (defined in
  `vite.config.ts`) — check the SHA before debugging. The dev SW is enabled too
  (`dev-dist/`, gitignored).
- **Base path.** Assets resolve under `/poker/` on Pages, `/` locally, via
  `BASE_PATH`. Anything hardcoding an absolute `/…` asset URL breaks in production only.
- **Nothing leaves the machine.** No network calls, no backend, no telemetry. Keep
  it that way.

## Product intent

Target is beating beginner/intermediate live and low-stakes players through
**exploits and discipline** — not solver-grade GTO purity. The ranges and the
grading baseline are explicitly teaching-standard approximations (README says so;
don't quietly present them as solver output). When a strategic concept needs to be
"remembered" for the user, it belongs in the in-app reference surfaces —
`EquityAnchors.tsx`, the cheat-sheet components, `Reference.tsx` — not in prose here.
