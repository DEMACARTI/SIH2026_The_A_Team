import { memo, useLayoutEffect, useRef } from 'react';
import { waveformLabel } from '../format';
import { useElementWidth, useReducedMotion } from '../hooks';
import { shallowEqual, useStore } from '../store';
import { C, mono, sans } from '../theme';
import type { SonarState } from '../types';
import { Panel } from './ui';
import p from './panels.module.css';

type Pt = [number, number];
interface Box { x: number; y: number; w: number; h: number }
type BlockId = 'transducer' | 'trswitch' | 'pa' | 'dac' | 'lna' | 'adc' | 'dsp' | 'comms';

interface Layout {
  viewBox: string;
  blocks: Record<BlockId, Box>;
  tx: Pt[]; // DSP → DAC → PA → T/R → transducer
  rx: Pt[]; // transducer → T/R → LNA → ADC → DSP
  comms: Pt[];
  linkLabel: Pt;
  caption: string;
  text: { label: number; sub: number };
}

/* Wide: TX chain on top, RX chain below, converging on the shared transducer. */
const WIDE: Layout = {
  viewBox: '0 0 980 380',
  blocks: {
    transducer: { x: 20, y: 148, w: 108, h: 84 },
    trswitch: { x: 176, y: 148, w: 84, h: 84 },
    pa: { x: 316, y: 38, w: 104, h: 54 },
    dac: { x: 460, y: 38, w: 96, h: 54 },
    lna: { x: 316, y: 288, w: 104, h: 54 },
    adc: { x: 460, y: 288, w: 96, h: 54 },
    dsp: { x: 608, y: 106, w: 150, h: 168 },
    comms: { x: 812, y: 148, w: 148, h: 84 },
  },
  tx: [[683, 106], [683, 65], [218, 65], [218, 190], [128, 190]],
  rx: [[128, 190], [218, 190], [218, 315], [683, 315], [683, 274]],
  comms: [[758, 190], [812, 190]],
  linkLabel: [886, 256],
  caption: 'TX chain (upper) / RX chain (lower), converging at the shared transducer',
  text: { label: 12, sub: 10 },
};

/* Narrow (phones): TX chain up the left, RX chain down the right. */
const NARROW: Layout = {
  viewBox: '0 0 360 590',
  blocks: {
    transducer: { x: 105, y: 34, w: 150, h: 52 },
    trswitch: { x: 125, y: 118, w: 110, h: 46 },
    pa: { x: 16, y: 204, w: 136, h: 48 },
    dac: { x: 16, y: 288, w: 136, h: 48 },
    lna: { x: 208, y: 204, w: 136, h: 48 },
    adc: { x: 208, y: 288, w: 136, h: 48 },
    dsp: { x: 50, y: 376, w: 260, h: 80 },
    comms: { x: 90, y: 496, w: 180, h: 52 },
  },
  tx: [[84, 376], [84, 141], [180, 141], [180, 86]],
  rx: [[180, 86], [180, 141], [276, 141], [276, 376]],
  comms: [[180, 456], [180, 496]],
  linkLabel: [180, 572],
  caption: 'TX chain ↑ (left) / RX chain ↓ (right)',
  text: { label: 13.5, sub: 11.5 },
};

const pathD = (pts: Pt[]) => pts.map((pt, i) => `${i ? 'L' : 'M'} ${pt[0]},${pt[1]}`).join(' ');

const STATE_DESC: Record<SonarState, string> = {
  IDLE: 'idle — awaiting next ping',
  TRANSMIT: 'transmit — DAC → PA → T/R → transducer',
  LISTEN: 'listen — echo via T/R → LNA → ADC',
  PROCESS: 'process — matched filter, SNR estimate',
  ADAPT: 'adapt — retuning TX parameters',
};

