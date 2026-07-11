import { describe, expect, it } from 'vitest';
import { parseCard } from '../engine/cards';
import {
  buildChecklist,
  buildCallChecklist,
  gradeChecklist,
  gradeCallChecklist,
  heroCategory,
  streetOf,
  turnImpact,
} from './checklist';

const cards = (s: string) => s.split(' ').map(parseCard);

describe('heroCategory', () => {
  it('top pair top kicker is value', () => {
    expect(heroCategory(cards('As Ks'), cards('Kh 7d 2c'))).toBe('value');
  });
  it('flush + straight combo draw is a draw', () => {
    expect(heroCategory(cards('9s 8s'), cards('7s 6d 2s'))).toBe('draw');
  });
  it('pocket pair below top pair is marginal', () => {
    expect(heroCategory(cards('8h 8d'), cards('Kh 7d 2c'))).toBe('marginal');
  });
  it('no pair no draw is air', () => {
    expect(heroCategory(cards('Qh 4d'), cards('Ah 9s 2c'))).toBe('air');
  });
});

describe('buildChecklist', () => {
  it('includes the equity question only when equity is known', () => {
    expect(buildChecklist(0.5).map((q) => q.id)).toContain('equity');
    expect(buildChecklist(null).map((q) => q.id)).not.toContain('equity');
  });
});

describe('gradeChecklist', () => {
  const hero = cards('As Ks');
  const board = cards('Kh 7d 2c'); // TPTK on a dry rainbow board

  it('grades a fully correct read', () => {
    const { grades, score, total } = gradeChecklist(hero, board, 0.75, {
      category: 'value',
      texture: 'dry',
      equity: 'gt60',
      purpose: 'value',
      plan: 'call',
    });
    expect(score).toBe(total);
    expect(total).toBe(4); // plan is ungraded
    expect(grades.find((g) => g.questionId === 'plan')?.ok).toBeNull();
  });

  it('marks a wrong category and incoherent purpose', () => {
    const { grades } = gradeChecklist(hero, board, null, {
      category: 'draw',
      texture: 'dry',
      purpose: 'bluff', // TPTK betting is not a bluff
      plan: 'fold',
    });
    expect(grades.find((g) => g.questionId === 'category')?.ok).toBe(false);
    expect(grades.find((g) => g.questionId === 'purpose')?.ok).toBe(false);
  });

  it('accepts semi-bluff as the purpose for a draw', () => {
    const dHero = cards('9s 8s');
    const dBoard = cards('7s 6d 2s');
    const { grades } = gradeChecklist(dHero, dBoard, null, {
      category: 'draw',
      texture: 'wet',
      purpose: 'semibluff',
      plan: 'raise',
    });
    expect(grades.find((g) => g.questionId === 'category')?.ok).toBe(true);
    expect(grades.find((g) => g.questionId === 'purpose')?.ok).toBe(true);
  });

  it('treats a made pair with a live flush draw as a semi-bluff', () => {
    // the reported spot: bottom pair + nut flush draw on a monotone turn.
    const h = cards('Ac 2h');
    const b = cards('9c Tc 2c 6d');
    // "semi-bluff" is a valid purpose even though the hand buckets as marginal…
    const semi = gradeChecklist(h, b, null, {
      category: 'draw', texture: 'wet', turn: 'brick', purpose: 'semibluff', plan: 'call',
    });
    expect(semi.grades.find((g) => g.questionId === 'purpose')?.ok).toBe(true);
    // …and reading it as a "draw" is accepted too (the draw drives the bet).
    expect(semi.grades.find((g) => g.questionId === 'category')?.ok).toBe(true);

    // control: the SAME pair with no draw (A♦ not A♣) — semi-bluff is now wrong.
    const dry = gradeChecklist(cards('Ad 2h'), b, null, {
      category: 'draw', texture: 'wet', turn: 'brick', purpose: 'semibluff', plan: 'call',
    });
    expect(dry.grades.find((g) => g.questionId === 'purpose')?.ok).toBe(false);
    expect(dry.grades.find((g) => g.questionId === 'category')?.ok).toBe(false);
  });

  it('gives boundary credit on a near-miss equity bucket', () => {
    const near = gradeChecklist(hero, board, 0.62, {
      category: 'value', texture: 'dry', equity: 'b4560', purpose: 'value', plan: 'call',
    });
    expect(near.grades.find((g) => g.questionId === 'equity')?.ok).toBe(true);

    const far = gradeChecklist(hero, board, 0.75, {
      category: 'value', texture: 'dry', equity: 'lt30', purpose: 'value', plan: 'call',
    });
    expect(far.grades.find((g) => g.questionId === 'equity')?.ok).toBe(false);
  });

  it('classifies a two-tone connected board as wet', () => {
    const { grades } = gradeChecklist(cards('As Ks'), cards('7s 6s 5h'), null, {
      category: 'air', texture: 'wet', purpose: 'bluff', plan: 'fold',
    });
    expect(grades.find((g) => g.questionId === 'texture')?.ok).toBe(true);
  });
});

