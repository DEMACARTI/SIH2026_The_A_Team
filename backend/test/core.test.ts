import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandQueue } from '../src/commands.js';
import { parseCommand, parseTelemetry, type Telemetry } from '../src/contract.js';
import { TelemetryHub } from '../src/hub.js';
import { narrate } from '../src/narrate.js';
import { SonarSimulator } from '../src/simulator.js';

const sample: Telemetry = {
  state: 'TRANSMIT', cycle: 42, frequency_khz: 30, pulse_width_ms: 1.5, gain_db: 18,
  waveform: 'LFM_CHIRP', snr_db: 8.4, noise_floor_db: 34.2, target_present: true,
  target_range_m: 22.1, timestamp_ms: 1234567,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('contract', () => {
  it('accepts the documented telemetry message', () => {
    const r = parseTelemetry(sample);
    assert.ok(r.ok);
    assert.deepEqual(r.value, sample);
  });

  it('normalizes waveform/state spellings and null range', () => {
    const r = parseTelemetry({ ...sample, state: 'listen', waveform: 'CW Pulse', target_present: false, target_range_m: null });
    assert.ok(r.ok);
    assert.equal(r.value.state, 'LISTEN');
    assert.equal(r.value.waveform, 'CW_PULSE');
    assert.equal(r.value.target_range_m, 0);
  });

  it('rejects malformed telemetry with a reason', () => {
    for (const bad of [null, [], 'x', { ...sample, state: 'SLEEP' }, { ...sample, gain_db: 'high' }, { ...sample, snr_db: NaN }, { ...sample, target_present: 1 }]) {
      const r = parseTelemetry(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
  });

  it('validates, snaps and clamps commands', () => {
    assert.deepEqual(parseCommand({ cmd: 'set_mode', value: 'manual' }), { ok: true, value: { cmd: 'set_mode', value: 'manual' } });
    assert.equal(parseCommand({ cmd: 'set_mode', value: 'turbo' }).ok, false);
    assert.equal(parseCommand({ cmd: 'self_destruct' }).ok, false);
    assert.equal(parseCommand({ cmd: 'set_params' }).ok, false);
    const r = parseCommand({ cmd: 'set_params', frequency_khz: 31, pulse_width_ms: 9, gain_db: -3 });
    assert.ok(r.ok);
    assert.deepEqual(r.value, { cmd: 'set_params', frequency_khz: 30, pulse_width_ms: 5, gain_db: 0 });
  });
});

describe('simulator adaptive rules', () => {
  /** Run the sim until it reaches ADAPT with forced sensed values. */
  function adaptWith(sim: SonarSimulator, snr: number, noise: number, range = 50) {
    // Drive to PROCESS, then override what was "sensed" before the ADAPT tick.
    while (sim.state !== 'PROCESS') sim.step();
    const s = (sim as unknown as { sensed: { snr: number; noiseFloor: number; range: number; targetPresent: boolean } }).sensed;
    s.snr = snr; s.noiseFloor = noise; s.range = range; s.targetPresent = true;
    return sim.step();
  }

  it('cycles IDLE → TRANSMIT → LISTEN → PROCESS → ADAPT', () => {
    const sim = new SonarSimulator();
    assert.deepEqual([1, 2, 3, 4, 5].map(() => sim.step().state), ['TRANSMIT', 'LISTEN', 'PROCESS', 'ADAPT', 'IDLE']);
  });

  it('low SNR raises gain and pulse width, hops channel on high noise, and explains why', () => {
    const sim = new SonarSimulator();
    const t = adaptWith(sim, 3, 44);
    assert.equal(t.state, 'ADAPT');
    assert.equal(t.gain_db, 21);
    assert.equal(t.pulse_width_ms, 1.9);
    assert.equal(t.frequency_khz, 34);
    assert.match(t.log!, /SNR 3\.0dB < 6dB/);
    assert.match(t.log!, /noise 44\.0dB > 40dB → hop 30→34kHz/);
  });

  it('respects the 40dB / 5ms caps', () => {
    const sim = new SonarSimulator();
    sim.params.gain_db = 39; sim.params.pulse_width_ms = 4.9;
    let t = adaptWith(sim, 0, 30);
    assert.equal(t.gain_db, 40);
    assert.equal(t.pulse_width_ms, 5);
    t = adaptWith(sim, 0, 30);
    assert.equal(t.gain_db, 40);
    assert.equal(t.pulse_width_ms, 5);
    assert.match(t.log!, /cap/);
  });

  it('high SNR lowers gain to save power', () => {
    const sim = new SonarSimulator();
    const t = adaptWith(sim, 25, 30, 20);
    assert.equal(t.gain_db, 16);
    assert.equal(t.waveform, 'CW_PULSE');
    assert.match(t.log!, /save power/);
  });

  it('holds parameters in manual mode and applies set_params', () => {
    const sim = new SonarSimulator();
    sim.applyCommand({ cmd: 'set_mode', value: 'manual' });
    sim.applyCommand({ cmd: 'set_params', gain_db: 10, frequency_khz: 42 });
    const t = adaptWith(sim, 1, 50);
    assert.equal(t.gain_db, 10);
    assert.equal(t.frequency_khz, 42);
    assert.equal(t.mode, 'manual');
    assert.match(t.log!, /manual/);
  });

  it('trigger_ping jumps straight to TRANSMIT', () => {
    const sim = new SonarSimulator();
    sim.step(); sim.step(); // LISTEN
    sim.applyCommand({ cmd: 'trigger_ping' });
    assert.equal(sim.step().state, 'TRANSMIT');
  });
});

describe('narration', () => {
  it('infers ADAPT reasoning from parameter diffs when the device sends none', () => {
    const prev = { ...sample, state: 'PROCESS' as const, snr_db: 4 };
    const cur = { ...sample, state: 'ADAPT' as const, snr_db: 4, gain_db: 21, frequency_khz: 34, noise_floor_db: 42 };
    const line = narrate(prev, cur, 'auto')!;
    assert.equal(line.tag, 'ADAPT');
    assert.match(line.text, /SNR 4\.0dB < 6dB → gain 18→21dB, hop 30→34kHz \(noise 42\.0dB > 40dB\) \(inferred\)/);
  });

  it('uses device-supplied reasoning verbatim', () => {
    const line = narrate(null, { ...sample, state: 'ADAPT', log: 'custom reason' }, 'auto')!;
    assert.equal(line.text, 'custom reason');
  });
});

describe('command queue', () => {
  it('drains once and expires stale commands', async () => {
    const q = new CommandQueue(50);
    const a = q.enqueue({ cmd: 'trigger_ping' });
    const b = q.enqueue({ cmd: 'set_mode', value: 'auto' });
    assert.equal(b.id, a.id + 1);
    assert.equal(q.drain().length, 2);
    assert.equal(q.drain().length, 0);
    q.enqueue({ cmd: 'trigger_ping' });
    await sleep(80);
    assert.equal(q.drain().length, 0);
  });
});

describe('hub', () => {
  const opts = { simTimeoutMs: 150, simTickMs: 20, simulationEnabled: true, historySize: 50, logSize: 100 };

  it('simulates with no hardware, yields to real data, and falls back again', async () => {
    const hub = new TelemetryHub(opts);
    const sources: string[] = [];
    hub.on('telemetry', (m) => sources.push(m.source));
    hub.start();
    await sleep(70);
    assert.ok(hub.simulating);
    assert.ok(sources.length > 0 && sources.every((s) => s === 'simulated'));

    sources.length = 0;
    assert.deepEqual(hub.ingest(sample, 'wifi', '10.0.0.7'), { ok: true, duplicate: false });
    assert.equal(hub.simulating, false);
    assert.deepEqual(sources, ['wifi']);
    assert.equal(hub.status().wifi.remote, '10.0.0.7');

    await sleep(260);
    assert.ok(hub.simulating, 'falls back after the timeout');
    // The fallback continues from the device's last known state.
    assert.ok(hub.getHistory().at(-1)!.cycle >= sample.cycle);
    hub.stop();
  });

  it('drops the same message arriving over both links, and rejects bad input', () => {
    const hub = new TelemetryHub({ ...opts, simulationEnabled: false });
    assert.deepEqual(hub.ingest(sample, 'serial'), { ok: true, duplicate: false });
    assert.deepEqual(hub.ingest(sample, 'wifi'), { ok: true, duplicate: true });
    assert.equal(hub.getHistory().length, 1);
    assert.equal(hub.ingest({ nope: 1 }, 'wifi').ok, false);
  });

  it('caps the ring buffer', () => {
    const hub = new TelemetryHub({ ...opts, simulationEnabled: false, historySize: 5 });
    for (let i = 0; i < 12; i++) hub.ingest({ ...sample, cycle: i, timestamp_ms: i }, 'serial');
    assert.deepEqual(hub.getHistory().map((m) => m.cycle), [7, 8, 9, 10, 11]);
  });
});
