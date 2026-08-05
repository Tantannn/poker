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

### Rake — `src/engine/rake.ts`
`RAKE_PROFILES` (none / online / live 1-2 / 2-5 / 5-10) → `rakeInChips(id, bb)` →
a chip-denominated `Rake { pct, cap, drop }`, consumed by **both** `rakeOn`/`netPot`
(pot collected) and `rakeMarginal` (the tax on the *next* chip won — zero past the cap).
`GameState.rake` holds the profile id; `table.ts: takeRake` takes it off the **main
pot** at award time and only when a flop was dealt (**no flop, no drop**), recording
`state.rakePaid`. `strategy/index.ts` resolves the same id once per node and passes the
`Rake` into every engine, so a recommendation can't be rake-free while the table charges.

Two things make rake worth modelling rather than approximating: the **cap makes it
regressive** (a flat fee on a limped pot, ~1% of a stacks-in pot), and it raises the
**break-even equity of a call** to `call ÷ (pot after rake)`. That is why it kills exactly
the marginal spots the trainer teaches — thin river value, small-blind flats, cheap steals —
and leaves coolers alone.

Where it lands in the math: pots hero *collects* are netted (`netPot`), chips hero
*invests* are never reduced (a loser pays no rake), and incremental winnings — a thin bet's
extra chips, later-street value — are shaved by `rakeMarginal`. In the CFR solvers the
terminal pots are precomputed **per bet size outside the loops** (`netAtBet` / `foldWinBet` /
`netPotByBets`): calling into the rake model per leaf cost seconds of wall clock and timed
the turn solves out. Keep it that way.

Preflop reaches the charts through a shading layer, not through the chart data —
`preflopRake.ts: shadeForRake` runs last in `preflopStrategy` (read → depth → rake, since
the house is a property of neither the villain nor the stack). Two mechanics, and neither
is a flat frequency cut. The **cap makes it regressive**, so `rakeTaxRate` is a function of
pot size and the shade tapers by `marginality` — it bites the marginal tail and leaves
coolers alone. And **no flop, no drop** makes it per-ACTION: a call always sees a flop and
pays in full, a raise pays only on the called branch (`RAISE_TAX_SHARE`, mostly gone
multiway), a fold pays nothing and absorbs the slack. The live lesson falls straight out —
under rake, marginal hands are raise-or-fold.

Disclosed gaps: the chart *data* is still ~100bb rake-free (this shades what it teaches),
and `ai/decide.ts` doesn't see it, so rake changes hero's graded line, not how the bots play.

### Straddle — `table.ts: straddleSeats` / `effectiveBigBlind`
`GameState.straddle` is `off | utg | double | button` (Mississippi); `startHand` posts it
right after the blinds and records the live bet in `state.straddleTo`. Cash only, and never
with fewer than 3 live seats — the straddler has to have a seat that still acts last.

Two mechanics carry it. **Order**: the last blind posted is the last to act preflop, so
`toAct` starts left of the straddler (UTG+1 behind a UTG straddle, the SB behind a
Mississippi) and the straddler keeps the option — his `hasActed` is reset exactly like the
blinds'. **Depth**: `effectiveBigBlind(state)` returns the straddle when one is live, and
every depth-sensitive consumer reads it instead of `bigBlind` — `effectiveStackBB` (so a
100bb table is 50 bets deep, which is what shifts the chart depth notes and the ≤15bb
push/fold gate), the bots' `effStackBB`, their open sizing (`openToBB × effectiveBigBlind` —
size off the blind instead and every open is a min-raise), their 3-bet/4-bet multiples, and
the `facingRaise` test in both `index.ts` and `ai/decide.ts`.

That last one is the subtle invariant: **a straddle is a blind, not a raise.** Compare
`currentBet` to `bigBlind` anywhere and an unopened straddled pot reads as "facing a raise",
which sends hero and every bot into 3-bet ranges in a limped pot.

