// Hover/focus tooltips for every number the app computes. One reusable Tooltip
// plus a CALC registry of "how it's calculated / how to remember it" cards, so a
// formula lives in exactly one place and any panel can surface it on hover.
// Homemade portal tooltip (was antd — the app's only use, worth ~420 kB gzipped).

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CALC, GLOSSARY } from './CalConstant';

type Pos = 'top' | 'bottom';

/** Generic tooltip: wraps any trigger node, pops `content` on hover/focus.
 *  Rendered through a portal at a fixed position, so it never clips inside
 *  narrow / overflow-hidden panels — same behaviour the antd one had. */
export function Tooltip({
  content,
  children,
  pos = 'top',
  className = '',
}: {
  content: ReactNode;
  children: ReactNode;
  pos?: Pos;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Resolved after the bubble mounts: exact top-left clamped so the WHOLE bubble
  // stays on-screen (center-only clamping let wide bubbles overflow on mobile).
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const show = () => setRect(ref.current?.getBoundingClientRect() ?? null);
  const hide = () => {
    setRect(null);
    setCoords(null);
  };

  // Measure the rendered bubble, then clamp its edges into the viewport and flip
  // sides if the preferred side has no room. Runs once the portal is in the DOM.
  useLayoutEffect(() => {
    if (!rect || !popRef.current) return;
    const pop = popRef.current.getBoundingClientRect();
    const m = 8; // viewport margin
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // horizontal: centre on the trigger, then clamp both edges on-screen
    let left = rect.left + rect.width / 2 - pop.width / 2;
    left = Math.min(Math.max(m, left), Math.max(m, vw - pop.width - m));

    // vertical: use the requested side, flip when it would clip off-screen
    let top = pos === 'bottom' ? rect.bottom + m : rect.top - pop.height - m;
    if (pos === 'top' && top < m) top = rect.bottom + m;
    else if (pos === 'bottom' && top + pop.height > vh - m) top = rect.top - pop.height - m;
    top = Math.min(Math.max(m, top), Math.max(m, vh - pop.height - m));

    setCoords({ left, top });
  }, [rect, pos]);

  return (
    <span
      ref={ref}
      className={`tip ${className}`}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {rect &&
        createPortal(
          <span
            ref={popRef}
            className={`tip-pop ${pos}`}
            role="tooltip"
            style={{
              left: coords?.left ?? rect.left,
              top: coords?.top ?? rect.top,
              // hide the pre-measurement frame so the bubble doesn't flash off-screen
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Standalone ⓘ marker that pops a tooltip — for rows where there's no label to underline. */
export function InfoTip({ content, pos = 'top' }: { content: ReactNode; pos?: Pos }) {
  return (
    <Tooltip content={content} pos={pos} className="tip-dot">
      <span className="tip-i" aria-label="explain">ⓘ</span>
    </Tooltip>
  );
}

export interface CalcCard {
  title: string;
  what: string; // one-line plain meaning
  formula?: string; // the calculation
  remember?: string; // memory hook
}

/** Renders a CALC card as tooltip content. */
export function TipBody({ tip }: { tip: CalcCard }) {
  return (
    <span className="tip-body">
      <b className="tip-title">{tip.title}</b>
      <span className="tip-what">{tip.what}</span>
      {tip.formula && <code className="tip-formula">{tip.formula}</code>}
      {tip.remember && (
        <span className="tip-remember">
          <b>Remember:</b> {tip.remember}
        </span>
      )}
    </span>
  );
}

// Glossary term → card, plus one combined matcher. Built once at module load.
// Longest phrases first so "worst hand that still calls" wins over "calls".
const GLOSSARY_MAP = new Map<string, CalcCard>();
for (const g of GLOSSARY) for (const t of g.terms) GLOSSARY_MAP.set(t.toLowerCase(), g.card);
const GLOSSARY_RE = new RegExp(
  '\\b(' +
    [...GLOSSARY_MAP.keys()]
      .sort((a, b) => b.length - a.length)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') +
    ')\\b',
  'gi',
);

/** Renders plain feedback text, auto-underlining any known jargon with a hover
 *  card — so beginners never hit a term with no explanation. Unmatched text is
 *  passed straight through. */
export function GlossaryText({ text, pos = 'top' }: { text: string; pos?: Pos }) {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(GLOSSARY_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const card = GLOSSARY_MAP.get(m[0].toLowerCase());
    out.push(
      card ? (
        <Tooltip key={key++} pos={pos} content={<TipBody tip={card} />} className="tip-label">
          {m[0]}
        </Tooltip>
      ) : (
        m[0]
      ),
    );
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Underlined label that pops its formula card from the registry on hover. */
export function CalcLabel({
  id,
  children,
  pos = 'top',
}: {
  id: CalcId;
  children?: ReactNode;
  pos?: Pos;
}) {
  const tip = CALC[id];
  return (
    <Tooltip pos={pos} content={<TipBody tip={tip} />} className="tip-label">
      {children ?? tip.title}
    </Tooltip>
  );
}

export type CalcId =
  | 'equity'
  | 'winTie'
  | 'potOdds'
  | 'oddsRatio'
  | 'ev'
  | 'evLoss'
  | 'outs'
  | 'ruleOf24'
  | 'potGeometry'
  | 'mdf'
  | 'riverBalance'
  | 'bb100'
  | 'evLoss100'
  | 'gtowScore'
  | 'accuracy'
  | 'rngAdherence'
  | 'netBB'
  | 'spr'
  | 'betEvFormula';

