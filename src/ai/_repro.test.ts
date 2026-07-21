import { describe, it } from 'vitest';
import { createGame, startHand, legalActions, applyAction, potTotal, positionLabel } from '../engine/table';
import { decideAction } from './decide';

describe('repro: short-stack bot opens', () => {
  it('logs preflop raises vs actor stack', () => {
    const profiles = ['tag', 'lag', 'nit', 'fish', 'tag'];
    let state = createGame(6, 40, 20, profiles, true);
    const hits: string[] = [];
    for (let hand = 0; hand < 120; hand++) {
      state = startHand(state);
      const bb = state.bigBlind;
      let guard = 0;
      while (state.street === 'preflop' && state.toAct >= 0 && guard++ < 40) {
        const i = state.toAct;
        const p = state.players[i];
        if (i === 0) {
          // hero: just fold/check to keep bots driving
          const la = legalActions(state);
          applyAction(state, la.canCheck ? { type: 'check' } : { type: 'fold' });
          continue;
        }
        const before = p.stack;
        const stackBB = (p.stack + p.committed) / bb;
        const a = decideAction(state, undefined);
        if ((a.type === 'raise' || a.type === 'bet') && a.amount) {
          const added = a.amount - p.committed;
          const fracOfStack = added / before;
          const toBB = a.amount / bb;
          if (fracOfStack >= 0.3 && toBB < stackBB - 0.5) {
            // a raise that is NOT an all-in but risks >=30% of stack
            hits.push(
              `h${state.handNumber} L bb=${bb} ${positionLabel(i, state.buttonIndex, 6)} stack=${stackBB.toFixed(1)}bb raiseTo=${toBB.toFixed(2)}bb added=${(added / bb).toFixed(2)}bb frac=${(fracOfStack * 100).toFixed(0)}% pot=${(potTotal(state) / bb).toFixed(2)}bb`,
            );
          }
        }
        applyAction(state, a);
      }
    }
    console.log('\n=== non-allin raises risking >=30% of stack ===');
    console.log(hits.slice(0, 60).join('\n'));
    console.log(`total hits: ${hits.length}`);
  });
});