describe('streetOf', () => {
  it('reads the street from the board length', () => {
    expect(streetOf(cards('Kh 7d 2c'))).toBe('flop');
    expect(streetOf(cards('Kh 7d 2c 5s'))).toBe('turn');
    expect(streetOf(cards('Kh 7d 2c 5s 9h'))).toBe('river');
  });
});

describe('turnImpact', () => {
  it('flags a board-pairing turn', () => {
    expect(turnImpact(cards('Kh 7d 2c Ks'))).toBe('pair');
  });
  it('flags a flush-completing turn', () => {
    expect(turnImpact(cards('Ks 7s 2d 9s'))).toBe('draw'); // third spade → flush live
  });
  it('flags a straight-opening turn', () => {
    expect(turnImpact(cards('Kh 7d 2c 8h'))).toBe('draw'); // 8-7 now straighty
  });
  it('flags a scare overcard', () => {
    expect(turnImpact(cards('9h 7d 2c Ah'))).toBe('over');
  });
  it('calls a dry non-pairing off card a brick', () => {
    expect(turnImpact(cards('Kh 8d 2c 5s'))).toBe('brick'); // no pair, no flush, no new run
  });
});

describe('turn checklist', () => {
  it('adds a graded turn question only on the turn', () => {
    expect(buildChecklist(0.5, cards('Kh 7d 2c')).map((q) => q.id)).not.toContain('turn');
    expect(buildChecklist(0.5, cards('Kh 7d 2c 5s')).map((q) => q.id)).toContain('turn');

    const { grades } = gradeChecklist(cards('As Ks'), cards('Ks 7s 2d 9s'), null, {
      category: 'value', texture: 'wet', turn: 'draw', purpose: 'value', plan: 'call',
    });
    expect(grades.find((g) => g.questionId === 'turn')?.ok).toBe(true);
  });
});

describe('river checklist', () => {
  const hero = cards('As Ks');
  const board = cards('Kh 7d 2c 5s 9h'); // TPTK, no draws left

  it('drops the draw category and semi-bluff/protection purposes', () => {
    const qs = buildChecklist(0.7, board);
    const cat = qs.find((q) => q.id === 'category')!;
    const purpose = qs.find((q) => q.id === 'purpose')!;
    expect(cat.options.map((o) => o.id)).not.toContain('draw');
    expect(purpose.options.map((o) => o.id)).toEqual(['value', 'bluff']);
  });

  it('grades top pair betting for value, not protection', () => {
    const value = gradeChecklist(hero, board, 0.7, {
      category: 'value', texture: 'dry', purpose: 'value', plan: 'call',
    });
    expect(value.grades.find((g) => g.questionId === 'purpose')?.ok).toBe(true);

    // protection is a valid FLOP purpose for a made hand but incoherent on the river
    const protect = gradeChecklist(hero, board, 0.7, {
      category: 'value', texture: 'dry', purpose: 'protection', plan: 'call',
    });
    expect(protect.grades.find((g) => g.questionId === 'purpose')?.ok).toBe(false);
  });
});

