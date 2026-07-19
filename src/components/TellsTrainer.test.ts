// Data-integrity test for the Tells/Timing/Table-Image trainer. No rendering —
// it just guards the quiz bank so a malformed scenario (out-of-range answer,
// missing explanation, duplicate id) can never ship.
import { describe, it, expect } from 'vitest';
import { TELL_SCENARIOS } from './TellsTrainer';

describe('TELL_SCENARIOS', () => {
  it('has a healthy number of scenarios', () => {
    expect(TELL_SCENARIOS.length).toBeGreaterThanOrEqual(14);
  });

  it('every scenario is well-formed', () => {
    for (const s of TELL_SCENARIOS) {
      // 3–4 non-empty options
      expect(s.options.length).toBeGreaterThanOrEqual(3);
      expect(s.options.length).toBeLessThanOrEqual(4);
      for (const o of s.options) expect(o.trim().length).toBeGreaterThan(0);

      // correctIndex points at a real option
      expect(Number.isInteger(s.correctIndex)).toBe(true);
      expect(s.correctIndex).toBeGreaterThanOrEqual(0);
      expect(s.correctIndex).toBeLessThan(s.options.length);

      // prompt + explanation are present
      expect(s.prompt.trim().length).toBeGreaterThan(0);
      expect(s.explain.trim().length).toBeGreaterThan(0);

      // question type is one we render
      expect(['read', 'exploit']).toContain(s.type);
    }
  });

  it('has unique ids', () => {
    const ids = TELL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mixes read and exploit questions', () => {
    const types = new Set(TELL_SCENARIOS.map((s) => s.type));
    expect(types.has('read')).toBe(true);
    expect(types.has('exploit')).toBe(true);
  });

  it('teaches that a cluster beats a single tell', () => {
    expect(TELL_SCENARIOS.some((s) => s.category === 'Cluster')).toBe(true);
  });
});
