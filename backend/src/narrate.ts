/**
 * Turns the telemetry stream into console log lines. Every source (serial, WiFi,
 * simulated) goes through the same narration, so the console reads the same
 * regardless of where data comes from.
 *
 * If a device sends the optional `log` field, that text is used verbatim.
 * Otherwise the ADAPT line is inferred by diffing parameters against the
 * previous message, and is marked "(inferred)" so it's clear the host wrote it.
 */
import type { Mode, Source, Telemetry } from './contract.js';
import { ADAPT_RULES } from './simulator.js';

export type LogTag = 'TX' | 'RX' | 'PROC' | 'ADAPT' | 'MANUAL' | 'CMD' | 'LINK' | 'SYS' | 'DEV' | 'WARN';

export interface LogEntry {
  id: number;
  /** Server epoch ms. */
  t: number;
  tag: LogTag;
  text: string;
  source?: Source;
}

const WAVEFORM_LABEL: Record<string, string> = {
  LFM_CHIRP: 'LFM chirp',
  CW_PULSE: 'CW pulse',
  GEOMETRIC_SWEEP: 'geometric sweep',
  PHASE_CODED: 'phase-coded',
};
const waveformLabel = (w: Telemetry['waveform']) => WAVEFORM_LABEL[w] ?? w;

export function narrate(prev: Telemetry | null, cur: Telemetry, mode: Mode): { tag: LogTag; text: string } | null {
  switch (cur.state) {
    case 'IDLE':
      return cur.log ? { tag: 'SYS', text: cur.log } : null;
    case 'TRANSMIT': {
      if (cur.log) return { tag: 'TX', text: cur.log };
      // Real TX-only hardware: gain_db is an amplitude scale, not literal dB — phrase it as "amp".
      const gainPart = cur.rx_available === false ? `amp=${cur.gain_db.toFixed(0)}` : `gain=${cur.gain_db.toFixed(0)}dB`;
      const samplesPart = cur.waveform_samples?.length
        ? `, ${cur.waveform_samples.length} samples${cur.sample_rate_hz ? ` @ ${(cur.sample_rate_hz / 1000).toFixed(0)}kHz` : ''} captured`
        : '';
      return {
        tag: 'TX',
        text: `ping #${cur.cycle} — ${cur.frequency_khz}kHz ${waveformLabel(cur.waveform)}, ` +
          `pulse=${cur.pulse_width_ms.toFixed(1)}ms, ${gainPart}${samplesPart}`,
      };
    }
    case 'LISTEN':
      return {
        tag: 'RX',
        text: cur.log ?? (cur.target_present
          ? `echo @ ${cur.target_range_m.toFixed(1)}m, SNR=${cur.snr_db.toFixed(1)}dB`
          : 'no return — open water'),
      };
    case 'PROCESS':
      return {
        tag: 'PROC',
        text: cur.log ?? `SNR=${cur.snr_db.toFixed(1)}dB, noise floor=${cur.noise_floor_db.toFixed(1)}dB`,
      };
    case 'ADAPT': {
      const tag: LogTag = mode === 'manual' ? 'MANUAL' : 'ADAPT';
      if (cur.log) return { tag, text: cur.log };
      if (cur.fuzzy) return { tag, text: inferAdaptReasonFuzzy(cur) };
      return { tag, text: inferAdaptReason(prev, cur) };
    }
  }
}

/** Fuzzy-driven reasoning for the real TX-only hardware — no SNR feedback loop exists on it. */
function inferAdaptReasonFuzzy(cur: Telemetry): string {
  const f = cur.fuzzy!;
  const dominant = (label: string, m: { low: number; med: number; high: number } | { cold: number; normal: number; warm: number }) => {
    const entries = Object.entries(m) as [string, number][];
    const [name, value] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    return `${label} ${name} (${value.toFixed(2)})`;
  };
  const scores = f.scores;
  const winner = (Object.entries(scores) as [string, number][]).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const winnerLabel = winner === 'lfm' ? 'LFM chirp' : winner === 'geo' ? 'geometric sweep' : 'phase-coded';
  return `${dominant('turbidity', f.turbidity)}, ${dominant('depth', f.depth)}, ${dominant('temp', f.temperature)} ` +
    `→ ${winnerLabel} [LFM ${scores.lfm.toFixed(2)}, Geo ${scores.geo.toFixed(2)}, Phase ${scores.phase.toFixed(2)}]`;
}

function inferAdaptReason(prev: Telemetry | null, cur: Telemetry): string {
  const R = ADAPT_RULES;
  const snr = `SNR ${cur.snr_db.toFixed(1)}dB`;
  const band = cur.snr_db < R.snrLowDb ? `${snr} < ${R.snrLowDb}dB`
    : cur.snr_db > R.snrHighDb ? `${snr} > ${R.snrHighDb}dB`
    : `${snr} within ${R.snrLowDb}–${R.snrHighDb}dB band`;

  const changes: string[] = [];
  if (prev) {
    if (prev.gain_db !== cur.gain_db) changes.push(`gain ${prev.gain_db}→${cur.gain_db}dB`);
    if (prev.pulse_width_ms !== cur.pulse_width_ms) changes.push(`pulse ${prev.pulse_width_ms.toFixed(1)}→${cur.pulse_width_ms.toFixed(1)}ms`);
    if (prev.frequency_khz !== cur.frequency_khz) {
      const why = cur.noise_floor_db > R.noiseHopDb ? ` (noise ${cur.noise_floor_db.toFixed(1)}dB > ${R.noiseHopDb}dB)` : '';
      changes.push(`hop ${prev.frequency_khz}→${cur.frequency_khz}kHz${why}`);
    }
    if (prev.waveform !== cur.waveform) changes.push(`waveform → ${waveformLabel(cur.waveform)}`);
  }
  return changes.length
    ? `${band} → ${changes.join(', ')} (inferred)`
    : `${band} — no parameter change (inferred)`;
}
