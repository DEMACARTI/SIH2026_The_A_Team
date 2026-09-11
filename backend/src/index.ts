/**
 * Sonar telemetry hub — entry point.
 *
 * Environment:
 *   PORT            HTTP/WebSocket port (default 8080)
 *   SIM_TIMEOUT_MS  simulate after this long without real telemetry (default 5000)
 *   SIM_TICK_MS     simulated state-machine tick (default 1000)
 *   SIMULATION=off  never simulate (show "no data" instead)
 *   SERIAL_PORT     open this serial port on startup, e.g. /dev/cu.usbserial-0001
 *   SERIAL_BAUD     baud rate for SERIAL_PORT (default 115200)
 */
import path from 'node:path';
import { createServer } from './app.js';
import { CommandQueue } from './commands.js';
import { TelemetryHub } from './hub.js';
import { SerialManager } from './serial.js';

const env = (key: string, fallback: number) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const port = env('PORT', 8080);
const hub = new TelemetryHub({
  simTimeoutMs: env('SIM_TIMEOUT_MS', 5000),
  simTickMs: env('SIM_TICK_MS', 1000),
  simulationEnabled: process.env.SIMULATION !== 'off',
  historySize: 50,
  logSize: 300,
});
const serial = new SerialManager();
const queue = new CommandQueue();
const staticDir = path.resolve(import.meta.dirname, '../../frontend/dist');

const app = createServer({ hub, serial, queue, port, staticDir });
hub.start();

app.server.listen(port, '0.0.0.0', () => {
  const s = hub.status();
  console.log(`sonar hub listening on http://localhost:${port}  (ws: /ws)`);
  console.log(`  simulation fallback: ${s.simulationEnabled ? `on, after ${s.simTimeoutMs}ms without real telemetry` : 'off'}`);
  if (process.env.SERIAL_PORT) {
    serial.connect(process.env.SERIAL_PORT, env('SERIAL_BAUD', 115200)).catch((err) => {
      console.error(`could not open ${process.env.SERIAL_PORT}: ${err.message}`);
    });
  }
});

app.server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `port ${port} is already in use — set PORT=…` : err);
  process.exit(1);
});

const shutdown = async () => {
  hub.stop();
  await serial.disconnect(true);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
