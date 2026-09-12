import { memo, useMemo, useRef } from 'react';
import { SOURCE_LABEL } from '../format';
import { useReducedMotion } from '../hooks';
import { useStore } from '../store';
import { C } from '../theme';
import { FREQ_CHANNELS_KHZ, isFuzzyHardware, SNR_LOW_DB, type TelemetryMessage } from '../types';
import { MembershipChart } from './FuzzyCurves';
import { SpectrogramPanel } from './Spectrogram';
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

/** Real DAC buffer captured on the last TRANSMIT — the actual generated waveform, not a reconstruction. */
function RealScope({ latest }: { latest: TelemetryMessage }) {
  const samples = latest.waveform_samples!;
  const durationMs = latest.duration_ms ?? (latest.sample_rate_hz ? (samples.length / latest.sample_rate_hz) * 1000 : samples.length);
  const N = samples.length;
  const d = useMemo(
    () => samples.map((v, i) => `${i ? 'L' : 'M'}${((i / (N - 1)) * 1000).toFixed(1)},${(115 - (v / 255) * 105).toFixed(1)}`).join(''),
    [samples, N],
  );
  const peak = Math.max(...samples.map((v) => Math.abs(v - 128)));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const sim = latest.source === 'simulated';
  return (
    <div className={p.scope}>
      <svg viewBox="0 0 1000 120" preserveAspectRatio="none" className={p.scopeSvg} aria-hidden>
        <line x1={0} x2={1000} y1={65} y2={65} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {ticks.map((f) => (
          <line key={f} x1={f * 1000} x2={f * 1000} y1={0} y2={120} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <path d={d} fill="none" stroke={C.cyan} vectorEffect="non-scaling-stroke" strokeWidth={1.4} opacity={0.95}
          strokeDasharray={sim ? '5 2' : undefined} />
      </svg>
      <span className={p.echoTag} style={{ left: '4%' }}>peak ±{peak}/128</span>
      <div className={p.scopeAxis}>
        {ticks.map((f) => (
          <span key={f} style={{ left: `${f * 100}%` }}>{(f * durationMs).toFixed(0)}ms</span>
        ))}
      </div>
    </div>
  );
}

function Scope() {
  const latest = useStore((st) => st.latest);
  // Real hardware only transmits (and sends samples) on a ping — the store remembers the last
  // burst (across status frames, and a page refresh via the `hello` history replay) so the scope
  // doesn't go blank between transmits.
  const lastBurst = useStore((st) => st.lastBurst);
  const reduced = useReducedMotion();
  // Phosphor persistence: keep the last few traces and fade them.
  const trail = useRef<{ seq: number; d: string }[]>([]);
  const traces = useMemo(() => {
    if (!latest || latest.waveform_samples || isFuzzyHardware(latest)) return [];
    if (trail.current[trail.current.length - 1]?.seq !== latest.seq) {
      trail.current = [...trail.current, { seq: latest.seq, d: buildTrace(latest) }].slice(-4);
    }
    return trail.current;
  }, [latest]);

  if (!latest) return <div className={p.scopeEmpty}>awaiting telemetry…</div>;

  // Real hardware: the last TRANSMIT frame carries the actual generated DAC buffer.
  if (isFuzzyHardware(latest)) {
    return lastBurst
      ? <RealScope latest={lastBurst} />
      : <div className={p.scopeEmpty}>awaiting first transmit — trigger a ping to capture the real burst…</div>;
  }

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

/* ---------------- Waveform formation: computed sweep/phase shape ---------------- */

const FREQ_MIN_KHZ = 10;   // matches firmware's `freqMin` / fuzzy-simulator's FREQ_MIN
const CARRIER_KHZ = 30;    // matches firmware's phase-coded `carrier`
const PHASE_PATTERN = [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0]; // matches firmware exactly

/**
 * The commanded shape for the CURRENT parameters, computed from the exact same
 * formulas the firmware/simulator use to generate the burst — not measured, and
 * updates live every tick (even between transmits) as sensor readings move the
 * commanded top frequency / duration. Distinct from RealScope, which plots
 * actual captured samples from the last transmit only.
 */
function formationTrace(waveform: TelemetryMessage['waveform'], topFreqKhz: number, durationMs: number) {
  const n = 80;
  const isPhase = waveform === 'PHASE_CODED';
  const pts: { t: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    let v: number;
    if (isPhase) {
      const seg = Math.min(PHASE_PATTERN.length - 1, Math.floor(frac * PHASE_PATTERN.length));
      v = PHASE_PATTERN[seg];
    } else if (waveform === 'GEOMETRIC_SWEEP') {
      v = FREQ_MIN_KHZ * (topFreqKhz / FREQ_MIN_KHZ) ** frac;
    } else if (waveform === 'CW_PULSE') {
      v = topFreqKhz;
    } else {
      v = FREQ_MIN_KHZ + (topFreqKhz - FREQ_MIN_KHZ) * frac; // LFM_CHIRP: linear ramp
    }
    pts.push({ t: frac * durationMs, v });
  }
  return { pts, isPhase };
}

function WaveformFormation() {
  const latest = useStore((st) => st.latest);
  const { pts, isPhase, durationMs, waveform } = useMemo(() => {
    if (!latest) return { pts: [], isPhase: false, durationMs: 0, waveform: undefined };
    const durationMs = latest.duration_ms ?? latest.pulse_width_ms;
    const { pts, isPhase } = formationTrace(latest.waveform, latest.frequency_khz, durationMs);
    return { pts, isPhase, durationMs, waveform: latest.waveform };
  }, [latest?.waveform, latest?.frequency_khz, latest?.duration_ms, latest?.pulse_width_ms]);

  if (!latest || pts.length === 0) return null;

  const vMax = isPhase ? 1 : Math.max(FREQ_MIN_KHZ, latest.frequency_khz, CARRIER_KHZ) * 1.08;
  const coords = pts.map((pt) => [
    (pt.t / Math.max(durationMs, 1)) * 1000,
    isPhase ? (pt.v ? 14 : 56) : 60 - (pt.v / vMax) * 50,
  ]);
  const d = coords.map(([px, py], i) => {
    if (i === 0) return `M${px.toFixed(1)},${py.toFixed(1)}`;
    // Step function (phase): hold the previous value out to this x, then jump — a clean square wave.
    const prefix = isPhase ? `L${px.toFixed(1)},${coords[i - 1][1].toFixed(1)} ` : '';
    return `${prefix}L${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(' ');

  return (
    <div className={p.formation}>
      <div className={p.formationHead}>
        <span>Commanded {isPhase ? 'phase pattern' : 'frequency sweep'}</span>
        <span className={p.dim}>computed from waveform + parameters, not measured</span>
      </div>
      <svg viewBox="0 0 1000 70" preserveAspectRatio="none" className={p.formationSvg} aria-hidden>
        {isPhase ? (
          <>
            <line x1={0} x2={1000} y1={14} y2={14} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} x2={1000} y1={56} y2={56} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </>
        ) : (
          <line x1={0} x2={1000} y1={60} y2={60} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
        <path d={d} fill="none" stroke={waveform && STATE_ACCENT_FOR(waveform)} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={p.formationAxis}>
        <span>0ms</span>
        <span className={p.dim}>
          {isPhase ? '0° / 180°' : `${FREQ_MIN_KHZ}–${Math.round(vMax / 1.08)}kHz`}
        </span>
        <span>{durationMs.toFixed(0)}ms</span>
      </div>
    </div>
  );
}

const STATE_ACCENT_FOR = (w: TelemetryMessage['waveform']) => (w === 'PHASE_CODED' ? C.amber : C.cyan);

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

/* ---------------- Fuzzy mode selection (real hardware) ---------------- */

const MODE_LABELS: Record<'lfm' | 'geo' | 'phase', string> = { lfm: 'LFM chirp', geo: 'Geometric sweep', phase: 'Phase-coded' };

function Bar({ label, value, active }: { label: string; value: number; active?: boolean }) {
  return (
    <div className={p.fuzzyBar}>
      <span className={p.fuzzyBarLabel}>{label}</span>
      <div className={p.fuzzyBarTrack}>
        <div className={p.fuzzyBarFill} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: active ? C.cyan : C.textFaint }} />
      </div>
      <span className={p.fuzzyBarValue}>{value.toFixed(2)}</span>
    </div>
  );
}

function FuzzyModePanel() {
  const fuzzy = useStore((st) => st.latest?.fuzzy);
  const sensorRaw = useStore((st) => st.latest?.sensor_raw);
  const waveform = useStore((st) => st.latest?.waveform);
  if (!fuzzy) return (
    <Panel title="Fuzzy mode selection" meta="turbidity / depth / temperature"><div className={p.empty}>awaiting telemetry…</div></Panel>
  );
  const winner = (Object.entries(fuzzy.scores) as ['lfm' | 'geo' | 'phase', number][]).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return (
    <Panel title="Fuzzy mode selection" meta="live membership — moves as the readings do">
      <MembershipChart title="Turbidity" value={sensorRaw?.turbidity_adc} degrees={fuzzy.turbidity} labels={['low', 'med', 'high']} />
      <MembershipChart title="Depth" value={sensorRaw?.depth_adc} degrees={fuzzy.depth} labels={['low', 'med', 'high']} />
      <MembershipChart title="Temperature" value={sensorRaw?.temp_adc}
        degrees={{ low: fuzzy.temperature.cold, med: fuzzy.temperature.normal, high: fuzzy.temperature.warm }}
        labels={['cold', 'normal', 'warm']} />
      <div className={p.fuzzyGroup}>
        <span className={p.subhead}>Mode scores {waveform && <span className={p.dim}>(active: {waveformLabelShort(waveform)})</span>}</span>
        <Bar label="LFM" value={fuzzy.scores.lfm} active={winner === 'lfm'} />
        <Bar label="Geo" value={fuzzy.scores.geo} active={winner === 'geo'} />
        <Bar label="Phase" value={fuzzy.scores.phase} active={winner === 'phase'} />
      </div>
    </Panel>
  );
}

function waveformLabelShort(w: TelemetryMessage['waveform']): string {
  return w === 'LFM_CHIRP' ? MODE_LABELS.lfm : w === 'GEOMETRIC_SWEEP' ? MODE_LABELS.geo : w === 'PHASE_CODED' ? MODE_LABELS.phase : w;
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
              <th>cycle</th><th>src</th><th>freq</th><th className={p.hideSm}>pulse</th><th className={p.hideSm}>amp</th>
              <th>SNR / mode</th><th>noise / turb</th><th>range</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((h) => (
              <tr key={h.key} className={p.row}>
                <td>#{h.cycle}</td>
                <td className={h.source === 'simulated' ? p.srcSim : p.srcReal}>{SOURCE_LABEL[h.source]}</td>
                <td>{h.frequency}k</td>
                <td className={p.hideSm}>{h.pulseWidth.toFixed(1)}ms</td>
                <td className={p.hideSm}>{h.gain}{h.rxAvailable ? 'dB' : ''}</td>
                {h.rxAvailable ? (
                  <>
                    <td style={{ color: h.snr < SNR_LOW_DB ? C.danger : C.cyan }}>{h.snr.toFixed(1)}dB</td>
                    <td className={p.dim}>{h.noiseFloor.toFixed(1)}dB</td>
                    <td>{h.range != null ? `${h.range.toFixed(1)}m` : '—'}</td>
                  </>
                ) : (
                  <>
                    <td style={{ color: C.cyan }}>{waveformLabelShort2(h)}</td>
                    <td className={p.dim}>{h.sensorRaw ? h.sensorRaw.turbidity_adc : '—'}</td>
                    <td className={p.dim}>—</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {recent.length === 0 && <div className={p.empty}>awaiting first cycle…</div>}
      </div>
    </Panel>
  );
});

function waveformLabelShort2(h: { fuzzy?: TelemetryMessage['fuzzy'] }): string {
  if (!h.fuzzy) return '—';
  const winner = (Object.entries(h.fuzzy.scores) as ['lfm' | 'geo' | 'phase', number][]).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return winner.toUpperCase();
}

export function SignalPanel() {
  const state = useStore((st) => st.latest?.state);
  const fuzzy = useStore((st) => isFuzzyHardware(st.latest));
  const hasSamples = useStore((st) => !!st.lastBurst);
  return (
    <div className={p.stack}>
      {/* Real samples when the connected hardware sends them; otherwise the contract carries scalars, so say so. */}
      <Panel title="Return signal"
        meta={fuzzy
          ? (hasSamples ? 'REAL — captured ESP32 DAC buffer' : 'real hardware — no burst captured yet')
          : `reconstructed from range / SNR / noise · 0–${RANGE_MAX_M}m${state ? ` · ${state}` : ''}`}>
        <Scope />
        <WaveformFormation />
        {fuzzy && <SpectrogramPanel />}
      </Panel>
      <div className={p.sideGrid}>
        {fuzzy ? <FuzzyModePanel /> : <Channels />}
        <PingHistory />
      </div>
    </div>
  );
}
