import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandQueue } from '../src/commands.js';
import { parseCommand, parseTelemetry, type Telemetry } from '../src/contract.js';
import { FuzzySimulator } from '../src/fuzzy-simulator.js';
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

  it('validates set_waveform_mode, normalizing spelling like telemetry', () => {
    const r = parseCommand({ cmd: 'set_waveform_mode', value: 'geometric sweep' });
    assert.deepEqual(r, { ok: true, value: { cmd: 'set_waveform_mode', value: 'GEOMETRIC_SWEEP' } });
    assert.equal(parseCommand({ cmd: 'set_waveform_mode', value: 'nonsense' }).ok, false);
  });

  const fuzzyReal = {
    state: 'TRANSMIT' as const, cycle: 3, frequency_khz: 34, pulse_width_ms: 120, gain_db: 76,
    waveform: 'PHASE_CODED' as const, timestamp_ms: 555, rx_available: false,
    fuzzy: {
      turbidity: { low: 0, med: 0.2, high: 0.8 }, depth: { low: 1, med: 0, high: 0 },
      temperature: { cold: 0, normal: 1, warm: 0 }, scores: { lfm: 0.1, geo: 0.05, phase: 0.85 },
    },
    sensor_raw: { temp_adc: 2048, depth_adc: 512, turbidity_adc: 3800 },
    waveform_samples: [128, 200, 60, 128],
    sample_rate_hz: 160000, duration_ms: 120,
  };

  it('accepts real TX-only hardware telemetry: no RX fields, fuzzy + sensor + samples present', () => {
    const r = parseTelemetry(fuzzyReal);
    assert.ok(r.ok);
    assert.equal(r.value.rx_available, false);
    assert.equal(r.value.snr_db, 0);
    assert.equal(r.value.target_present, false);
    assert.deepEqual(r.value.fuzzy, fuzzyReal.fuzzy);
    assert.deepEqual(r.value.sensor_raw, fuzzyReal.sensor_raw);
    assert.deepEqual(r.value.waveform_samples, fuzzyReal.waveform_samples);
  });

  it('rejects RX-chain telemetry missing snr/noise/target unless rx_available is false', () => {
    const { snr_db, noise_floor_db, target_present, target_range_m, ...noRx } = sample;
    assert.equal(parseTelemetry(noRx).ok, false);
    const r = parseTelemetry({ ...noRx, rx_available: false });
    assert.ok(r.ok);
    assert.equal(r.value.snr_db, 0);
  });

  it('drops a malformed fuzzy/sensor_raw/waveform_samples block instead of rejecting the whole message', () => {
    const r = parseTelemetry({ ...sample, fuzzy: { turbidity: { low: 'nope' } }, sensor_raw: { temp_adc: 1 }, waveform_samples: ['x'] });
    assert.ok(r.ok);
    assert.equal(r.value.fuzzy, undefined);
    assert.equal(r.value.sensor_raw, undefined);
    assert.equal(r.value.waveform_samples, undefined);
  });

  it('accepts a spectrogram grid (from the ADC-loopback FFT monitor, once wired)', () => {
    const grid = { freq_step_hz: 781.25, frame_step_ms: 8, frames: [[0, 10, 255], [1, 20, 200]] };
    const r = parseTelemetry({ ...sample, spectrogram: grid });
    assert.ok(r.ok);
    assert.deepEqual(r.value.spectrogram, grid);
  });

  it('drops a spectrogram with jagged rows or an oversized grid instead of rejecting the message', () => {
    const jagged = parseTelemetry({ ...sample, spectrogram: { freq_step_hz: 1, frame_step_ms: 1, frames: [[1, 2], [1]] } });
    assert.ok(jagged.ok);
    assert.equal(jagged.value.spectrogram, undefined);

    const empty = parseTelemetry({ ...sample, spectrogram: { freq_step_hz: 1, frame_step_ms: 1, frames: [] } });
    assert.ok(empty.ok);
    assert.equal(empty.value.spectrogram, undefined);
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

  it('set_waveform_mode forces the waveform directly', () => {
    const sim = new SonarSimulator();
    sim.applyCommand({ cmd: 'set_waveform_mode', value: 'PHASE_CODED' });
    assert.equal(sim.params.waveform, 'PHASE_CODED');
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

  it('narrates fuzzy mode selection for real TX-only hardware with no SNR loop', () => {
    const cur = {
      ...sample, state: 'ADAPT' as const, rx_available: false,
      fuzzy: {
        turbidity: { low: 0, med: 0.1, high: 0.9 }, depth: { low: 1, med: 0, high: 0 },
        temperature: { cold: 0, normal: 1, warm: 0 }, scores: { lfm: 0.05, geo: 0.1, phase: 0.9 },
      },
    };
    const line = narrate(null, cur, 'auto')!;
    assert.equal(line.tag, 'ADAPT');
    assert.match(line.text, /turbidity high \(0\.90\)/);
    assert.match(line.text, /→ phase-coded \[LFM 0\.05, Geo 0\.10, Phase 0\.90\]/);
  });
});

describe('fuzzy simulator (fake-device --fuzzy)', () => {
  it('produces a well-formed telemetry frame that the real contract accepts', () => {
    const sim = new FuzzySimulator();
    const r = parseTelemetry(sim.step());
    assert.ok(r.ok);
    assert.equal(r.value.rx_available, false);
  });

  it('only attaches a spectrogram when explicitly asked, and it validates against the real contract', () => {
    const sim = new FuzzySimulator();
    const plain = parseTelemetry(sim.transmit(false));
    assert.ok(plain.ok);
    assert.equal(plain.value.spectrogram, undefined);

    const withSpec = parseTelemetry(sim.transmit(true));
    assert.ok(withSpec.ok);
    assert.ok(withSpec.value.spectrogram);
    assert.ok(withSpec.value.spectrogram!.frames.length > 0);
    const binCount = withSpec.value.spectrogram!.frames[0].length;
    assert.ok(withSpec.value.spectrogram!.frames.every((f) => f.length === binCount));
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