describe('size grading', () => {
  const hero = cards('As Ks');

  it('rewards a small bet on a dry board and flags an oversize one', () => {
    const board = cards('Kh 7d 2c'); // dry → wants 25–33%
    const good = gradeChecklist(hero, board, null, {
      category: 'value', texture: 'dry', purpose: 'value', size: 'small', plan: 'call',
    }, { amount: 6, pot: 18, spr: 5 });
    expect(good.grades.find((g) => g.questionId === 'size')?.ok).toBe(true);

    const tooBig = gradeChecklist(hero, board, null, {
      category: 'value', texture: 'dry', purpose: 'value', size: 'over', plan: 'call',
    }, { amount: 24, pot: 18, spr: 5 });
    const g = tooBig.grades.find((q) => q.questionId === 'size')!;
    expect(g.ok).toBe(false);
    expect(g.note).toMatch(/25–33%|sizing down/);
  });

  it('buckets a pot-sized bet as "pot", not "big" (no ⅔–¾ mislabel)', () => {
    const board = cards('9s 8s 7h'); // wet
    // 20 into 20 = 100% pot → the 'pot' band; label must say pot-sized, not ⅔–¾
    const { grades } = gradeChecklist(hero, board, null, {
      category: 'value', texture: 'wet', purpose: 'value', size: 'pot', plan: 'call',
    }, { amount: 20, pot: 20, spr: 5 });
    const g = grades.find((q) => q.questionId === 'size')!;
    expect(g.note).toContain('100% pot (about pot-sized)');
    expect(g.note).not.toContain('⅔–¾');
    expect(g.ok).toBe(true); // wet target 'big', 'pot' is one band over → within tolerance
  });

  it('offers a pot-sized option in the size question', () => {
    const size = buildChecklist(0.7, cards('9s 8s 7h'), 3).find((q) => q.id === 'size')!;
    expect(size.options.map((o) => o.id)).toContain('pot');
  });

  it('wants a big bet on a wet board', () => {
    const board = cards('9s 8s 7h'); // wet
    const { grades } = gradeChecklist(hero, board, null, {
      category: 'air', texture: 'wet', purpose: 'bluff', size: 'big', plan: 'fold',
    }, { amount: 14, pot: 20, spr: 5 });
    expect(grades.find((g) => g.questionId === 'size')?.ok).toBe(true);
  });

  it('demands a jam when committed (SPR ≤ 1)', () => {
    const board = cards('Kh 7d 2c');
    const jam = gradeChecklist(hero, board, null, {
      category: 'value', texture: 'dry', purpose: 'value', size: 'jam', plan: 'raise',
    }, { amount: 40, pot: 45, spr: 0.9 });
    expect(jam.grades.find((g) => g.questionId === 'size')?.ok).toBe(true);
    expect(jam.grades.find((g) => g.questionId === 'size')?.note).toMatch(/committed/);
  });

  it('skips the size grade when no bet context is supplied', () => {
    const board = cards('Kh 7d 2c');
    const { grades } = gradeChecklist(hero, board, null, {
      category: 'value', texture: 'dry', purpose: 'value', plan: 'call',
    });
    expect(grades.find((g) => g.questionId === 'size')).toBeUndefined();
  });

  it('asks the SPR question only when commitment binds (≤1 or >4)', () => {
    const board = cards('Kh 7d 2c');
    const has = (spr?: number) => buildChecklist(0.5, board, spr).map((q) => q.id).includes('spr');
    expect(has(undefined)).toBe(false); // unknown
    expect(has(2.5)).toBe(false); // normal 1–4 — hidden
    expect(has(0.5)).toBe(true); // committed
    expect(has(6)).toBe(true); // deep
    // and it sits right before the size question
    const ids = buildChecklist(0.5, board, 0.5).map((q) => q.id);
    expect(ids.indexOf('spr')).toBe(ids.indexOf('size') - 1);
  });

  it('grades the commitment read against the real SPR', () => {
    const board = cards('Kh 7d 2c');
    const committed = gradeChecklist(hero, board, null, {
      category: 'value', texture: 'dry', purpose: 'value', spr: 'committed', size: 'jam', plan: 'raise',
    }, { amount: 40, pot: 45, spr: 0.9 });
    expect(committed.grades.find((g) => g.questionId === 'spr')?.ok).toBe(true);
    // calling it "normal" when SPR is 0.9 is the graded-wrong answer
    const wrong = gradeChecklist(hero, board, null, {
      category: 'value', texture: 'dry', purpose: 'value', spr: 'normal', size: 'jam', plan: 'raise',
    }, { amount: 40, pot: 45, spr: 0.9 });
    expect(wrong.grades.find((g) => g.questionId === 'spr')?.ok).toBe(false);
  });
});