function Block({ b, label, sub, subColor, active, accent, dashed, glow, text }: {
  b: Box;
  text: Layout['text'];
  label: string;
  sub?: string;
  subColor?: string;
  active: boolean;
  accent: string;
  dashed?: boolean;
  glow: 'pulse' | 'static' | false;
}) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return (
    <g>
      {active && glow && (
        <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={2} fill="none" stroke={accent} strokeWidth={5}
          filter="url(#arch-glow)" className={glow === 'pulse' ? p.glowPulse : undefined} opacity={0.8} />
      )}
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={2}
        fill={C.bgPanelAlt}
        stroke={active ? accent : C.border}
        strokeWidth={active ? 1.6 : 1}
        strokeDasharray={dashed ? '5 4' : undefined}
        style={{ transition: 'stroke 0.3s' }} />
      <text x={cx} y={cy + (sub ? -3 : 4)} textAnchor="middle" fontFamily={sans} fontSize={text.label} fontWeight="600"
        fill={active ? C.text : C.textMuted} style={{ transition: 'fill 0.3s' }}>
        {label}
      </text>
      {sub && (
        <text x={cx} y={cy + text.sub + 4} textAnchor="middle" fontFamily={mono} fontSize={text.sub} fill={subColor ?? C.textMuted}>
          {sub}
        </text>
      )}
    </g>
  );
}

/** A dot riding a path. begin="indefinite" + beginElement() so it starts at the path's origin when mounted. */
function FlowDot({ d, color, dur = '1s', once = false }: { d: string; color: string; dur?: string; once?: boolean }) {
  const ref = useRef<SVGCircleElement>(null);
  // Callers key this by telemetry seq, so it mounts once per message and starts from the path origin.
  useLayoutEffect(() => {
    ref.current?.querySelectorAll<SVGAnimationElement>('animate, animateMotion').forEach((a) => a.beginElement());
  }, []);
  const repeat = once ? 1 : 'indefinite';
  return (
    <circle ref={ref} r={4} fill={color} filter="url(#arch-glow-soft)" opacity={0}>
      <animateMotion path={d} dur={dur} begin="indefinite" repeatCount={repeat} fill="freeze" />
      {/* visible only while moving, so a finished one-shot dot doesn't park at the origin */}
      <animate attributeName="opacity" values={once ? '1;1;0' : '1;1'} keyTimes={once ? '0;0.8;1' : '0;1'} dur={dur}
        begin="indefinite" repeatCount={repeat} fill="freeze" />
    </circle>
  );
}

