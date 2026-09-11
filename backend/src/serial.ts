/**
 * USB serial transport. Splits the byte stream into lines, hands JSON lines to
 * the hub, tolerates garbage (boot ROM output, wrong baud rate, partial lines),
 * and survives the cable being pulled: an unexpected close switches to
 * `reconnecting` and the same port is re-opened as soon as it reappears.
 */
import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';

export type SerialState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface SerialStatus {
  state: SerialState;
  path: string | null;
  baudRate: number | null;
  error: string | null;
  linesReceived: number;
  invalidLines: number;
  lastLineAgoMs: number | null;
  /** Port is open but the device has gone quiet (hung, resetting, wrong baud). */
  silent: boolean;
}

export interface PortSummary {
  path: string;
  label: string;
  /** USB-UART bridge chips commonly found on ESP32 dev boards. */
  likelyEsp32: boolean;
  isUsb: boolean;
}

type SerialEvents = {
  /** A line that parsed as JSON. */
  json: [unknown];
  /** A non-JSON line (device debug output). */
  text: [string];
  info: [string];
  warn: [string];
  change: [];
};

const MAX_LINE = 4096;
const RETRY_MS = 2000;
const SILENT_MS = 3000;
const WARN_INTERVAL_MS = 2000;
// CP210x, CH340/CH9102, Espressif native USB, FTDI
const ESP32_VENDORS = new Set(['10c4', '1a86', '303a', '0403']);

export class SerialManager extends EventEmitter<SerialEvents> {
  private port: SerialPort | null = null;
  private buf = '';
  private state: SerialState = 'disconnected';
  private path: string | null = null;
  private baudRate: number | null = null;
  private error: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private openedAt = 0;
  private silent = false;
  private linesReceived = 0;
  private invalidLines = 0;
  private lastLineAt: number | null = null;
  private lastWarnAt = 0;
  private suppressedWarnings = 0;

  get connected(): boolean {
    return this.state === 'connected';
  }

  status(): SerialStatus {
    return {
      state: this.state,
      path: this.path,
      baudRate: this.baudRate,
      error: this.error,
      linesReceived: this.linesReceived,
      invalidLines: this.invalidLines,
      lastLineAgoMs: this.lastLineAt ? Date.now() - this.lastLineAt : null,
      silent: this.silent,
    };
  }

  async list(): Promise<PortSummary[]> {
    const ports = await SerialPort.list();
    return ports
      .map((p) => {
        const vid = p.vendorId?.toLowerCase();
        const isUsb = !!vid;
        const name = p.manufacturer ?? (isUsb ? 'USB serial' : 'system port');
        // macOS: /dev/tty.* blocks on open waiting for carrier detect; /dev/cu.* is the one to use.
        const path = process.platform === 'darwin' ? p.path.replace(/^\/dev\/tty\./, '/dev/cu.') : p.path;
        return {
          path,
          label: `${path} — ${name}${vid ? ` [${vid}:${p.productId ?? '?'}]` : ''}`,
          likelyEsp32: !!vid && ESP32_VENDORS.has(vid),
          isUsb,
        };
      })
      .sort((a, b) => Number(b.likelyEsp32) - Number(a.likelyEsp32) || Number(b.isUsb) - Number(a.isUsb) || a.path.localeCompare(b.path));
  }

  async connect(path: string, baudRate: number): Promise<void> {
    await this.disconnect(true);
    this.path = path;
    this.baudRate = baudRate;
    this.linesReceived = 0;
    this.invalidLines = 0;
    this.lastLineAt = null;
    this.setState('connecting', null);
    try {
      await this.open();
      this.emit('info', `serial connected: ${path} @ ${baudRate} baud`);
    } catch (err) {
      this.path = null;
      this.setState('disconnected', (err as Error).message);
      throw err;
    }
  }

  /** User-initiated disconnect: no auto-reconnect. */
  async disconnect(silent = false): Promise<void> {
    this.clearRetry();
    this.stopProbe();
    const port = this.port;
    this.port = null;
    if (port?.isOpen) {
      port.removeAllListeners('close');
      await new Promise<void>((res) => port.close(() => res()));
    }
    if (this.state !== 'disconnected') {
      if (!silent) this.emit('info', `serial disconnected${this.path ? `: ${this.path}` : ''}`);
      this.path = null;
      this.setState('disconnected', null);
    }
  }

