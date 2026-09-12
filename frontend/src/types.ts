/**
 * Mirrors backend/src/contract.ts (device contract) plus the WebSocket/status
 * shapes the backend sends. Keep in sync when the contract changes.
 */

export const STATES = ['IDLE', 'TRANSMIT', 'LISTEN', 'PROCESS', 'ADAPT'] as const;
export type SonarState = (typeof STATES)[number];
export type Waveform = 'LFM_CHIRP' | 'CW_PULSE' | 'GEOMETRIC_SWEEP' | 'PHASE_CODED';
export type Mode = 'auto' | 'manual';
export type Source = 'serial' | 'wifi' | 'simulated';

export const FREQ_CHANNELS_KHZ = [22, 26, 30, 34, 38, 42] as const;
export const SNR_LOW_DB = 6;
export const SNR_HIGH_DB = 18;
export const NOISE_HOP_DB = 40;

/** Mirrors backend/src/contract.ts FuzzyState — real fuzzy-logic TX hardware, no SNR feedback loop. */
export interface FuzzyState {
  turbidity: { low: number; med: number; high: number };
  depth: { low: number; med: number; high: number };
  temperature: { cold: number; normal: number; warm: number };
  scores: { lfm: number; geo: number; phase: number };
}

export interface SensorRaw {
  temp_adc: number;
  depth_adc: number;
  turbidity_adc: number;
}

/** On-device FFT spectrogram of the transmitted wave via a DAC->ADC loopback (once wired). */
export interface Spectrogram {
  freq_step_hz: number;
  frame_step_ms: number;
  /** frames[t][bin], magnitude 0-255. Time: frame 0 -> last. Frequency: bin 0 (DC) -> last (Nyquist). */
  frames: number[][];
}

export interface TelemetryMessage {
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
  mode?: Mode;
  log?: string;
  /** false on hardware with no receive/echo chain — snr/noise/range above are placeholders, not measurements. */
  rx_available?: boolean;
  fuzzy?: FuzzyState;
  sensor_raw?: SensorRaw;
  waveform_samples?: number[];
  sample_rate_hz?: number;
  duration_ms?: number;
  spectrogram?: Spectrogram;
  source: Source;
  seq: number;
  received_at: number;
}

export type Command =
  | { cmd: 'set_mode'; value: Mode }
  | { cmd: 'set_params'; frequency_khz?: number; pulse_width_ms?: number; gain_db?: number }
  | { cmd: 'trigger_ping' }
  | { cmd: 'set_waveform_mode'; value: Waveform };

/** True for the real fuzzy-logic TX-only board (no SNR/echo sensing) — the single discriminator the UI branches on. */
export const isFuzzyHardware = (t: TelemetryMessage | null | undefined): boolean => t?.rx_available === false;

export type LogTag = 'TX' | 'RX' | 'PROC' | 'ADAPT' | 'MANUAL' | 'CMD' | 'LINK' | 'SYS' | 'DEV' | 'WARN';

export interface LogEntry {
  id: number;
  t: number;
  tag: LogTag;
  text: string;
  source?: Source;
}

export type SerialState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface Status {
  simulated: boolean;
  simulationEnabled: boolean;
  simTimeoutMs: number;
  lastRealSource: 'serial' | 'wifi' | null;
  lastRealAgoMs: number | null;
  wifi: { online: boolean; lastTelemetryAgoMs: number | null; remote: string | null };
  commandedMode: Mode;
  serial: {
    state: SerialState;
    path: string | null;
    baudRate: number | null;
    error: string | null;
    linesReceived: number;
    invalidLines: number;
    lastLineAgoMs: number | null;
    silent: boolean;
  };
  wifiPoll: { lastPollAgoMs: number; remote: string } | null;
  pendingCommands: number;
  lanAddresses: string[];
  port: number;
}

export interface PortSummary {
  path: string;
  label: string;
  likelyEsp32: boolean;
  isUsb: boolean;
}

export type ServerMessage =
  | { type: 'hello'; status: Status; history: TelemetryMessage[]; log: LogEntry[] }
  | { type: 'telemetry'; data: TelemetryMessage }
  | { type: 'log'; entry: LogEntry }
  | { type: 'status'; status: Status };
