// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { loadThinkTime, recordThinkTime, resetThinkTime, avgThinkMs } from './thinkTime';

describe('thinkTime store', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty and averages to 0', () => {
    expect(loadThinkTime()).toEqual({ totalMs: 0, count: 0 });
    expect(avgThinkMs({ totalMs: 0, count: 0 })).toBe(0);
  });

  it('accumulates decisions and averages them', () => {
    recordThinkTime(2000);
    const t = recordThinkTime(4000);
    expect(t).toEqual({ totalMs: 6000, count: 2 });
    expect(avgThinkMs(t)).toBe(3000);
    // survives a reload (persisted to localStorage)
    expect(loadThinkTime()).toEqual({ totalMs: 6000, count: 2 });
  });

  it('resets to empty', () => {
    recordThinkTime(1234);
    expect(resetThinkTime()).toEqual({ totalMs: 0, count: 0 });
    expect(loadThinkTime()).toEqual({ totalMs: 0, count: 0 });
  });
});
