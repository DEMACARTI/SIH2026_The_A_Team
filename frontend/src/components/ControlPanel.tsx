import { Play, RefreshCw, Usb, Wifi, FlaskConical } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSerial, disconnectSerial, listPorts, sendCommand, type CommandResult } from '../api';
import { fmtAgo, waveformLabel } from '../format';
import { shallowEqual, useStore } from '../store';
import { C } from '../theme';
import { isFuzzyHardware, type Command, type PortSummary, type Waveform } from '../types';
import { Panel, StatusDot, Toggle, ui } from './ui';
import p from './panels.module.css';

type Feedback = { ok: boolean; text: string } | null;

function describeDelivery(cmd: Command, r: CommandResult): string {
  const d = r.delivered;
  const via = [d.serial && 'serial', d.wifiQueue && 'wifi queue', d.simulator && 'simulator'].filter(Boolean).join(' + ');
  return `${cmd.cmd} #${r.id} → ${via}`;
}

function useCommand() {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const send = useCallback(async (cmd: Command) => {
    try {
      const r = await sendCommand(cmd);
      setFeedback({ ok: true, text: describeDelivery(cmd, r) });
    } catch (err) {
      setFeedback({ ok: false, text: `${cmd.cmd} failed: ${(err as Error).message}` });
    }
  }, []);
  return { feedback, send };
}

/* ---------------- Operating mode + parameters ---------------- */

interface Params { frequency_khz: number; pulse_width_ms: number; gain_db: number }

function SliderRow({ label, value, unit, min, max, step, disabled, onChange, fmt = (v) => v.toString() }: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  disabled: boolean; onChange: (v: number) => void; fmt?: (v: number) => string;
}) {
  const id = `slider-${label.replace(/\W+/g, '-')}`;
  return (
    <div className={p.slider}>
      <div className={p.sliderHead}>
        <label htmlFor={id} className={disabled ? p.dim : undefined}>{label}</label>
        <span className={p.sliderValue} style={{ color: disabled ? C.textFaint : C.text }}>{fmt(value)} {unit}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))} className={p.range} />
    </div>
  );
}

const WAVEFORM_MODES: Waveform[] = ['LFM_CHIRP', 'GEOMETRIC_SWEEP', 'PHASE_CODED'];

/** Real fuzzy-logic hardware only supports picking one of 3 discrete waveform modes — no continuous freq/pulse/gain. */
function WaveformModeButtons({ disabled, send }: { disabled: boolean; send: (cmd: Command) => void }) {
  const current = useStore((st) => st.latest?.waveform);
  return (
    <div className={p.modeButtons}>
      {WAVEFORM_MODES.map((w) => (
        <button key={w} type="button" disabled={disabled}
          className={`${ui.btn} ${current === w ? ui.btnPrimary : ''}`}
          onClick={() => send({ cmd: 'set_waveform_mode', value: w })}>
          {waveformLabel(w)}
        </button>
      ))}
    </div>
  );
}

