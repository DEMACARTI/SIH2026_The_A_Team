import { ADC_MAX, MEMBERSHIP_CURVES } from '../fuzzy';
import { C, mono, sans } from '../theme';
import p from './panels.module.css';

const W = 300, H = 92, PAD_L = 4, PAD_R = 4, PLOT_TOP = 14, PLOT_BOT = 74;
const x = (adc: number) => PAD_L + (adc / ADC_MAX) * (W - PAD_L - PAD_R);
const y = (degree: number) => PLOT_BOT - degree * (PLOT_BOT - PLOT_TOP);

const CURVE_COLOR: Record<'low' | 'med' | 'high', string> = { low: C.cyan, med: C.textMuted, high: C.amber };
const PEAK_ADC: Record<'low' | 'med' | 'high', number> = { low: 0, med: 2048, high: 4095 };

function curvePath(key: 'low' | 'med' | 'high'): string {
  return MEMBERSHIP_CURVES[key].map(([adc, deg], i) => `${i ? 'L' : 'M'}${x(adc).toFixed(1)},${y(deg).toFixed(1)}`).join(' ');
}

/**
 * One sensor's fuzzy membership functions (the exact triangular shapes the device
 * evaluates), with the CURRENT raw reading marked — so turning a pot visibly slides
 * the marker and changes which membership degrees light up, live.
 */
export function MembershipChart({ title, value, degrees, labels }: {
  title: string;
  /** Raw ADC reading (0–4095), or undefined while no telemetry has arrived yet. */
  value: number | undefined;
  /** The device-reported degrees for this reading — never recomputed client-side. */
  degrees: { low: number; med: number; high: number };
  /** Display names for the three states, in low/med/high order (e.g. ["low","med","high"] or ["cold","normal","warm"]). */
  labels: [string, string, string];
}) {
  const markerX = value != null ? x(value) : null;
  const rows: { key: 'low' | 'med' | 'high'; label: string; degree: number }[] = [
    { key: 'low', label: labels[0], degree: degrees.low },
    { key: 'med', label: labels[1], degree: degrees.med },
    { key: 'high', label: labels[2], degree: degrees.high },
  ];
  const dominant = rows.reduce((a, b) => (b.degree > a.degree ? b : a));

  return (
    <div className={p.membershipChart}>
      <div className={p.membershipHead}>
        <span>{title}</span>
        <span style={{ color: CURVE_COLOR[dominant.key] }}>{dominant.label} · {dominant.degree.toFixed(2)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={p.membershipSvg} role="img" aria-label={`${title} fuzzy membership, current reading ${value ?? 'unknown'}`}>
        <line x1={PAD_L} y1={PLOT_BOT} x2={W - PAD_R} y2={PLOT_BOT} stroke={C.border} strokeWidth={1} />
        {rows.map((r) => (
          <path key={r.key} d={curvePath(r.key)} fill="none" stroke={CURVE_COLOR[r.key]} strokeWidth={1.4}
            opacity={value != null && r.key === dominant.key ? 1 : 0.55} />
        ))}
        {markerX != null && (
          <g>
            <line x1={markerX} y1={PLOT_TOP - 4} x2={markerX} y2={PLOT_BOT} stroke={C.text} strokeWidth={1} strokeDasharray="2 2" />
            {rows.map((r) => (
              <circle key={r.key} cx={markerX} cy={y(r.degree)} r={2.6} fill={CURVE_COLOR[r.key]}
                opacity={r.key === dominant.key ? 1 : 0.6} />
            ))}
            <text x={markerX} y={PLOT_TOP - 6} textAnchor="middle" fontFamily={mono} fontSize="8.5" fill={C.text}>{value}</text>
          </g>
        )}
        {rows.map((r) => (
          <text key={r.key} x={x(PEAK_ADC[r.key])} y={H - 4} textAnchor="middle"
            fontFamily={sans} fontSize="8.5" fill={CURVE_COLOR[r.key]}>{r.label}</text>
        ))}
      </svg>
    </div>
  );
}