describe('buildCallChecklist', () => {
  it('always asks the price and the verdict', () => {
    const ids = buildCallChecklist(null, cards('Kh 7d 2c')).map((q) => q.id);
    expect(ids).toContain('price');
    expect(ids).toContain('verdict');
  });
  it('adds the equity question only when equity is known', () => {
    expect(buildCallChecklist(0.4, cards('Kh 7d 2c')).map((q) => q.id)).toContain('equity');
    expect(buildCallChecklist(null, cards('Kh 7d 2c')).map((q) => q.id)).not.toContain('equity');
  });
  it('adds the bluff-catch read only on the river', () => {
    expect(buildCallChecklist(0.4, cards('Kh 7d 2c')).map((q) => q.id)).not.toContain('bluffcatch');
    expect(buildCallChecklist(0.4, cards('Kh 7d 2c 5s 9h')).map((q) => q.id)).toContain('bluffcatch');
  });
});

describe('gradeCallChecklist', () => {
  const board = cards('Kh 7d 2c'); // flop
  const air = cards('9s 4h'); // total whiff on this board

  it('grades the pot-odds price against the real bet faced', () => {
    // call 5 into 15 → need 5/20 = 25% → the ~25% bucket
    const good = gradeCallChecklist(air, board, 0.5, { toCall: 5, pot: 15, outs: 0 }, {
      price: 'b25', equity: 'b4560', verdict: 'call',
    });
    expect(good.grades.find((g) => g.questionId === 'price')?.ok).toBe(true);

    const wrong = gradeCallChecklist(air, board, 0.5, { toCall: 5, pot: 15, outs: 0 }, {
      price: 'gt33', equity: 'b4560', verdict: 'call',
    });
    expect(wrong.grades.find((g) => g.questionId === 'price')?.ok).toBe(false);
  });

  it('calls it when equity clears the price and folds a losing air call', () => {
    // 50% equity, need 25% → ahead → call/raise ok, fold wrong
    const callIt = gradeCallChecklist(air, board, 0.5, { toCall: 5, pot: 15, outs: 0 }, {
      price: 'b25', equity: 'b4560', verdict: 'call',
    });
    expect(callIt.grades.find((g) => g.questionId === 'verdict')?.ok).toBe(true);

    // 15% equity air, need 25%, no draw → fold; calling is a leak
    const foldIt = gradeCallChecklist(air, board, 0.15, { toCall: 5, pot: 15, outs: 0 }, {
      price: 'b25', equity: 'lt30', verdict: 'call',
    });
    expect(foldIt.grades.find((g) => g.questionId === 'verdict')?.ok).toBe(false);
    const foldOk = gradeCallChecklist(air, board, 0.15, { toCall: 5, pot: 15, outs: 0 }, {
      price: 'b25', equity: 'lt30', verdict: 'fold',
    });
    expect(foldOk.grades.find((g) => g.questionId === 'verdict')?.ok).toBe(true);
  });

  it('does NOT fold a made hand getting a close price (KJ top pair, ~22% vs ~24%)', () => {
    // The reported bug: top pair facing a small-ish bet was told to fold as if it
    // were air. A made hand has showdown value + outs to improve → it's a call.
    const kj = cards('Kc Js'); // top pair on Kh 7d 2c
    const callOk = gradeCallChecklist(kj, board, 0.22, { toCall: 8, pot: 25, outs: 0 }, {
      price: 'b30', equity: 'lt30', verdict: 'call',
    });
    const v = callOk.grades.find((g) => g.questionId === 'verdict')!;
    expect(v.ok).toBe(true);
    expect(v.note).toMatch(/made hand|priced in/i);

    // and folding a made hand at this price is now the graded-wrong answer
    const foldWrong = gradeCallChecklist(kj, board, 0.22, { toCall: 8, pot: 25, outs: 0 }, {
      price: 'b30', equity: 'lt30', verdict: 'fold',
    });
    expect(foldWrong.grades.find((g) => g.questionId === 'verdict')?.ok).toBe(false);
  });

  it('still folds a made hand short of the price on the river (no implied odds)', () => {
    const kj = cards('Kh Js');
    const river = cards('Kh 7d 2c 5s 9h'); // TPTK, nothing to come
    const { grades } = gradeCallChecklist(kj, river, 0.22, { toCall: 8, pot: 25, outs: 0 }, {
      price: 'b30', equity: 'lt30', verdict: 'fold',
    });
    expect(grades.find((g) => g.questionId === 'verdict')?.ok).toBe(true);
  });

  it('lets a big draw peel with implied odds off the river', () => {
    // call 20 into 30 → need 40%; 32% equity but 9 outs on the flop → peel or fold
    const draw = cards('9s 8s'); // flush + straight draw territory
    const wetBoard = cards('7s 6d 2s');
    const peel = gradeCallChecklist(draw, wetBoard, 0.32, { toCall: 20, pot: 30, outs: 9 }, {
      price: 'gt33', equity: 'b3045', verdict: 'draw',
    });
    expect(peel.grades.find((g) => g.questionId === 'verdict')?.ok).toBe(true);
    // a bare call with air + the same numbers is not credited — the draw is the reason
    const bareCall = gradeCallChecklist(air, wetBoard, 0.32, { toCall: 20, pot: 30, outs: 0 }, {
      price: 'gt33', equity: 'b3045', verdict: 'call',
    });
    expect(bareCall.grades.find((g) => g.questionId === 'verdict')?.ok).toBe(false);
  });

  it('leaves the verdict ungraded while equity is still computing', () => {
    const { grades } = gradeCallChecklist(air, board, null, { toCall: 5, pot: 15, outs: 0 }, {
      price: 'b25', verdict: 'call',
    });
    expect(grades.find((g) => g.questionId === 'verdict')?.ok).toBeNull();
  });

  it('flags multiway fair-share on the equity note so a low % is not read as behind', () => {
    const kj = cards('Kc Js');
    const { grades } = gradeCallChecklist(kj, board, 0.35, { toCall: 8, pot: 25, outs: 0, opps: 4 }, {
      price: 'b30', equity: 'b3045', verdict: 'call',
    });
    const eq = grades.find((g) => g.questionId === 'equity');
    expect(eq?.note).toMatch(/5-way|average hand's share|decided by the price/i);
  });

  it('adds an ungraded river bluff-catch read', () => {
    const river = cards('Kh 7d 2c 5s 9h');
    const { grades } = gradeCallChecklist(air, river, 0.3, { toCall: 10, pot: 20, outs: 0 }, {
      price: 'b30', equity: 'b3045', verdict: 'fold', bluffcatch: 'rarely',
    });
    const bc = grades.find((g) => g.questionId === 'bluffcatch');
    expect(bc?.ok).toBeNull();
    expect(bc?.note).toMatch(/bluffing/i);
  });
});
