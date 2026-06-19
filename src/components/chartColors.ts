// Shared coloring for the 13x13 range grids (full chart + popup).

import type { ActionOption } from '../strategy/types';

export const KIND_COLOR: Record<string, string> = {
  value: '#2ec27e',
  open: '#1f9e62',
  call: '#3aa0e0',
  bluff: '#e0843a',
  passive: '#3aa0e0',
  aggressive: '#2ec27e',
  fold: '#2a3a31',
};

export const KIND_LABEL: Record<string, string> = {
  value: 'Open / 3-Bet (value)',
  call: 'Call',
  bluff: '3-Bet bluff',
  fold: 'Fold',
};

/** Background for a cell from its action mix (gradient split by frequency). */
export function cellBackground(opts: ActionOption[]): string {
  if (opts.length === 0) return KIND_COLOR.fold;
  if (opts.length === 1) return KIND_COLOR[opts[0].kind ?? 'fold'];
  const sorted = [...opts].sort((a, b) => b.freq - a.freq);
  let acc = 0;
  const stops: string[] = [];
  for (const o of sorted) {
    const c = KIND_COLOR[o.kind ?? 'fold'];
    const start = acc * 100;
    acc += o.freq;
    stops.push(`${c} ${start}% ${acc * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