EVs stay quoted in real big blinds; only depth is counted in straddles. The charts remain a
~100bb no-straddle baseline, and `straddleNote` says so on every straddled hand.

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
   abstraction, not solver-exact), `multiwaySolver.ts` (3- to 5-handed **flop, turn and
   river**: hero + one villain solved by CFR, the remaining 1–3 players on a fixed MDF
   policy — see Node lock and Multiway flop below), `riverAdapter.ts` (expands ranges →
   combos, maps the solve onto `NodeStrategy`).
   Turn/river gated by `RIVER_SOLVER_ENABLED`, flop by `FLOP_SOLVER_ENABLED`, 3-way by
   `MULTIWAY_SOLVER_ENABLED` (separate flags — flop + multiway carry abstractions), all in
   `index.ts`; flip to `false` to A/B against the per-hand model. Applies to hero-first
   flop/turn/river HU nodes (villain may fold / call / **raise** hero's bet, hero then folds or
   calls — see Hero-first tree below), hero-facing-a-bet on **all three** streets (fold / call / two
   raise sizes / jam, and villain may **re-raise** any non-jam raise — `vsBet.ts` is the
   shared equity-driven CFR core, fed a per-street equity matrix: exact showdown on the
   river, equity over the remaining runouts on turn/flop — and node-locked
   on villain's response to hero's raise, see below), and hero-first
   multiway (2–8 live opponents, i.e. 3- to 9-way) on **all three** streets, capped by
   `MAX_MULTIWAY_OPPONENTS = 8` — 9-max is `useGame`'s own seat maximum, so every table the app
   can deal is solved (the cap reached the max table once `fieldCoef` retired the 2^field
   enumeration — see Multiway flop below). What still falls back to (1): **villain-first multiway**
   (facing a bet with 2+ opponents — `vsBet.ts` is heads-up only).
   `docs/range-vs-range-ev-design.md` is the staged plan (flop = Stage 3, multiway = Stage 4,
   both built).

### Hero-first tree: villain may raise — `riverSolver.ts: villainRaiseSizes`
Hero bets, villain answers **fold / call / raise**, hero then **folds or calls** the raise.
Depth stops there (no hero re-raise), same as the facing-a-bet tree's one re-raise. All three
heads-up streets carry it, `villainMayRaise` (default true) turns it off for an A/B, and it
rides into the nested subgames so the check line and the bet line model the same tree. The
raise-TO is one size — villain's call plus ¾ of the pot he'd then play — floored at a legal
min-raise, capped at the stack, and absent when hero is already all-in. A **locked** villain
still raises (`locked3BetPolicy`, strongest `LOCKED_THREEBET_SHARE` of what he keeps), or hero
would get a bet that can never be punished.

