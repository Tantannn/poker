// Shared decision-classification types. The crude chart/equity baseline that
// used to live here was removed — grading now goes through analysis/grade.ts
// (solver-EV based), and these two types are all the rest of the app consumes.

export type ActionClass = 'fold' | 'check' | 'call' | 'raise';
export type Verdict = 'correct' | 'ok' | 'mistake';
