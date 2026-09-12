import type { Source, Waveform } from './types';

const pad = (n: number) => n.toString().padStart(2, '0');

export function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtAgo(ms: number | null | undefined): string {
  if (ms == null) return 'never';
  if (ms < 1500) return 'just now';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(Math.floor(s % 60))}s ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const WAVEFORM_LABELS: Record<Waveform, string> = {
  LFM_CHIRP: 'LFM chirp',
  CW_PULSE: 'CW pulse',
  GEOMETRIC_SWEEP: 'Geometric sweep',
  PHASE_CODED: 'Phase-coded',
};
export const waveformLabel = (w: Waveform | undefined) => (w ? WAVEFORM_LABELS[w] ?? w : '—');

export const SOURCE_LABEL: Record<Source, string> = { serial: 'USB', wifi: 'WiFi', simulated: 'SIM' };

export const isReal = (s: Source | undefined): s is 'serial' | 'wifi' => s === 'serial' || s === 'wifi';
