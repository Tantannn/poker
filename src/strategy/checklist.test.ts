import { describe, expect, it } from 'vitest';
import { parseCard } from '../engine/cards';
import { buildChecklist, gradeChecklist, heroCategory } from './checklist';

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
