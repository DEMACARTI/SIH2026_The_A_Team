/**
 * Device <-> app data contract. This file is the seam between the ESP32
 * firmware and everything else — keep it in sync with
 * firmware/sonar_tx/sonar_tx.ino and frontend/src/types.ts.
 */

export const STATES = ['IDLE', 'TRANSMIT', 'LISTEN', 'PROCESS', 'ADAPT'] as const;
export type SonarState = (typeof STATES)[number];

export const WAVEFORMS = ['LFM_CHIRP', 'CW_PULSE'] as const;
export type Waveform = (typeof WAVEFORMS)[number];

export const FREQ_CHANNELS_KHZ = [22, 26, 30, 34, 38, 42] as const;

export const LIMITS = {
  gainDb: { min: 0, max: 40 },
  pulseWidthMs: { min: 0.5, max: 5 },
} as const;

export type Mode = 'auto' | 'manual';
export type Source = 'serial' | 'wifi' | 'simulated';

/** Telemetry message, device -> app. One JSON object per line (serial) or per POST body (WiFi). */
export interface Telemetry {
  state: SonarState;
  cycle: number;
  frequency_khz: number;
  pulse_width_ms: number;
  gain_db: number;
  waveform: Waveform;
  snr_db: number;
  noise_floor_db: number;
  target_present: boolean;
  target_range_m: number;
  timestamp_ms: number;
  /** Optional extension: the device's current operating mode. */
  mode?: Mode;
  /** Optional extension: human-readable reasoning for this step (used for the ADAPT decision log). */
  log?: string;
}

/** Telemetry after ingestion: tagged with where it came from. */
export interface TelemetryMessage extends Telemetry {
  source: Source;
  seq: number;
  received_at: number;
}

/** Command message, app -> device. */
export type Command =
  | { cmd: 'set_mode'; value: Mode }
  | { cmd: 'set_params'; frequency_khz?: number; pulse_width_ms?: number; gain_db?: number }
  | { cmd: 'trigger_ping' };

/** A command as delivered to the device. `id` lets a device on both links drop duplicates. */
export type QueuedCommand = Command & { id: number };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const nearestChannel = (khz: number): number =>
  FREQ_CHANNELS_KHZ.reduce((best, c) => (Math.abs(c - khz) < Math.abs(best - khz) ? c : best), FREQ_CHANNELS_KHZ[0]);

/** Accepts `LFM_CHIRP`, `lfm chirp`, `LFM-Chirp`, … */
function normalizeWaveform(v: unknown): Waveform | undefined {
  if (typeof v !== 'string') return undefined;
  const w = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (WAVEFORMS as readonly string[]).includes(w) ? (w as Waveform) : undefined;
}

function normalizeState(v: unknown): SonarState | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  return (STATES as readonly string[]).includes(s) ? (s as SonarState) : undefined;
}

export function parseTelemetry(raw: unknown): Result<Telemetry> {
  if (!isObj(raw)) return { ok: false, error: 'telemetry must be a JSON object' };

  const state = normalizeState(raw.state);
  if (!state) return { ok: false, error: `invalid state ${JSON.stringify(raw.state)}` };
  const waveform = normalizeWaveform(raw.waveform);
  if (!waveform) return { ok: false, error: `invalid waveform ${JSON.stringify(raw.waveform)}` };
  if (typeof raw.target_present !== 'boolean') return { ok: false, error: 'target_present must be a boolean' };

  const numeric = ['cycle', 'frequency_khz', 'pulse_width_ms', 'gain_db', 'snr_db', 'noise_floor_db', 'timestamp_ms'] as const;
  const values: Partial<Record<(typeof numeric)[number], number>> = {};
  for (const key of numeric) {
    const v = num(raw[key]);
    if (v === undefined) return { ok: false, error: `${key} must be a finite number` };
    values[key] = v;
  }
  // A device with no target may send null/omit the range.
  const range = raw.target_range_m == null ? 0 : num(raw.target_range_m);
  if (range === undefined) return { ok: false, error: 'target_range_m must be a number or null' };

  const t: Telemetry = {
    state,
    cycle: Math.trunc(values.cycle!),
    frequency_khz: values.frequency_khz!,
    pulse_width_ms: values.pulse_width_ms!,
    gain_db: values.gain_db!,
    waveform,
    snr_db: values.snr_db!,
    noise_floor_db: values.noise_floor_db!,
    target_present: raw.target_present,
    target_range_m: range,
    timestamp_ms: values.timestamp_ms!,
  };
  if (raw.mode === 'auto' || raw.mode === 'manual') t.mode = raw.mode;
  if (typeof raw.log === 'string' && raw.log.trim()) t.log = raw.log.trim().slice(0, 400);
  return { ok: true, value: t };
}

export function parseCommand(raw: unknown): Result<Command> {
  if (!isObj(raw)) return { ok: false, error: 'command must be a JSON object' };
  switch (raw.cmd) {
    case 'set_mode':
      if (raw.value !== 'auto' && raw.value !== 'manual') return { ok: false, error: 'set_mode value must be "auto" or "manual"' };
      return { ok: true, value: { cmd: 'set_mode', value: raw.value } };
    case 'set_params': {
      const out: Extract<Command, { cmd: 'set_params' }> = { cmd: 'set_params' };
      const f = num(raw.frequency_khz);
      const pw = num(raw.pulse_width_ms);
      const g = num(raw.gain_db);
      if (raw.frequency_khz !== undefined && f === undefined) return { ok: false, error: 'frequency_khz must be a number' };
      if (raw.pulse_width_ms !== undefined && pw === undefined) return { ok: false, error: 'pulse_width_ms must be a number' };
      if (raw.gain_db !== undefined && g === undefined) return { ok: false, error: 'gain_db must be a number' };
      if (f === undefined && pw === undefined && g === undefined) return { ok: false, error: 'set_params needs at least one parameter' };
      // Snap/clamp to what the hardware can actually do.
      if (f !== undefined) out.frequency_khz = nearestChannel(f);
      if (pw !== undefined) out.pulse_width_ms = Math.round(clamp(pw, LIMITS.pulseWidthMs.min, LIMITS.pulseWidthMs.max) * 10) / 10;
      if (g !== undefined) out.gain_db = Math.round(clamp(g, LIMITS.gainDb.min, LIMITS.gainDb.max));
      return { ok: true, value: out };
    }
    case 'trigger_ping':
      return { ok: true, value: { cmd: 'trigger_ping' } };
    default:
      return { ok: false, error: `unknown cmd ${JSON.stringify(raw.cmd)}` };
  }
}

export function describeCommand(c: Command): string {
  switch (c.cmd) {
    case 'set_mode':
      return `set_mode ${c.value}`;
    case 'set_params': {
      const parts: string[] = [];
      if (c.frequency_khz !== undefined) parts.push(`freq=${c.frequency_khz}kHz`);
      if (c.pulse_width_ms !== undefined) parts.push(`pulse=${c.pulse_width_ms.toFixed(1)}ms`);
      if (c.gain_db !== undefined) parts.push(`gain=${c.gain_db}dB`);
      return `set_params ${parts.join(' ')}`;
    }
    case 'trigger_ping':
      return 'trigger_ping';
  }
}