  /** Write one command as a JSON line. Returns false if no port is open. */
  write(obj: unknown): boolean {
    if (!this.port?.isOpen || this.state !== 'connected') return false;
    this.port.write(JSON.stringify(obj) + '\n'); // failures surface via the port's 'error'/'close' events
    return true;
  }

  /** Called when a JSON line didn't match the telemetry contract. */
  reportInvalid(reason: string, line: string): void {
    this.invalidLines += 1;
    this.warnThrottled(`serial: skipped invalid line (${reason}): ${line.slice(0, 80)}${line.length > 80 ? '…' : ''}`);
  }

  private open(): Promise<void> {
    const path = this.path!;
    const port = new SerialPort({ path, baudRate: this.baudRate!, autoOpen: false });
    return new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) return reject(err);
        this.port = port;
        this.buf = '';
        this.openedAt = Date.now();
        this.silent = false;
        port.on('data', (chunk: Buffer) => this.onData(chunk));
        port.on('error', (e) => this.warnThrottled(`serial error: ${e.message}`));
        // 'close' can fire more than once for one failure; only react for the current port.
        port.on('close', (e?: Error & { disconnected?: boolean }) => {
          if (this.port === port) this.onUnexpectedClose(e);
        });
        this.startProbe();
        this.setState('connected', null);
        resolve();
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
    if (this.buf.length > MAX_LINE) {
      this.buf = '';
      this.invalidLines += 1;
      this.warnThrottled(`serial: discarded ${MAX_LINE}+ bytes with no newline — wrong baud rate?`);
    }
  }

  private onLine(line: string): void {
    this.linesReceived += 1;
    this.lastLineAt = Date.now();
    if (this.silent) {
      this.silent = false;
      this.emit('info', 'serial data resumed');
      this.emit('change');
    }
    if (line.startsWith('{')) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        this.reportInvalid('malformed JSON', line);
        return;
      }
      this.emit('json', obj);
      return;
    }
    // Printable text only — boot ROM noise at the wrong baud is binary junk.
    const text = line.replace(/[^\x20-\x7E]/g, '');
    if (text.length >= line.length * 0.8 && text.length > 0) this.emit('text', text.replace(/^#\s*/, ''));
    else this.reportInvalid('non-text bytes', text);
  }

  /**
   * Some failures (device hung, PTY closed, flaky hub) never raise a 'close'.
   * Once the line goes quiet, write an empty line (firmware ignores it): on a
   * dead port the write fails, which triggers 'close' → reconnect.
   */
  private startProbe(): void {
    this.stopProbe();
    this.probeTimer = setInterval(() => {
      if (!this.port?.isOpen || this.state !== 'connected') return;
      const quietFor = Date.now() - (this.lastLineAt ?? this.openedAt);
      if (quietFor < SILENT_MS) return;
      if (!this.silent) {
        this.silent = true;
        this.emit('warn', `serial port open but no data for ${(quietFor / 1000).toFixed(0)}s — device hung/resetting, or wrong baud rate?`);
        this.emit('change');
      }
      this.port.write('\n');
    }, 1000);
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  private onUnexpectedClose(err?: Error & { disconnected?: boolean }): void {
    this.port = null;
    this.stopProbe();
    this.silent = false;
    if (!this.path) return;
    const reason = err?.disconnected ? 'device unplugged' : err?.message ?? 'port closed';
    this.emit('warn', `serial link lost (${reason}) — retrying ${this.path} every ${RETRY_MS / 1000}s`);
    this.setState('reconnecting', reason);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.clearRetry();
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.state !== 'reconnecting' || !this.path) return;
      try {
        await this.open(); // fails fast (ENOENT) while the device is still unplugged
        this.emit('info', `serial link restored: ${this.path}`);
      } catch {
        this.scheduleRetry();
      }
    }, RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setState(state: SerialState, error: string | null): void {
    this.state = state;
    this.error = error;
    this.emit('change');
  }

  private warnThrottled(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) {
      this.suppressedWarnings += 1;
      return;
    }
    const extra = this.suppressedWarnings ? ` (+${this.suppressedWarnings} similar suppressed)` : '';
    this.suppressedWarnings = 0;
    this.lastWarnAt = now;
    this.emit('warn', msg + extra);
  }
}
