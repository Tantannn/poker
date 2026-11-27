# Grading, live capture, store, hook/worker, components

Deep reference split out of CLAUDE.md — read it before changing this area.

## `src/analysis/` — grading
`grade.ts: gradeNode` scores the hero's executed action as EV loss against
`NodeStrategy.bestEv`, then buckets it via `stats.ts: moveTier` into
`best | correct | inaccuracy | wrong | blunder`. **Grading is anchored on EV, not on
frequency** — the "best" line is the highest-EV option, even when a lower-EV action
is played more often in the mix. `buildSizingCoach` / `buildCheckLineCoach` produce
the prose. `observed.ts` derives live villain stats; `tilt.ts` and `aggression.ts`
produce session warnings.

## Live capture — `src/analysis/offline/liveHand.ts` + `components/LiveHand.tsx`
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

## `src/store/` — localStorage persistence, no framework
Plain functions (`loadX` / `saveX`), no state library. **Every key must be prefixed
`poker-` or `poker.`** — `backup.ts` filters on that prefix to build the
export/import bundle, so an unprefixed key silently won't travel with a user's
backup. `history.ts` caps hand history (journal-tagged hands are protected),
`srs.ts` is the spaced-repetition weighting shared by all drills
(`weightOf` / `recordSrs` / `weightedIndex`), `stats.ts` computes bb/100, EV-loss/100
and the leak finder.

## `src/hooks/useGame.ts` + `src/workers/hudWorker.ts`
`useGame` is the deliberate god-hook (~940 lines) owning game state, bot turns,
feedback, history, journal, stats and every setting; `App.tsx` threads the whole
object into tabs as `g`. HUD/strategy computation runs off-thread in `hudWorker.ts`
because the Monte-Carlo runs used to hitch the UI on phones — requests carry a
`seq` so stale replies are dropped when state advances mid-compute. Postflop the worker answers
**twice**: first the per-hand model (`getNodeStrategy` `{ fast: true }` skips every CFR gate,
`NodeStrategy.provisional`, `EngineBadge` "⏳ refining…"), then the solve (turn ~4s). Acting
before the solve lands grades against the estimate, relabelled as one (never as "refining").

## `src/components/` + `App.tsx`
35 tabs. `App.tsx` holds the `Tab` union, the `TABS` array (order = display order)
and `Cat` grouping for the nav dropdown; every tab except `PokerTable` is
`lazy()`-imported from a **named** export remapped to `{ default }`. Adding a tab =
add to the union, add a `TABS` entry with a category, add the `lazy` import, render
it in the switch.
