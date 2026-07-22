import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BankrollSim } from './BankrollSim';

describe('<BankrollSim />', () => {
  it('renders the variance KPIs from the default sim', () => {
    render(<BankrollSim />);
    expect(screen.getByText('Expected profit')).toBeTruthy();
    expect(screen.getByText('Median (p50)')).toBeTruthy();
    expect(screen.getByText('Chance of loss')).toBeTruthy();
    expect(screen.getAllByText('Risk of ruin').length).toBeGreaterThan(0); // label + note
  });

  it('re-runs and scales the expected profit when hands change', () => {
    render(<BankrollSim />);
    // default: 5 bb/100 × 20000 hands = +1000 bb expected. The grouping separator
    // is locale/ICU-dependent (",", "." or none), so tolerate any of them.
    expect(screen.getByText(/^\+1[,.]?000 bb$/)).toBeTruthy();

    const handsInput = screen.getByDisplayValue('20000') as HTMLInputElement;
    fireEvent.change(handsInput, { target: { value: '40000' } });
    fireEvent.click(screen.getByText('Run simulation'));
    // 5 bb/100 × 40000 = +2000 bb
    expect(screen.getByText(/^\+2[,.]?000 bb$/)).toBeTruthy();
  });

  it('hides the "use my session" shortcut when no session data is supplied', () => {
    render(<BankrollSim />);
    expect(screen.queryByText(/Use my session/)).toBeNull();
  });

  it('offers the shortcut once a tracked session has enough hands', () => {
    const stats = {
      handsPlayed: 5000,
      netBB: 250,
      wonBB: 7500,
      lostBB: 5000,
      busts: 0,
      decisions: [],
      movesTotal: 0,
      handResults: Array.from({ length: 5000 }, (_, i) => (i % 2 ? 3 : -2)),
      startedAt: 0,
    };
    render(<BankrollSim g={{ stats }} />);
    expect(screen.getByText(/Use my session/)).toBeTruthy();
  });
});
