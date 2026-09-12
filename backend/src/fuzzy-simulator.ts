/**
 * Software twin of the real TX-only board (firmware/sonar_tx/sonar_tx.ino): same
 * fuzzy-logic mode selection and Hann-windowed waveform generation, so `npm run
 * fake-device -- --fuzzy` can exercise the whole pipeline — including the real
 * waveform_samples scope and fuzzy trend charts — without hardware connected.
 *
 * Mirrors the firmware's math closely enough to be a useful stand-in; it is not
 * a byte-for-byte port (no pots/buttons/DAC here, just the same formulas).
 */
import type { Command, FuzzyState, Mode, SensorRaw, Telemetry, Waveform } from './contract.js';

const MODE_NAMES: Waveform[] = ['LFM_CHIRP', 'GEOMETRIC_SWEEP', 'PHASE_CODED'];
const SAMPLE_RATE = 160_000;
const SCOPE_POINTS = 200;
const FREQ_MIN = 10_000;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function triangularMF(x: number, a: number, b: number, c: number): number {
  if (x <= a || x >= c) return 0;
  if (x === b) return 1;
  return x < b ? (x - a) / (b - a) : (c - x) / (c - b);
}

function fuzzify(value: number): { low: number; med: number; high: number } {
  return {
    low: triangularMF(value, -2048, 0, 2048),
    med: triangularMF(value, 0, 2048, 4095),
    high: triangularMF(value, 2048, 4095, 6143),
  };
}

function hann(index: number, total: number): number {
  return total <= 1 ? 1 : 0.5 * (1 - Math.cos((2 * Math.PI * index) / (total - 1)));
}

/** Real burst shape — same math as the firmware's generateLFM/Geometric/PhaseCoded. */
function generateBuffer(mode: number, durationMs: number, topFreq: number, ampScale: number): number[] {
  const n = Math.round((SAMPLE_RATE / 1000) * durationMs);
  const buf = new Array<number>(n);
  let phase = 0;
  const pattern = [true, true, true, true, false, false, false, false, true, true, true, true, false, false, false, false];
  const samplesPerSegment = Math.floor(n / pattern.length);
  const carrier = 30_000;
  for (let i = 0; i < n; i++) {
    let freq: number;
    if (mode === 0) freq = FREQ_MIN + (topFreq - FREQ_MIN) * (i / n);
    else if (mode === 1) freq = FREQ_MIN * (topFreq / FREQ_MIN) ** (i / n);
    else freq = carrier;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    let val = Math.sin(phase);
    if (mode === 2) {
      const seg = Math.min(pattern.length - 1, Math.floor(i / samplesPerSegment));
      if (!pattern[seg]) val = -val;
    }
    const amp = ampScale * hann(i, n);
    buf[i] = clamp(Math.round(128 + val * amp), 0, 255);
  }
  return buf;
}

function decimate(buf: number[], points: number): number[] {
  const n = Math.min(points, buf.length);
  return Array.from({ length: n }, (_, i) => buf[Math.round((i * (buf.length - 1)) / Math.max(1, n - 1))]);
}

const SPEC_BINS = 48;
const SPEC_FRAMES = 20;
const SPEC_MAX_HZ = 55_000;

/**
 * Synthetic stand-in for the real device's ADC-loopback FFT spectrogram (which
 * needs hardware the team hasn't built yet — see firmware/sonar_tx/sonar_tx.ino's
 * ENABLE_SPECTROGRAM_MONITOR). Puts a Gaussian energy peak at the analytically
 * known instantaneous frequency per time slice, not a real transform of a real
 * signal — good enough to exercise the dashboard's heatmap rendering, nothing more.
 */
function buildSpectrogram(mode: number, durationMs: number, topFreqHz: number): Telemetry['spectrogram'] {
  const freqStepHz = SPEC_MAX_HZ / SPEC_BINS;
  const frames: number[][] = [];
  for (let f = 0; f < SPEC_FRAMES; f++) {
    const frac = f / Math.max(1, SPEC_FRAMES - 1);
    const bins = new Array<number>(SPEC_BINS).fill(0);
    if (mode === 2) {
      // Phase-coded: constant 30kHz carrier the whole time, no sweep to show.
      const centerBin = 30_000 / freqStepHz;
      for (let b = 0; b < SPEC_BINS; b++) bins[b] = Math.round(230 * Math.exp(-((b - centerBin) ** 2) / (2 * 1.2 ** 2)));
    } else {
      const instFreq = mode === 1 ? FREQ_MIN * (topFreqHz / FREQ_MIN) ** frac : FREQ_MIN + (topFreqHz - FREQ_MIN) * frac;
      const centerBin = instFreq / freqStepHz;
      for (let b = 0; b < SPEC_BINS; b++) bins[b] = Math.round(235 * Math.exp(-((b - centerBin) ** 2) / (2 * 1.4 ** 2)));
    }
    for (let b = 0; b < SPEC_BINS; b++) bins[b] = clamp(bins[b] + Math.round(Math.random() * 12), 0, 255);
    frames.push(bins);
  }
  return { freq_step_hz: +freqStepHz.toFixed(1), frame_step_ms: +(durationMs / SPEC_FRAMES).toFixed(2), frames };
}

