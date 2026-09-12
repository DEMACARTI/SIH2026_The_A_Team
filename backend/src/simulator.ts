/**
 * Adaptive sonar simulation engine. Behaves like a virtual ESP32: it steps the
 * same IDLE → TRANSMIT → LISTEN → PROCESS → ADAPT state machine as the firmware,
 * accepts the same commands, and emits telemetry in the exact device contract.
 *
 * Used by the backend's no-hardware fallback and by `npm run fake-device`.
 */
import {
  FREQ_CHANNELS_KHZ, LIMITS, STATES,
  type Command, type Mode, type SonarState, type Telemetry, type Waveform,
} from './contract.js';

export const ADAPT_RULES = {
  snrLowDb: 6,
  snrHighDb: 18,
  noiseHopDb: 40,
  gainStepUpDb: 3,
  gainStepDownDb: 2,
  gainFloorDb: 6,
  pulseStepMs: 0.4,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

interface Params {
  frequency_khz: number;
  pulse_width_ms: number;
  gain_db: number;
  waveform: Waveform;
}

interface Sensed {
  noiseFloor: number;
  targetPresent: boolean;
  range: number;
  echoAmp: number;
  snr: number;
}

export class SonarSimulator {
  mode: Mode = 'auto';
  cycle = 0;
  params: Params = { frequency_khz: 30, pulse_width_ms: 1.5, gain_db: 18, waveform: 'LFM_CHIRP' };

  private stateIdx = 0;
  private sensed: Sensed = { noiseFloor: 34, targetPresent: true, range: 22, echoAmp: 42, snr: 8 };
  private pingRequested = false;
  private clockMs = 0;

  constructor(private readonly rng: () => number = Math.random) {}

  get state(): SonarState {
    return STATES[this.stateIdx];
  }

  /** Continue from where a real device left off, so the fallback doesn't visibly "reset". */
  seedFrom(t: Telemetry): void {
    this.params = {
      frequency_khz: t.frequency_khz,
      pulse_width_ms: t.pulse_width_ms,
      gain_db: t.gain_db,
      waveform: t.waveform,
    };
    this.sensed.noiseFloor = t.noise_floor_db;
    this.sensed.snr = t.snr_db;
    this.sensed.targetPresent = t.target_present;
    if (t.target_present) this.sensed.range = t.target_range_m;
    if (t.mode) this.mode = t.mode;
    this.cycle = t.cycle;
    this.stateIdx = STATES.indexOf(t.state);
  }

  /** Apply a host command. Returns a one-line description of the effect. */
  applyCommand(c: Command): string {
    switch (c.cmd) {
      case 'set_mode':
        this.mode = c.value;
        return c.value === 'auto' ? 'auto-adaptive control engaged' : 'manual control — adaptation suspended';
      case 'set_params': {
        const p = this.params;
        if (c.frequency_khz !== undefined) p.frequency_khz = c.frequency_khz;
        if (c.pulse_width_ms !== undefined) p.pulse_width_ms = c.pulse_width_ms;
        if (c.gain_db !== undefined) p.gain_db = c.gain_db;
        return `params now ${p.frequency_khz}kHz / ${p.pulse_width_ms.toFixed(1)}ms / ${p.gain_db}dB`;
      }
      case 'trigger_ping':
        this.pingRequested = true;
        return 'ping requested — jumping to TRANSMIT';
      case 'set_waveform_mode':
        this.params.waveform = c.value;
        return `waveform forced → ${c.value}`;
    }
  }

  /** Advance one state-machine tick (~1s) and return the resulting telemetry. */
  step(dtMs = 1000): Telemetry {
    this.clockMs += dtMs;
    if (this.pingRequested) {
      this.pingRequested = false;
      this.stateIdx = STATES.indexOf('TRANSMIT');
    } else {
      this.stateIdx = (this.stateIdx + 1) % STATES.length;
    }

    let log: string | undefined;
    switch (this.state) {
      case 'TRANSMIT':
        this.cycle += 1;
        break;
      case 'LISTEN':
        this.listen();
        break;
      case 'PROCESS': {
        const mfGain = this.params.pulse_width_ms * 1.6;
        this.sensed.snr = clamp(this.sensed.snr + mfGain, -8, 34);
        log = `matched filter +${mfGain.toFixed(1)}dB → SNR ${this.sensed.snr.toFixed(1)}dB, noise floor ${this.sensed.noiseFloor.toFixed(1)}dB`;
        break;
      }
      case 'ADAPT':
        log = this.adapt();
        break;
    }

    return {
      state: this.state,
      cycle: this.cycle,
      frequency_khz: this.params.frequency_khz,
      pulse_width_ms: r1(this.params.pulse_width_ms),
      gain_db: Math.round(this.params.gain_db),
      waveform: this.params.waveform,
      snr_db: r1(this.sensed.snr),
      noise_floor_db: r1(this.sensed.noiseFloor),
      target_present: this.sensed.targetPresent,
      target_range_m: this.sensed.targetPresent ? r1(this.sensed.range) : 0,
      timestamp_ms: this.clockMs,
      mode: this.mode,
      ...(log ? { log } : {}),
    };
  }

  /** Echo model: noise floor random-walks; return strength depends on gain and range. */
  private listen(): void {
    const s = this.sensed;
    const rnd = this.rng;
    s.noiseFloor = clamp(s.noiseFloor + (rnd() - 0.5) * 5, 20, 55);
    const present = rnd() < 0.72;
    if (present) {
      const base = s.targetPresent ? s.range : 15 + rnd() * 70;
      const drift = s.targetPresent ? (rnd() - 0.5) * 8 : 0;
      s.range = clamp(base + drift, 4, 95);
    }
    s.targetPresent = present;
    const targetStrength = 14 + rnd() * 10;
    const attenuation = s.range * 0.16 + 4;
    const rawAmp = present
      ? this.params.gain_db * 0.55 + targetStrength - attenuation
      : this.params.gain_db * 0.1 - 6;
    s.echoAmp = clamp(rawAmp, -10, 60);
    s.snr = clamp(s.echoAmp - s.noiseFloor * 0.55, -8, 32);
  }

  /** Adaptive rules. Returns the reasoning for the decision — including "no change". */
  private adapt(): string {
    const { snr, noiseFloor, range } = this.sensed;
    const p = this.params;
    const R = ADAPT_RULES;
    const snrTxt = `SNR ${snr.toFixed(1)}dB`;

    if (this.mode === 'manual') {
      return `${snrTxt} — manual mode, operator parameters held`;
    }

    if (snr < R.snrLowDb) {
      const changes: string[] = [];
      if (p.gain_db < LIMITS.gainDb.max) {
        const prev = p.gain_db;
        p.gain_db = clamp(p.gain_db + R.gainStepUpDb, LIMITS.gainDb.min, LIMITS.gainDb.max);
        changes.push(`gain ${prev}→${p.gain_db}dB`);
      } else {
        changes.push(`gain already at ${LIMITS.gainDb.max}dB cap`);
      }
      if (p.pulse_width_ms < LIMITS.pulseWidthMs.max) {
        const prev = p.pulse_width_ms;
        p.pulse_width_ms = r1(clamp(p.pulse_width_ms + R.pulseStepMs, LIMITS.pulseWidthMs.min, LIMITS.pulseWidthMs.max));
        changes.push(`pulse ${prev.toFixed(1)}→${p.pulse_width_ms.toFixed(1)}ms`);
      } else {
        changes.push(`pulse already at ${LIMITS.pulseWidthMs.max}ms cap`);
      }
      if (p.waveform !== 'LFM_CHIRP') {
        p.waveform = 'LFM_CHIRP';
        changes.push('waveform → LFM chirp for pulse-compression gain');
      }
      let reason = `${snrTxt} < ${R.snrLowDb}dB → ${changes.join(', ')}`;
      if (noiseFloor > R.noiseHopDb) {
        const idx = FREQ_CHANNELS_KHZ.indexOf(p.frequency_khz as (typeof FREQ_CHANNELS_KHZ)[number]);
        const next = FREQ_CHANNELS_KHZ[(idx + 1) % FREQ_CHANNELS_KHZ.length];
        reason += `; noise ${noiseFloor.toFixed(1)}dB > ${R.noiseHopDb}dB → hop ${p.frequency_khz}→${next}kHz`;
        p.frequency_khz = next;
      }
      return reason;
    }

    if (snr > R.snrHighDb) {
      const changes: string[] = [];
      if (p.gain_db > R.gainFloorDb) {
        const prev = p.gain_db;
        p.gain_db = Math.max(R.gainFloorDb, p.gain_db - R.gainStepDownDb);
        changes.push(`gain ${prev}→${p.gain_db}dB to save power`);
      }
      if (this.sensed.targetPresent && range < 30 && p.waveform !== 'CW_PULSE') {
        p.waveform = 'CW_PULSE';
        changes.push(`close target (${range.toFixed(1)}m) → CW pulse`);
      }
      return changes.length
        ? `${snrTxt} > ${R.snrHighDb}dB → ${changes.join(', ')}`
        : `${snrTxt} > ${R.snrHighDb}dB but gain at ${R.gainFloorDb}dB floor — holding`;
    }

    return `${snrTxt} within ${R.snrLowDb}–${R.snrHighDb}dB band — nominal, holding parameters`;
  }
}
