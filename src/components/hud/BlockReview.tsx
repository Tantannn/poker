import { useMemo, useState } from 'react';
import type { useGame } from '@/hooks/useGame';
import { BLOCK_SIZES, summarizeBlock, type BlockEntry } from '@/analysis/grading';

import { Feedback } from './Feedback';
import { PlayingCard, PanelButton } from '@/components/shared';
import { ActionLine } from '@/components/table';





type G = ReturnType<typeof useGame>;

export function BlockControls({ g }: { g: G }) {
  const [size, setSize] = useState<number>(30);
  const { block } = g;
  if (block && !block.done) {
    return (
      <div className="block-progress">
        🎯 Block session: hand {Math.min(block.hands + 1, block.target)} / {block.target} — guides &amp; grades hidden
        <button className="link-btn" onClick={g.endBlockEarly}>End early &amp; review</button>
      </div>
    );
  }
  if (block) return null;
  return (
    <div className="block-start">
      <div className="block-start-head">🎯 Block session — play blind, review at the end</div>
      <div className="block-sizes">
        {BLOCK_SIZES.map((n) => (
          <button key={n} className={`btn block-size ${n === size ? 'primary' : 'secondary'}`} onClick={() => setSize(n)}>
            {n}
          </button>
        ))}
      </div>
      <PanelButton variant="go" onClick={() => g.startBlock(size)} title="No HUD, no solver, no grades — then review every mistake at the end">
        ▶ Start {size}-hand block
      </PanelButton>
    </div>
  );
}

function bb(n: number) {
  return `${n.toFixed(2)}bb`;
}

function signedBB(n: number) {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}bb`;
}

function WorstSpot({ e, rank }: { e: BlockEntry; rank: number }) {
  const [open, setOpen] = useState(false);
  const ctx = e.fb.context;
  return (
    <li className="block-worst">
      <div className="block-worst-meta">
        #{rank} · Hand {e.handNumber} · <b>{e.street}</b>
        {ctx?.position && <> · {ctx.position}</>}
        {ctx?.facing && <> · {ctx.facing}</>}
        {ctx && <> · pot {ctx.potBB.toFixed(1)}bb</>}
        {ctx?.villainName && <> · vs {ctx.villainName}{ctx.villainTag && ` (${ctx.villainTag})`}</>}
      </div>

      <div className="block-cards">
        {e.heroCards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}
        {e.board.length > 0 && <span className="block-cards-sep" />}
        {e.board.map((c, i) => <PlayingCard key={`b${i}`} card={c} size="sm" />)}
        {ctx?.handLabel && <span className="block-hand-label">{ctx.handLabel}</span>}
      </div>

      <ActionLine actions={e.actions} />

      <div className="block-verdict">
        You <b className="bad">{e.fb.chosenLabel}</b> · best <b className="good">{e.fb.bestLabel}</b> · lost {bb(e.fb.evLoss)}
        {e.resultBB !== undefined && (
          <span className={`block-result ${e.resultBB >= 0 ? 'good' : 'bad'}`}>hand result {signedBB(e.resultBB)}</span>
        )}
      </div>

      <button className="link-btn" onClick={() => setOpen(!open)}>
        {open ? '▲ Hide explanation' : '▼ Why? Show explanation'}
      </button>
      {open && <Feedback fb={e.fb} peeked={false} />}
    </li>
  );
}

export function BlockReview({ g }: { g: G }) {
  const block = g.block;
  const s = useMemo(() => (block ? summarizeBlock(block.entries, block.hands) : null), [block]);
  if (!block || !block.done || !s) return null;

  return (
    <div className="block-review deferred-review">
      <div className="dr-head">
        🎯 Block review — {s.hands} hands, {s.decisions} decisions
        <span className="dr-sub">
          {s.mistakes} mistakes · EV lost {bb(s.evLoss)} ({s.evLossPer100.toFixed(1)} bb/100)
        </span>
      </div>

      <div className="block-marry">
        Marry-hand check: <b>{s.callsWhenRaiseOrFold}</b> call{s.callsWhenRaiseOrFold === 1 ? '' : 's'} where raise or fold was better.
      </div>

      {s.leaks.length > 0 && (
        <>
          <h4>Leaks (by EV lost)</h4>
          <ul className="block-leaks">
            {s.leaks.map((l) => (
              <li key={l.kind}>{l.label}: {l.count}× — {bb(l.evLoss)}</li>
            ))}
          </ul>
        </>
      )}

      <h4>By street</h4>
      <ul className="block-streets">
        {s.byStreet.map((st) => (
          <li key={st.street}>{st.street}: {st.decisions} decisions, −{bb(st.evLoss)}</li>
        ))}
      </ul>

      {s.worst.length > 0 ? (
        <>
          <h4>Worst decisions</h4>
          <ol className="block-worst-list">
            {s.worst.map((e, i) => <WorstSpot key={`${e.handNumber}-${i}`} e={e} rank={i + 1} />)}
          </ol>
        </>
      ) : (
        <div>No mistakes above the noise threshold — clean block.</div>
      )}

      <button className="btn btn-deal" onClick={g.closeBlock}>Close review</button>
    </div>
  );
}
