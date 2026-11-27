import type { ButtonHTMLAttributes } from 'react';

type Variant = 'toggle' | 'master' | 'go';

const BASE: Record<Variant, string> = {
  toggle: 'study-toggle',
  master: 'guides-master',
  go: 'btn btn-raise block-go',
};

const ACTIVE: Record<Variant, string> = {
  toggle: 'on',
  master: 'off',
  go: '',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  active?: boolean;
}

export function PanelButton({ variant = 'toggle', active = false, className = '', ...rest }: Props) {
  const classes = [BASE[variant], active && ACTIVE[variant], className].filter(Boolean).join(' ');
  return <button type="button" className={classes} {...rest} />;
}
