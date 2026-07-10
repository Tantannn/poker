# Range-vs-Range EV — Design Doc (Tier-2)

Status: **proposed** · Owner: TBD · Prereq: Tier-1 range realism (shipped, `4feb577`)

---

## 1. Problem

The postflop engine (`strategy/postflopModel.ts` → `solvePostflop`) computes EV for
**hero's specific hand vs the villain range**. It is *not* range-vs-range. Villain's
fold/continue is a heuristic (`feMult` / MDF-style), not a best response to hero's
**range**, and the action mix is a softmax over per-hand EVs (`mixFromEv`), not an
equilibrium.

Verified consequences (this session):
- **Overbets are structurally dominated.** A nut hand alone just folds out
  bluff-catchers → no value → the model always prefers *pot* (for calls) or
  *all-in* (to commit). Adding 1.5×/2× sizes spewed on the flop and sat inert on
  the river. Overbets are correct in GTO only because hero's *range* is polar —
  a per-hand model cannot represent that.
- **Frequencies** are a softmax approximation (~65% match to a solver).
- **Sizing** polarizes to endpoints (small / pot / all-in), ~60% match.

Everything the *math* needs (equity, pot odds, MDF, outs) is already solver-exact.
The gap is purely the **strategic outputs** (frequencies, sizing, polar play), and
they are gated by the per-hand architecture. This doc scopes replacing the EV core
with a range-vs-range solver.

## 2. Goals / Non-Goals

**Goals**
- Emit range-vs-range strategies (frequencies + EVs) for postflop nodes.
- Unlock the three things per-hand can't do: real mixed frequencies, polar sizing
  (incl. overbets), and capped-range exploits.
- Keep the existing UX. The new engine emits the same `NodeStrategy` shape
  (`strategy/types.ts`); HUD, grader, coach, tooltips all keep working unchanged.
- Ship value incrementally; each stage independently testable.

**Non-Goals**
- Preflop solving — charts stay (`ai/preflop.ts`, `strategy/preflopChart.ts`).
- PioSOLVER parity or sub-0.5%-exploitability guarantees.
- Real-time deep flop solves on every keystroke — latency is budgeted; hot spots
  may be cached/precomputed.

## 3. Current architecture (what we keep vs replace)

| Component | File | Fate |
|---|---|---|
| Monte-Carlo equity | `engine/equity.ts` | **keep** — leaf/showdown evaluation |
| Hand evaluator | `engine/evaluator.ts` (`evaluate7`) | **keep** |
| Weighted range + card removal | `engine/range.ts` | **keep** — range representation |
| Villain range by role + board conditioning | `strategy/index.ts` (`buildVillainRange`, `betConditionedWeight`) | **keep** — feeds the villain range input |
| Per-hand EV candidates + softmax mix | `strategy/postflopModel.ts` (`solvePostflop`, `computeAggro`, `mixFromEv`) | **replace** as the strategy source; **retain** as a fallback behind a flag |
| Strategy interface | `strategy/types.ts` (`NodeStrategy`) | **keep** — output contract |
| Off-thread compute | `workers/hudWorker.ts`, `strategy/hudCompute.ts` | **keep/extend** — solves run here with a time budget |
| Dispatch | `strategy/index.ts` (`getNodeStrategy`) | **modify** — route to solver when flag on |

The important structural win: `buildVillainRange` already produces a realistic
weighted villain range. We now also need **hero's** range at the node (the same
machinery, hero's preflop role), which today is unused because we only score
hero's single hand.

## 4. Approaches considered

### A. Live CFR subgame solver
Build a game tree from the current decision forward (actions = check/call/fold +
the bet-size set), both ranges as inputs, run CFR+ to convergence.
- **+** True equilibrium; every output (freq, size, overbet, exploit) correct;
  generalizes to any node.
- **−** Compute-heavy, esp. flop (two future chance layers); convergence time;
  most code.

### B. Single-street analytic equilibrium (river only)
Closed-form-ish polar construction on the river: value:bluff ratios by size (already
have `requiredEquityForBet` = `f/(1+2f)`), MDF, indifference. No iteration.
- **+** Fast, deterministic; fixes the worst per-hand failure (river polarization +
  overbets) directly.
- **−** River only; turn/flop still need trees.

### C. Precomputed solver DB
Ship offline solver outputs bucketed by (texture, SPR, range pair); nearest-node
lookup + interpolation.
- **+** Highest fidelity, zero live solve — how commercial trainers hit ~95%.
- **−** Large data + a generation pipeline + storage; interpolation error; only
  covers canned spots.

