// Preflop open-raise SIZE by stack depth — the "how big do I open?" rule, kept
// separate from the range charts (which hands) because size is driven by DEPTH,
// not by the hand. Single source shared by the postflop SizingCheatSheet (block 0)
// and the Preflop Charts trainer, so the two can never disagree.

export const OPEN_SIZE_ROWS: [string, string][] = [
  ['100bb+ (cash / deep)', '2.5–3bb (3–4bb live/loose). Deep → build the pot; 3–4bb is a DEEP-stack number, not a default.'],
  ['40–60bb', '2–2.5bb. Blinds rising → open smaller; a big open over-commits your shrinking stack.'],
  ['20–30bb', '2–2.2bb (≈ min-raise). Keep it cheap — you can’t profitably call a re-jam very wide.'],
  ['< 15bb', 'Stop open-raise-folding — open-JAM or fold. Raise then fold to a shove just bleeds chips.'],
  ['Antes in play (mid/late MTT)', 'Open a notch SMALLER (2–2.2bb). Extra dead money → better steal price, so risk less to win it.'],
  ['Position', 'Late (BTN/CO) → smaller & wider steals; early → tighter range, same size.'],
  ['Why', 'Stack DEPTH sets the size. Shallow + 3–4bb open = over-commit + invites shoves; a small open wins the same pot / same fold equity for less risk and preserves your stack.'],
];

// One-line gut hook for the collapsible header / cheat-sheet lead.
export const OPEN_SIZE_HOOK =
  '3–4bb = deep/cash. Rising blinds → open smaller: 40–60bb → 2–2.5bb · 20–30bb → min-ish · <15bb → jam.';
