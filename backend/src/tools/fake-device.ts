/**
 * Fake ESP32: speaks the exact device contract using the same simulation engine,
 * but through the REAL ingestion paths, so the dashboard shows it as live data.
 * Use it to test WiFi/serial plumbing without hardware.
 *
 *   npm run fake-device -- --wifi [http://localhost:8080]
 *   npm run fake-device -- --serial /dev/cu.usbserial-XXXX [--baud 115200]
 *   add --garbage to inject malformed lines/bodies now and then
 */
import { SerialPort } from 'serialport';
import { parseCommand, type QueuedCommand } from '../contract.js';
import { SonarSimulator } from '../simulator.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
};

const sim = new SonarSimulator();
const garbage = flag('garbage');
const seen: number[] = [];

function apply(raw: unknown) {
  const c = parseCommand(raw);
  if (!c.ok) return console.warn(`  ! ignored command: ${c.error}`);
  const id = (raw as Partial<QueuedCommand>).id;
  if (typeof id === 'number') {
    if (seen.includes(id)) return; // already applied via the other link
    seen.push(id);
    if (seen.length > 16) seen.shift();
  }
  console.log(`  ← ${JSON.stringify(raw)}  → ${sim.applyCommand(c.value)}`);
}

if (flag('wifi')) {
  const base = (opt('wifi') ?? 'http://localhost:8080').replace(/\/$/, '');
  console.log(`fake device → WiFi mode, posting to ${base}/api/telemetry`);
  setInterval(async () => {
    const t = sim.step();
    const body = garbage && Math.random() < 0.1 ? '{"state": "TRANSMIT", oops' : JSON.stringify(t);
    try {
      const res = await fetch(`${base}/api/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      console.log(`→ ${t.state.padEnd(8)} cycle ${t.cycle}  ${res.status}`);
    } catch (err) {
      console.warn(`→ POST failed: ${(err as Error).message}`);
    }
  }, 1000);
  setInterval(async () => {
    try {
      const res = await fetch(`${base}/api/commands/pending`);
      const { commands } = (await res.json()) as { commands: unknown[] };
      commands.forEach(apply);
    } catch { /* backend down — keep trying */ }
  }, 500);
} else if (opt('serial')) {
  const path = opt('serial')!;
  const baudRate = Number(opt('baud') ?? 115200);
  const port = new SerialPort({ path, baudRate });
  console.log(`fake device → serial mode on ${path} @ ${baudRate}`);
  let buf = '';
  port.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { apply(JSON.parse(line)); } catch { console.warn(`  ! bad command line: ${line}`); }
    }
  });
  setInterval(() => {
    const t = sim.step();
    if (garbage && Math.random() < 0.1) port.write('{"state":"LIS\n');
    port.write(JSON.stringify(t) + '\n');
    if (t.state === 'IDLE') port.write(`# heap ok, cycle ${t.cycle}\n`);
  }, 1000);
} else {
  console.log('usage: npm run fake-device -- --wifi [url] | --serial <path> [--baud N] [--garbage]');
  process.exit(1);
}
