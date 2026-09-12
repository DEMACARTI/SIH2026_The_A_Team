/**
 * Device <-> app data contract. This file is the seam between the ESP32
 * firmware and everything else — keep it in sync with
 * firmware/sonar_tx/sonar_tx.ino and frontend/src/types.ts.
 */

export const STATES = ['IDLE', 'TRANSMIT', 'LISTEN', 'PROCESS', 'ADAPT'] as const;
export type SonarState = (typeof STATES)[number];

export const WAVEFORMS = ['LFM_CHIRP', 'CW_PULSE', 'GEOMETRIC_SWEEP', 'PHASE_CODED'] as const;
export type Waveform = (typeof WAVEFORMS)[number];

export const FREQ_CHANNELS_KHZ = [22, 26, 30, 34, 38, 42] as const;

export const LIMITS = {
  gainDb: { min: 0, max: 40 },
  pulseWidthMs: { min: 0.5, max: 5 },
} as const;

export type Mode = 'auto' | 'manual';
export type Source = 'serial' | 'wifi' | 'simulated';

/**
 * Fuzzy environmental mode-selection data (real hardware extension). The real
 * TX-only board has no receive chain — it picks a waveform from turbidity /
 * depth / temperature sensors via fuzzy logic instead of an SNR feedback loop.
 * Mirrors the `fuzzify()` / `evaluateFuzzyMode()` membership + score values in
 * firmware/sonar_tx/sonar_tx.ino.
 */
export interface FuzzyState {
  turbidity: { low: number; med: number; high: number };
  depth: { low: number; med: number; high: number };
  temperature: { cold: number; normal: number; warm: number };
  scores: { lfm: number; geo: number; phase: number };
}

/** Raw ADC readings (0-4095) from the temp/depth/turbidity sensors. */
export interface SensorRaw {
  temp_adc: number;
  depth_adc: number;
  turbidity_adc: number;
}

/**
 * On-device FFT spectrogram of the transmitted analog wave, sampled through a
 * DAC-output-to-ADC-input loopback (through the analog conditioning circuit,
 * once built) — validates the real transmitted signal, not the digital buffer
 * that generated it. `frames[t][bin]` is a quantized (0-255) magnitude; time
 * runs frame 0 -> last, frequency runs bin 0 (DC) -> last (Nyquist).
 */
export interface Spectrogram {
  /** Hz per frequency bin (bin i ~ i * freq_step_hz). */
  freq_step_hz: number;
  /** ms per time frame. */
  frame_step_ms: number;
  frames: number[][];
}

