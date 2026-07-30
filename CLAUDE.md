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
   `flopSolver.ts` (nests the turn solver, bucketing turn cards by texture — the two
   chance layers make the flop the heaviest solve, so the bucketing is a disclosed
   abstraction, not solver-exact), `multiwaySolver.ts` (3-way turn/river: hero + one
   villain solved by CFR, the third player on a fixed MDF policy — see Node lock below),
   `riverAdapter.ts` (expands ranges → combos, maps the solve onto `NodeStrategy`).
   Turn/river gated by `RIVER_SOLVER_ENABLED`, flop by `FLOP_SOLVER_ENABLED`, 3-way by
   `MULTIWAY_SOLVER_ENABLED` (separate flags — flop + multiway carry abstractions), all in
   `index.ts`; flip to `false` to A/B against the per-hand model. Applies to hero-first
   flop/turn/river HU nodes, hero-facing-a-bet on **all three** streets (fold/call/raise —
   `vsBet.ts` is the shared equity-driven CFR core, fed a per-street equity matrix: exact
   showdown on the river, equity over the remaining runouts on turn/flop), and hero-first
   3-way (exactly two live opponents) turn/river; 4+-way and villain-first multiway fall
   back to (1).
   `docs/range-vs-range-ev-design.md` is the staged plan (flop = Stage 3, multiway = Stage 4,
   both built).

Preflop never uses either: `preflopChart.ts` holds mixed-frequency charts per
scenario id, and `pushFold.ts` takes over at ≤15bb effective (mirroring the bot's
own short-stack logic in `ai/decide.ts`, so the graded answer matches how the table
actually plays).

`hudCompute.ts` is the single entry point the worker calls (see below).

### Node lock — `src/strategy/villainModel.ts`
The postflop engine has exactly **two** knobs that move the recommended line, and
this module is the only place that decides their values:

- `bluffFreq` → `bluffMult` in `index.ts: betConditionedWeight` — how much of
  villain's *betting* range is air (what your bluff-catcher beats).
- `callStation` → `contBias` in `postflopModel.ts: computeAggro` — how wide villain
  continues vs a bet (your fold equity, and how thin you can value bet).

Both used to be read straight off `getProfile(profileId)`, i.e. the bot's *hidden*
archetype. `resolveVillainModel(prior, obs, lock)` replaces the source without
touching the math: observed reads (`analysis/observed.ts` counts fold-to-bet and
bet-when-checked-to per seat) shrunk toward a prior by **that read's own** decision
count, with a manual lock overriding outright. Models reach the engine as the 5th
arg of `getNodeStrategy` and ride in the `hudWorker` request payload; `useGame`
builds them (`villainModels`) from `obsCounters` + `villainLocks`.

Two invariants worth keeping. In anonymous mode the prior must be `BALANCED`, never
the profile — otherwise the engine uses what the UI deliberately hides — and
`VillainModel.archetypeVisible` must be false alongside it, since a *balanced* model
still lets explain text name the tag (`gto` is numerically balanced). It defaults to
false so a caller that forgets it leaks nothing. And when a
read/lock is off-balanced the node is solved **twice** (balanced vs villain-specific)
to produce `NodeStrategy.exploit`, the "GTO says X, vs this player do Y, worth +Z bb"
delta; both solves must take their equity from `seededEquity` so the only difference
between them is the model, not Monte-Carlo noise.

There are **two different ways** a read reaches the postflop engine, and which one a
node uses depends on its gate:

1. **Fall through to the per-hand model** — the **flop** and **3-way** gates share the
   `primaryHasRead` carve-out in `postflopStrategy`: they route to the CFR only when the
   primary villain has NO meaningful read/lock (`isExploitable`). An active read/lock
   drops to `solvePostflop`, which computes the balanced-vs-villain delta. Here the CFR
   is the GTO baseline and the per-hand model is the exploit path. `nodeLock.test.ts`'s
   flop spots rely on exactly this.
2. **Node-lock inside the CFR** — the **HU river** gate does the opposite: it passes
   `villainFoldToBet` into `solveRiver`, which pins villain's strategy to a threshold
   continue policy (`lockedVillainStrategy`) and never updates his regrets, so hero's
   CFR converges to a **best response** instead of an equilibrium. It then solves a
   second time unlocked to produce the exploit delta. This keeps range-vs-range quality
   on the street where an over-fold read pays most.

Why (2) is necessary at all: reweighting villain's *range* (`comboWeight`/`bluffMult`)
cannot express a fold-frequency read, and while CFR solves both sides the result is
unexploitable by construction — so "he over-folds the river" would change nothing.
Locking his strategy is what turns a read into a line. The lock is quoted at ¾ pot
(`LOCK_REF_FRAC`) and scaled across sizes by MDF, so a locked villain still folds more
to bigger bets. `VillainModel.foldToBet` is the primitive carried for this; `callStation`
is its clamped affine image, so shrinkage runs in fold-frequency space to keep them
consistent.

