# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # vite dev server (http://localhost:5173)
npm run build          # tsc -b && vite build  → dist/
npm test               # vitest run (~85 test files, jsdom)
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
`table/table.ts` is the state machine (`createGame` → `startHand` → `legalActions` →
`applyAction`), side pots, showdown, tournament levels. `cards/evaluator.ts` packs a
7-card hand into one comparable score. `equity/equity.ts` is Monte-Carlo + outs.
`cards/range.ts` is the `WeightedRange = Map<169code, weight>` type plus combo sampling.
Everything here is deterministic given a seeded RNG (`cards/cards.ts: makeRng`).

### Deep reference — read the matching file before working in that area
Split out to keep this file short. Each line names the one invariant that most often bites.

- **`docs/claude/solvers.md`** — CFR internals: hero-first tree (villain raise), villain stab +
  hero check-raise, called-line futures (hero-first AND facing-a-bet), multiway, size grids, solve
  cache. *`villainCallFreq` is calls only — folds are 1 − `villainContinueFreq`; futures are per
  (hero, villain) PAIR, round 0 on full ranges, damped ½/½.*
- **`docs/claude/reads.md`** — node lock (`villainModel.ts`), anonymous-seat recognition, windowed
  reads / leveling, preflop read layer. *Anonymous mode: prior must be `BALANCED` and
  `archetypeVisible` false — never leak the hidden profile.*
- **`docs/claude/bots.md`** — `decide.ts` preflop/postflop model, range respect, measured `hud`,
  bot simulator. *Retuning a bot moves its measured stats: re-measure `profiles.ts` `hud` (the
  calibration test fails until you do).*
- **`docs/claude/rake-straddle.md`** — rake model and straddles. *A straddle is a blind, not a
  raise — compare `currentBet` to `effectiveBigBlind`, never `bigBlind`.*
- **`docs/claude/preflop-ranges.md`** — limped-pot roles, `solverPreflop.json` override layer.
  *`bb-defend`/`threebet` stay heuristic; an empty preflop log is a synthesised spot, not a limp.*
- **`docs/claude/app-layers.md`** — grading, live capture, store (`poker-` key prefix), the
  `useGame` god-hook + HUD worker (fast provisional answer, then the solve), tabs.
- **`docs/range-vs-range-ev-design.md`** — the staged solver plan.

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
   every node including multiway. Not a Nash solve. Its heads-up OOP check is priced by
   `checkVsStab` (villain bets ¾ pot into it, hero check-calls or check-folds) instead of a
   flat realisation haircut; multiway / IP keep the old formula.
2. **`solver/`** — real range-vs-range CFR. `riverSolver.ts` (vector CFR, exact
   showdown), `turnSolver.ts` (nests the river solver as leaf evaluator),
   `flopSolver.ts` (nests the turn solver, bucketing turn cards by texture — the two
   chance layers make the flop the heaviest solve, so the bucketing is a disclosed
   abstraction, not solver-exact), `multiwaySolver.ts` (3- to 5-handed **flop, turn and
   river**: hero + one villain solved by CFR, the remaining 1–3 players on a fixed MDF
   policy — see `docs/claude/reads.md` and `docs/claude/solvers.md`), `riverAdapter.ts` (expands ranges →
   combos, maps the solve onto `NodeStrategy`).
   Turn/river gated by `RIVER_SOLVER_ENABLED`, flop by `FLOP_SOLVER_ENABLED`, 3-way by
   `MULTIWAY_SOLVER_ENABLED` (separate flags — flop + multiway carry abstractions), all in
   `index.ts`; flip to `false` to A/B against the per-hand model. Applies to hero-first
   flop/turn/river HU nodes (villain may fold / call / **raise** hero's bet, hero then folds or
   calls — see `docs/claude/solvers.md`), hero-facing-a-bet on **all three** streets (fold / call / two
   raise sizes / jam, and villain may **re-raise** any non-jam raise — `vsBet.ts` is the
   shared equity-driven CFR core, fed a per-street equity matrix: exact showdown on the
   river, equity over the remaining runouts on turn/flop — and node-locked
   on villain's response to hero's raise, see `docs/claude/reads.md`), and hero-first
   multiway (2–8 live opponents, i.e. 3- to 9-way) on **all three** streets, capped by
   `MAX_MULTIWAY_OPPONENTS = 8` — 9-max is `useGame`'s own seat maximum, so every table the app
   can deal is solved (the cap reached the max table once `fieldCoef` retired the 2^field
   enumeration — see `docs/claude/solvers.md`). What still falls back to (1): **villain-first multiway**
   (facing a bet with 2+ opponents — `vsBet.ts` is heads-up only).
   `docs/range-vs-range-ev-design.md` is the staged plan (flop = Stage 3, multiway = Stage 4,
   both built).