Why it matters: without the branch a bet could only be folded to or called, so a bluff was
priced risk-free and the solver could not express **bet-fold** at all. `heroRaiseResponse` /
`heroFoldToRaiseFreq` now carry that decision out to the coach ("he raises this ~18% — plan to
fold with this hand").

Three traps this created, all guarded by `betRaiseTree.test.ts`:

- **`villainCallFreq` is calls only.** Continues are call + raise, so a fold read is the
  complement of `villainContinueFreq`, not of the call frequency. Measuring folds off calls
  counts every raise as a fold.
- **"Adding the raise lowers a bluff's EV" is FALSE at equilibrium.** A re-solve moves
  villain's whole strategy: the strong end of his range migrates from call to raise, so hero's
  bluff gets folded on more often, which can outweigh the raises. The direction is only exact
  with villain held FIXED (a node lock): air is indifferent-to-worse, a value hand strictly
  better off, since a raise from a worse hand pays more than a call.
- **Turn frequencies near a locked over-folder are coin flips.** Hero's alternative to
  barrelling is to check and bluff the river, where the same locked villain folds just as
  often — so the two lines sit within fractions of a chip and which one takes the frequency
  flips between adjacent runouts. The stable turn claim is that betting's **EV** rises with the
  fold read; the big `exploit` delta lives on the river, where there is no street left to delay
  to. Don't re-add a turn frequency assertion.

`exploitability.ts` re-derives this tree independently (including hero's second decision) and
still reports < 1% of pot on a converged solve — that is the audit that the branch's payoffs
and signs are right. The multiway solvers keep the two-action tree; villain's raise there would
need the field's response modelled too.

### Multiway flop — `multiwaySolver.ts: solveFlop3way`
All three multiway streets share one street-agnostic CFR (`multiwayCfr`): hero picks
check/bet-size, the solved villain answers fold/call, and the fixed field is pre-collapsed
into `ThirdAgg` scalars. The only per-street difference is where `hvWin` comes from — an exact
showdown on the river, equity over the remaining runouts on the turn, and on the flop equity
over **nested texture buckets** (a turn representative × a river representative, weighted).

The flop needed one thing the other streets didn't. Its check line nests a real turn subgame
while a *called bet* is scored as a static two-street showdown (the cost bound the HU flop
solver also takes). Heads-up, fold equity hides that gap; multiway it dominates and **widens
with every extra player**, because the check line keeps the whole field in for its nested
street and the bet line folds part of the field out for nothing later. Uncorrected, the solve
checks a set on a wet 5-way flop — the worst advice this app could give a live player. So
`calledLineFutureValue` raises the bet line to the same fidelity: it nests a turn subgame at
the *called* pot, subtracts the static baseline at that same pot, and discounts the remainder
by the combo's scoop share (without that discount the nested solve lends pure air the barrel
equity of a range it isn't in, and hero starts stabbing multiway flops with king-high).

Cost is the constraint — measured through the live gate: **~1.0s 3-way, ~1.3s 6-way, ~1.9s
8-way, ~2.2s 9-way**, vs ~1.2s for the HU flop. It is the heaviest node in the app, and it
grows only **linearly** — ~280ms per added opponent, no doubling. That was the whole point of
`multiwaySolver.ts: fieldCoef`: the field's caller sets used to be **enumerated** (2^field
subsets), which capped the solver near 6-way; `betEvVsField`/`callEvVsField` consume the field
only as `Σ prob·win·netByBets[callers+k]`, and that sum is the coefficient of a generating
function — the exact O(field²) collapse of the enumeration, no sampling. The field side is now
cheap, so the cost is bounded by the nested subgames, whose `scaleCap` (riverAdapter.ts) combo
caps sit on the 12-floor from nField ≥ 3 up — i.e. **unchanged** past 5-way. That is what makes
`MAX_MULTIWAY_OPPONENTS = 8` (full ring) affordable. If the flop ever gets slow again, the
remaining levers are `NEST_BUCKETS` (turn buckets solved per sweep) and solving the called line
only at the smallest and largest size, **interpolating** the interior sizes by called pot —
both disclosed abstractions. The solve runs in `hudWorker.ts` off the UI thread, which is what
makes ~2.2s a latency cost rather than a hitch.
`multiwayFlop.test.ts` pins the strategic direction (air stops bluffing, a wet-board set
charges the field, nesting raises the check EV *and* the bet EV) plus a wall-clock budget.
It deliberately does **not** pin "a set bets a dry multiway flop" — checking top set on
A-7-2 rainbow three-handed is a real line and the solve reports it as near-indifferent.

### Size grids — `src/strategy/solver/betSizeGrid.ts`
Every CFR node is solved over a grid built **per node**, because the sizes on
offer depend on the stack. Two invariants the adapter's `bet:${s}` → `ActionId` mapping
depends on: sizes are distinct positive chip amounts (two that round equal would split one
decision across identical actions and halve its frequency), and nothing exceeds the
effective stack — every size at or past it collapses into **one** `allin` slot rather than
being labelled "pot" at stack size.

`bet150` (1½× pot) is the polar overbet slot, offered on the hero-first **turn and river
only**. It exists because an overbet can't be reached by scaling a normal bet: it profits
only for a *polar* range (nuts + bluffs), which a range-vs-range solve discovers and the
per-hand model cannot — `postflopModel.ts:653` documents why it deliberately has no
interior overbet. The band matches `DifficultyParams.overbet` (1.3–1.75×) so hero trains
at the size the bots actually use. Flop and 3-way keep the 4-size grid: each nests another
chance layer, so a 5th size costs more there than it teaches. The turn's nested river
subgames on the check line also keep the base grid (`checkLineBetSizes`) — after checking,
hero's range is capped, the one range an overbet can't represent.

`raiseSizeGrid(Q, b, minRaiseTo, maxRaiseTo)` is the facing-a-bet twin: hero's raise-TO
totals at ½ and 1× the pot he'd play after calling (`Q + 2b`), plus the jam — ids `raise`,
`raisebig`, `allin`. The fractions deliberately match the ½-pot / pot / all-in buttons
`Controls.tsx` already renders facing a bet (same `bet + f × (pot + callAmount)` arithmetic),
so a recommended raise is one tap instead of a slider hunt. It also returns `threeBetTo` per
size — villain's re-raise total, `2.2×` the raise capped at hero's own all-in, since a
re-raise past what hero can call is not a distinct branch. The jam's `threeBetTo` equals the
raise itself, which is how the solvers read "no re-raise here".

Why the re-raise branch matters: without it hero's raise could only be folded to or called,
so every bluff-raise was priced as risk-free and the raise line was systematically
over-valued — the more so since the facing-a-bet node lock made raising more attractive.
`raiseTree.test.ts` pins the direction (a bluff-raise is worth strictly less once villain
can play back).

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
count, with a manual lock overriding outright. Two of those counters are
**conditional** rather than pooled, because the pooled version answers the wrong
question: `turnGiveUp` (of the flops he led that reached a turn *lead chance*, the
share he then checked — the reg's signature "over-c-bet the flop, abandon the turn",
which pooled `turnBetFreq` blurs with hands he entered as caller) and `foldToRaise`
(decisions where **his own** bet got raised, which `facedBet` counts but cannot
isolate). Both denominators exclude the spots where the decision was never offered —
a turn someone donk-bet into him is not a barrel he declined. `turnGiveUp` feeds the
coach, the read panel and the Leveling drill but **no engine knob**; `foldToRaise`
drives the facing-a-bet lock (below). Models reach the engine as the 5th
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
(`exploitAnnotated` in `index.ts` is shared by every locked gate).

**Facing a bet** — all three streets — node-locks too, and the thing being pinned is
different: villain has already bet, so his one remaining decision is fold-or-call vs hero's
**raise**, and that is what `lockedContinueVsRaise` pins (`lockedThresholdPolicy` over his
betting range, ordered by showdown strength on the river and by equity-vs-hero-range on
turn/flop, where a draw is a real continue). Two channels carry the read at these nodes and
they price different actions: his betting-range *composition* (`comboWeight`/`bluffMult` —
how much is air) prices hero's **call**, the lock prices hero's **raise**. Without the lock
CFR solves his response and the node is unexploitable, so "he gives up when raised" would
change nothing and a bluff-raise could never appear.

The raise is re-priced, not read off the ¾-pot number directly: villain adds `r − b` to win
`Q + b + r`, so his pot-odds size is `(r − b)/(Q + b + r)` — a better price than the ¾-pot
reference, which correctly folds him *less* here than his raw fold-to-bet figure. One
observed read therefore drives every node without a second calibration.

That derivation is a **fallback**, not the preferred input. When the hero has actually watched
this seat's bets get raised, `observed.ts: foldToRaise` measures the decision the lock is pinning
directly, and it wins: `VillainModel.foldToRaise` (null with no sample) rides to the facing-a-bet
gate as `villainFoldToRaise` and `lockedContinueVsRaise` anchors on it instead. Two invariants.
The measured number is **re-anchored, not used raw** — it is quoted at the modal raise geometry
(`REF_RAISE_PRICE = 1/3`: a ¾-pot bet raised to the smaller grid size) and pushed back through
the same MDF curve, so a jam still folds him out more than a min-raise. And the prior it shrinks
toward is `foldToRaiseFromFoldToBet` — *what the lock would have derived anyway* — so a
one-spot sample can only pull the number off that, never invent it. `villainModel.ts` keeps its
own copy of the MDF ratio (so `useGame` doesn't pull the solver into its import graph);
`foldToRaiseLock.test.ts` pins the two together by asserting that feeding the derived value back
in is a no-op. `foldToRaise` is deliberately **not** part of `isExploitable`, for the same reason
`preflop` isn't: that predicate decides which ENGINE solves a flop node, and a read about
villain's response to a raise must not flip it.

A locked villain still **re-raises**: `locked3BetPolicy` gives the strongest
`LOCKED_THREEBET_SHARE` (0.3) of his continuing range the re-raise, the rest call. That share
is a **disclosed abstraction, not a measured statistic** — a fold read says nothing about his
3-bet frequency, but pinning it to zero would hand hero a raise branch that can never be
punished and turn every bluff-raise into free money. Both slices are threshold policies over
the same ordering, so the 3-betting hands are a subset of the continuing hands by construction.

The only gate left with **no lock** is the hero-first **flop**, which keeps the
`primaryHasRead` fall-through to the per-hand model instead.

The **preflop** half of the same read is a separate module with its own counters and
its own shrinkage — see Preflop read layer below.

**Multiway reads.** The 3-way solver's fixed third player is read-aware: when the
non-primary live seat carries an observed/locked, off-balanced fold-to-bet read, index.ts
passes it as `thirdFoldToBet` and `mdfCallProbs` re-anchors his continue share to it
(via the same ¾-pot-referenced `lockedContinueBySize` curve the HU lock uses) instead of
parameter-free MDF. The *solved* primary's read still routes through the per-hand fallback
(the `primaryHasRead` carve-out); only the fixed player's read lands in the CFR.

### Windowed reads & the leveling war — `observed.ts: readShifts`
Every stat above is a lifetime average, and a lifetime average **cannot see an opponent
change**: a reg who has stopped folding to your bets still reads ~55% for dozens of hands. So
each of the two exploit dimensions also carries an EWMA over the seat's recent decisions
(`foldToBetRecent` / `betFreqRecent`, `RECENT_ALPHA = 0.2` — the last ~6 decisions dominate),
and `toStats` publishes the **signed shift** recent − baseline, but only once the baseline has
`SHIFT_MIN_SAMPLE = 8` decisions behind it. `readShifts` turns a shift past `SHIFT_MAG = 0.22`
into a `ShiftAlert` carrying the counter it calls for.

The `leveling` flag is the part that matters: a *fight-back* (folding less / betting more) is
only evidence he is countering **you** if you have actually been the aggressor, so the alert
takes the hero's own recent lead frequency as context (`HERO_AGGRO_HI = 0.55`, fed from
`obsCounters[0].betFreqRecent` — the hero is a seat in the same counters). Same numbers, passive
hero: drift, advice is "he stopped respecting your aggression". Aggressive hero: leveling,
advice is "change gears FIRST — make his adjustment the wrong one". `OpponentPanel`'s
`ShiftAlerts` renders the two differently.

The sparring partner for it is the `reg` archetype (`ai/profiles.ts`), whose defining trait is
`adapt: 0.6` — `decide.ts` takes `effAdapt = max(diff.adapt, profile.adapt)`, so a reg
counter-adjusts on **every** difficulty while the slider still makes all bots adapt at
hard/extreme.

`components/LevelingDrill.tsx` (🔄 Leveling War, generator in `levelingSpot.ts`) drills the
loop: is the shift trustworthy → what is the counter → he moves back, re-level. The invariant
is that **no answer is authored** — the generator builds `ObsCounters`, runs them through the
real `toStats` → `readShifts`, and takes the correct answer from the resulting alert
(`counterFor`). Hard-coding the answers would let the drill teach a threshold the table doesn't
apply. Half of `KINDS` is deliberately thin-sample or sub-threshold noise, because the
expensive leveling mistake is inventing an adjustment out of four hands.

### Preflop read layer — `src/strategy/preflopModel.ts`
The node lock's analogue for the one street it never reached. Before it, the preflop
path was a static chart for everyone: the recommended 5-bet-bluff / flat / fold mix
facing a maniac's 4-bet was **byte-identical** to the mix facing a nit's, and the
villain range the postflop engines inherited was the chart's regardless of what he had
actually been doing.

Three observed rates drive it, counted in `analysis/observed.ts` alongside the postflop
ones but keyed on **raise level**, not "is there a bet ahead" (preflop there is always a
blind in front of everyone): `pfOpenChances/Taken` → **RFI%** (blinds excluded — they
have no unopened pot to open into), `pfThreeBetChances/Taken` → **3-bet%**, and
`pfFacedThreeBet/Folded` → **fold-to-3-bet%**. Each shrinks toward `PF_BALANCED` on
**its own** decision count (`PF_HALF_WEIGHT`), because faced-3-bet spots arrive an order
of magnitude slower than open chances and a pooled denominator would trust both equally.
A `VillainLock` overrides outright — it extends `PreflopLock`, so one lock object
carries both the postflop knobs and these.

The read rides on `VillainModel.preflop`, deliberately **not** on `isExploitable`: that
predicate gates the postflop CFR fall-through, and a purely preflop read must not flip
which engine solves a flop node. There is also no archetype prior here — the bot
profiles carry no preflop frequencies, so an un-modelled seat is balanced preflop even
when its postflop prior is the bot's own tag.

Two consumers:

1. **Chart frequencies at hero's node.** `preflopAdjust(level, code, read)` →
   per-kind multipliers, `applyPreflopRead` scales the cell with fold absorbing. Whose
   read counts depends on the level: facing action it's the **last raiser**, unopened
   it's the live seat **behind** with the highest 3-bet frequency (the max, not an
   average — one 3-bettor yet to act is enough to tax a steal, and when even the widest
   of them is a nit the same number correctly widens hero's open).
2. **The projected range the postflop engines inherit.** `roleBaseRange` resizes by
   `rangeMultForRole` → `resizeRangeByStrength`. A 20% 3-bettor modelled on the chart's
   ~8% 3-bet range reads too tight and too strong on every later street, which is the
   direction that costs hero money against him.

Three things this layer does that depth shading deliberately doesn't, and why:

- **Premiums are read-proof.** `marginality(code)` tapers every multiplier to zero above
  ~0.82 strength. AA opens and 4-bets against everyone; the exploits all live on the
  marginal tail.
- **A cell the chart plays 100% can start folding**, and **a cell it folds 100% can start
  raising** (`PROMOTE_FLOOR`, opt-in via `applyPreflopRead`'s `aggr` arg). Without both,
  "fold AQo to a nit's 3-bet" and "3-bet the hands he folds to" are unreachable no matter
  how firm the read — and those are the two most valuable preflop exploits there are.
  Promotion invents only the **aggressive** action (fold equity is the mechanism) and is
  withheld multiway, where `squashBluffsMultiway` just removed those bluffs for a reason.
- **`NodeStrategy.exploit` is emitted here too**, but the charts are teaching baselines
  whose EVs are *relative estimates*. `preflopExploit`'s `gainBb` ranks two lines in the
  read's own frame; it is not a solved edge and the prose must never read as one.

A read that moves frequencies silently teaches nothing, so a read-adjusted node also
carries the mix it deviated FROM: `NodeStrategy.baseline` is the same node re-shaded with
the villain treated as balanced (`chartedBalanced`), and `readDetail` breaks the move down
— whose read, the three rates with their own sample counts (`PreflopRead.samples`, since
`confidence` is the max of the three and cannot say which one is thin), which rate prices
*this* node, and the per-action from→to deltas. Both mixes are depth- **and** rake-shaded,
which is what makes the gap between them the read alone. `StrategyPanel` toggles between
them; `readBaseline.test.ts` pins that every rendered row has a baseline twin.

`ReadStat.spot` is the live-table half: the app's target player has no HUD, so every stat
is paired with the countable observation that produces it. `PlayerReadChecklist.tsx`
(in `OpponentPanel`, keyed by seat) is the same idea as input — tick what you watched him
do, and the ticks merge into a `VillainLock`. Tell values are deliberately coarse (one
"wide", one "tight" per knob): a tell is evidence a rate is far from balanced, not a
measurement of it, and opposite ticks average back to balanced on purpose.

Disclosed gap: **the bots don't consume THIS layer.** `ai/decide.ts` does now adapt to the
hero preflop — it reads the hero's fold-to-3-bet and blind-fold rates off `HeroReads` and
3-bets / 4-bet-bluffs / steals wider vs an over-folder (hard/extreme only, sample-gated, same
confidence ramp as the postflop `HeroReads` block — see `decide.ts` preflop adaptation and
`adaptPreflop.test.ts`). But that is the bot's OWN parallel read, not `preflopModel.ts`'s chart
adjustments or projected ranges — those still feed only the hero's coach. And the bots still
play rake-free (`ai/decide.ts` never sees `state.rake`).

### Limped pots — `index.ts: roleBaseRange`
Every postflop engine inherits its villain range from `roleBaseRange`, which reads a seat's
**role** off the preflop action log. A limp is a `call` made while the pot is still unraised
(a straddle posts as a blind, so calling one cold is a limp) — it is **not** a cold-call of
an open, and the two are opposite range shapes. Roles: `open` / `threebet` / `limp` /
`continue`, plus an iso-raise (`raiseRank === 0` with limpers in front, `ISO_RAISE_TIGHTEN`)
and a limp-call (`LIMP_CALL_TIGHTEN`).

`LIMP_RANGE` is wider than *any* opening range, weak-tailed, and **capped at the top** —
premiums are excluded for the same reason `DEFAULT_MIN_PLAY` is 0.6: a binary set admits a
hand at full weight, so a player who limps AA one time in ten would read as always holding
it. `BB_OPTION_RANGE` (BB checked its option in an unraised pot) is wider still — it never
chose to be in the hand. Both live in `ai/preflop.ts`; neither is a chart id, so neither
feeds the bots' preflop ranges.

Two invariants. **An empty preflop log is a synthesised spot** (Postflop Lab, drills, most
solver tests), not a limped pot — absence of a raise only means a limp when there is action
to read, and without that guard every constructed state hands villain an any-two range.
And the **`limp` role takes the read unresized**: `observed.ts` counts a limp as an open
chance *declined*, so a habitual limper's RFI% is low by construction and feeding it to
`rangeMultForRole` would tighten the one range that is wide by definition.

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
holds archetypes (tag/lag/lp/gto/nit/reg), `difficulty.ts` layers easy→extreme
params and per-seat overrides, `blueprint.ts` holds frequency curves.
`DifficultyParams.overbet` gates the turn/river polar overbet (1.3–1.75× pot). Every
tier overbets its nut end; only tiers with `adapt > 0` balance the bluff side at the
same size, so on easy/normal an overbet *is* a value tell the hero can read. Bots and the
grader read the same preflop charts, so keeping them in sync is a hard requirement,
not a nicety.

`DifficultyParams.jam` is the same knob for the **all-in**, and it exists because the
commitment guard in `sizeTo` only ever upgrades a bet *already worth stacking off*
(`willCommit`) — bluffs cap at 1.1× pot and never cross the SPR line, so at any real depth
**every bot shove was the nuts** and the hero could fold to it forever. `jamSpot` bounds the
window on both sides: stack **1.5–3× pot** on the turn or river, heads-up. Below 1.5× the
overbet slot already lands on the stack; past 3× the price stops being one a real player
offers, since risking `stack` to win `pot` needs `stack/(stack+pot)` folds (75% at 3×). The
bluff side is gated on `effAdapt > 0` and a tighter equity bar than the overbet's — so easy
and normal keep the shove-is-nuts tell deliberately, and a `reg` balances it on *any* tier
through its own `adapt`. `jam.test.ts` pins both directions plus the frequency asymmetry
(same size, still value-weighted). Note `jamBet` is the only caller of `sizeTo`'s `shove`
flag: skipping the guard is the whole point, since the guard is what sizes a bluff back down.

### `src/analysis/` — grading
`grade.ts: gradeNode` scores the hero's executed action as EV loss against
`NodeStrategy.bestEv`, then buckets it via `stats.ts: moveTier` into
`best | correct | inaccuracy | wrong | blunder`. **Grading is anchored on EV, not on
frequency** — the "best" line is the highest-EV option, even when a lower-EV action
is played more often in the mix. `buildSizingCoach` / `buildCheckLineCoach` produce
the prose. `observed.ts` derives live villain stats; `tilt.ts` and `aggression.ts`
produce session warnings.

### Live capture — `src/analysis/liveHand.ts` + `components/LiveHand.tsx`
The one path into the app from outside it: a hand played at a casino, entered, graded, and
folded into the **same** `HistoryHand` + `DecisionRecord` stream as in-app play — so Hand
Review, `findLeaks`, bb/100 and the SRS weighting need no changes and a live hand is
indistinguishable to them. `useGame: importLiveHand` is the single write point.

`replayLiveHand` **drives the real engine** (`createGame` → `startHand` → `applyAction`)
rather than assembling nodes by hand: `legalActions`, blind posting, side pots and `toAct`
ordering are what make a graded node trustworthy, and a form that reimplemented them would
drift from the table. The user enters only the action *sequence* — the engine decides whose
turn each one is, which doubles as the validation (an action illegal for the seat on turn is
a typo, reported with its index).

Two mechanics to keep. `dealAround` gives every other seat cards drawn from a pool with
hero's hand and the whole entered board removed, so the engine's own board deals can never
collide; `forceBoard` then overwrites `state.board` after every action with what the user
actually saw. Villain holdings are never entered and never needed — every engine works off
ranges. `rngMatch` is null on these records: a replayed hand has no live roll to honour, and
scoring it against a fresh one would be noise.

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
35 tabs. `App.tsx` holds the `Tab` union, the `TABS` array (order = display order)
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

- **CFR test expectations are range-composition-sensitive.** A two-combo hero range makes the
  game degenerate — villain's response to a range that is half air is nothing like his real
  one — so a solver test that "fails" may just have an unrealistic range. Use value + draw +
  air before concluding the solver is wrong. And the heavy solver tests (multiway flop ≈ 1.7s a
  node) need explicit per-test timeouts: the 5s default passes solo and fails under the full
  suite's parallel load.
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