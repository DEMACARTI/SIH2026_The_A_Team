import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Wifi, Usb, Activity, Radio, Play, Sliders, Waves } from 'lucide-react';

/* ---------------------------------------------------------------------- */
/* Design tokens                                                          */
/* ---------------------------------------------------------------------- */

const C = {
  bgDeep: '#060A10',
  bgPanel: '#0D141C',
  bgPanelAlt: '#101922',
  bgInset: '#080D13',
  border: '#1C2A35',
  borderBright: '#2C4048',
  cyan: '#3ED6C7',
  cyanDim: '#1F6E68',
  cyanFaint: 'rgba(62,214,199,0.16)',
  amber: '#F0A94E',
  amberDim: '#8A611F',
  amberFaint: 'rgba(240,169,78,0.16)',
  text: '#E7EEF2',
  textMuted: '#7C93A1',
  textFaint: '#44586A',
  danger: '#E2584B',
};

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
`;

const sans = "'IBM Plex Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

const STATES = ['IDLE', 'TRANSMIT', 'LISTEN', 'PROCESS', 'ADAPT'];
const STATE_COLOR = {
  IDLE: C.textFaint,
  TRANSMIT: C.cyan,
  LISTEN: C.cyan,
  PROCESS: C.amber,
  ADAPT: C.amber,
};
const FREQ_CHANNELS = [22, 26, 30, 34, 38, 42];

/* ---------------------------------------------------------------------- */
/* Small helpers                                                          */
/* ---------------------------------------------------------------------- */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtTime = (s) => {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
};

function pushCapped(arr, item, cap) {
  const next = [...arr, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/* ---------------------------------------------------------------------- */
/* Simulation step                                                        */
/* ---------------------------------------------------------------------- */

function stepSim(sim, mode, manual) {
  const nextIdx = (sim.stateIdx + 1) % STATES.length;
  const nextState = STATES[nextIdx];
  let { params, sensed, history, log, pingCount } = sim;
  let newParams = { ...params };
  let newSensed = { ...sensed };
  let newLog = log;
  let newHistory = history;
  let newPingCount = pingCount;

  const addLog = (line) => {
    newLog = pushCapped(newLog, { t: sim.elapsed + 1, line }, 90);
  };

  if (mode === 'manual') {
    newParams = {
      frequency: manual.frequency,
      pulseWidth: manual.pulseWidth,
      gain: manual.gain,
      waveform: manual.waveform,
    };
  }

  if (nextState === 'TRANSMIT') {
    newPingCount = pingCount + 1;
    addLog(
      `[TX] ping #${newPingCount} — ${newParams.frequency}kHz, ${newParams.waveform}, ` +
      `pulse=${newParams.pulseWidth.toFixed(1)}ms, gain=${newParams.gain.toFixed(0)}dB`
    );
  }

  if (nextState === 'LISTEN') {
    const drift = (Math.random() - 0.5) * 5;
    newSensed.noiseFloor = clamp(sensed.noiseFloor + drift, 20, 55);
    const targetPresent = Math.random() < 0.72;
    if (targetPresent) {
      const rangeDrift = sensed.targetPresent ? (Math.random() - 0.5) * 8 : 0;
      newSensed.range = clamp(
        (sensed.targetPresent ? sensed.range : 15 + Math.random() * 70) + rangeDrift,
        4, 95
      );
    }
    newSensed.targetPresent = targetPresent;
    const targetStrength = 14 + Math.random() * 10;
    const attenuation = newSensed.range * 0.16 + 4;
    const rawAmp = targetPresent
      ? newParams.gain * 0.55 + targetStrength - attenuation
      : newParams.gain * 0.1 - 6;
    newSensed.echoAmp = clamp(rawAmp, -10, 60);
    newSensed.snr = clamp(newSensed.echoAmp - newSensed.noiseFloor * 0.55, -8, 32);
    const listenWindowMs = ((newSensed.range * 2) / 1500) * 1000;
    newSensed.listenWindowMs = listenWindowMs;
    addLog(
      targetPresent
        ? `[RX] echo detected @ ${newSensed.range.toFixed(1)}m, amp=${newSensed.echoAmp.toFixed(1)}dB`
        : `[RX] no return — open water`
    );
  }

  if (nextState === 'PROCESS') {
    const matchedFilterGain = newParams.pulseWidth * 1.6;
    newSensed.snr = clamp(newSensed.snr + matchedFilterGain, -8, 34);
    addLog(
      `[PROC] matched filter applied, +${matchedFilterGain.toFixed(1)}dB → SNR=${newSensed.snr.toFixed(1)}dB, noise=${newSensed.noiseFloor.toFixed(1)}dB`
    );
  }

  if (nextState === 'ADAPT') {
    if (mode === 'auto') {
      const changes = [];
      if (newSensed.snr < 6) {
        if (newParams.gain < 36) {
          const prevGain = newParams.gain;
          newParams.gain = clamp(newParams.gain + 3, 0, 40);
          changes.push(`gain ${prevGain.toFixed(0)}→${newParams.gain.toFixed(0)}dB`);
        }
        if (newParams.pulseWidth < 4) {
          const prevPW = newParams.pulseWidth;
          newParams.pulseWidth = clamp(+(newParams.pulseWidth + 0.4).toFixed(1), 0.5, 5);
          changes.push(`pulse ${prevPW.toFixed(1)}→${newParams.pulseWidth.toFixed(1)}ms`);
        }
        if (newSensed.noiseFloor > 40) {
          const idx = FREQ_CHANNELS.indexOf(newParams.frequency);
          const nextF = FREQ_CHANNELS[(idx + 1) % FREQ_CHANNELS.length];
          changes.push(`freq hop ${newParams.frequency}→${nextF}kHz`);
          newParams.frequency = nextF;
        }
        newParams.waveform = 'LFM Chirp';
      } else if (newSensed.snr > 18) {
        if (newParams.gain > 10) {
          const prevGain = newParams.gain;
          newParams.gain = clamp(newParams.gain - 2, 8, 40);
          changes.push(`gain ${prevGain.toFixed(0)}→${newParams.gain.toFixed(0)}dB (power save)`);
        }
        if (newSensed.range < 30) newParams.waveform = 'CW Pulse';
      }
      addLog(
        changes.length
          ? `[ADAPT] SNR=${newSensed.snr.toFixed(1)}dB — ${changes.join(', ')}`
          : `[ADAPT] SNR=${newSensed.snr.toFixed(1)}dB — nominal, holding parameters`
      );
    } else {
      addLog(`[MANUAL] operator parameters held — SNR=${newSensed.snr.toFixed(1)}dB`);
    }
    newHistory = pushCapped(
      history,
      {
        cycle: pingCount,
        frequency: newParams.frequency,
        gain: newParams.gain,
        pulseWidth: newParams.pulseWidth,
        snr: +newSensed.snr.toFixed(1),
        noiseFloor: +newSensed.noiseFloor.toFixed(1),
      },
      24
    );
  }

  return {
    stateIdx: nextIdx,
    elapsed: sim.elapsed + 1,
    pingCount: newPingCount,
    params: newParams,
    sensed: newSensed,
    history: newHistory,
    log: newLog,
  };
}

