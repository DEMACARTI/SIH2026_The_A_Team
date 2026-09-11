/**
 * Design tokens (validated in the prototype). CSS uses the same values as
 * custom properties in styles/global.css; SVG and chart code reads them here.
 * One accent pair only: cyan = live RF/signal, amber = DSP/adaptive decisions.
 */
export const C = {
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
} as const;

export const sans = "'IBM Plex Sans', system-ui, sans-serif";
export const mono = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

export const STATE_COLOR = {
  IDLE: C.textFaint,
  TRANSMIT: C.cyan,
  LISTEN: C.cyan,
  PROCESS: C.amber,
  ADAPT: C.amber,
} as const;
