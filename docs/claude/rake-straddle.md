# Rake and straddle

Deep reference split out of CLAUDE.md — read it before changing this area.

## Rake — `src/engine/rake.ts`
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

Disclosed gap: the chart *data* is still ~100bb rake-free (this shades what it teaches).
The bots play the same shade: preflop, `decide.ts` applies `preflopRake.ts: multFor` per action
(`callKeep` on limps/flats, `raiseKeep` on opens/3-bets/light 4-bets, fold absorbs, a shaded-out
flat turns into a raise at `raiseKeep − callKeep` where the hand already raises), premiums
exempt. So `vsOpenPlan` gets the **rake-free** price — rake reaches that node once, not twice.
The shade draws RNG only when a multiplier is < 1, which keeps rake `none` byte-identical
(`botRake.test.ts`). Postflop, `reqEqRaked` lifts a call's break-even and `rakeMarginal` the
thin-value bar. Easy bots, push/fold and the 4-bet node stay unshaded.

## Straddle — `table.ts: straddleSeats` / `effectiveBigBlind`
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
