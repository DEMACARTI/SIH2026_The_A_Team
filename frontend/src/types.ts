/**
 * Mirrors backend/src/contract.ts (device contract) plus the WebSocket/status
 * shapes the backend sends. Keep in sync when the contract changes.
 */

export const STATES = ['IDLE', 'TRANSMIT', 'LISTEN', 'PROCESS', 'ADAPT'] as const;
export type SonarState = (typeof STATES)[number];
export type Waveform = 'LFM_CHIRP' | 'CW_PULSE';
export type Mode = 'auto' | 'manual';
export type Source = 'serial' | 'wifi' | 'simulated';

export const FREQ_CHANNELS_KHZ = [22, 26, 30, 34, 38, 42] as const;
export const SNR_LOW_DB = 6;
export const SNR_HIGH_DB = 18;
export const NOISE_HOP_DB = 40;

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
  source: Source;
  seq: number;
  received_at: number;
}

export type Command =
  | { cmd: 'set_mode'; value: Mode }
  | { cmd: 'set_params'; frequency_khz?: number; pulse_width_ms?: number; gain_db?: number }
  | { cmd: 'trigger_ping' };

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