const initialSim = {
  stateIdx: 0,
  elapsed: 0,
  pingCount: 0,
  params: { frequency: 30, pulseWidth: 1.5, gain: 18, waveform: 'LFM Chirp' },
  sensed: { noiseFloor: 34, targetPresent: true, range: 22, echoAmp: 42, snr: 8, listenWindowMs: 29 },
  history: [],
  log: [{ t: 0, line: '[BOOT] adaptive sonar TX module online — self-test passed' }],
};

/* ---------------------------------------------------------------------- */
/* Reusable UI bits                                                       */
/* ---------------------------------------------------------------------- */

function Panel({ title, right, children, style }) {
  return (
    <div style={{
      background: C.bgPanel, border: `1px solid ${C.border}`, borderRadius: 4,
      padding: '16px 18px', ...style,
    }}>
      {title && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 14, paddingBottom: 10, borderBottom: `1px solid ${C.border}`,
        }}>
          <span style={{ fontFamily: sans, fontSize: 13, fontWeight: 600, color: C.text }}>{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function Readout({ label, value, unit, accent }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 82 }}>
      <span style={{ fontFamily: sans, fontSize: 10.5, color: C.textMuted }}>{label}</span>
      <span style={{ fontFamily: mono, fontSize: 17, fontWeight: 500, color: accent || C.text }}>
        {value}<span style={{ fontSize: 11, color: C.textMuted, marginLeft: 3 }}>{unit}</span>
      </span>
    </div>
  );
}