The **HU turn** now node-locks exactly like the river: the gate passes `villainFoldToBet`
into `solveTurn`, which pins villain to a threshold continue policy (ordered by his
equity-vs-hero-range, since a turn draw is a real continue) and rides the lock down into
the nested river subgames on the check line, so both the bet line and the check line
best-respond to the *same* read. A second unlocked solve gives the delta
(`exploitAnnotated` in `index.ts` is shared by the river and turn gates). **Flop and
turn/flop-facing-a-bet still carry no delta** — those gates have no lock yet.

**Multiway reads.** The 3-way solver's fixed third player is read-aware: when the
non-primary live seat carries an observed/locked, off-balanced fold-to-bet read, index.ts
passes it as `thirdFoldToBet` and `mdfCallProbs` re-anchors his continue share to it
(via the same ¾-pot-referenced `lockedContinueBySize` curve the HU lock uses) instead of
parameter-free MDF. The *solved* primary's read still routes through the per-hand fallback
(the `primaryHasRead` carve-out); only the fixed player's read lands in the CFR.

### Preflop chart override layer
`src/data/solverPreflop.json` overrides the built-in heuristic preflop charts — per
scenario, per hand, with heuristic fallback for anything absent. `solverCharts.ts`
reads it; `src/data/README.md` documents the format and the full scenario-id list.

It **ships populated** with 11 of 33 scenarios (the 5 RFI seats, the 5 BB defences and
`sb-vs-btn`), generated by `scripts/authored-preflop.mjs`. Those are
**hand-authored ~100bb 6-max approximations, not solver output** — `meta.source` says
so and so must any UI that surfaces them. Regenerate with
`node scripts/authored-preflop.mjs` (`--dry` prints coverage without writing).
`scripts/solver-to-preflop.mjs` converts TexasSolver/hand-transcribed exports and
overwrites **one scenario at a time**, so real solves and authored charts coexist;
`--report` prints per-scenario coverage and flags partial charts.

Two traps. **The JSON is bundled at build time — restart the dev server after editing
it.** And the `rfi-*` / `bb-defend` / `threebet` ids double as the *opponent-range*
ids the bots and villain-range builder project to **binary** sets, so populating one
changes bot play and every postflop villain read, not just the trainer.

`bb-defend` and `threebet` are therefore deliberately kept on the heuristic, and
`authored-preflop.mjs` prunes them on every full run (`solverCharts.test.ts` guards
it). A defend chart's non-fold projection is the whole ~54% *defend* range, most of
which is a flatting tail that folds the flop — feed that in as a postflop range and
villain reads get too wide and too weak. Deriving `bb-defend` from `bb-vs-btn` did
exactly that and made an underpair on a paired board value-bet ¾-pot four-way, caught
by `crossCheck.test.ts`'s bluff-catcher sweep. `threebet` additionally feeds `diffSet`
when flat ranges are built.

Related: `DEFAULT_MIN_PLAY` in `solverCharts.ts` is **0.6, not 0.5** — a binary set
admits a hand at full weight, so a ½ cut-off gives a hand opened 55% of the time the
same presence as one opened always and over-represents the mixed tail.

### `src/ai/` — the bots
`decide.ts` (`decideAction`) is the bot's single decision function; `profiles.ts`
holds archetypes (tag/lag/lp/gto/nit/fish), `difficulty.ts` layers easy→extreme
params and per-seat overrides, `blueprint.ts` holds frequency curves.
`DifficultyParams.overbet` gates the turn/river polar overbet (1.3–1.75× pot). Every
tier overbets its nut end; only tiers with `adapt > 0` balance the bluff side at the
same size, so on easy/normal an overbet *is* a value tell the hero can read. Bots and the
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

Target is beating beginner/intermediate/low-pro live and low/mid-stakes players through
**exploits and discipline** — not solver-grade GTO purity. The ranges and the
grading baseline are explicitly teaching-standard approximations (README says so;
don't quietly present them as solver output). When a strategic concept needs to be
"remembered" for the user, it belongs in the in-app reference surfaces —
`EquityAnchors.tsx`, the cheat-sheet components, `Reference.tsx` — not in prose here.


## Coding style

- Prefer descriptive names over explanatory comments.
- Keep functions small enough to be understood without comments.
- Avoid comments describing *what* the code does.
- 3 lines max
- Only write comments for:
  - poker concepts that are not obvious,
  - mathematical derivations,
  - performance hacks,
  - invariants that future refactors could accidentally break.