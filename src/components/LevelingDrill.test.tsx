// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LevelingDrill } from './LevelingDrill';

describe('LevelingDrill component', () => {
  it('walks the trust → counter phases and always reaches a reveal', () => {
    render(<LevelingDrill />);
    expect(screen.getByText(/Leveling War/i)).toBeTruthy();

    // phase 1: trust. Either answer advances to the counter question.
    fireEvent.click(screen.getByText(/Real adjustment/i));
    expect(screen.getByText(/What do you change\?/i)).toBeTruthy();

    // phase 2: counter. `keep-watching` is always on offer, so it's a safe click.
    fireEvent.click(screen.getByText(/Nothing to act on yet/i));

    // Either the spot had a re-level round (asks again) or it finished. Round 1's buttons stay
    // on screen (disabled, showing the answer), so the live list is the LAST match.
    if (screen.queryByText(/Re-level\. What now\?/i)) {
      const live = screen.getAllByText(/Give his bets credit/i);
      fireEvent.click(live[live.length - 1]);
    }
    expect(screen.getByText(/Next spot/i)).toBeTruthy();
    cleanup();
  }, 20000);
});