const Diagram = memo(function Diagram({ layout, reduced }: { layout: Layout; reduced: boolean }) {
  const v = useStore((st) => ({
    state: st.latest?.state ?? 'IDLE',
    freq: st.latest?.frequency_khz,
    gain: st.latest?.gain_db,
    waveform: st.latest?.waveform,
    mode: st.latest?.mode,
    present: st.latest?.target_present,
    range: st.latest?.target_range_m,
    source: st.latest?.source,
    seq: st.latest?.seq ?? 0,
    usb: st.status?.serial.state === 'connected',
    wifi: st.status?.wifi.online ?? false,
  }), shallowEqual);

  const { blocks: B } = layout;
  const tx = v.state === 'TRANSMIT';
  const rx = v.state === 'LISTEN';
  const proc = v.state === 'PROCESS';
  const adapt = v.state === 'ADAPT';
  const autoAdapt = adapt && v.mode !== 'manual';
  const simulated = v.source === 'simulated';
  const linkUp = v.usb || v.wifi;
  const glow = reduced ? 'static' : 'pulse';

  const txD = pathD(layout.tx);
  const rxD = pathD(layout.rx);
  const commsD = pathD(layout.comms);
  const txColor = autoAdapt ? C.amber : C.cyan;

  return (
    <svg viewBox={layout.viewBox} className={p.archSvg} role="img"
      aria-label={`Signal path diagram, current state ${v.state}`}>
      <defs>
        <filter id="arch-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" /></filter>
        <filter id="arch-glow-soft" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.2" /></filter>
      </defs>

      <path d={txD} fill="none" stroke={tx || autoAdapt ? txColor : C.border} strokeWidth={tx || autoAdapt ? 1.6 : 1}
        strokeDasharray={autoAdapt ? '6 4' : undefined} opacity={tx || autoAdapt ? 0.95 : 0.7} style={{ transition: 'stroke 0.3s' }} />
      <path d={rxD} fill="none" stroke={rx || proc ? C.cyan : C.border} strokeWidth={rx || proc ? 1.6 : 1}
        opacity={rx || proc ? 0.95 : 0.7} style={{ transition: 'stroke 0.3s' }} />
      <path d={commsD} fill="none" stroke={linkUp && !simulated ? C.cyan : C.border}
        strokeDasharray={simulated ? '4 4' : undefined} opacity={0.8} />

      <Block b={B.transducer} label="Transducer" sub={rx && v.present ? `echo ${v.range?.toFixed(1)}m` : 'shared TX/RX'}
        subColor={rx && v.present ? C.cyan : undefined} active={tx || rx} accent={C.cyan} glow={glow} text={layout.text} />
      <Block b={B.trswitch} label="T/R Switch" sub={tx ? '→ TX' : rx ? '← RX' : undefined} active={tx || rx} accent={C.cyan} glow={false} text={layout.text} />
      <Block b={B.dac} label="DAC" sub={v.freq ? `${v.freq}kHz` : undefined} active={tx || autoAdapt} accent={txColor} glow={false} text={layout.text} />
      <Block b={B.pa} label="Power Amp" sub={v.gain != null ? `${v.gain}dB` : undefined} active={tx || autoAdapt} accent={txColor} glow={false} text={layout.text} />
      <Block b={B.lna} label="LNA" active={rx || proc} accent={C.cyan} glow={false} text={layout.text} />
      <Block b={B.adc} label="ADC" active={rx || proc} accent={C.cyan} glow={false} text={layout.text} />
      <Block b={B.dsp} label="DSP / MCU"
        sub={v.freq ? `${v.freq}kHz · ${waveformLabel(v.waveform)}` : 'Adaptive Control Core'}
        active={proc || adapt} accent={C.amber} glow={glow} text={layout.text} />
      <Block b={B.comms} label="Comms Link" sub={simulated ? 'simulated feed' : 'USB · WiFi'}
        subColor={simulated ? C.danger : undefined} active={linkUp && !simulated} accent={C.cyan} dashed={simulated} glow={false} text={layout.text} />

      {!reduced && tx && <FlowDot key={`tx${v.seq}`} d={txD} color={C.cyan} />}
      {!reduced && rx && <FlowDot key={`rx${v.seq}`} d={rxD} color={C.cyan} />}
      {!reduced && autoAdapt && <FlowDot key={`ad${v.seq}`} d={txD} color={C.amber} dur="1.2s" once />}
      {!reduced && v.seq > 0 && <FlowDot key={`c${v.seq}`} d={commsD} color={simulated ? C.danger : C.cyan} dur="0.5s" once />}

      <text x={layout.linkLabel[0]} y={layout.linkLabel[1]} textAnchor="middle" fontFamily={mono} fontSize={layout.text.sub + 0.5} fill={C.textMuted}>
        USB {v.usb ? '●' : '○'}   WiFi {v.wifi ? '●' : '○'}
      </text>
      <text x="16" y="22" fontFamily={sans} fontSize="11" fill={C.textMuted}>{layout.caption}</text>
    </svg>
  );
});

export function ArchitecturePanel() {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrap);
  const reduced = useReducedMotion();
  const state = useStore((st) => st.latest?.state);
  const manual = useStore((st) => st.latest?.mode === 'manual');
  const desc = state ? (state === 'ADAPT' && manual ? 'adapt — manual mode, parameters held' : STATE_DESC[state]) : 'awaiting telemetry';
  return (
    <Panel title="System architecture" meta={<span aria-live="polite">{desc}</span>}>
      <div ref={wrap}>
        {width > 0 && <Diagram layout={width >= 560 ? WIDE : NARROW} reduced={reduced} />}
      </div>
    </Panel>
  );
}
