import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Review } from './Review';
import { CARDS } from './flashcards';

describe('<Review />', () => {
  beforeEach(() => localStorage.clear()); // start each case with a clean SRS store

  it('shows the mastery dashboard with the full card count tracked', () => {
    render(<Review />);
    expect(screen.getByText('🔁 Review — Spaced Repetition')).toBeTruthy();
    expect(screen.getByText('Cards tracked')).toBeTruthy();
    expect(screen.getByText(String(CARDS.length))).toBeTruthy();
  });

  it('has nothing due on a fresh store and disables the due-review button', () => {
    render(<Review />);
    const dueBtn = screen.getByText(/caught up/) as HTMLButtonElement;
    expect(dueBtn.disabled).toBe(true);
  });

  it('starts a review session from "Review all"', () => {
    render(<Review />);
    fireEvent.click(screen.getByText(/Review all/));
    expect(screen.getByText('🔁 Review session')).toBeTruthy();
    expect(screen.getByText("What's your equity?")).toBeTruthy();
  });
});
