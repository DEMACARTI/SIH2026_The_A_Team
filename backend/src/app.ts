/**
 * HTTP API + WebSocket broadcast. See README.md for the endpoint reference.
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { describeCommand, parseCommand, type Command } from './contract.js';
import type { CommandQueue } from './commands.js';
import type { TelemetryHub } from './hub.js';
import type { SerialManager } from './serial.js';

export interface AppDeps {
  hub: TelemetryHub;
  serial: SerialManager;
  queue: CommandQueue;
  port: number;
  /** Built frontend to serve (frontend/dist). Optional in dev, where Vite serves it. */
  staticDir?: string;
}

const HELLO_LOG_LINES = 150;
const STATUS_HEARTBEAT_MS = 1000;
const WS_PING_MS = 15_000;
const MAX_WS_BUFFER = 1_000_000;

const cleanIp = (ip?: string) => (ip ?? '').replace(/^::ffff:/, '') || 'unknown';

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

export function createServer({ hub, serial, queue, port, staticDir }: AppDeps) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  let lastPoll: { at: number; remote: string } | null = null;
  let lastWifiWarnAt = 0;

  const status = () => ({
    ...hub.status(),
    serial: serial.status(),
    wifiPoll: lastPoll ? { lastPollAgoMs: Date.now() - lastPoll.at, remote: lastPoll.remote } : null,
    pendingCommands: queue.size,
    lanAddresses: lanAddresses(),
    port,
  });

  /* ---------------- WebSocket broadcast ---------------- */

  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) {
      // Skip clients that can't keep up rather than buffering unboundedly.
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_WS_BUFFER) ws.send(data);
    }
  };

  let statusQueued = false;
  const pushStatus = () => {
    if (statusQueued) return;
    statusQueued = true;
    queueMicrotask(() => {
      statusQueued = false;
      broadcast({ type: 'status', status: status() });
    });
  };

  hub.on('telemetry', (data) => broadcast({ type: 'telemetry', data }));
  hub.on('log', (entry) => broadcast({ type: 'log', entry }));
  hub.on('change', pushStatus);
  serial.on('change', pushStatus);

  const heartbeat = setInterval(pushStatus, STATUS_HEARTBEAT_MS);

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', () => ws.terminate());
    ws.send(JSON.stringify({
      type: 'hello',
      status: status(),
      history: hub.getHistory(),
      log: hub.getLogs(HELLO_LOG_LINES),
    }));
  });
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
  }, WS_PING_MS);

  /* ---------------- Serial → hub ---------------- */

  serial.on('json', (obj) => {
    const r = hub.ingest(obj, 'serial');
    if (!r.ok) serial.reportInvalid(r.error, JSON.stringify(obj));
  });
  serial.on('text', (text) => hub.log('DEV', text, 'serial'));
  serial.on('info', (msg) => hub.log('LINK', msg));
  serial.on('warn', (msg) => hub.log('WARN', msg));

  /* ---------------- Commands ---------------- */

  function dispatch(cmd: Command) {
    const queued = queue.enqueue(cmd);
    const delivered = { serial: serial.write(queued), wifiQueue: true, simulator: false };
    if (cmd.cmd === 'set_mode') hub.commandedMode = cmd.value;
    let effect = '';
    if (hub.simulating) {
      effect = hub.sim.applyCommand(cmd);
      delivered.simulator = true;
    }
    const routes = [delivered.serial && 'serial', 'wifi queue', delivered.simulator && 'simulator'].filter(Boolean);
    hub.log('CMD', `${describeCommand(cmd)} → ${routes.join(' + ')}${effect ? ` — ${effect}` : ''}`);
    pushStatus();
    return { id: queued.id, delivered };
  }

  /* ---------------- REST API ---------------- */

  app.use(express.json({ limit: '16kb', type: ['application/json', 'text/plain'] }));

  app.get('/api/status', (_req, res) => {
    res.json(status());
  });

  app.get('/api/history', (_req, res) => {
    res.json({ history: hub.getHistory(), log: hub.getLogs() });
  });

  app.get('/api/ports', async (_req, res) => {
    try {
      res.json({ ports: await serial.list() });
    } catch (err) {
      res.status(500).json({ error: `could not list serial ports: ${(err as Error).message}` });
    }
  });

  app.post('/api/connect', async (req, res) => {
    const { port: portPath, baudRate = 115200 } = req.body ?? {};
    if (typeof portPath !== 'string' || !portPath) return void res.status(400).json({ error: '"port" is required' });
    const baud = Number(baudRate);
    if (!Number.isInteger(baud) || baud < 300 || baud > 4_000_000) return void res.status(400).json({ error: 'invalid baudRate' });
    try {
      await serial.connect(portPath, baud);
      res.json({ ok: true, status: status() });
    } catch (err) {
      const msg = (err as Error).message;
      hub.log('WARN', `serial connect to ${portPath} failed: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  app.post('/api/disconnect', async (_req, res) => {
    await serial.disconnect();
    res.json({ ok: true, status: status() });
  });

  // WiFi ingestion: same schema as a serial line, one object per POST.
  app.post('/api/telemetry', (req, res) => {
    const remote = cleanIp(req.ip);
    const r = hub.ingest(req.body, 'wifi', remote);
    if (!r.ok) {
      if (Date.now() - lastWifiWarnAt > 2000) {
        lastWifiWarnAt = Date.now();
        hub.log('WARN', `wifi: rejected telemetry from ${remote}: ${r.error}`);
      }
      return void res.status(400).json({ error: r.error });
    }
    res.json({ ok: true, duplicate: r.duplicate, pending: queue.size });
  });

  app.post('/api/commands', (req, res) => {
    const parsed = parseCommand(req.body);
    if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
    res.json({ ok: true, ...dispatch(parsed.value) });
  });

  app.get('/api/commands/pending', (req, res) => {
    lastPoll = { at: Date.now(), remote: cleanIp(req.ip) };
    res.json({ commands: queue.drain() });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // Malformed JSON bodies land here instead of crashing or returning HTML.
  app.use((err: Error & { status?: number; type?: string }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (req.path === '/api/telemetry') hub.log('WARN', `wifi: unparseable body from ${cleanIp(req.ip)}: ${err.message}`);
    res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'invalid JSON body' : err.message });
  });

  return {
    server,
    async close() {
      clearInterval(heartbeat);
      clearInterval(pinger);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
