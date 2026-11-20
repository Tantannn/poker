# Villain reads, node lock, archetype recognition, preflop read layer

Deep reference split out of CLAUDE.md — read it before changing this area.

## Node lock — `src/strategy/villainModel.ts`
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

## Recognising an anonymous seat — `analysis/archetypeSignature.ts`
Anonymous mode hides the tag *and* forces the engine's prior to `BALANCED`, so the hero's own
read is the only read — which made the guess buttons a 1-in-7 shot with nothing connecting the
VPIP/PFR/AF bars to them. `rankArchetypes(observed)` closes that: three axes (VPIP, postflop AF,
inverted fold-to-bet), compared against each bot's **measured** HUD stats (`profiles.ts` `hud`,
from the bots-only simulator), both sides normalised over the field's measured span, distance
weighted by each axis's own sample so an unsampled axis **drops out** rather than defaulting.
It used to compare against the behavioural dials through authored live bands and picked the right
bot ~40% of the time at 200 hands (a maniac read as a station); measured, it is ~65% (82% top-2,
and tag/gto/reg are the only real confusion). `ArchetypeGuide.tsx` renders it in the
`hidden` branch of `OpponentPanel`.

Three invariants. It never reads the seat's `profileId` — the rank comes from observed stats
plus the public measured table, which is what keeps the mode honest. Nothing is authored per
archetype: quadrant, giveaway, nearest neighbour and discriminator all fall out of
`PROFILE_LIST`'s `hud`, so re-measuring a bot retunes the guide (`archetypeSignature.test.ts` pins
this by mutating a copy of the field; `archetypeCalibration.test.ts` fails when a retune leaves
`hud` stale and checks the guide's hit rate). `STATIC_TIE` = 0.2 of a span (~0.45 AF, ~5 points
of fold-to-bet): the run-to-run noise of the measurement itself. And `discriminator` returns a **null axis** when two archetypes
are statically indistinguishable — that is the true answer for tag/gto/reg, a closed
confusable clique whose only real separator is `adapt`, i.e. the `readShifts` alert below.
Visible-archetype mode uses the same measured fold rate as the coach's prior
(`villainModel.ts: archetypePrior`) — the dial-implied rate over-stated every fold (nit 62% vs a
measured 48%) and called a station's 26% zero.

## Windowed reads & the leveling war — `observed.ts: readShifts`
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

## Preflop read layer — `src/strategy/preflopModel.ts`
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
adjustments or projected ranges — those still feed only the hero's coach.
