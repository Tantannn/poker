// Hover/focus tooltips for every number the app computes. One reusable Tooltip
// plus a CALC registry of "how it's calculated / how to remember it" cards, so a
// formula lives in exactly one place and any panel can surface it on hover.
// Homemade portal tooltip (was antd — the app's only use, worth ~420 kB gzipped).

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CALC } from './CalConstant';

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
  const [rect, setRect] = useState<DOMRect | null>(null);

  const show = () => setRect(ref.current?.getBoundingClientRect() ?? null);
  const hide = () => setRect(null);

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
            className={`tip-pop ${pos}`}
            role="tooltip"
            style={{
              // fixed-position, clamped to the viewport; flips handled by `pos`
              left: Math.min(Math.max(8, rect.left + rect.width / 2), window.innerWidth - 8),
              top: pos === 'bottom' ? rect.bottom + 8 : rect.top - 8,
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

