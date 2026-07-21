// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
      amount={6}
      pot={18}
      spr={2.5}
      actionLabel="Bet 6"
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
    fireEvent.click(screen.getByText(/No clear read yet/)); // villain read — ungraded
    fireEvent.click(screen.getByText(/Value — worse hands/));
    fireEvent.click(screen.getByText(/small \/ range bet/)); // 6 into 18 = ⅓ pot on a dry board
    fireEvent.click(screen.getByText(/Call — my hand/));

    expect(lock().disabled).toBe(false);
    fireEvent.click(lock());

    // graded: category/texture/equity/purpose/size = 5/5 (plan ungraded), notes revealed
    expect(screen.getByText(/5\/5/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm Bet 6/ }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('omits the equity question while the HUD is still computing', () => {
    setup(null);
    expect(screen.queryByText(/equity vs villain/i)).toBeNull();
  });

  it('adds the commitment (SPR) question only when it binds, and grades it', () => {
    // normal SPR (2.5) → no SPR question
    setup();
    expect(screen.queryByText(/How deep are the stacks/i)).toBeNull();
    cleanup();

    // committed SPR (0.5) → SPR question shows; jam is the read
    const onConfirm = vi.fn();
    render(
      <DecisionChecklist
        hero={cards('As Ks')}
        board={cards('Kh 7d 2c')}
        equity={0.75}
        amount={9}
        pot={18}
        spr={0.5}
        actionLabel="Bet 9"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/How deep are the stacks/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Strong made hand/));
    fireEvent.click(screen.getByText(/Dry \/ static/));
    fireEvent.click(screen.getByText(/Over 60%/));
    fireEvent.click(screen.getByText(/No clear read yet/)); // villain read — ungraded
    fireEvent.click(screen.getByText(/Value — worse hands/));
    fireEvent.click(screen.getByText(/Committed — SPR/));
    fireEvent.click(screen.getByText(/All-in \/ jam/));
    fireEvent.click(screen.getByText(/Call — my hand/));
    fireEvent.click(screen.getByRole('button', { name: /lock answers/i }));
    // category/texture/equity/purpose/spr/size = 6/6 (plan ungraded)
    expect(screen.getByText(/6\/6/)).toBeTruthy();
  });

  it('backs out without acting', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Cancel — rethink/ }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('runs the call variant: price, equity, verdict — then confirms the call', () => {
    const onConfirm = vi.fn();
    render(
      <DecisionChecklist
        mode="call"
        hero={cards('As Ks')}
        board={cards('Kh 7d 2c')}
        equity={0.5}
        pot={15}
        toCall={5}
        outs={0}
        actionLabel="Call 5"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/about half pot/)); // 5 into 15 = 25% price
    fireEvent.click(screen.getByText(/coin flip/)); // 45–60% equity
    fireEvent.click(screen.getByText(/No clear read yet/)); // villain read — ungraded
    fireEvent.click(screen.getByText(/my equity clears the price/));

    const lock = screen.getByRole('button', { name: /lock answers/i });
    fireEvent.click(lock);
    expect(screen.getByText(/3\/3/)).toBeTruthy(); // price + equity + verdict all right
    fireEvent.click(screen.getByRole('button', { name: /Confirm Call 5/ }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
