// Web Worker wrapper for the hero-turn HUD/strategy computation. The ~2×1400
// Monte-Carlo runs + range summarisation used to run on the main thread and
// hitch the UI on every hero turn (worst on phones); here they run off-thread
// and post the finished numbers back. Requests carry a `seq` so the caller can
// drop stale replies when the game state advances mid-compute.

import type { GameState } from '../engine/table';
import type { VillainModels } from '../strategy';
import { computeHudNode } from '../strategy/hudCompute';

// `models` (observed villain reads / manual node locks) rides along in the request
// because the worker has no access to React state — it is a plain object of numbers,
// so it structured-clones like the state does.
self.onmessage = (e: MessageEvent<{ seq: number; state: GameState; models?: VillainModels }>) => {
  const { seq, state, models } = e.data;
  // NodeStrategy contains a Map (villainRange) — fine: Maps structured-clone.
  self.postMessage({ seq, result: computeHudNode(state, models) });
};
