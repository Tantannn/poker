# The bots (`src/ai/`)

Deep reference split out of CLAUDE.md — read it before changing this area.

## `src/ai/` — the bots
`decide.ts` (`decideAction`) is the bot's single decision function; `profiles.ts`
holds archetypes (tag/lag/lp/gto/nit/reg), `difficulty.ts` layers easy→extreme
params and per-seat overrides, `blueprint.ts` holds frequency curves.
`DifficultyParams.overbet` gates the turn/river polar overbet (1.3–1.75× pot). Every
tier overbets its nut end; only tiers with `adapt > 0` balance the bluff side at the
same size, so on easy/normal an overbet *is* a value tell the hero can read. Bots and the
grader read the same preflop charts, so keeping them in sync is a hard requirement,
not a nicety.

The chart is the **looseness-0.5 baseline**, not every bot's range. `blueprint.ts:
rfiOpenFreq` widens or trims it per archetype (`1 − (1 − chart%)^m`, `m` from
`openLooseness`), so a nit opens ~11% UTG and a maniac ~31%. Without it every archetype
opened the same chart and the VPIP axis of `archetypeSignature` read nothing. `limp` (only
`lp` sets it) open-limps non-`looksPremium` hands; speculative hands over-limp behind
limpers; iso-raises add `1 + limpers` bb. Facing a 3-bet, a bot continues the top
`vs3BetContinueShare` of its **own** entering range (`entryPercentile`) — a fixed continue
list folded wide openers ~90%, making any-two 3-bets profitable vs every bot.
Facing an open, `vsOpenPlan` sets a 3-bet share and a continue share **of the deck** (by
archetype, seat, opener width, price) and `strengthPercentile` maps a hand onto them — never
a raw `preflopStrength` cut: the score is compressed (K7o ≈ 0.55), so a ~0.5 threshold
flatted half the deck and the BB defended ~97%. 3-bets are polar (⅔ value from the top,
⅓ `BLUFF_THREEBET_RANGE` then `BLUFF_THREEBET_WIDE`), and the flat cut sits below the
bluffs' share so the SB stays 3-bet-or-fold. `archetypePreflop.test.ts` pins widths,
fold-to-3-bet (25–70%), vs-open 3-bet/defend rates, limping and iso sizing.

Postflop, a bot's equity is read against a range narrowed by **this street's** bet only
(`villainActionWeight`), so a flop bet, a turn barrel and a raise of its own bet never made it
fold — every archetype played like a station (≈25% fold to c-bet, ≈50% to showdown). `decide.ts`
now discounts the call margin by `respect × lineStrength`: `lineStrength` grows with each earlier
street the bettor fired and with a raise of the bot's own bet; `respect = (1−callStation)^1.5 ×
(1.3 − 0.6·aggression)` (nit ≈0.83, TAG ≈0.63, maniac ≈0.42, station ≈0.07); the raised-bet part
shrinks with aggression (a maniac reads a raise as a bluff). Aggressive archetypes also **float**
in position, **bluff-raise** heads-up (a maniac re-bluffs ~19% when raised), and barrel the
turn/river in proportion to `aggression`. Preflop tightness by looseness: `openRangeExponent`
(nit ≈27% button) and `vsOpenPlan` flats (BB `0.14 + 0.55·cr`, cold `0.24·cr − 0.015`) put a nit
at ~16% VPIP on hard.

**Measured signature.** `botSim.ts` plays a bots-only table (callback `onHand` lets analysis/ run
its own counters over it). `profiles.ts` `hud` stores what `observed.ts` measures on each archetype
at hard (VPIP, postflop AF, fold-to-bet) — the coach's prior (`archetypePrior`) and the archetype
guide read it. `analysis/reads/archetypeCalibration.test.ts` runs ONE 900-hand sim (cheap equity reads)
and checks `hud` is still true, the postflop bands (station/maniac vs the solid pool) and the
guide's hit rate. After a retune, re-measure at full hard-tier iterations:
`SIM=1 npx vitest run src/analysis/reads/archetypeCalibration.test.ts --silent=false --reporter=verbose`
(prints `HUD …` lines, ~10 min). `SIM=1 … src/ai/sim/_sim.test.ts` prints the full HUD table.

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
