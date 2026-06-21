// Hover/focus tooltips for every number the app computes. One reusable Tooltip
// plus a CALC registry of "how it's calculated / how to remember it" cards, so a
// formula lives in exactly one place and any panel can surface it on hover.

import type { ReactNode } from 'react';
import { Tooltip as AntTooltip } from 'antd';
import { CALC } from './CalConstant';

type Pos = 'top' | 'bottom';

/** Generic tooltip: wraps any trigger node, pops `content` on hover/focus.
 *  Uses antd's portal-rendered Tooltip so it never clips inside narrow panels. */
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
  return (
    <AntTooltip
      title={content}
      placement={pos === 'bottom' ? 'bottom' : 'top'}
      color="#0a120e"
      styles={{ root: { maxWidth: 300 } }}
    >
      <span className={`tip ${className}`} tabIndex={0}>
        {children}
      </span>
    </AntTooltip>
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
  | 'spr';