## Test conventions

Colocated `*.test.ts(x)`, vitest + jsdom, `src/test/setup.ts` unmounts between
cases. Three unusual suites worth knowing before you "fix" them:

- **`strategy/postflop/crossCheck.test.ts`** — cross-module consistency sweep asserting
  `handClass.ts` and `postflopModel.ts` never *unambiguously* contradict each other
  (air value-bet, monster-as-bluff, bluff-catcher shoving). It deliberately tolerates
  close frequency calls, and documents known residuals as `it.todo`.
- **`strategy/postflop/spotRecheck.test.ts`** — pinned regressions for specific hands
  (paired-board bluff-catchers, board-driven outs). These encode past bugs; changing
  the expectation needs a reason.
- **`ai/sim/_repro.test.ts`** — a logging harness, not an assertion suite.

`_winrate.6max.txt` at the repo root is a committed sim-output artifact, not config.

## Things that will bite you

- **CFR test expectations are range-composition-sensitive.** A two-combo hero range makes the
  game degenerate — villain's response to a range that is half air is nothing like his real
  one — so a solver test that "fails" may just have an unrealistic range. Use value + draw +
  air before concluding the solver is wrong. And the heavy solver tests (multiway flop ≈ 1.7s a
  node) need explicit per-test timeouts: the 5s default passes solo and fails under the full
  suite's parallel load.
- **The two postflop engines can disagree at the SAME node.** A read landing on the primary
  villain flips a flop/multiway node from the CFR to the per-hand model (`primaryHasRead`),
  and the per-hand model's mix is not the CFR's — replaying one spot can turn "bet pot 86%"
  into "check 98%". `index.ts: heuristicEngineNote` names the engine and the gate that
  excluded the node, carried on `NodeStrategy.engineNote` and rendered by `EngineBadge` +
  the note block in `StrategyPanel` / `Feedback`. `engineNote.test.ts` pins it. Never let a
  heuristic node render without that provenance.
- **Rake defaults to `none`.** Every EV in the app is rake-free until the user picks a
  profile in ⚙ Settings, so the whole test suite pins rake-free numbers and a rake bug is
  invisible by default (`strategy/rake.test.ts` is the direction guard). `GameState.rake`
  also has to be **stamped onto any state built by `createGame`** — `useGame` does it in
  `deal` and in `setRake`; a new call site that skips it silently plays rake-free.
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