/** Telemetry message, device -> app. One JSON object per line (serial) or per POST body (WiFi). */
export interface Telemetry {
  state: SonarState;
  cycle: number;
  frequency_khz: number;
  pulse_width_ms: number;
  gain_db: number;
  waveform: Waveform;
  /**
   * The next four fields describe a receive/echo chain. The real TX-only
   * board has none, defaults to 0/false, and marks `rx_available: false` so
   * the UI can say "n/a" instead of showing a fabricated measurement.
   */
  snr_db: number;
  noise_floor_db: number;
  target_present: boolean;
  target_range_m: number;
  timestamp_ms: number;
  /** Optional extension: the device's current operating mode. */
  mode?: Mode;
  /** Optional extension: human-readable reasoning for this step (used for the ADAPT decision log). */
  log?: string;
  /** Optional extension: false on hardware with no receive/echo sensing (see above). Default true. */
  rx_available?: boolean;
  /** Optional extension: fuzzy mode-selection state (real hardware only). */
  fuzzy?: FuzzyState;
  /** Optional extension: raw sensor ADC readings (real hardware only). */
  sensor_raw?: SensorRaw;
  /** Optional extension: decimated real DAC waveform buffer, 0-255, sent on TRANSMIT. */
  waveform_samples?: number[];
  /** Optional extension: sample rate the waveform was generated at, for the samples' time axis. */
  sample_rate_hz?: number;
  /** Optional extension: real burst duration in ms (may differ from pulse_width_ms's usual meaning). */
  duration_ms?: number;
  /** Optional extension: on-device FFT spectrogram of the transmitted wave, from an ADC loopback (real hardware only, once wired). */
  spectrogram?: Spectrogram;
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
  | { cmd: 'trigger_ping' }
  /** Discrete waveform-mode override for the real fuzzy-logic hardware (no continuous freq/pulse/gain control). */
  | { cmd: 'set_waveform_mode'; value: Waveform };

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

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const membership01 = (v: unknown): number | undefined => (isFiniteNum(v) ? clamp(v, -0.05, 1.05) : undefined);

/** `{low,med,high}` or `{cold,normal,warm}` — same shape, different key names. */
function parseTriple(raw: unknown, keys: readonly [string, string, string]): [number, number, number] | undefined {
  if (!isObj(raw)) return undefined;
  const [a, b, c] = keys.map((k) => membership01(raw[k]));
  return a === undefined || b === undefined || c === undefined ? undefined : [a, b, c];
}

/** Fuzzy mode-selection state (real hardware only). Malformed/absent → dropped, not a rejection of the whole message. */
function parseFuzzy(raw: unknown): FuzzyState | undefined {
  if (!isObj(raw)) return undefined;
  const turb = parseTriple(raw.turbidity, ['low', 'med', 'high']);
  const depth = parseTriple(raw.depth, ['low', 'med', 'high']);
  const temp = parseTriple(raw.temperature, ['cold', 'normal', 'warm']);
  const scores = isObj(raw.scores)
    ? ([membership01(raw.scores.lfm), membership01(raw.scores.geo), membership01(raw.scores.phase)] as const)
    : undefined;
  if (!turb || !depth || !temp || !scores || scores.some((v) => v === undefined)) return undefined;
  return {
    turbidity: { low: turb[0], med: turb[1], high: turb[2] },
    depth: { low: depth[0], med: depth[1], high: depth[2] },
    temperature: { cold: temp[0], normal: temp[1], warm: temp[2] },
    scores: { lfm: scores[0]!, geo: scores[1]!, phase: scores[2]! },
  };
}

const ADC_MAX = 4095;
function parseSensorRaw(raw: unknown): SensorRaw | undefined {
  if (!isObj(raw)) return undefined;
  const temp = num(raw.temp_adc), depth = num(raw.depth_adc), turb = num(raw.turbidity_adc);
  if (temp === undefined || depth === undefined || turb === undefined) return undefined;
  const c = (v: number) => Math.round(clamp(v, 0, ADC_MAX));
  return { temp_adc: c(temp), depth_adc: c(depth), turbidity_adc: c(turb) };
}

const MAX_WAVEFORM_SAMPLES = 1024;
function parseWaveformSamples(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WAVEFORM_SAMPLES) return undefined;
  const out: number[] = [];
  for (const v of raw) {
    if (!isFiniteNum(v)) return undefined;
    out.push(Math.round(clamp(v, 0, 255)));
  }
  return out;
}

const MAX_SPECTROGRAM_FRAMES = 64;
const MAX_SPECTROGRAM_BINS = 256;
function parseSpectrogram(raw: unknown): Spectrogram | undefined {
  if (!isObj(raw)) return undefined;
  const freqStep = num(raw.freq_step_hz);
  const frameStep = num(raw.frame_step_ms);
  if (freqStep === undefined || frameStep === undefined || !Array.isArray(raw.frames)) return undefined;
  if (raw.frames.length === 0 || raw.frames.length > MAX_SPECTROGRAM_FRAMES) return undefined;
  const frames: number[][] = [];
  const binCount = Array.isArray(raw.frames[0]) ? raw.frames[0].length : -1;
  if (binCount <= 0 || binCount > MAX_SPECTROGRAM_BINS) return undefined;
  for (const frame of raw.frames) {
    // Every frame must share the same bin count — a jagged array isn't a valid spectrogram grid.
    if (!Array.isArray(frame) || frame.length !== binCount) return undefined;
    const bins: number[] = [];
    for (const v of frame) {
      if (!isFiniteNum(v)) return undefined;
      bins.push(Math.round(clamp(v, 0, 255)));
    }
    frames.push(bins);
  }
  return { freq_step_hz: freqStep, frame_step_ms: frameStep, frames };
}

