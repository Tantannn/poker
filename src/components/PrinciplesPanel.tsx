// Principles — the "review later" surface that closes the study loop. Lists every
// tagged hand and the takeaway you wrote, so the journal isn't write-only. Uses
// antd Table (multi-select checkboxes + bulk delete), a filter Select, and inline
// editable takeaways. Open a hand's takeaway to refine the principle over time.

import { useMemo, useState } from 'react';
import { ConfigProvider, Table, Select, Button, Input, Tag, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import type { useGame } from '../hooks/useGame';
import type { JournalEntry } from '../store/journal';
import { PlayingCard } from './PlayingCard';

type G = ReturnType<typeof useGame>;
type Filter = 'all' | 'wins' | 'losses' | 'noted' | 'unnoted';

export function PrinciplesPanel({ g }: { g: G }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<number[]>([]);

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

  const columns: TableColumnsType<JournalEntry> = [
    {
      title: 'Hand',
      dataIndex: 'handNumber',
      width: 130,
      sorter: (a, b) => a.handNumber - b.handNumber,
      render: (_: number, e) => (
        <div className="pr-hand">
          <span className="pr-num">#{e.handNumber}</span>
          <span className="pr-cards">{e.heroCards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</span>
        </div>
      ),
    },
    {
      title: 'Board',
      dataIndex: 'board',
      width: 150,
      render: (_: unknown, e) =>
        e.board.length ? (
          <span className="pr-cards">{e.board.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</span>
        ) : (
          <span className="pr-muted">no flop</span>
        ),
    },
    {
      title: 'Result',
      dataIndex: 'deltaBB',
      width: 100,
      sorter: (a, b) => a.deltaBB - b.deltaBB,
      render: (d: number) => (
        <Tag color={d > 0 ? 'green' : d < 0 ? 'red' : 'default'}>
          {d >= 0 ? '+' : ''}
          {d.toFixed(1)} bb
        </Tag>
      ),
    },
    {
      title: 'Takeaway / principle',
      dataIndex: 'takeaway',
      render: (_: string, e) => (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder="Extract one principle from this hand…"
          value={e.takeaway}
          onChange={(ev) => g.setHandTakeaway(e.handNumber, ev.target.value)}
        />
      ),
    },
  ];

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { colorPrimary: '#2ec27e', colorBgContainer: '#0c1813', colorBorder: '#27412f', borderRadius: 8 },
      }}
    >
      <div className="card">
        <h2>Principles</h2>
        <p className="sub">
          Every hand you tagged for review, with the takeaway you wrote. Refine a principle by editing its text;
          select hands to prune. This is your durable study-notes log — extract patterns, not single hands.
        </p>

        <div className="pr-bar">
          <Select<Filter>
            value={filter}
            onChange={setFilter}
            style={{ width: 170 }}
            options={[
              { value: 'all', label: `All tagged (${g.journal.length})` },
              { value: 'wins', label: 'Wins only' },
              { value: 'losses', label: 'Losses only' },
              { value: 'noted', label: `With a takeaway (${withNotes})` },
              { value: 'unnoted', label: 'Needs a takeaway' },
            ]}
          />
          <Button
            danger
            disabled={selected.length === 0}
            onClick={() => {
              g.removeJournalEntries(selected);
              setSelected([]);
            }}
          >
            Delete selected ({selected.length})
          </Button>
          <span className="pr-count">{rows.length} shown · {withNotes}/{g.journal.length} have a principle</span>
        </div>

        {g.journal.length === 0 ? (
          <p className="sub">
            No tagged hands yet. In <b>Play vs Bots</b> or <b>Hand Review</b>, hit <b>☆ Tag</b> on a hand, then write a
            takeaway — it lands here.
          </p>
        ) : (
          <Table<JournalEntry>
            rowKey="handNumber"
            size="small"
            columns={columns}
            dataSource={rows}
            pagination={{ pageSize: 12, hideOnSinglePage: true }}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as number[]),
            }}
          />
        )}
      </div>
    </ConfigProvider>
  );
}
