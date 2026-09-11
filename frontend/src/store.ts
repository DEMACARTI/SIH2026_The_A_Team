/**
 * Tiny external store. Components subscribe with a selector and re-render only
 * when the selected value changes, so a telemetry tick updates the readouts,
 * the active chart and the console — not the whole page.
 */
import { useRef, useSyncExternalStore } from 'react';
import type { LogEntry, ServerMessage, Source, Status, TelemetryMessage } from './types';

export const HISTORY_CAP = 40;
export const LOG_CAP = 250;

/** One point per ping cycle, updated in place as the cycle's states arrive. */
export interface HistoryPoint {
  key: string;
  cycle: number;
  source: Source;
  frequency: number;
  gain: number;
  pulseWidth: number;
  snr: number;
  noiseFloor: number;
  range: number | null;
}

export type WsState = 'connecting' | 'open' | 'closed';

export interface AppState {
  ws: { state: WsState; retryAt: number | null; attempt: number };
  status: Status | null;
  latest: TelemetryMessage | null;
  history: HistoryPoint[];
  log: LogEntry[];
}

let state: AppState = {
  ws: { state: 'connecting', retryAt: null, attempt: 0 },
  status: null,
  latest: null,
  history: [],
  log: [],
};

const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ state: AppState; value: T } | null>(null);
  const getSnapshot = () => {
    const c = cache.current;
    if (c && c.state === state) return c.value;
    const value = selector(state);
    if (c && equal(c.value, value)) {
      c.state = state;
      return c.value;
    }
    cache.current = { state, value };
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot);
}

export const shallowEqual = <T extends object>(a: T, b: T) =>
  Object.keys(a).length === Object.keys(b).length &&
  (Object.keys(a) as (keyof T)[]).every((k) => Object.is(a[k], b[k]));

/* ---------------- reducers for server messages ---------------- */

function toPoint(t: TelemetryMessage): HistoryPoint {
  return {
    key: `${t.source}:${t.cycle}`,
    cycle: t.cycle,
    source: t.source,
    frequency: t.frequency_khz,
    gain: t.gain_db,
    pulseWidth: t.pulse_width_ms,
    snr: t.snr_db,
    noiseFloor: t.noise_floor_db,
    range: t.target_present ? t.target_range_m : null,
  };
}

function upsertPoint(history: HistoryPoint[], t: TelemetryMessage): HistoryPoint[] {
  const p = toPoint(t);
  const last = history[history.length - 1];
  if (last && last.key === p.key) return [...history.slice(0, -1), p];
  const next = [...history, p];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}

export function applyServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'hello': {
      let history: HistoryPoint[] = [];
      for (const t of msg.history) history = upsertPoint(history, t);
      setState({
        status: msg.status,
        latest: msg.history[msg.history.length - 1] ?? null,
        history,
        log: msg.log.slice(-LOG_CAP),
      });
      break;
    }
    case 'telemetry':
      setState({ latest: msg.data, history: upsertPoint(state.history, msg.data) });
      break;
    case 'log': {
      const log = [...state.log, msg.entry];
      setState({ log: log.length > LOG_CAP ? log.slice(log.length - LOG_CAP) : log });
      break;
    }
    case 'status':
      setState({ status: msg.status });
      break;
  }
}
