// One bots-only simulation, measured through the app's OWN HUD counters (observed.ts), guards
// three things that silently drift when a bot is retuned:
//   1. profiles.ts `hud` — what the coach's prior and the archetype guide assume a bot does;
//   2. the postflop archetype bands (before the range-respect fix every bot was a station);
//   3. the guide actually recognising the bots.
// Re-measure `hud` after a retune (prints the table, minutes):
//   SIM=1 npx vitest run src/analysis/archetypeCalibration.test.ts --silent=false --reporter=verbose
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { simulateBots, SIM_ARCHETYPES, type ArchStats } from '@/ai/sim';

import { getProfile } from '@/ai/decide';

import { makeRng } from '@/engine/cards';

import { accumulateHand, toStats, emptyObs, type ObsCounters, type ObservedStats } from './observed';
import { rankArchetypes } from './archetypeSignature';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const HANDS = env.SIM ? 8000 : 900;
const SOLID = ['tag', 'nit', 'gto', 'reg'];

function sumCounters(a: ObsCounters, b: ObsCounters): ObsCounters {
  const out = { ...emptyObs(), ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b))
    if (typeof v === 'number' && typeof out[k] === 'number' && !k.includes('Recent')) out[k] = (out[k] as number) + v;
  return out as unknown as ObsCounters;
}

describe('bots match their measured signature (hard)', () => {
  let sim: Record<string, ArchStats>;
  const hud: Record<string, ObservedStats> = {};
  const seats: { arch: string; stats: ObservedStats }[] = [];

  beforeAll(() => {
    vi.spyOn(Math, 'random').mockImplementation(makeRng(20261120));
    const pooled: Record<string, ObsCounters> = Object.fromEntries(SIM_ARCHETYPES.map((a) => [a, emptyObs()]));
    let table = -1;
    let counters: Record<number, ObsCounters> = {};
    let profiles: string[] = [];
    const closeTable = () =>
      profiles.forEach((arch, id) => {
        if (!counters[id]) return;
        pooled[arch] = sumCounters(pooled[arch], counters[id]);
        seats.push({ arch, stats: toStats(counters[id]) });
      });
    sim = simulateBots('hard', HANDS, 3, env.SIM ? {} : { iters: 120 }, (st, t) => {
      if (t !== table) {
        closeTable();
        table = t;
        counters = {};
        profiles = st.players.map((p) => p.profileId);
      }
      counters = accumulateHand(counters, st.log, st.handNumber);
    });
    closeTable();
    for (const a of SIM_ARCHETYPES) hud[a] = toStats(pooled[a]);
    if (env.SIM)
      for (const a of SIM_ARCHETYPES)
        console.log(`HUD ${a}: { vpip: ${hud[a].vpip.toFixed(2)}, af: ${hud[a].af?.toFixed(2)}, foldToBet: ${hud[a].foldToBet?.toFixed(2)} }`);
  }, 900000);
  afterAll(() => vi.restoreAllMocks());

  it('profiles.ts `hud` still describes the bots — re-measure after a retune', () => {
    // The fast run (cheap equity reads, 900 hands) reads AF up to ~0.6 and fold-to-bet up to
    // ~0.1 off the full measurement, so these catch a RETUNE (today's moved folds 20+ points),
    // not a few points of drift — re-measure with SIM=1 after any change to decide.ts.
    for (const a of SIM_ARCHETYPES) {
      const want = getProfile(a).hud;
      expect(Math.abs(hud[a].vpip - want.vpip), `${a} vpip ${hud[a].vpip.toFixed(2)}`).toBeLessThan(0.05);
      expect(Math.abs((hud[a].af ?? 0) - want.af), `${a} af ${hud[a].af?.toFixed(2)}`).toBeLessThan(0.75);
      expect(Math.abs((hud[a].foldToBet ?? 0) - want.foldToBet), `${a} foldToBet ${hud[a].foldToBet?.toFixed(2)}`).toBeLessThan(0.13);
    }
  });

  describe('postflop archetype bands', () => {
    const pooled = (k: keyof ArchStats) => SOLID.reduce((a, x) => a + sim[x][k], 0) / SOLID.length;
    it('solid players fold to c-bets and reach showdown at real rates, not like stations', () => {
      expect(pooled('foldToCbet')).toBeGreaterThan(35);
      expect(pooled('wtsd')).toBeLessThan(34);
    });
    it('the calling station stays a station', () => {
      expect(sim.lp.foldToCbet).toBeLessThan(pooled('foldToCbet') - 12);
      expect(sim.lp.wtsd).toBeGreaterThan(pooled('wtsd') + 8);
      expect(sim.lp.foldToRaise).toBeLessThan(pooled('foldToRaise') - 15);
      expect(sim.lp.af).toBeLessThan(1);
    });
    it('the maniac is the most aggressive player at the table', () => {
      expect(sim.maniac.af).toBeGreaterThan(pooled('af') + 0.8);
    });
  });

  it('the guide recognises the bots that play distinctly', () => {
    // tag / gto / reg are a static clique (only `adapt` separates them), so they count as one
    const group = (id: string) => (['tag', 'gto', 'reg'].includes(id) ? 'balanced' : id);
    const hits = seats.filter((s) => group(rankArchetypes(s.stats)[0].id) === group(s.arch)).length;
    expect(hits / seats.length).toBeGreaterThan(0.6);
  });
});