export function parseTelemetry(raw: unknown): Result<Telemetry> {
  if (!isObj(raw)) return { ok: false, error: 'telemetry must be a JSON object' };

  const state = normalizeState(raw.state);
  if (!state) return { ok: false, error: `invalid state ${JSON.stringify(raw.state)}` };
  const waveform = normalizeWaveform(raw.waveform);
  if (!waveform) return { ok: false, error: `invalid waveform ${JSON.stringify(raw.waveform)}` };

  const numeric = ['cycle', 'frequency_khz', 'pulse_width_ms', 'gain_db', 'timestamp_ms'] as const;
  const values: Partial<Record<(typeof numeric)[number], number>> = {};
  for (const key of numeric) {
    const v = num(raw[key]);
    if (v === undefined) return { ok: false, error: `${key} must be a finite number` };
    values[key] = v;
  }

  // Receive/echo fields: hardware with no RX chain omits these and sets rx_available: false
  // instead of faking a measurement. Default to neutral values so the rest of the pipeline
  // (charts, ring buffer) doesn't need to special-case an absent field.
  const rxAvailable = raw.rx_available === false ? false : true;
  let snrDb = 0, noiseFloorDb = 0, targetPresent = false, targetRangeM = 0;
  if (rxAvailable) {
    const snr = num(raw.snr_db);
    if (snr === undefined) return { ok: false, error: 'snr_db must be a finite number (or set rx_available: false)' };
    const noise = num(raw.noise_floor_db);
    if (noise === undefined) return { ok: false, error: 'noise_floor_db must be a finite number (or set rx_available: false)' };
    if (typeof raw.target_present !== 'boolean') return { ok: false, error: 'target_present must be a boolean (or set rx_available: false)' };
    const range = raw.target_range_m == null ? 0 : num(raw.target_range_m);
    if (range === undefined) return { ok: false, error: 'target_range_m must be a number or null' };
    snrDb = snr; noiseFloorDb = noise; targetPresent = raw.target_present; targetRangeM = range;
  }

  const t: Telemetry = {
    state,
    cycle: Math.trunc(values.cycle!),
    frequency_khz: values.frequency_khz!,
    pulse_width_ms: values.pulse_width_ms!,
    gain_db: values.gain_db!,
    waveform,
    snr_db: snrDb,
    noise_floor_db: noiseFloorDb,
    target_present: targetPresent,
    target_range_m: targetRangeM,
    timestamp_ms: values.timestamp_ms!,
  };
  if (!rxAvailable) t.rx_available = false;
  if (raw.mode === 'auto' || raw.mode === 'manual') t.mode = raw.mode;
  if (typeof raw.log === 'string' && raw.log.trim()) t.log = raw.log.trim().slice(0, 400);

  const fuzzy = parseFuzzy(raw.fuzzy);
  if (fuzzy) t.fuzzy = fuzzy;
  const sensorRaw = parseSensorRaw(raw.sensor_raw);
  if (sensorRaw) t.sensor_raw = sensorRaw;
  const samples = parseWaveformSamples(raw.waveform_samples);
  if (samples) {
    t.waveform_samples = samples;
    const sr = num(raw.sample_rate_hz);
    if (sr !== undefined) t.sample_rate_hz = sr;
    const dur = num(raw.duration_ms);
    if (dur !== undefined) t.duration_ms = dur;
  }
  const spectrogram = parseSpectrogram(raw.spectrogram);
  if (spectrogram) t.spectrogram = spectrogram;
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
    case 'set_waveform_mode': {
      const w = normalizeWaveform(raw.value);
      if (!w) return { ok: false, error: `set_waveform_mode value must be one of ${WAVEFORMS.join(', ')}` };
      return { ok: true, value: { cmd: 'set_waveform_mode', value: w } };
    }
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
    case 'set_waveform_mode':
      return `set_waveform_mode ${c.value}`;
  }
}
