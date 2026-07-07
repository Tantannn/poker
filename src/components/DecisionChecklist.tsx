// Think-first gate: when enabled, a postflop bet/raise doesn't fire until the
// hero answers a short checklist (hand class, texture, equity, purpose, plan).
// Answers are graded against the app's own reads (strategy/checklist.ts) and
// the truth is revealed BEFORE the chips commit — the hero can still back out.

import { useEffect, useRef, useState } from 'react';
import type { Card } from '../engine/cards';
import { buildChecklist, gradeChecklist, type ChecklistGrade } from '../strategy/checklist';

interface Props {
  hero: Card[];
  board: Card[];
  /** equity vs villain range from the HUD, or null while it's still computing. */
  equity: number | null;
  /** e.g. "Bet 12" / "Raise to 30" — labels the confirm button. */
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DecisionChecklist({ hero, board, equity, actionLabel, onConfirm, onCancel }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [locked, setLocked] = useState(false);
  // stable per mount — equity arriving mid-quiz must not add/remove a question
  const [questions] = useState(() => buildChecklist(equity));

  // a11y mirrors RangeChartModal: Escape cancels, focus restored on close.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      e.stopPropagation(); // keep F/C/R table shortcuts from firing under the modal
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onCancel]);

  const allAnswered = questions.every((q) => answers[q.id] != null);
  const result = locked ? gradeChecklist(hero, board, equity, answers) : null;
  const gradeFor = (id: string): ChecklistGrade | undefined =>
    result?.grades.find((g) => g.questionId === id);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={boxRef}
        tabIndex={-1}
        className="modal dc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Think-first checklist"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span>🧠 Think first — then {actionLabel.toLowerCase()}</span>
          <button className="modal-close" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="modal-note">
          Answer every question, lock them in, then confirm the {actionLabel.split(' ')[0].toLowerCase()} —
          or back out if your own answers talk you out of it.
        </p>

        {questions.map((q) => {
          const grade = gradeFor(q.id);
          return (
            <div className="dc-q" key={q.id}>
              <div className="dc-prompt">
                {grade && (
                  <span className={`dc-mark ${grade.ok === null ? 'info' : grade.ok ? 'good' : 'bad'}`}>
                    {grade.ok === null ? '○' : grade.ok ? '✓' : '✗'}
                  </span>
                )}
                {q.prompt}
              </div>
              <div className="dc-opts">
                {q.options.map((o) => (
                  <button
                    key={o.id}
                    className={`dc-opt ${answers[q.id] === o.id ? 'sel' : ''}`}
                    disabled={locked}
                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.id }))}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {grade && <div className={`dc-note ${grade.ok === false ? 'bad' : ''}`}>{grade.note}</div>}
            </div>
          );
        })}

        {!locked ? (
          <div className="dc-actions">
            <button className="btn dc-check" disabled={!allAnswered} onClick={() => setLocked(true)}>
              {allAnswered ? 'Lock answers & check my read' : 'Answer everything first…'}
            </button>
            <button className="link-btn" onClick={onCancel}>
              Cancel — rethink the action
            </button>
          </div>
        ) : (
          <div className="dc-actions">
            <div className="dc-score">
              Read check: <b>{result!.score}/{result!.total}</b> matched the app&apos;s reads
            </div>
            <button className="btn btn-raise" onClick={onConfirm}>
              Confirm {actionLabel}
            </button>
            <button className="link-btn" onClick={onCancel}>
              ← Back out (no action taken)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
