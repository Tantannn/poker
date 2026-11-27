# CFR solver internals

Deep reference split out of CLAUDE.md — read it before changing this area.

## Hero-first tree: villain may raise — `riverSolver.ts: villainRaiseSizes`
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

## Villain bets into a check, and the called line plays on — `STAB_FRAC`, `CALLED_NEST_ROUNDS`
Two gaps made every hero-first street favour hero. **A check went straight to showdown**: the
villain could never bet into it, so OOP hero kept every checked pot for free. All three HU
streets now give villain a ¾-pot bet when checked to (`STAB_FRAC`, one size) and hero answers
fold / call / **check-raise** (villain's raise formula; villain then folds or calls, no re-raise).
`villainMayStab` / `heroMayCheckRaise` (default true) turn them off for an A/B and ride into the
nested subgames. Without the check-raise villain's stabs could never be punished. `heroStabResponse`
(`[fold, call, check-raise]`) / `villainStabFreq` carry the check-call / check-fold / check-raise
plan to the coach. The called check-raise borrows the stab-called future scaled by called pot. **A called bet ended the hand** on the turn/flop while the check line nested the next
street, so a bet earned one street of value: on a static K-K-K toy the turn nuts earned 152 vs
the exact 225 and checked a third of the time. The called, raise-called and stab-called lines now
carry a per-MATCHUP future value (`pairEv` from a nested solve over the betting/calling ranges
minus the static showdown), added to hero's payoff and taken off villain's so it stays zero-sum.

Three invariants. The future is **per (hero, villain) pair**, never per hero combo: air's later
steals come out of villain's weak calls, and charging them to his strong ones made him fold
~80%. **Round 0 nests over the full ranges** and later rounds condition on the previous pass and
**damp ½/½** — conditioning on a static first pass handed air phantom value, and undamped rounds
oscillate (the answer flipped with round parity). And every line that can be called needs the
future: with the raise-called line left static, villain raised ~30% to deny hero the river.

`closedForm.test.ts` is the audit: polar river (bluff ratio B/(P+B), MDF P/(P+B)), the reversed
stab game, and the static K-K-K turn/flop (nuts ≈ 2.25·P). Tests that pin the OLD tree's
claims ("nesting raises the check EV", "air never helped by the raise") now pass
`villainMayStab: false` / `nestRiverForCall: false` explicitly — those are theorems only there.
Cost at live caps: turn ~3.8s (was ~2.0s), flop ~2.6s (was ~1.2s); the levers are
`FUTURE_NEST_BUCKETS`, the half-iteration future nests and `CALLED_NEST_ROUNDS`. Disclosed
abstractions: future nests use the heaviest river/turn textures; the raise-called future is one
reference raise scaled by pot; the flop's nested turn keeps static turn lines (cost bound).
Averaging trap: hero's stab answer is averaged by range weight, NOT own reach — a set that never
checks would otherwise report an unconverged (½ call) answer and a junk check EV. Villain's answer
to the check-raise IS reach-weighted (it drives exploitability; range weight measured 4% pot).

**Facing a bet, the call plays the next street too** (`solveVsBetWithFuture`, turnSolver.ts). The
turn/flop facing-a-bet call used to be a static equity showdown, so a draw had no implied odds and a
bluff-catcher OOP got to see the river free of a second barrel. `vsBet.ts` now takes `callFuture`
(per matchup, from a nested next-street solve at the called pot over hero's CALLING range vs his
betting range; round 0 full range, one conditioned round, damped ½/½) and `stackAfterCall`; the
raise-called and re-raise-called lines borrow it scaled by pot (none when all-in). When hero is in
position the nest runs with roles swapped and the value negated (`heroActsFirst`, from
`index.ts`'s position). Effect: a nut flush draw IP calls instead of jamming; QQ under a K realises
less. Cost: facing-bet turn ~0.6s (was 0.1s), flop ~0.9s (was 0.35s).

**Multiway**: the solved villain may stab ¾ pot into hero's check, the field answers by the same
MDF policy (its aggs carry the stab as one extra size), hero folds or calls — no multiway
check-raise, only the solved villain bets, stab-called line static. With the stab, the turn's
asymmetry bit: a set checked 97% (check line nests the river, called bet didn't), so
`calledLineFutureValue` now takes a nest function and the 3-way TURN uses it too (river nests).

**Solve cache** (`riverAdapter.ts: cachedSolve`, LRU 8): one turn/flop solve answers every hero
combo, so a repeat of the same spot — chiefly the unlocked baseline re-solved whenever a read
changes — is served from memory. Keyed on both combo lists, board, pot, stack, lock and rake.

## Multiway flop — `multiwaySolver.ts: solveFlop3way`
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

## Size grids — `src/strategy/solver/betSizeGrid.ts`
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
own short-stack logic in `ai/decide/decide.ts`, so the graded answer matches how the table
actually plays).

`hudCompute.ts` is the single entry point the worker calls (see `app-layers.md`).

- **Lock vs the called line.** `solveVsBetWithFuture`'s first pass runs WITHOUT the node lock. The lock prices hero's raise only; letting it shape the calling range that sizes the next street emptied that range and scored a call ~1.7bb too low (`solver/lockCallFuture.test.ts`).
