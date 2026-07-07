# ♠ Poker Trainer ♥

A 100% local 6-max No-Limit Hold'em training app (React + TypeScript + Vite) for
drilling **preflop** and **postflop** decisions against AI opponents, with a live
equity / pot-odds HUD and GTO-baseline feedback.

> Nothing leaves your machine. Stats persist in `localStorage`.

## Run it

```bash
cd D:\code\poker
npm install      # already installed in this repo
npm run dev      # http://localhost:5173
```

Build a static bundle with `npm run build` (output in `dist/`), preview with `npm run preview`.

## What's inside

### 1. Game engine (`src/engine/`)
- **`cards.ts`** — deck generation, Fisher–Yates shuffle, seedable PRNG.
- **`evaluator.ts`** — fast 7-card hand evaluation packed into a single comparable score.
- **`table.ts`** — full state machine: blinds, betting rounds, min-raise enforcement,
  all-in handling, **side pots**, showdown, and uncontested wins. 6 players, 100bb.
- **`equity.ts`** — Monte-Carlo equity (win/tie) + outs counting + Rule of 2 & 4.
- **`potOdds.ts`** — pot odds, required equity, MDF.

### 2. AI layer (`src/ai/`)
- **`profiles.ts`** — archetypes (Tight-Aggressive, Loose-Aggressive, Calling Station,
  Maniac, Nit, GTO-ish) as tunable parameter sets.
- **`preflop.ts`** — 169-hand notation, range parsing, position RFI charts, 3-bet ranges,
  hand-strength scoring.
- **`decide.ts`** — the single decision seam. Uses charts preflop and equity-vs-pot-odds
  postflop. Swap in a stronger engine here without touching the game loop.

### 3. Training & analytics (`src/analysis/`, `src/store/`)
- **`feedback.ts`** — grades each hero action against a transparent baseline.
- **`stats.ts`** — bb/100 win rate, decision accuracy, and a heuristic **leak finder**.

### 4. Heuristic strategy engine (`src/strategy/`) — the "solver-model"
Not a real Nash solver (true solves are GB-scale and need a CFR engine). Instead a fast,
offline, **transparent EV model**:
- **`postflopModel.ts`** — for any node computes equity-vs-range + a fold-equity model to
  estimate each action's EV (bb), then derives a **mixed strategy** (frequencies) via softmax.
- **`preflopChart.ts`** — multi-scenario charts (RFI, vs-open, vs-3-bet) with mixed
  Fold / Call / 3-Bet-value / 3-Bet-bluff / 4-Bet frequencies.
- **`index.ts`** — picks villain range + routes a live node to the right model; `types.ts`
  has EV-loss, RNG-prescription, and the mixing math.

Powers: per-action **frequency % + EV** (the "Info button"), **EV-loss** scoring, **RNG**
prescriptions for mixed spots, and equity-vs-range everywhere.

### 5. UI (`src/components/`, `src/hooks/useGame.ts`)
Tabs: **Play vs Bots** (table + equity-vs-range HUD + solver-strategy panel + EV-loss feedback
+ optional **Think-first checklist**: postflop bets/raises are gated behind a graded 5-question
quiz — hand class, board texture, equity, purpose, plan-if-raised — before the chips commit),
**Tournament** (single-table freezeout: rising blinds, antes, payouts, bubble/ICM advisory),
**Preflop Charts** (color-coded multi-scenario matrix), **Range Trainer**, **Postflop Lab**
(board-texture drills with full frequencies/EV/RNG, heads-up or 3-way), **Gameplan**,
**Leak Quiz** (drills your real detected leaks), **Read & Exploit** (archetype exploitation),
**Hand Review** (replay + journal), **Principles**, **Pot Odds**, **Equity Drill**
(flashcards + vs-range calibration), **Review** (spaced-repetition home — due cards & mastery),
**Bet Sizing**, **Bankroll** (variance Monte-Carlo: outcome spread, downswings, risk of ruin),
**Analytics** (bb/100, EV-loss/100, RNG adherence, leaks, hand history, backup/restore),
**Reference**. Global **speed** control (1x / 2x / Instant) and **Fold & skip**.

Installable as a **PWA** — serve the build over HTTPS, "Add to Home Screen", runs fully offline.

## Keyboard shortcuts (Play tab)
`F` fold · `C` check/call · `R` raise (min) · `Space` deal next hand.

## Notes / honesty
Ranges and the feedback baseline are **teaching-standard approximations**, not a solver.
Equity is Monte-Carlo (2,500 sims for the hero HUD), so it wobbles a touch hand-to-hand.
The architecture is built so a real solver/CFR engine can replace `ai/decide.ts` and the
baseline in `analysis/feedback.ts` later. Play responsibly.