function StatusDot({ on, colorOn = C.cyan }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: on ? colorOn : C.textFaint,
      boxShadow: on ? `0 0 6px ${colorOn}` : 'none',
    }} />
  );
}

/* ---------------------------------------------------------------------- */
/* Architecture diagram                                                   */
/* ---------------------------------------------------------------------- */

const BLOCKS = {
  transducer: { x: 20, y: 148, w: 108, h: 84, label: 'Transducer Array' },
  trswitch: { x: 176, y: 148, w: 84, h: 84, label: 'T/R Switch' },
  dac: { x: 320, y: 38, w: 84, h: 54, label: 'DAC' },
  pa: { x: 452, y: 38, w: 100, h: 54, label: 'Power Amp' },
  lna: { x: 320, y: 288, w: 84, h: 54, label: 'LNA' },
  adc: { x: 452, y: 288, w: 100, h: 54, label: 'ADC' },
  dsp: { x: 608, y: 106, w: 150, h: 168, label: 'DSP / MCU', sub: 'Adaptive Control Core' },
  comms: { x: 812, y: 148, w: 148, h: 84, label: 'Comms Link', sub: 'USB · WiFi' },
};

function edge(b, side) {
  const { x, y, w, h } = b;
  if (side === 'l') return [x, y + h / 2];
  if (side === 'r') return [x + w, y + h / 2];
  if (side === 't') return [x + w / 2, y];
  if (side === 'b') return [x + w / 2, y + h];
  return [x + w / 2, y + h / 2];
}

