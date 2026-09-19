/**
 * Design tokens (validated in the prototype). CSS uses the same values as
 * custom properties in styles/global.css; SVG and chart code reads them here.
 * One accent pair only: cyan = live RF/signal, amber = DSP/adaptive decisions.
 */
export const C = {
  bgDeep: '#EEF2F5',
  bgPanel: '#FFFFFF',
  bgPanelAlt: '#F4F7F9',
  bgInset: '#E8EDF1',
  border: '#D3DCE3',
  borderBright: '#B2C0CA',
  cyan: '#0B8A80',
  cyanDim: '#8FD3CC',
  cyanFaint: 'rgba(11,138,128,0.10)',
  amber: '#B86A0C',
  amberDim: '#E2B878',
  amberFaint: 'rgba(184,106,12,0.12)',
  text: '#14202A',
  textMuted: '#526675',
  textFaint: '#7D909E',
  danger: '#C8372B',
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