function OperatingMode() {
  const commanded = useStore((st) => st.status?.commandedMode ?? 'auto');
  const reported = useStore((st) => st.latest?.mode);
  const fuzzy = useStore((st) => isFuzzyHardware(st.latest));
  const live = useStore((st) => st.latest ? {
    frequency_khz: st.latest.frequency_khz, pulse_width_ms: st.latest.pulse_width_ms, gain_db: st.latest.gain_db,
  } : null, (a, b) => (a && b ? shallowEqual(a, b) : a === b));
  const manual = commanded === 'manual';
  const [draft, setDraft] = useState<Params | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { feedback, send } = useCommand();

  // Entering manual: start the sliders from what the device is actually doing.
  useEffect(() => {
    if (!manual) setDraft(null);
    else if (!draft && live) setDraft(live);
  }, [manual, live, draft]);

  const shown = manual && draft ? draft : live ?? { frequency_khz: 30, pulse_width_ms: 1.5, gain_db: 18 };

  const update = (patch: Partial<Params>) => {
    const next = { ...shown, ...patch };
    setDraft(next);
    // Debounce so dragging a slider sends one command, not fifty.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => send({ cmd: 'set_params', ...next }), 250);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const pendingAck = reported && reported !== commanded;

  return (
    <Panel title="Operating mode" meta={pendingAck ? <span style={{ color: C.amber }}>awaiting device ack…</span> : `device: ${reported ?? '—'}`}>
      <div className={p.controlStack}>
        <div className={p.modeRow}>
          <Toggle label="Operating mode" checked={!manual} onLabel="Auto-adaptive" offLabel="Manual"
            onChange={(auto) => send({ cmd: 'set_mode', value: auto ? 'auto' : 'manual' })} />
          <span className={p.hint}>{manual
            ? (fuzzy ? 'operator picks the waveform mode' : 'operator sets TX parameters')
            : (fuzzy ? 'fuzzy logic picks the waveform from turbidity/depth/temperature' : 'module adapts to SNR / noise')}</span>
        </div>
        {fuzzy ? (
          <>
            <span className={p.hint}>No continuous frequency/pulse/gain control on this hardware — pick a waveform mode directly.</span>
            <WaveformModeButtons disabled={!manual} send={send} />
          </>
        ) : (
          <>
            <SliderRow label="Frequency channel" value={shown.frequency_khz} unit="kHz" min={22} max={42} step={4}
              disabled={!manual} onChange={(v) => update({ frequency_khz: v })} />
            <SliderRow label="Pulse width" value={shown.pulse_width_ms} unit="ms" min={0.5} max={5} step={0.1}
              disabled={!manual} onChange={(v) => update({ pulse_width_ms: v })} fmt={(v) => v.toFixed(1)} />
            <SliderRow label="Transmit gain" value={shown.gain_db} unit="dB" min={0} max={40} step={1}
              disabled={!manual} onChange={(v) => update({ gain_db: v })} />
            {!manual && <span className={p.hint}>Sliders follow the live device values. Switch to Manual to override.</span>}
          </>
        )}
        <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => send({ cmd: 'trigger_ping' })}>
          <Play size={13} /> Trigger ping now
        </button>
        <div className={p.feedback} role="status" style={{ color: feedback ? (feedback.ok ? C.textMuted : C.danger) : C.textFaint }}>
          {feedback ? `${feedback.ok ? '✓' : '✗'} ${feedback.text}` : 'commands go to the serial port, the WiFi queue, and (when simulating) the simulator'}
        </div>
      </div>
    </Panel>
  );
}

/* ---------------- Comms link ---------------- */

const BAUD_RATES = [9600, 57600, 115200, 230400, 460800, 921600];

