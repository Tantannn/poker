// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DecisionChecklist } from './DecisionChecklist';
import { parseCard } from '../engine/cards';

const cards = (s: string) => s.split(' ').map(parseCard);

function setup(equity: number | null = 0.75) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <DecisionChecklist
      hero={cards('As Ks')}
      board={cards('Kh 7d 2c')}
      equity={equity}
      actionLabel="Bet 12"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('DecisionChecklist', () => {
  it('locks only after every question is answered, then confirms the action', () => {
    const { onConfirm } = setup();
    const lock = () =>
      screen.getByRole('button', { name: /lock answers|answer everything/i }) as HTMLButtonElement;
    expect(lock().disabled).toBe(true);

    fireEvent.click(screen.getByText(/Strong made hand/));
    fireEvent.click(screen.getByText(/Dry \/ static/));
    fireEvent.click(screen.getByText(/Over 60%/));
    fireEvent.click(screen.getByText(/Value — worse hands/));
    fireEvent.click(screen.getByText(/Call — my hand/));

    expect(lock().disabled).toBe(false);
    fireEvent.click(lock());

    // graded: 4/4 (plan ungraded), truth notes revealed
    expect(screen.getByText(/4\/4/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm Bet 12/ }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('omits the equity question while the HUD is still computing', () => {
    setup(null);
    expect(screen.queryByText(/equity vs villain/i)).toBeNull();
  });

  it('backs out without acting', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Cancel — rethink/ }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