export class FuzzySimulator {
  mode: Mode = 'auto';
  private currentMode = 0;
  private cycle = 0;

  step(): Telemetry {
    const potTemp = Math.round(Math.random() * 4095);
    const potDepth = Math.round(Math.random() * 4095);
    const potTurb = Math.round(Math.random() * 4095);
    const turbidity = fuzzify(potTurb), depth = fuzzify(potDepth), temperature3 = fuzzify(potTemp);
    const temperature = { cold: temperature3.low, normal: temperature3.med, warm: temperature3.high };

    const scores = {
      phase: turbidity.high * 1.0 + turbidity.med * 0.4,
      geo: depth.high * 1.0 + depth.med * 0.4 + temperature.cold * 0.3,
      lfm: Math.min(turbidity.low, depth.low) * 1.0 + temperature.warm * 0.3,
    };
    const fuzzy: FuzzyState = { turbidity, depth, temperature, scores };
    const sensorRaw: SensorRaw = { temp_adc: potTemp, depth_adc: potDepth, turbidity_adc: potTurb };

    const freqMax = Math.round(20_000 + (potTemp / 4095) * 30_000);
    const durationMs = Math.round(50 + (potDepth / 4095) * 150);
    const ampScale = Math.round(20 + (potTurb / 4095) * 90);

    let state: Telemetry['state'] = 'IDLE';
    let log: string | undefined;
    if (this.mode === 'auto') {
      const winner = (Object.entries(scores) as ['lfm' | 'geo' | 'phase', number][]).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
      const idx = winner === 'lfm' ? 0 : winner === 'geo' ? 1 : 2;
      if (idx !== this.currentMode) {
        this.currentMode = idx;
        state = 'ADAPT';
        log = `fuzzy re-evaluation -> ${MODE_NAMES[idx]} [LFM ${scores.lfm.toFixed(2)}, Geo ${scores.geo.toFixed(2)}, Phase ${scores.phase.toFixed(2)}]`;
      }
    }

    return {
      state, cycle: this.cycle, frequency_khz: Math.round(freqMax / 1000), pulse_width_ms: durationMs,
      gain_db: ampScale, waveform: MODE_NAMES[this.currentMode], snr_db: 0, noise_floor_db: 0,
      target_present: false, target_range_m: 0, timestamp_ms: Date.now(), mode: this.mode,
      rx_available: false, fuzzy, sensor_raw: sensorRaw, ...(log ? { log } : {}),
    };
  }

  /** Real burst — generates and decimates a buffer exactly like the firmware does on TRANSMIT. */
  transmit(includeSpectrogram = false): Telemetry {
    const t = this.step();
    const buf = generateBuffer(this.currentMode, t.pulse_width_ms, t.frequency_khz * 1000, t.gain_db);
    this.cycle += 1;
    return {
      ...t, state: 'TRANSMIT', cycle: this.cycle,
      log: `TX #${this.cycle} — ${t.waveform}, ${t.frequency_khz}kHz top, ${t.pulse_width_ms}ms, amp=${t.gain_db}`,
      waveform_samples: decimate(buf, SCOPE_POINTS), sample_rate_hz: SAMPLE_RATE, duration_ms: t.pulse_width_ms,
      ...(includeSpectrogram ? { spectrogram: buildSpectrogram(this.currentMode, t.pulse_width_ms, t.frequency_khz * 1000) } : {}),
    };
  }

  applyCommand(c: Command): string {
    switch (c.cmd) {
      case 'set_mode':
        this.mode = c.value;
        return c.value === 'auto' ? 'auto (fuzzy) mode' : 'manual override';
      case 'set_waveform_mode': {
        const idx = MODE_NAMES.indexOf(c.value);
        if (idx < 0) return `unsupported waveform ${c.value}`;
        this.currentMode = idx;
        this.mode = 'manual';
        return `waveform -> ${c.value} (manual)`;
      }
      case 'trigger_ping':
        return 'ping requested — next step() will transmit';
      case 'set_params':
        return 'ignored — this hardware has no continuous freq/pulse/gain control';
    }
  }
}
