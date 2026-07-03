// Shared keyboard shortcuts for the drill tabs: number keys 1–9 pick the Nth
// answer button, Space/Enter advances to the next spot once the answer is
// revealed. Mirrors the live table's keydown pattern (PokerTable/PreflopTrainer)
// so every drill trains at typing speed, not mouse speed.

import { useEffect } from 'react';

export function useDrillKeys(opts: {
  /** number of answer choices currently on screen (keys 1..choices pick). */
  choices: number;
  /** pick handler, 0-based index into the on-screen choice order. */
  onPick: (index: number) => void;
  /** advance handler — fires on Space/Enter, only when `revealed`. */
  onNext: () => void;
  /** answer shown? gates picks off and next on. */
  revealed: boolean;
  /** master switch (e.g. off while a sub-mode without choices is open). */
  enabled?: boolean;
}): void {
  const { choices, onPick, onNext, revealed, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // never steal keys from form fields or when a modifier is held
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ' || e.key === 'Enter') {
        if (revealed) {
          e.preventDefault(); // Space must not scroll / re-click the focused button
          onNext();
        }
        return;
      }
      const n = parseInt(e.key, 10);
      if (!revealed && n >= 1 && n <= Math.min(9, choices)) {
        e.preventDefault();
        onPick(n - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choices, onPick, onNext, revealed, enabled]);
}

/** One-line hint for the UI so the shortcuts are discoverable. */
export function drillKeysHint(choices: number): string {
  return `⌨ 1–${Math.min(9, choices)} pick · Space next`;
}
