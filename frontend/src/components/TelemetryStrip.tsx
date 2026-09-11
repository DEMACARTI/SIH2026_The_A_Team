import { waveformLabel } from '../format';
import { useStore, type AppState } from '../store';
import { C } from '../theme';
import { SNR_LOW_DB } from '../types';
import s from './shell.module.css';

/**
 * Each readout subscribes to its own field, so only the numbers that changed
 * re-render (and flash) on a telemetry tick.
 */
function Readout({ label, unit, select, color }: {
  label: string;
  unit?: string;
  select: (st: AppState) => string | null | undefined;
  color?: (value: string) => string | undefined;
}) {
  const value = useStore(select) ?? '—';
  return (
    <div className={s.readout}>
      <span className={s.readoutLabel}>{label}</span>
      {/* key={value}: remount on change to replay the flash animation */}
      <span key={value} className={s.readoutValue} style={{ color: color?.(value) ?? C.text }}>
        {value}
        {unit && value !== '—' && <span className={s.readoutUnit}>{unit}</span>}
      </span>
    </div>
  );
}

const cyan = () => C.cyan;

export function TelemetryStrip() {
  return (
    <div className={s.strip} aria-label="Live telemetry">
      <Readout label="Frequency" unit="kHz" select={(st) => st.latest?.frequency_khz.toString()} color={cyan} />
      <Readout label="Pulse width" unit="ms" select={(st) => st.latest?.pulse_width_ms.toFixed(1)} color={cyan} />
      <Readout label="Gain" unit="dB" select={(st) => st.latest?.gain_db.toFixed(0)} color={cyan} />
      <Readout label="Waveform" select={(st) => st.latest && waveformLabel(st.latest.waveform)} />
      <Readout label="SNR" unit="dB" select={(st) => st.latest?.snr_db.toFixed(1)}
        color={(v) => (Number(v) < SNR_LOW_DB ? C.danger : C.amber)} />
      <Readout label="Noise floor" unit="dB" select={(st) => st.latest?.noise_floor_db.toFixed(1)} />
      <Readout label="Range" unit="m"
        select={(st) => st.latest && (st.latest.target_present ? st.latest.target_range_m.toFixed(1) : '—')} />
      <Readout label="Mode" select={(st) => st.latest?.mode && (st.latest.mode === 'auto' ? 'Auto' : 'Manual')}
        color={(v) => (v === 'Auto' ? C.cyan : C.amber)} />
    </div>
  );
}
