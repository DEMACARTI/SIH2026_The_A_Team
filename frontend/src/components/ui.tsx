import type { ReactNode } from 'react';
import s from './ui.module.css';

export function Panel({ title, meta, children, className }: {
  title?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${s.panel} ${className ?? ''}`}>
      {title && (
        <header className={s.panelHead}>
          <h2 className={s.panelTitle} style={{ margin: 0 }}>{title}</h2>
          {meta && <span className={s.panelMeta}>{meta}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatusDot({ color, blink = false, title }: { color?: string; blink?: boolean; title?: string }) {
  return (
    <span
      className={`${s.dot} ${blink ? s.dotBlink : ''}`}
      title={title}
      style={color ? { background: color, boxShadow: `0 0 6px ${color}` } : undefined}
    />
  );
}

export function Toggle({ checked, onChange, onLabel, offLabel, disabled, label }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  onLabel: string;
  offLabel: string;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`${s.toggle} ${checked ? s.toggleOn : ''}`}
    >
      <span className={`${s.toggleSeg} ${checked ? s.toggleSegActive : ''}`}>{onLabel}</span>
      <span className={`${s.toggleSeg} ${!checked ? s.toggleSegActiveAlt : ''}`}>{offLabel}</span>
    </button>
  );
}

export { s as ui };
