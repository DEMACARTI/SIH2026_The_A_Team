import { memo, useMemo, useRef } from 'react';
import { SOURCE_LABEL } from '../format';
import { useReducedMotion } from '../hooks';
import { useStore } from '../store';
import { C } from '../theme';
import { FREQ_CHANNELS_KHZ, SNR_LOW_DB, type TelemetryMessage } from '../types';
import { Panel, StatusDot } from './ui';
import p from './panels.module.css';

/* ---------------- Scope: return amplitude vs. range ---------------- */

const N = 200;
const RANGE_MAX_M = 95;
const Y_MAX = 60; // display amplitude units (≈ dB above the display floor)
const DB_TO_Y = 1.3; // visual gain applied to SNR so small changes are visible
const TICKS_M = [0, 20, 40, 60, 80, 95];

/** Deterministic PRNG so a trace only changes when a new message arrives, not on unrelated re-renders. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noiseLevel = (t: TelemetryMessage) => 2 + Math.min(1, Math.max(0, (t.noise_floor_db - 20) / 35)) * 8;
const echoVisible = (t: TelemetryMessage) =>
  t.target_present && (t.state === 'LISTEN' || t.state === 'PROCESS' || t.state === 'ADAPT');

/** Synthesized A-scan from the telemetry scalars: noise floor, TX ring-down, and an echo at the reported range with height ∝ SNR. */
function buildTrace(t: TelemetryMessage): string {
  const rnd = mulberry32(t.seq * 7919 + t.cycle);
  const nl = noiseLevel(t);
  const echo = echoVisible(t);
  const peak = nl + Math.max(0, t.snr_db) * DB_TO_Y + 3;
  const pts: string[] = [];
  for (let i = 0; i < N; i++) {
    const r = (i / (N - 1)) * RANGE_MAX_M;
    let a = ((rnd() + rnd() + rnd()) / 3) * nl * 1.6;
    if (r < 4) a += (t.state === 'TRANSMIT' ? 52 : 22) * Math.exp(-r / 1.2) * (0.75 + 0.25 * Math.sin(i * 2.3));
    if (echo) a += peak * Math.exp(-((r - t.target_range_m) ** 2) / (2 * 0.8 ** 2)) * (0.85 + rnd() * 0.15);
    const y = 115 - (Math.min(a, Y_MAX) / Y_MAX) * 105;
    pts.push(`${i ? 'L' : 'M'}${((i / (N - 1)) * 1000).toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join('');
}

function Scope() {
  const latest = useStore((st) => st.latest);
  const reduced = useReducedMotion();
  // Phosphor persistence: keep the last few traces and fade them.
  const trail = useRef<{ seq: number; d: string }[]>([]);
  const traces = useMemo(() => {
    if (!latest) return [];
    if (trail.current[trail.current.length - 1]?.seq !== latest.seq) {
      trail.current = [...trail.current, { seq: latest.seq, d: buildTrace(latest) }].slice(-4);
    }
    return trail.current;
  }, [latest]);

  if (!latest) return <div className={p.scopeEmpty}>awaiting telemetry…</div>;

  const nl = noiseLevel(latest);
  const thresholdY = 115 - (Math.min(nl + SNR_LOW_DB * DB_TO_Y + 3, Y_MAX) / Y_MAX) * 105;
  const echo = echoVisible(latest);
  const sim = latest.source === 'simulated';

  return (
    <div className={p.scope}>
      <svg viewBox="0 0 1000 120" preserveAspectRatio="none" className={p.scopeSvg} aria-hidden>
        {TICKS_M.map((m) => {
          const x = (m / RANGE_MAX_M) * 1000;
          return <line key={m} x1={x} x2={x} y1={0} y2={120} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
        })}
        <line x1={0} x2={1000} y1={thresholdY} y2={thresholdY} stroke={C.danger} strokeDasharray="4 4" strokeWidth={1}
          vectorEffect="non-scaling-stroke" opacity={0.7} />
        {traces.map((tr, i) => {
          const current = i === traces.length - 1;
          return (
            <path key={tr.seq} d={tr.d} fill="none" stroke={C.cyan} vectorEffect="non-scaling-stroke"
              strokeWidth={current ? 1.4 : 1} opacity={current ? 0.95 : 0.08 + i * 0.07}
              strokeDasharray={sim && current ? '5 2' : undefined} />
          );
        })}
      </svg>
      {!reduced && latest.state === 'LISTEN' && <div key={latest.seq} className={p.sweep} />}
      <span className={p.threshold} style={{ top: `${(thresholdY / 120) * 100}%` }}>{SNR_LOW_DB} dB detect</span>
      {echo && (
        <span className={p.echoTag} style={{ left: `${Math.min(92, (latest.target_range_m / RANGE_MAX_M) * 100)}%` }}>
          ▼ {latest.target_range_m.toFixed(1)}m
        </span>
      )}
      <div className={p.scopeAxis}>
        {TICKS_M.map((m) => (
          <span key={m} style={{ left: `${(m / RANGE_MAX_M) * 100}%` }}>{m}m</span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Channel indicator ---------------- */

function Channels() {
  const freq = useStore((st) => st.latest?.frequency_khz);
  const lastHop = useStore((st) => {
    const h = st.history;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i].frequency !== h[i - 1].frequency && h[i].source === h[i - 1].source) {
        return `${h[i - 1].frequency}→${h[i].frequency}kHz @ #${h[i].cycle}`;
      }
    }
    return null;
  });
  return (
    <Panel title="Frequency channel" meta={lastHop ? `last hop ${lastHop}` : 'no hops yet'}>
      <div className={p.channels} role="list">
        {FREQ_CHANNELS_KHZ.map((f) => {
          const active = f === freq;
          return (
            <div key={f} role="listitem" aria-current={active} className={`${p.channel} ${active ? p.channelActive : ''}`}>
              <span>{f} kHz</span>
              {active && <StatusDot color={C.cyan} />}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ---------------- Ping history ---------------- */

const PingHistory = memo(function PingHistory() {
  const rows = useStore((st) => st.history);
  const recent = rows.slice(-8).reverse();
  return (
    <Panel title="Ping history" meta="newest first">
      <div className={p.tableWrap}>
        <table className={p.table}>
          <thead>
            <tr>
              <th>cycle</th><th>src</th><th>freq</th><th className={p.hideSm}>pulse</th><th className={p.hideSm}>gain</th>
              <th>SNR</th><th>noise</th><th>range</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((h) => (
              <tr key={h.key} className={p.row}>
                <td>#{h.cycle}</td>
                <td className={h.source === 'simulated' ? p.srcSim : p.srcReal}>{SOURCE_LABEL[h.source]}</td>
                <td>{h.frequency}k</td>
                <td className={p.hideSm}>{h.pulseWidth.toFixed(1)}ms</td>
                <td className={p.hideSm}>{h.gain}dB</td>
                <td style={{ color: h.snr < SNR_LOW_DB ? C.danger : C.cyan }}>{h.snr.toFixed(1)}dB</td>
                <td className={p.dim}>{h.noiseFloor.toFixed(1)}dB</td>
                <td>{h.range != null ? `${h.range.toFixed(1)}m` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {recent.length === 0 && <div className={p.empty}>awaiting first cycle…</div>}
      </div>
    </Panel>
  );
});

export function SignalPanel() {
  const state = useStore((st) => st.latest?.state);
  return (
    <div className={p.stack}>
      {/* The contract carries scalars, not raw samples — be upfront that the trace is reconstructed. */}
      <Panel title="Return signal — amplitude vs. range"
        meta={`reconstructed from range / SNR / noise · 0–${RANGE_MAX_M}m${state ? ` · ${state}` : ''}`}>
        <Scope />
      </Panel>
      <div className={p.sideGrid}>
        <Channels />
        <PingHistory />
      </div>
    </div>
  );
}
