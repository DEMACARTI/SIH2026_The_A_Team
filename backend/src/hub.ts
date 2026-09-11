/**
 * TelemetryHub: the single normalized stream. Serial and WiFi ingestion both
 * feed `ingest()`; the simulation fallback feeds `publish()` directly. Every
 * message is tagged with its source, kept in a ring buffer, narrated into the
 * console log, and emitted for WebSocket broadcast.
 */
import { EventEmitter } from 'node:events';
import { parseTelemetry, type Mode, type Source, type Telemetry, type TelemetryMessage } from './contract.js';
import { narrate, type LogEntry, type LogTag } from './narrate.js';
import { SonarSimulator } from './simulator.js';

export interface HubOptions {
  /** Start simulating after this long without real telemetry. */
  simTimeoutMs: number;
  simTickMs: number;
  simulationEnabled: boolean;
  historySize: number;
  logSize: number;
}

export interface StreamStatus {
  simulated: boolean;
  simulationEnabled: boolean;
  simTimeoutMs: number;
  lastRealSource: 'serial' | 'wifi' | null;
  /** ms since the last real (non-simulated) telemetry, or null if none ever. */
  lastRealAgoMs: number | null;
  wifi: { online: boolean; lastTelemetryAgoMs: number | null; remote: string | null };
  commandedMode: Mode;
}

type HubEvents = {
  telemetry: [TelemetryMessage];
  log: [LogEntry];
  change: [];
};

const DEDUPE_WINDOW_MS = 3000;

export class TelemetryHub extends EventEmitter<HubEvents> {
  readonly sim = new SonarSimulator();
  commandedMode: Mode = 'auto';

  private history: TelemetryMessage[] = [];
  private logs: LogEntry[] = [];
  private seq = 0;
  private logId = 0;
  private prev: Telemetry | null = null;
  private lastReal: { at: number; source: 'serial' | 'wifi' } | null = null;
  private lastWifi: { at: number; remote: string | null } | null = null;
  private wifiOnline = false;
  private simTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private recent = new Map<string, number>();

  constructor(readonly opts: HubOptions) {
    super();
  }

  get simulating(): boolean {
    return this.simTimer !== null;
  }

  start(): void {
    this.log('SYS', 'telemetry hub online');
    this.watchdog = setInterval(() => this.checkLinks(), 250);
    this.checkLinks();
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.stopSim(null);
  }

  /** Ingest one raw telemetry object from a real device. */
  ingest(raw: unknown, source: 'serial' | 'wifi', remote?: string): { ok: true; duplicate: boolean } | { ok: false; error: string } {
    const parsed = parseTelemetry(raw);
    if (!parsed.ok) return parsed;
    const t = parsed.value;
    const now = Date.now();

    if (source === 'wifi') this.lastWifi = { at: now, remote: remote ?? null };

    // A device connected over both USB and WiFi sends every message twice.
    for (const [k, at] of this.recent) if (now - at > DEDUPE_WINDOW_MS) this.recent.delete(k);
    const key = `${t.cycle}|${t.timestamp_ms}|${t.state}`;
    if (this.recent.has(key)) return { ok: true, duplicate: true };
    this.recent.set(key, now);

    this.lastReal = { at: now, source };
    if (this.simulating) this.stopSim(source);
    this.publish(t, source);
    this.checkLinks();
    return { ok: true, duplicate: false };
  }

  publish(t: Telemetry, source: Source): TelemetryMessage {
    const mode = t.mode ?? this.commandedMode;
    const msg: TelemetryMessage = { ...t, mode, source, seq: ++this.seq, received_at: Date.now() };
    this.history.push(msg);
    if (this.history.length > this.opts.historySize) this.history.shift();
    this.emit('telemetry', msg);

    const line = narrate(this.prev, t, mode);
    if (line) this.log(line.tag, line.text, source);
    this.prev = t;
    return msg;
  }

  log(tag: LogTag, text: string, source?: Source): LogEntry {
    const entry: LogEntry = { id: ++this.logId, t: Date.now(), tag, text, ...(source ? { source } : {}) };
    this.logs.push(entry);
    if (this.logs.length > this.opts.logSize) this.logs.shift();
    this.emit('log', entry);
    return entry;
  }

  getHistory(): TelemetryMessage[] {
    return [...this.history];
  }

  getLogs(limit = this.opts.logSize): LogEntry[] {
    return this.logs.slice(-limit);
  }

  status(): StreamStatus {
    const now = Date.now();
    return {
      simulated: this.simulating,
      simulationEnabled: this.opts.simulationEnabled,
      simTimeoutMs: this.opts.simTimeoutMs,
      lastRealSource: this.lastReal?.source ?? null,
      lastRealAgoMs: this.lastReal ? now - this.lastReal.at : null,
      wifi: {
        online: this.wifiOnline,
        lastTelemetryAgoMs: this.lastWifi ? now - this.lastWifi.at : null,
        remote: this.lastWifi?.remote ?? null,
      },
      commandedMode: this.commandedMode,
    };
  }

  /** Watchdog: WiFi online/offline edges and the simulation fallback. */
  private checkLinks(): void {
    const now = Date.now();
    const wifiOnline = !!this.lastWifi && now - this.lastWifi.at < this.opts.simTimeoutMs;
    if (wifiOnline !== this.wifiOnline) {
      this.wifiOnline = wifiOnline;
      this.log('LINK', wifiOnline
        ? `WiFi telemetry online${this.lastWifi?.remote ? ` from ${this.lastWifi.remote}` : ''}`
        : `WiFi telemetry lost — nothing for ${(this.opts.simTimeoutMs / 1000).toFixed(1)}s`);
      this.emit('change');
    }

    if (!this.opts.simulationEnabled || this.simulating) return;
    const quietFor = this.lastReal ? now - this.lastReal.at : Infinity;
    if (quietFor >= this.opts.simTimeoutMs) this.startSim(quietFor);
  }

  private startSim(quietFor: number): void {
    // Carry on from the device's last known state rather than resetting.
    if (this.prev && this.lastReal) this.sim.seedFrom(this.prev);
    this.sim.mode = this.prev?.mode ?? this.commandedMode;
    this.log('LINK', Number.isFinite(quietFor)
      ? `no device telemetry for ${(quietFor / 1000).toFixed(1)}s — streaming SIMULATED data`
      : 'no device connected — streaming SIMULATED data until real telemetry arrives');
    this.simTimer = setInterval(() => this.publish(this.sim.step(this.opts.simTickMs), 'simulated'), this.opts.simTickMs);
    this.emit('change');
  }

  private stopSim(source: 'serial' | 'wifi' | null): void {
    if (!this.simTimer) return;
    clearInterval(this.simTimer);
    this.simTimer = null;
    this.prev = null; // don't diff real params against simulated ones
    if (source) this.log('LINK', `real telemetry on ${source} — simulation stopped`);
    this.emit('change');
  }
}
