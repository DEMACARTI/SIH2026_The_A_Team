import { memo, useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtClock, SOURCE_LABEL } from '../format';
import { useReducedMotion } from '../hooks';
import { useStore, type HistoryPoint } from '../store';
import { C, mono, sans, STATE_COLOR } from '../theme';
import { isFuzzyHardware, NOISE_HOP_DB, SNR_HIGH_DB, SNR_LOW_DB, STATES, type LogEntry } from '../types';
import { Panel } from './ui';
import p from './panels.module.css';

/* ---------------- State machine ---------------- */

function StateMachine() {
  const state = useStore((st) => st.latest?.state);
  const cycle = useStore((st) => st.latest?.cycle);
  const mode = useStore((st) => st.latest?.mode);
  const reduced = useReducedMotion();
  const cx = 140, cy = 140, r = 100, nodeR = 30;
  const pos = STATES.map((_, i) => {
    const a = (Math.PI * 2 * i) / STATES.length - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });

  return (
    <svg viewBox="0 0 280 280" className={p.fsm} role="img" aria-label={`State machine, current state ${state ?? 'unknown'}`}>
      <defs>
        <marker id="fsm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill={C.textFaint} />
        </marker>
        {(['cyan', 'amber'] as const).map((k) => (
          <marker key={k} id={`fsm-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill={C[k]} />
          </marker>
        ))}
        <filter id="fsm-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" /></filter>
      </defs>
      {STATES.map((s, i) => {
        const [x1, y1] = pos[i];
        const [x2, y2] = pos[(i + 1) % STATES.length];
        // Shorten the edge so arrows stop at the node rim.
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
        const ux = dx / len, uy = dy / len;
        const leaving = s === state; // the transition that fires next
        return (
          <line key={s} x1={x1 + ux * (nodeR + 3)} y1={y1 + uy * (nodeR + 3)} x2={x2 - ux * (nodeR + 5)} y2={y2 - uy * (nodeR + 5)}
            stroke={leaving ? STATE_COLOR[s] : C.border} strokeWidth={leaving ? 1.6 : 1}
            markerEnd={!leaving || s === 'IDLE' ? 'url(#fsm-arrow)' : STATE_COLOR[s] === C.amber ? 'url(#fsm-arrow-amber)' : 'url(#fsm-arrow-cyan)'} style={{ transition: 'stroke 0.3s' }} />
        );
      })}
      {STATES.map((s, i) => {
        const [x, y] = pos[i];
        const active = s === state;
        const color = STATE_COLOR[s];
        return (
          <g key={s}>
            {active && (
              <circle cx={x} cy={y} r={nodeR + 2} fill="none" stroke={color} strokeWidth={6} filter="url(#fsm-glow)"
                className={reduced ? undefined : p.glowPulse} opacity={0.8} />
            )}
            <circle cx={x} cy={y} r={active ? nodeR + 2 : nodeR} fill={active ? `${color}22` : C.bgPanelAlt}
              stroke={active ? color : C.border} strokeWidth={active ? 1.8 : 1} style={{ transition: 'all 0.3s' }} />
            <text x={x} y={y + 4} textAnchor="middle" fontFamily={mono} fontSize="10" fontWeight="600"
              fill={active ? C.text : C.textMuted}>{s}</text>
          </g>
        );
      })}
      <text x={cx} y={cy - 4} textAnchor="middle" fontFamily={mono} fontSize="18" fontWeight="500" fill={C.text}>
        {cycle != null ? `#${cycle}` : '—'}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontFamily={sans} fontSize="10.5"
        fill={mode === 'manual' ? C.amber : C.cyan}>
        {mode === 'manual' ? 'manual' : mode === 'auto' ? 'auto-adaptive' : ''}
      </text>
    </svg>
  );
}

/* ---------------- Decision log ---------------- */

const isDecision = (e: LogEntry) => e.tag === 'ADAPT' || e.tag === 'MANUAL' || (e.tag === 'CMD' && !e.text.startsWith('trigger_ping'));

function DecisionLog() {
  const log = useStore((st) => st.log);
  const decisions = useMemo(() => log.filter(isDecision).slice(-6).reverse(), [log]);
  return (
    <div className={p.decisions}>
      <span className={p.subhead}>Recent adaptive decisions</span>
      {decisions.length === 0 && <span className={p.empty}>no decisions logged yet — first ADAPT step within ~5s</span>}
      {decisions.map((d) => (
        <div key={d.id} className={p.decision}>
          <span className={p.decisionMeta}>
            {fmtClock(d.t)} · {d.source ? SOURCE_LABEL[d.source] : 'host'} · {d.tag}
          </span>
          <span style={{ color: d.tag === 'ADAPT' ? C.amber : C.text }}>{d.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Trend charts ---------------- */

type Metric = 'frequency' | 'gain' | 'snr' | 'noiseFloor';

interface ChartRow { cycle: number; real: number | null; sim: number | null }

/** Real and simulated points go to separate series so simulated data is drawn dashed, never passed off as real. */
function toRows(history: HistoryPoint[], metric: Metric): ChartRow[] {
  return history.map((h) => ({
    cycle: h.cycle,
    real: h.source === 'simulated' ? null : h[metric],
    sim: h.source === 'simulated' ? h[metric] : null,
  }));
}

type FuzzyScoreKey = 'lfm' | 'geo' | 'phase';
type SensorKey = 'temp_adc' | 'depth_adc' | 'turbidity_adc';

function toFuzzyRows(history: HistoryPoint[], key: FuzzyScoreKey): ChartRow[] {
  return history.map((h) => {
    const v = h.fuzzy?.scores[key] ?? null;
    return { cycle: h.cycle, real: h.source === 'simulated' ? null : v, sim: h.source === 'simulated' ? v : null };
  });
}

function toSensorRows(history: HistoryPoint[], key: SensorKey): ChartRow[] {
  return history.map((h) => {
    const v = h.sensorRaw?.[key] ?? null;
    return { cycle: h.cycle, real: h.source === 'simulated' ? null : v, sim: h.source === 'simulated' ? v : null };
  });
}

const tick = { fill: C.textFaint, fontSize: 9.5, fontFamily: mono };

const rowsEqual = (a: ChartRow[], b: ChartRow[]) =>
  a.length === b.length && a.every((r, i) => r.cycle === b[i].cycle && r.real === b[i].real && r.sim === b[i].sim);

type TrendProps = {
  rows: ChartRow[];
  label: string;
  unit: string;
  color: string;
  domain: [number, number];
  step?: boolean;
  refs?: { y: number; color: string; label: string }[];
};

/** Skip the (comparatively expensive) Recharts render when this metric's series didn't change. */
const trendPropsEqual = (a: TrendProps, b: TrendProps) =>
  rowsEqual(a.rows, b.rows) && a.label === b.label && a.color === b.color;

const TrendChart = memo(function TrendChart({ rows, label, unit, color, domain, step, refs }: TrendProps) {
  const type = step ? 'stepAfter' : 'monotone';
  const last = rows[rows.length - 1];
  const current = last?.real ?? last?.sim;
  return (
    <div className={p.chart}>
      <div className={p.chartHead}>
        <span>{label} {unit && <span className={p.dim}>({unit})</span>}</span>
        <span style={{ color, fontFamily: mono }}>
          {current != null ? current.toFixed(unit === 'kHz' || unit === 'adc' ? 0 : unit === '' ? 2 : 1) : '—'}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={110}>
        <LineChart data={rows} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
          <CartesianGrid stroke={C.border} strokeDasharray="2 3" vertical={false} />
          <XAxis dataKey="cycle" tick={tick} axisLine={{ stroke: C.border }} tickLine={false} minTickGap={24} />
          <YAxis domain={domain} tick={tick} axisLine={false} tickLine={false} width={42} allowDataOverflow />
          <Tooltip
            contentStyle={{ background: C.bgPanelAlt, border: `1px solid ${C.border}`, borderRadius: 2, fontFamily: mono, fontSize: 11 }}
            labelStyle={{ color: C.textMuted }} labelFormatter={(c) => `cycle #${c}`}
            formatter={(v, name) => [`${Number(v).toFixed(1)} ${unit}`, name === 'sim' ? 'simulated' : 'device']}
          />
          {refs?.map((r) => (
            <ReferenceLine key={r.y} y={r.y} stroke={r.color} strokeDasharray="3 3" strokeOpacity={0.8}
              label={{ value: r.label, position: 'insideTopRight', fill: r.color, fontSize: 9, fontFamily: mono }} />
          ))}
          <Line type={type} dataKey="real" stroke={color} strokeWidth={1.8} dot={{ r: 1.8, strokeWidth: 0, fill: color }}
            isAnimationActive={false} connectNulls={false} />
          <Line type={type} dataKey="sim" stroke={color} strokeWidth={1.4} strokeDasharray="4 3" strokeOpacity={0.75}
            dot={false} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}, trendPropsEqual);

function Trends() {
  const history = useStore((st) => st.history);
  const fuzzy = useStore((st) => isFuzzyHardware(st.latest));
  const hasSim = history.some((h) => h.source === 'simulated');
  const rows = useMemo(() => ({
    frequency: toRows(history, 'frequency'),
    gain: toRows(history, 'gain'),
    snr: toRows(history, 'snr'),
    noiseFloor: toRows(history, 'noiseFloor'),
    lfm: toFuzzyRows(history, 'lfm'),
    geo: toFuzzyRows(history, 'geo'),
    phase: toFuzzyRows(history, 'phase'),
    temp: toSensorRows(history, 'temp_adc'),
    depth: toSensorRows(history, 'depth_adc'),
    turb: toSensorRows(history, 'turbidity_adc'),
  }), [history]);
  return (
    <Panel title={fuzzy ? 'Fuzzy score & sensor trends' : 'Adaptive parameter trends'}
      meta={<>── device{hasSim && <span style={{ color: C.danger }}>  ┄┄ simulated</span>} · last {history.length} cycles</>}>
      <div className={p.charts}>
        {fuzzy ? (
          <>
            <TrendChart rows={rows.lfm} label="LFM chirp score" unit="" color={C.cyan} domain={[0, 1]} />
            <TrendChart rows={rows.geo} label="Geometric score" unit="" color={C.cyan} domain={[0, 1]} />
            <TrendChart rows={rows.phase} label="Phase-coded score" unit="" color={C.amber} domain={[0, 1]} />
            <TrendChart rows={rows.turb} label="Turbidity" unit="adc" color={C.amber} domain={[0, 4095]} />
            <TrendChart rows={rows.depth} label="Depth" unit="adc" color={C.textMuted} domain={[0, 4095]} />
            <TrendChart rows={rows.temp} label="Temperature" unit="adc" color={C.textMuted} domain={[0, 4095]} />
          </>
        ) : (
          <>
            <TrendChart rows={rows.frequency} label="Frequency" unit="kHz" color={C.cyan} domain={[20, 44]} step />
            <TrendChart rows={rows.gain} label="Gain" unit="dB" color={C.cyan} domain={[0, 40]} />
            <TrendChart rows={rows.snr} label="SNR" unit="dB" color={C.amber} domain={[-8, 34]}
              refs={[{ y: SNR_LOW_DB, color: C.danger, label: `${SNR_LOW_DB} dB` }, { y: SNR_HIGH_DB, color: C.textFaint, label: `${SNR_HIGH_DB} dB` }]} />
            <TrendChart rows={rows.noiseFloor} label="Noise floor" unit="dB" color={C.textMuted} domain={[20, 56]}
              refs={[{ y: NOISE_HOP_DB, color: C.amberDim, label: 'hop' }]} />
          </>
        )}
      </div>
    </Panel>
  );
}

export function AdaptPanel() {
  return (
    <div className={p.stack}>
      <Panel title="Cycle state machine">
        <div className={p.fsmRow}>
          <StateMachine />
          <DecisionLog />
        </div>
      </Panel>
      <Trends />
    </div>
  );
}
