// Short-handed preflop: the hero is graded against the chart the TABLE calls for. Heads-up has
// its own ranges (the button opens ~82%); at 3–5 handed a seat's range follows how many act
// behind it, so a 4-handed "UTG" open is defended like a 6-max cutoff open, not like UTG.
import { describe, it, expect } from 'vitest';
import { createGame, startHand, applyAction, positionLabel, type GameState, type Action } from '@/engine/table';
import { getNodeStrategy } from '@/strategy';
import { getScenario } from '@/strategy/preflop';

/** Deal until the hero sits in `heroPos`, then play `script` (one action per seat to act). */
function spot(n: number, heroPos: string, script: Action[]): GameState {
  let st = createGame(n, 100, 2, Array(n - 1).fill('tag'));
  for (let k = 0; k < 3 * n; k++) {
    st = startHand(st);
    if (positionLabel(0, st.buttonIndex, n) === heroPos) break;
  }
  expect(positionLabel(0, st.buttonIndex, n)).toBe(heroPos);
  for (const a of script) {
    expect(st.toAct).not.toBe(0);
    applyAction(st, a);
  }
  expect(st.toAct).toBe(0);
  return st;
}
const chartOf = (st: GameState) => getNodeStrategy(st, 0).note ?? '';
const raise = (bb: number): Action => ({ type: 'raise', amount: bb * 2 });

describe('heads-up uses the heads-up charts', () => {
  it('the button opens from the ~82% HU range', () => {
    expect(chartOf(spot(2, 'BTN', []))).toContain(getScenario('hu-sb-rfi').label);
  });
  it('the BB defends vs the HU button open', () => {
    expect(chartOf(spot(2, 'BB', [raise(2.5)]))).toContain(getScenario('hu-bb-vs-sb').label);
  });
});

describe('3–5 handed reads the opener by seats behind, not by seat name', () => {
  it('4-handed: BB vs a UTG open (3 behind) defends like vs a 6-max cutoff', () => {
    const st = spot(4, 'BB', [raise(2.5), { type: 'fold' }, { type: 'fold' }]);
    expect(chartOf(st)).toContain(getScenario('bb-vs-co').label);
  });
  it('5-handed: BB vs a UTG open (4 behind) defends like vs a 6-max MP open', () => {
    const st = spot(5, 'BB', [raise(2.5), { type: 'fold' }, { type: 'fold' }, { type: 'fold' }]);
    expect(chartOf(st)).toContain(getScenario('bb-vs-mp').label);
  });
});
