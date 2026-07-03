// Principles — the "review later" surface that closes the study loop. Lists every
// tagged hand and the takeaway you wrote, so the journal isn't write-only: a
// filter, multi-select checkboxes + bulk delete, and inline editable takeaways.
// Plain HTML table — this used to be the app's only antd consumer and carried a
// ~420 kB chunk for one table; the homemade version costs nothing.

import { useMemo, useState } from 'react';
import type { useGame } from '../hooks/useGame';
import { PlayingCard } from './PlayingCard';

type G = ReturnType<typeof useGame>;
type Filter = 'all' | 'wins' | 'losses' | 'noted' | 'unnoted';

export function PrinciplesPanel({ g }: { g: G }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    return g.journal.filter((e) => {
      if (filter === 'wins') return e.deltaBB > 0;
      if (filter === 'losses') return e.deltaBB < 0;
      if (filter === 'noted') return e.takeaway.trim().length > 0;
      if (filter === 'unnoted') return e.takeaway.trim().length === 0;
      return true;
    });
  }, [g.journal, filter]);

  const withNotes = g.journal.filter((e) => e.takeaway.trim().length > 0).length;
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected(allShownSelected ? new Set() : new Set(rows.map((r) => r.id)));

  return (
    <div className="card">
      <h2>Principles</h2>
      <p className="sub">
        Every hand you tagged for review, with the takeaway you wrote. Refine a principle by editing its text;
        select hands to prune. This is your durable study-notes log — extract patterns, not single hands.
      </p>

      <div className="pr-bar">
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All tagged ({g.journal.length})</option>
          <option value="wins">Wins only</option>
          <option value="losses">Losses only</option>
          <option value="noted">With a takeaway ({withNotes})</option>
          <option value="unnoted">Needs a takeaway</option>
        </select>
        <button
          className="btn-small pr-danger"
          disabled={selected.size === 0}
          onClick={() => {
            g.removeJournalEntries([...selected]);
            setSelected(new Set());
          }}
        >
          Delete selected ({selected.size})
        </button>
        <span className="pr-count">{rows.length} shown · {withNotes}/{g.journal.length} have a principle</span>
      </div>

      {g.journal.length === 0 ? (
        <p className="sub">
          No tagged hands yet. In <b>Play vs Bots</b> or <b>Hand Review</b>, hit <b>☆ Tag</b> on a hand, then write a
          takeaway — it lands here.
        </p>
      ) : (
        <div className="pr-tablewrap">
          <table className="pr-table">
            <thead>
              <tr>
                <th className="pr-check">
                  <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all shown" />
                </th>
                <th>Hand</th>
                <th>Board</th>
                <th>Result</th>
                <th className="pr-take-h">Takeaway / principle</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={selected.has(e.id) ? 'sel' : ''}>
                  <td className="pr-check">
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Select hand ${e.handNumber}`} />
                  </td>
                  <td>
                    <div className="pr-hand">
                      <span className="pr-num">#{e.handNumber}</span>
                      <span className="pr-cards">{e.heroCards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</span>
                    </div>
                  </td>
                  <td>
                    {e.board.length ? (
                      <span className="pr-cards">{e.board.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</span>
                    ) : (
                      <span className="pr-muted">no flop</span>
                    )}
                  </td>
                  <td>
                    <span className={`pr-tag ${e.deltaBB > 0 ? 'pos' : e.deltaBB < 0 ? 'neg' : ''}`}>
                      {e.deltaBB >= 0 ? '+' : ''}{e.deltaBB.toFixed(1)} bb
                    </span>
                  </td>
                  <td className="pr-take">
                    <textarea
                      rows={2}
                      placeholder="Extract one principle from this hand…"
                      value={e.takeaway}
                      onChange={(ev) => g.setHandTakeaway(e.id, ev.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
