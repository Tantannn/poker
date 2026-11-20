// Prints the full per-archetype HUD table from the bots-only simulator. Opt-in (minutes):
//   SIM=1 npx vitest run src/ai/_sim.test.ts --silent=false --reporter=verbose
import { it } from 'vitest';
import { simulateBots, SIM_ARCHETYPES } from './botSim';
import type { Difficulty } from './difficulty';

const f = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-').padStart(5);

function print(diff: Difficulty, hands: number, seed: number) {
  const s = simulateBots(diff, hands, seed);
  console.log(`\nSIM ${diff} (${hands} hands)`);
  console.log('SIM arch     VPIP  PFR   3B  F3B   CB  FCB   AF WTSD W$SD  FvR RvCl bb/100');
  for (const a of SIM_ARCHETYPES) {
    const x = s[a];
    console.log(`SIM ${a.padEnd(7)}${f(x.vpip)}${f(x.pfr)}${f(x.threeBet)}${f(x.foldTo3Bet)}${f(x.cbet)}${f(x.foldToCbet)}${f(x.af, 1)}${f(x.wtsd)}${f(x.wsd)}${f(x.foldToRaise)}${f(x.riverCall)}${f(x.bb100, 1)}`);
  }
}

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

it.skipIf(!env.SIM)('bots-only HUD stats per archetype', () => {
  print('normal', 8000, 7);
  print('hard', 8000, 11);
}, 900000);
