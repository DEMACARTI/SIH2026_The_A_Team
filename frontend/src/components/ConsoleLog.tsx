import { memo, useLayoutEffect, useRef } from 'react';
import { fmtClock, SOURCE_LABEL } from '../format';
import { useStore } from '../store';
import { C } from '../theme';
import type { LogEntry, LogTag } from '../types';
import s from './shell.module.css';

const TAG_COLOR: Record<LogTag, string> = {
  ADAPT: C.amber,
  MANUAL: C.text,
  CMD: C.text,
  LINK: C.text,
  TX: C.cyan,
  RX: C.cyan,
  PROC: C.textMuted,
  SYS: C.textMuted,
  DEV: C.textMuted,
  WARN: C.danger,
};

const Line = memo(function Line({ e }: { e: LogEntry }) {
  return (
    <div className={s.line}>
      <span className={s.lineTime}>{fmtClock(e.t)}</span>
      <span className={`${s.lineSrc} ${e.source === 'simulated' ? s.lineSrcSim : ''}`}>{e.source ? SOURCE_LABEL[e.source] : 'hub'}</span>
      <span className={s.lineText} style={{ color: TAG_COLOR[e.tag] }}>[{e.tag}] {e.text}</span>
    </div>
  );
});

export function ConsoleLog() {
  const log = useStore((st) => st.log);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Auto-scroll only while the operator is at the bottom — scrolling up to read holds the view.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <section aria-label="Console log">
      <div className={s.consoleHead}>
        <span>Serial console</span>
        <span className={s.consoleMeta}>{log.length} lines · scroll up to pause</span>
      </div>
      <div ref={ref} className={s.console} onScroll={onScroll} role="log" aria-live="off">
        {log.map((e) => <Line key={e.id} e={e} />)}
        {log.length === 0 && <div style={{ color: C.textFaint }}>waiting for the telemetry hub…</div>}
      </div>
    </section>
  );
}