Target is beating beginner/intermediate/low-pro live and low/mid-stakes players through
**exploits and discipline** — not solver-grade GTO purity. The ranges and the
grading baseline are explicitly teaching-standard approximations (README says so;
don't quietly present them as solver output). When a strategic concept needs to be
"remembered" for the user, it belongs in the in-app reference surfaces —
`EquityAnchors.tsx`, the cheat-sheet components, `Reference.tsx` — not in prose here.

## Architecture & Code Conventions (portable — React + TypeScript)

The project-specific sections above override anything here.

### Structure
- **Imports**: path alias (`@/`) across modules, never `../../`. Same-folder `./x` is fine.
- **Limits**: files <~300 lines, components <250. Over → logic to hook/service, UI to child components, static data/schemas/mocks to `constants.ts`/`types.ts`/`*-schema.ts`. Split BEFORE adding a feature to a near-limit file. Split by what changes together (one reason to change per file), never by line count — no `part1`/`part2` files; if you can't name a piece by its job, the split is wrong.
- **Folder size**: ~7 source files per folder max. Not counted: barrel `index.ts`, test files. Tests go in a `__tests__/` subfolder next to the code they test. Over → subfolders by sub-concern (`tools/extrude/`, `tools/fillet/`), not by file type. Split BEFORE adding an 8th file.
- **Folder shape**: ~7 subfolders per folder (`__tests__/` excluded) and max ~4 levels deep inside a module. Too wide → group subfolders by concept (e.g
. editing / persistence / display). Too deep → the module is probably two modules; split it instead of nesting further. Apply by ratchet; don't reorgani
ze existing trees unasked.
- **Barrel files** (`index.ts`): one per module/subfolder = its public API. Explicit named re-exports only (`export { X } from './x'`, `export type { T } from './t'`) — no `export *`, no logic, no side effects. Export only what outsiders need. Inside a module import siblings by direct path, never via own barrel (avoids cycles). Outside a module import only via its barrel — no deep paths.

### Architecture
- **Layer direction**: `routes/pages → feature modules → core/lib`. Lower layers never import higher ones. Domain reaches core only via injected handlers/ports (dependency inversion).
- **Placement**: code lives in the deepest folder containing all its users. Second user in a sibling folder → propose moving i
t to their nearest common parent, named by concept (`tools/snapping/`, not `tools/shared/`); never import into a sibling's int
ernals. Only generic code (math, geometry, formatting) moves up to `core/`/`lib/`; domain code stays in its module, and core g
ets an interface instead. Merge duplicates only if a change to one must always change the other; unsure → keep copies. Ask bef
ore moving files outside my owned folders.
- **Module boundaries**: never import across sibling feature modules except via their barrel.
- **Data boundary (anti-corruption layer)**: fetchers schema-parse the DTO and map to a domain type; components/tools/engines never see raw DTOs. One mapper per external shape. After the boundary, trust types — no defensive `?.` on validated data.
- **State placement**: server data → query cache; shareable/reload-safe (filters, tab, selected id) → URL params; cross-component UI → store; rest → local state. Never copy server data into a UI store.
- **Stores own one slice**: a store never imports unrelated domain stores or reaches into imperative engines for domain logic. Cross-domain behavior → handler slot (`xxx: Handlers | null` + `setXxx`) implemented in a service, registered once at app shell. Side-effects at call-site/injected service.
- **Discriminated unions** over `kind` + optional-field piles: `type T = A | B` with shared base. Lets TS narrow, removes guards.
- **Pure logic separate from UI**: inputs→result functions (no DOM/network/engine/store) live in `utils/`/`services/`/`*-math.ts`, never inline in component/hook/tool.
- **Facade for god objects**: a large entry class only delegates; new feature = new module + thin delegation.
- **Lifecycle**: every subscribe/listener/registration/GPU resource has paired teardown (`unload`/`deactivate`/effect cleanup). No raw `window` key listeners — route through the hotkey layer.
- **Input ownership**: each key/pointer event has exactly one owner at a time. Priorities live in one documented table; a handler that claims an event stops it. No second listener "just in case".

### Legacy code: ratchet
- Record a baseline of violation counts (cross-layer imports, oversized files, `export *` barrels, oversized folders). Counts only go down.
- Never add a new violation. When editing a file that has one, fix it if cheap (same PR, separate commit). No big-bang rewrites.
- Code you don't own: follow existing patterns, minimal diffs, no drive-by refactors.

### React
- **Component order**: context/hooks → refs → state → derived → effects → early returns → render.
- If React Compiler is on, no manual `useMemo`/`useCallback`/`memo` unless profiled.
- **a11y**: semantic HTML over `<div>`; keyboard nav (Tab/Enter/Space); `aria-label`/alt on icon buttons/images; focus management + ARIA for custom widgets/modals.
- **Styling**: no inline `style={{}}` except dynamic computed values. No hardcoded colors — design tokens/CSS vars. Never `!important`.
- **Errors**: Error Boundaries on major routes + state-heavy widgets. Catch API errors at query/mutation level with one standard un-wrapper. Actionable toasts + fallback UI, no infinite spinners. Never silently swallow.
- **UX safety**: destructive actions require confirmation. Numeric inputs have one max shared by form/schema/message/API.
- **i18n**: no hardcoded user-facing text.

### Quality
- **Testing**: new/changed pure logic ships with unit tests in the same PR. UI/engine: e2e only for critical flows.
- **Decisions**: non-trivial design choice → ADR `docs/adr/NNNN-title.md` (context, decision, alternatives, consequences).
- **Comments**: max 3 lines; only complex algorithms, unintuitive math, caveats/invariants. Never obvious code. Explain changes in the reply, not in comments.

## Working Style & Mentoring

### Working style
**Do NOT ask before acting in this project.** Overrides the global "Ask before acting" rule: act on clear requests directly; ask only when genuinely blocked on a decision that is the user's to make.

### Mentoring mode
I'm a fullstack dev (C#/ASP.NET Core, EF Core, TS frontend, AEC platform) growing into a software architect. Non-trivial answers serve two goals: solve the task + grow my architecture thinking.

- **Logic first**: root cause in 1–3 sentences, then WHY this approach. Name rejected alternatives + trade-off (complexity, perf, maintainability, cost, team size).
- **Architect lens** (short section at end): principle/pattern at work; what breaks at 10x or in 1 year; the decision I'd defend in design review, and how.
- **Practical**: tie to my real codebase, not textbook examples. If the codebase contradicts a generic pattern, say so and adapt. Minimal diffs.
- **Push me**: on design decisions, first ask ONE question — what would I choose and why — then compare. Call out flawed reasoning and symptom-fixing directly; don't just agree.
- **Grow over time**: complex answers end with "Concept to study next: <one topic>". When I make a decision, suggest an ADR.
- **Style**: direct, concise, no flattery. ASCII diagrams for structure/data flow (terminal doesn't render Mermaid). Reply in English only.