function SerialControl() {
  const serial = useStore((st) => st.status?.serial ?? null);
  const [ports, setPorts] = useState<PortSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [baud, setBaud] = useState(115200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listPorts();
      setPorts(list);
      setSelected((cur) => cur && list.some((x) => x.path === cur) ? cur : (list.find((x) => x.likelyEsp32) ?? list.find((x) => x.isUsb))?.path ?? '');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const state = serial?.state ?? 'disconnected';
  const open = state === 'connected' || state === 'reconnecting' || state === 'connecting';

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (open) await disconnectSerial();
      else await connectSerial(selected, baud);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const likely = ports.filter((x) => x.likelyEsp32);
  const usb = ports.filter((x) => x.isUsb && !x.likelyEsp32);
  const other = ports.filter((x) => !x.isUsb);
  const trouble = state === 'reconnecting' || (state === 'connected' && serial?.silent);

  return (
    <div className={p.linkSection}>
      <div className={p.linkHead}>
        <Usb size={15} color={state === 'connected' && !serial?.silent ? C.cyan : trouble ? C.danger : C.textFaint} />
        <span>USB serial</span>
        <StatusDot color={state === 'connected' && !serial?.silent ? C.cyan : trouble ? C.danger : undefined} blink={!!trouble} />
      </div>
      <div className={p.portRow}>
        <select className={ui.select} value={open ? serial?.path ?? selected : selected} disabled={open || busy}
          onChange={(e) => setSelected(e.target.value)} aria-label="Serial port">
          {!open && <option value="">{ports.length ? '— select serial port —' : 'no serial ports found'}</option>}
          {likely.length > 0 && <optgroup label="Likely ESP32 (USB-UART)">{likely.map((x) => <option key={x.path} value={x.path}>{x.label}</option>)}</optgroup>}
          {usb.length > 0 && <optgroup label="USB serial">{usb.map((x) => <option key={x.path} value={x.path}>{x.label}</option>)}</optgroup>}
          {other.length > 0 && <optgroup label="Other ports">{other.map((x) => <option key={x.path} value={x.path}>{x.label}</option>)}</optgroup>}
          {open && serial?.path && !ports.some((x) => x.path === serial.path) && <option value={serial.path}>{serial.path}</option>}
        </select>
        <button type="button" className={`${ui.btn} ${ui.btnIcon}`} onClick={refresh} disabled={open || busy} aria-label="Refresh port list" title="Refresh port list">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className={p.portRow}>
        <select className={ui.select} value={open ? serial?.baudRate ?? baud : baud} disabled={open || busy}
          onChange={(e) => setBaud(Number(e.target.value))} aria-label="Baud rate">
          {BAUD_RATES.map((b) => <option key={b} value={b}>{b} baud</option>)}
        </select>
        <button type="button" className={`${ui.btn} ${open ? '' : ui.btnPrimary}`} onClick={toggle}
          disabled={busy || (!open && !selected)} style={{ minWidth: 104 }}>
          {busy ? '…' : open ? 'Disconnect' : 'Connect'}
        </button>
      </div>
      <div className={p.linkStatus}>
        {state === 'connected' && serial && (serial.silent
          ? <span style={{ color: C.danger }}>port open, but no data for {fmtAgo(serial.lastLineAgoMs).replace(' ago', '')} — device reset/hung, or wrong baud?</span>
          : <>connected · {serial.linesReceived.toLocaleString()} lines · {serial.invalidLines} skipped · last {fmtAgo(serial.lastLineAgoMs)}</>)}
        {state === 'reconnecting' && <span style={{ color: C.danger }}>device lost ({serial?.error}) — re-opening {serial?.path} automatically</span>}
        {state === 'connecting' && 'opening port…'}
        {state === 'disconnected' && 'not connected — pick the ESP32 port (CP210x / CH340) and connect'}
        {error && <div style={{ color: C.danger }}>✗ {error}</div>}
      </div>
    </div>
  );
}

function WifiStatus() {
  const w = useStore((st) => ({
    online: st.status?.wifi.online ?? false,
    ago: st.status?.wifi.lastTelemetryAgoMs ?? null,
    remote: st.status?.wifi.remote ?? null,
    pollAgo: st.status?.wifiPoll?.lastPollAgoMs ?? null,
    lan: st.status?.lanAddresses.join(',') ?? '',
    port: st.status?.port ?? 8080,
  }), shallowEqual);
  const base = `http://${w.lan.split(',')[0] || '<this-host>'}:${w.port}`;
  return (
    <div className={p.linkSection}>
      <div className={p.linkHead}>
        <Wifi size={15} color={w.online ? C.cyan : C.textFaint} />
        <span>WiFi telemetry</span>
        <StatusDot color={w.online ? C.cyan : undefined} />
      </div>
      <div className={p.linkStatus}>
        {w.online ? `receiving from ${w.remote} · last ${fmtAgo(w.ago)}` : `offline · last telemetry ${fmtAgo(w.ago)}`}
        <br />
        command poll: {w.pollAgo == null ? 'no polls yet' : fmtAgo(w.pollAgo)}
      </div>
      <div className={p.endpoints}>
        <span className={p.dim}>set in firmware (BACKEND_HOST / BACKEND_PORT):</span>
        <code>POST {base}/api/telemetry</code>
        <code>GET&nbsp; {base}/api/commands/pending</code>
      </div>
    </div>
  );
}

function SimulationStatus() {
  const v = useStore((st) => ({
    simulated: st.status?.simulated ?? false,
    enabled: st.status?.simulationEnabled ?? true,
    timeout: st.status?.simTimeoutMs ?? 5000,
    pending: st.status?.pendingCommands ?? 0,
  }), shallowEqual);
  return (
    <div className={p.linkSection}>
      <div className={p.linkHead}>
        <FlaskConical size={15} color={v.simulated ? C.danger : C.textFaint} />
        <span>Simulation fallback</span>
        <span className={p.pill} style={{ color: v.simulated ? C.danger : C.textMuted }}>
          {!v.enabled ? 'disabled' : v.simulated ? 'ACTIVE' : 'standby'}
        </span>
      </div>
      <div className={p.linkStatus}>
        {v.enabled ? `takes over after ${(v.timeout / 1000).toFixed(0)}s without real telemetry; always labelled SIMULATED.` : 'disabled (SIMULATION=off).'}
        {' '}{v.pending} command{v.pending === 1 ? '' : 's'} queued for WiFi pickup.
      </div>
    </div>
  );
}

export function ControlPanel() {
  return (
    <div className={p.twoCol}>
      <OperatingMode />
      <Panel title="Comms link">
        <div className={p.controlStack}>
          <SerialControl />
          <WifiStatus />
          <SimulationStatus />
        </div>
      </Panel>
    </div>
  );
}