## 5. Recommendation — staged, river-first CFR (A), analytic (B) as the river MVP

Sequence so each stage ships value and de-risks the next:

- **Stage 0 — scaffolding (1–2 days).** New `strategy/solver/` module; tree +
  terminal + adapter interfaces; a `USE_SOLVER` feature flag in `getNodeStrategy`;
  the adapter maps a solved node → `NodeStrategy`. No behavior change yet.
- **Stage 1 — RIVER (3–5 days).** Smallest tree (no future cards → terminals are
  pure showdown via `evaluate7`), biggest per-hand-error fix. Start with the
  analytic construction (B); optionally validate against a tiny CFR on the same
  node. **Unlocks river overbets + polar frequencies + capped-range exploits.**
  Ship behind the flag; cross-check.
- **Stage 2 — TURN (~1 week).** One chance layer; solve the turn with the river
  solver as the leaf evaluator (nested), or CFR with chance sampling.
- **Stage 3 — FLOP (1–2 weeks).** Two chance layers — heaviest. Requires **range
  bucketing** (cluster combos) to stay tractable; iteration cap.
- **Stage 4 — performance / precompute (ongoing).** Cache by canonical spot
  (texture + SPR + range pair), worker pooling, optional precomputed DB (C) for
  hot flop nodes.

**Highest-ROI slice = Stage 0 + 1 (river).** That is where per-hand is *most* wrong
and where a single street is *cheapest* to solve. Deliver it, measure, re-decide
before committing to turn/flop.

## 6. Technical components

- **Tree builder.** Node = (street, pot, effective stacks, to-act, betting
  history). Actions = check/call/fold + the bet-size set (reuse the `addBet` fracs;
  overbets are now *legal* sizes because polarization is modeled).
- **Ranges.** `WeightedRange` per player (have it). Card removal / board blockers
  via the evaluator. Hero range from `buildVillainRange`-style role logic applied
  to hero.
- **Terminal eval.** Showdown = per-matchup win/tie via `evaluate7`; fold = pot to
  the aggressor. River terminals are exact (no sampling).
- **Solver.** CFR+ with chance sampling for future streets; **full enumeration on
  the river** (no more cards). Track average strategy for output.
- **Bucketing (turn/flop).** Cluster strategically-similar combos to bound tree
  size; a known accuracy/latency tradeoff.
- **Output adapter.** Solved node → `NodeStrategy`: per-action frequency = hero's
  strategy for the *specific* hero hand at this node (so the HUD still shows "your
  hand's mix"); per-action EV from the solve. `note`/`notes` regenerated from the
  solved shape.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Solve latency (esp. flop) | Worker (`hudWorker`) + time budget + progressive result; cache by canonical spot; river-first keeps early stages cheap |
| Convergence quality | Measure **exploitability** (best-response EV gap) per node; target < a few % pot; cap iterations with a floor on quality |
| Regressions / scope creep | Feature-flag; keep per-hand model as fallback; land stages independently |
| Correctness drift from a real solver | Cross-check suite: import a handful of Pio/GTO-Wizard reference spots, assert freq/size within tolerance |
| Bucketing error (flop) | Start unbucketed on river/turn; introduce bucketing only where forced; report the abstraction in-app (no silent caps) |

## 8. Validation

- **Exploitability** metric per solved node (best-response gap) — the honest
  "how-close-to-GTO" number this app currently *cannot* produce.
- **Reference cross-check**: a few known solver outputs → assert within tolerance.
- **Regression**: existing invariants in `strategy/crossCheck.test.ts` /
  `spotRecheck.test.ts` (bluff-catchers don't overbet, etc.) still hold.
- **A/B**: EV-loss distribution vs the current model over a hand sample.

## 9. Effort (rough, honest)

| Stage | Estimate |
|---|---|
| 0 — scaffolding | 1–2 days |
| 1 — river | 3–5 days |
| 2 — turn | ~1 week |
| 3 — flop | 1–2 weeks (bucketing) |
| 4 — perf / precompute | ongoing |

This is **weeks, not hours.** River-only (0+1) is the high-ROI, low-risk slice.

## 10. Decision needed

1. Approve **river-first CFR/analytic (Stage 0+1)** as the first shippable slice? **(recommended)**
2. Or commit to the **precomputed-DB** route (C) instead (higher fidelity, larger upfront pipeline)?
3. Or park Tier-2 and stay on the Tier-1 heuristic engine.

Recommendation: **(1)** — build the river slice behind a flag, measure exploitability
+ reference cross-check, then decide on turn/flop.
