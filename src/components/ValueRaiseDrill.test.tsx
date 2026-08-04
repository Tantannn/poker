// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ValueRaiseDrill } from './ValueRaiseDrill';
import { genSpot } from './valueRaiseSpot';

describe('ValueRaiseDrill spot generation', () => {
  it('produces well-formed facing-a-bet spots', () => {
    const s = genSpot();
    expect(['raise', 'call', 'fold']).toContain(s.best);
    expect(s.board.length).toBe(s.street === 'flop' ? 3 : 4);
    expect(s.hole.length).toBe(2);
    expect(s.betBB).toBeGreaterThan(0);
    expect(Number.isFinite(s.raiseEv)).toBe(true);
    expect(Number.isFinite(s.callEv)).toBe(true);
  }, 20000);

  it('surfaces a raise/call MIX — trains the raise reflex without being "always raise"', () => {
    // biased toward made hands, so value/protection raises are the majority line — but calls
    // (trap / pot-control) must also appear or the drill degenerates into one mindless button.
    // Measured ~67% raise / 33% call; loose bounds absorb MC noise.
    let raiseBest = 0;
    let nonRaise = 0;
    for (let i = 0; i < 20; i++) {
      if (genSpot().best === 'raise') raiseBest++;
      else nonRaise++;
    }
    expect(raiseBest).toBeGreaterThanOrEqual(6);
    expect(nonRaise).toBeGreaterThanOrEqual(2);
  }, 90000);
});

describe('ValueRaiseDrill component', () => {
  it('renders and grades a choice', () => {
    render(<ValueRaiseDrill />);
    expect(screen.getByText(/Value Raise/i)).toBeTruthy();
    // pick the first choice → reveal appears
    fireEvent.click(screen.getByText('Raise'));
    expect(screen.getByText(/Next spot/i)).toBeTruthy();
    cleanup();
  }, 20000);
});