function pathD(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`).join(' ');
}

function Block({ b, active, accent }) {
  return (
    <g>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={3}
        fill={C.bgPanelAlt}
        stroke={active ? accent : C.border}
        strokeWidth={active ? 1.6 : 1}
        style={{ filter: active ? `drop-shadow(0 0 6px ${accent})` : 'none', transition: 'stroke 0.3s' }}
      />
      <text x={b.x + b.w / 2} y={b.y + b.h / 2 + (b.sub ? -4 : 4)} textAnchor="middle"
        fontFamily={sans} fontSize="11.5" fontWeight="600"
        fill={active ? C.text : C.textMuted}>
        {b.label}
      </text>
      {b.sub && (
        <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 14} textAnchor="middle"
          fontFamily={mono} fontSize="9.5" fill={C.textMuted}>
          {b.sub}
        </text>
      )}
    </g>
  );
}

function FlowDot({ d, color, active, dur = '1.4s' }) {
  if (!active) return null;
  return (
    <circle r="4" fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
      <animateMotion path={d} dur={dur} repeatCount="indefinite" />
    </circle>
  );
}

function ArchitectureDiagram({ state, params, connection }) {
  const txActive = state === 'TRANSMIT';
  const rxActive = state === 'LISTEN' || state === 'PROCESS';
  const dspActive = state === 'PROCESS' || state === 'ADAPT';

  const txPath = pathD([edge(BLOCKS.dsp, 't'), [BLOCKS.dsp.x + BLOCKS.dsp.w / 2, 65], edge(BLOCKS.pa, 'r'), edge(BLOCKS.pa, 'l'), edge(BLOCKS.dac, 'r'), edge(BLOCKS.dac, 'l'), [225, 65], edge(BLOCKS.trswitch, 't'), edge(BLOCKS.transducer, 'r')]);
  const rxPath = pathD([edge(BLOCKS.transducer, 'r'), edge(BLOCKS.trswitch, 'l'), edge(BLOCKS.trswitch, 'b'), [225, 315], edge(BLOCKS.lna, 'l'), edge(BLOCKS.lna, 'r'), edge(BLOCKS.adc, 'l'), edge(BLOCKS.adc, 'r'), [BLOCKS.dsp.x + BLOCKS.dsp.w / 2, 315], edge(BLOCKS.dsp, 'b')]);
  const commsPath = pathD([edge(BLOCKS.dsp, 'r'), edge(BLOCKS.comms, 'l')]);

  return (
    <svg viewBox="0 0 980 380" style={{ width: '100%', height: 'auto', display: 'block' }}>
      <path d={txPath} fill="none" stroke={txActive ? C.cyan : C.border} strokeWidth={txActive ? 1.6 : 1} opacity={txActive ? 0.9 : 0.6} />
      <path d={rxPath} fill="none" stroke={rxActive ? C.cyan : C.border} strokeWidth={rxActive ? 1.6 : 1} opacity={rxActive ? 0.9 : 0.6} />
      <path d={commsPath} fill="none" stroke={C.border} strokeWidth={1} opacity={0.6} />

      <Block b={BLOCKS.transducer} active={txActive || rxActive} accent={C.cyan} />
      <Block b={BLOCKS.trswitch} active={txActive || rxActive} accent={C.cyan} />
      <Block b={BLOCKS.dac} active={txActive} accent={C.cyan} />
      <Block b={BLOCKS.pa} active={txActive} accent={C.cyan} />
      <Block b={BLOCKS.lna} active={rxActive} accent={C.cyan} />
      <Block b={BLOCKS.adc} active={rxActive} accent={C.cyan} />
      <Block b={BLOCKS.dsp} active={dspActive} accent={C.amber} />
      <Block b={BLOCKS.comms} active={false} accent={C.cyan} />

      <FlowDot d={txPath} color={C.cyan} active={txActive} />
      <FlowDot d={rxPath} color={C.cyan} active={rxActive} />

      <text x={BLOCKS.comms.x + BLOCKS.comms.w / 2} y={BLOCKS.comms.y + BLOCKS.comms.h + 22} textAnchor="middle" fontFamily={mono} fontSize="9.5" fill={C.textMuted}>
        USB {connection.usb ? '●' : '○'}  WiFi {connection.wifi ? '●' : '○'}
      </text>
      <text x={BLOCKS.dsp.x + BLOCKS.dsp.w / 2} y={BLOCKS.dsp.y + BLOCKS.dsp.h + 24} textAnchor="middle" fontFamily={mono} fontSize="9.5" fill={C.textMuted}>
        {params.frequency}kHz · {params.waveform}
      </text>

      <text x="20" y="24" fontFamily={sans} fontSize="10.5" fill={C.textMuted}>TX chain (upper) / RX chain (lower), converging at shared transducer</text>
    </svg>
  );
}

/* ---------------------------------------------------------------------- */
/* Signal panel                                                           */
/* ---------------------------------------------------------------------- */

function Scope({ sensed, state }) {
  const N = 140;
  const pts = [];
  const showEcho = (state === 'LISTEN' || state === 'PROCESS' || state === 'ADAPT') && sensed.targetPresent;
  const echoIdx = showEcho ? Math.round(10 + (sensed.range / 95) * 120) : -1;
  for (let i = 0; i < N; i++) {
    let y = 30 + (Math.random() - 0.5) * 5;
    if (i >= 3 && i <= 7) y -= 22;
    if (showEcho && Math.abs(i - echoIdx) <= 1) {
      y -= clamp(sensed.echoAmp, 0, 55) * 0.6;
    }
    pts.push([20 + i * 6.6, clamp(y, 4, 60)]);
  }
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 960 70" style={{ width: '100%', height: 90, display: 'block' }}>
      <line x1="20" y1="30" x2="940" y2="30" stroke={C.border} strokeDasharray="2,3" />
      <path d={d} fill="none" stroke={C.cyan} strokeWidth="1.3" opacity="0.9" />
      <text x="24" y="66" fontFamily={mono} fontSize="9" fill={C.textFaint}>0m</text>
      <text x="900" y="66" fontFamily={mono} fontSize="9" fill={C.textFaint}>95m</text>
    </svg>
  );
}

function SignalPanel({ sim }) {
  const { params, sensed, history, stateName } = sim;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel title="Return signal — amplitude vs. range" right={<span style={{ fontFamily: mono, fontSize: 11, color: C.textMuted }}>range window: 0–95m</span>}>
        <Scope sensed={sensed} state={stateName} />
      </Panel>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,260px) 1fr', gap: 16 }}>
        <Panel title="Frequency channel">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {FREQ_CHANNELS.map((f) => (
              <div key={f} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 10px', borderRadius: 3,
                background: f === params.frequency ? C.cyanFaint : 'transparent',
                border: `1px solid ${f === params.frequency ? C.cyanDim : 'transparent'}`,
              }}>
                <span style={{ fontFamily: mono, fontSize: 12, color: f === params.frequency ? C.cyan : C.textMuted }}>{f} kHz</span>
                {f === params.frequency && <StatusDot on colorOn={C.cyan} />}
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Ping history">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 6, fontFamily: mono, fontSize: 11.5 }}>
            {['cycle', 'freq', 'pulse', 'snr', 'noise'].map((h) => (
              <div key={h} style={{ color: C.textMuted, borderBottom: `1px solid ${C.border}`, paddingBottom: 6 }}>{h}</div>
            ))}
            {[...history].slice(-7).reverse().map((h) => (
              <React.Fragment key={h.cycle}>
                <div style={{ color: C.text }}>#{h.cycle}</div>
                <div style={{ color: C.text }}>{h.frequency}k</div>
                <div style={{ color: C.text }}>{h.pulseWidth}ms</div>
                <div style={{ color: h.snr < 6 ? C.danger : C.cyan }}>{h.snr}dB</div>
                <div style={{ color: C.textMuted }}>{h.noiseFloor}dB</div>
              </React.Fragment>
            ))}
            {history.length === 0 && <div style={{ color: C.textFaint, gridColumn: '1 / -1' }}>awaiting first cycle…</div>}
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Adapt panel — state machine + trends                                   */
/* ---------------------------------------------------------------------- */

function StateMachine({ stateName }) {
  const cx = 130, cy = 130, r = 96;
  const positions = STATES.map((_, i) => {
    const a = (Math.PI * 2 * i) / STATES.length - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  return (
    <svg viewBox="0 0 260 260" style={{ width: 260, height: 260, flexShrink: 0 }}>
      {STATES.map((s, i) => {
        const [x1, y1] = positions[i];
        const [x2, y2] = positions[(i + 1) % STATES.length];
        const active = STATES[i] === stateName;
        return <line key={s} x1={x1} y1={y1} x2={x2} y2={y2} stroke={active ? STATE_COLOR[s] : C.border} strokeWidth={active ? 1.8 : 1} />;
      })}
      {STATES.map((s, i) => {
        const [x, y] = positions[i];
        const active = s === stateName;
        return (
          <g key={s}>
            <circle cx={x} cy={y} r={active ? 30 : 26} fill={active ? `${STATE_COLOR[s]}22` : C.bgPanelAlt}
              stroke={active ? STATE_COLOR[s] : C.border} strokeWidth={active ? 1.8 : 1}
              style={{ filter: active ? `drop-shadow(0 0 8px ${STATE_COLOR[s]})` : 'none' }} />
            <text x={x} y={y + 4} textAnchor="middle" fontFamily={mono} fontSize="9.5" fontWeight="600"
              fill={active ? C.text : C.textMuted}>{s}</text>
          </g>
        );
      })}
    </svg>
  );
}

function TrendChart({ data, dataKey, label, color, unit, refLine }) {
  return (
    <div>
      <div style={{ fontFamily: sans, fontSize: 11, color: C.textMuted, marginBottom: 4 }}>{label} <span style={{ color: C.textFaint }}>({unit})</span></div>
      <ResponsiveContainer width="100%" height={90}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid stroke={C.border} strokeDasharray="2 3" vertical={false} />
          <XAxis dataKey="cycle" tick={{ fill: C.textFaint, fontSize: 9, fontFamily: mono }} axisLine={{ stroke: C.border }} tickLine={false} />
          <YAxis tick={{ fill: C.textFaint, fontSize: 9, fontFamily: mono }} axisLine={false} tickLine={false} width={30} />
          <Tooltip contentStyle={{ background: C.bgPanelAlt, border: `1px solid ${C.border}`, fontFamily: mono, fontSize: 11 }} labelStyle={{ color: C.textMuted }} />
          {refLine != null && <ReferenceLine y={refLine} stroke={C.danger} strokeDasharray="3 3" />}
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.8} dot={{ r: 2 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AdaptPanel({ sim }) {
  const decisions = sim.log.filter((l) => l.line.startsWith('[ADAPT]') || l.line.startsWith('[MANUAL]')).slice(-5).reverse();
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel title="Cycle state machine">
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <StateMachine stateName={sim.stateName} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 220 }}>
            <span style={{ fontFamily: sans, fontSize: 11, color: C.textMuted }}>Recent adaptive decisions</span>
            {decisions.length === 0 && <span style={{ fontFamily: mono, fontSize: 11.5, color: C.textFaint }}>no decisions logged yet</span>}
            {decisions.map((d, i) => (
              <div key={i} style={{ fontFamily: mono, fontSize: 11.5, color: d.line.startsWith('[ADAPT]') ? C.amber : C.textMuted, lineHeight: 1.5 }}>
                {d.line}
              </div>
            ))}
          </div>
        </div>
      </Panel>
      <Panel title="Adaptive parameter trends">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 20 }}>
          <TrendChart data={sim.history} dataKey="frequency" label="Frequency" color={C.cyan} unit="kHz" />
          <TrendChart data={sim.history} dataKey="gain" label="Gain" color={C.cyan} unit="dB" />
          <TrendChart data={sim.history} dataKey="snr" label="SNR" color={C.amber} unit="dB" refLine={6} />
          <TrendChart data={sim.history} dataKey="noiseFloor" label="Noise floor" color={C.textMuted} unit="dB" />
        </div>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Control panel                                                          */
/* ---------------------------------------------------------------------- */

function Toggle({ checked, onChange, onLabel = 'On', offLabel = 'Off' }) {
  return (
    <button onClick={() => onChange(!checked)} style={{
      display: 'flex', border: `1px solid ${checked ? C.cyanDim : C.border}`,
      borderRadius: 3, overflow: 'hidden', cursor: 'pointer', background: 'transparent', padding: 0,
    }}>
      <span style={{
        padding: '5px 12px', fontFamily: mono, fontSize: 11,
        background: checked ? C.cyanFaint : 'transparent', color: checked ? C.cyan : C.textFaint,
      }}>{onLabel}</span>
      <span style={{
        padding: '5px 12px', fontFamily: mono, fontSize: 11,
        background: !checked ? C.bgPanelAlt : 'transparent', color: !checked ? C.textMuted : C.textFaint,
      }}>{offLabel}</span>
    </button>
  );
}

function SliderRow({ label, value, unit, min, max, step, onChange, disabled }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: sans, fontSize: 11.5, color: disabled ? C.textFaint : C.textMuted }}>{label}</span>
        <span style={{ fontFamily: mono, fontSize: 12, color: disabled ? C.textFaint : C.text }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: disabled ? C.textFaint : C.cyan, opacity: disabled ? 0.4 : 1 }} />
    </div>
  );
}

function ControlPanel({ mode, setMode, manual, setManual, connection, setConnection, onPing }) {
  const disabled = mode !== 'manual';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) minmax(240px, 1fr)', gap: 16 }}>
      <Panel title="Operating mode">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Toggle checked={mode === 'auto'} onChange={(v) => setMode(v ? 'auto' : 'manual')} onLabel="Auto-adaptive" offLabel="Manual" />
          </div>
          <SliderRow label="Frequency (nearest channel)" value={manual.frequency} unit=" kHz" min={22} max={42} step={4}
            onChange={(v) => setManual((m) => ({ ...m, frequency: v }))} disabled={disabled} />
          <SliderRow label="Pulse width" value={manual.pulseWidth} unit=" ms" min={0.5} max={5} step={0.1}
            onChange={(v) => setManual((m) => ({ ...m, pulseWidth: v }))} disabled={disabled} />
          <SliderRow label="Transmit gain" value={manual.gain} unit=" dB" min={0} max={40} step={1}
            onChange={(v) => setManual((m) => ({ ...m, gain: v }))} disabled={disabled} />
          <button onClick={onPing} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            marginTop: 4, padding: '9px 14px', background: C.cyanFaint, border: `1px solid ${C.cyanDim}`,
            borderRadius: 3, color: C.cyan, fontFamily: sans, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}>
            <Play size={13} /> Trigger ping now
          </button>
        </div>
      </Panel>
      <Panel title="Comms link">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Usb size={15} color={connection.usb ? C.cyan : C.textFaint} />
              <span style={{ fontFamily: sans, fontSize: 12.5, color: C.text }}>USB serial</span>
            </div>
            <Toggle checked={connection.usb} onChange={(v) => setConnection((c) => ({ ...c, usb: v }))} onLabel="Linked" offLabel="Off" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Wifi size={15} color={connection.wifi ? C.cyan : C.textFaint} />
              <span style={{ fontFamily: sans, fontSize: 12.5, color: C.text }}>WiFi telemetry</span>
            </div>
            <Toggle checked={connection.wifi} onChange={(v) => setConnection((c) => ({ ...c, wifi: v }))} onLabel="Linked" offLabel="Off" />
          </div>
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, fontFamily: mono, fontSize: 11, color: C.textMuted, lineHeight: 1.7 }}>
            Host commands (mode, ping trigger, parameter overrides) are queued here and written to the module over the active link — same channel the module uses to report telemetry back.
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Console log                                                            */
/* ---------------------------------------------------------------------- */

function ConsoleLog({ log }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  const lineColor = (l) => {
    if (l.startsWith('[ADAPT]')) return C.amber;
    if (l.startsWith('[MANUAL]') || l.startsWith('[CMD]') || l.startsWith('[LINK]')) return C.text;
    if (l.startsWith('[TX]') || l.startsWith('[RX]')) return C.cyan;
    return C.textMuted;
  };
  return (
    <div ref={ref} style={{
      background: C.bgInset, border: `1px solid ${C.border}`, borderRadius: 4,
      height: 130, overflowY: 'auto', padding: '10px 14px', fontFamily: mono, fontSize: 11.5, lineHeight: 1.7,
    }}>
      {log.map((l, i) => (
        <div key={i} style={{ color: lineColor(l.line) }}>
          <span style={{ color: C.textFaint }}>[{fmtTime(l.t)}]</span> {l.line}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Main app                                                                */
/* ---------------------------------------------------------------------- */

const TABS = [
  { id: 'arch', label: 'Architecture', icon: Radio },
  { id: 'signal', label: 'Signal', icon: Waves },
  { id: 'adapt', label: 'Adaptive logic', icon: Activity },
  { id: 'control', label: 'Control', icon: Sliders },
];

export default function SonarVisualizer() {
  const [sim, setSim] = useState(initialSim);
  const [mode, setMode] = useState('auto');
  const [manual, setManual] = useState({ frequency: 30, pulseWidth: 1.5, gain: 18, waveform: 'CW Pulse' });
  const [connection, setConnection] = useState({ usb: true, wifi: false });
  const [tab, setTab] = useState('arch');

  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const manualRef = useRef(manual);
  useEffect(() => { manualRef.current = manual; }, [manual]);

  const tick = useCallback(() => {
    setSim((prev) => stepSim(prev, modeRef.current, manualRef.current));
  }, []);

  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tick]);

  const triggerPing = () => {
    setSim((prev) => ({ ...prev, stateIdx: STATES.length - 1 }));
    setSim((prev) => ({
      ...prev,
      log: pushCapped(prev.log, { t: prev.elapsed, line: '[CMD] operator-triggered ping queued' }, 90),
    }));
  };

  const stateName = STATES[sim.stateIdx];
  const enriched = { ...sim, stateName };

  return (
    <div style={{
      fontFamily: sans, background: C.bgDeep, color: C.text, minHeight: '100%',
      padding: 20, boxSizing: 'border-box',
    }}>
      <style>{FONTS}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Waves size={18} color={C.cyan} />
          <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0.2 }}>Adaptive Sonar TX — Module Console</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontFamily: mono, fontSize: 11.5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <StatusDot on={connection.usb} /><span style={{ color: C.textMuted }}>USB</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <StatusDot on={connection.wifi} /><span style={{ color: C.textMuted }}>WiFi</span>
          </div>
          <div style={{
            padding: '4px 10px', borderRadius: 3, border: `1px solid ${STATE_COLOR[stateName]}`,
            color: STATE_COLOR[stateName], background: `${STATE_COLOR[stateName]}18`,
          }}>{stateName}</div>
          <span style={{ color: C.textMuted }}>{fmtTime(sim.elapsed)}</span>
          <span style={{ color: C.textMuted }}>ping #{sim.pingCount}</span>
        </div>
      </div>

      {/* Telemetry strip */}
      <div style={{
        display: 'flex', gap: 28, flexWrap: 'wrap', background: C.bgPanel, border: `1px solid ${C.border}`,
        borderRadius: 4, padding: '14px 20px', marginBottom: 16,
      }}>
        <Readout label="Frequency" value={sim.params.frequency} unit="kHz" accent={C.cyan} />
        <Readout label="Pulse width" value={sim.params.pulseWidth.toFixed(1)} unit="ms" accent={C.cyan} />
        <Readout label="Gain" value={sim.params.gain.toFixed(0)} unit="dB" accent={C.cyan} />
        <Readout label="Waveform" value={sim.params.waveform} unit="" />
        <Readout label="SNR" value={sim.sensed.snr.toFixed(1)} unit="dB" accent={sim.sensed.snr < 6 ? C.danger : C.amber} />
        <Readout label="Noise floor" value={sim.sensed.noiseFloor.toFixed(1)} unit="dB" />
        <Readout label="Range" value={sim.sensed.targetPresent ? sim.sensed.range.toFixed(1) : '—'} unit="m" />
        <Readout label="Mode" value={mode === 'auto' ? 'Auto' : 'Manual'} unit="" accent={mode === 'auto' ? C.cyan : C.amber} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', background: 'transparent',
              border: 'none', borderBottom: active ? `2px solid ${C.cyan}` : '2px solid transparent',
              color: active ? C.text : C.textMuted, fontFamily: sans, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
            }}>
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ marginBottom: 16 }}>
        {tab === 'arch' && (
          <Panel title="System architecture" right={<span style={{ fontFamily: mono, fontSize: 11, color: C.textMuted }}>live signal path</span>}>
            <ArchitectureDiagram state={stateName} params={sim.params} connection={connection} />
          </Panel>
        )}
        {tab === 'signal' && <SignalPanel sim={enriched} />}
        {tab === 'adapt' && <AdaptPanel sim={enriched} />}
        {tab === 'control' && (
          <ControlPanel mode={mode} setMode={setMode} manual={manual} setManual={setManual}
            connection={connection} setConnection={setConnection} onPing={triggerPing} />
        )}
      </div>

      {/* Console */}
      <div style={{ fontFamily: sans, fontSize: 11, color: C.textMuted, marginBottom: 6 }}>Serial console</div>
      <ConsoleLog log={sim.log} />
    </div>
  );
}
