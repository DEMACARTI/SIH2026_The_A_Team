/**
 * WebSocket client: exponential-backoff reconnect (capped at 5s), plus a
 * liveness watchdog — the backend sends status every second, so an "open"
 * socket that goes quiet (laptop sleep, dead Wi-Fi) is closed and redialled.
 */
import { applyServerMessage, getState, setState } from './store';
import type { ServerMessage } from './types';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 5000;
const SILENCE_LIMIT_MS = 5000;

let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let lastMessageAt = 0;

function url() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connect() {
  retryTimer = null;
  setState({ ws: { state: 'connecting', retryAt: null, attempt } });
  const sock = new WebSocket(url());
  ws = sock;

  sock.onopen = () => {
    attempt = 0;
    lastMessageAt = Date.now();
    setState({ ws: { state: 'open', retryAt: null, attempt: 0 } });
  };
  sock.onmessage = (e) => {
    lastMessageAt = Date.now();
    try {
      applyServerMessage(JSON.parse(e.data) as ServerMessage);
    } catch (err) {
      console.warn('bad server message', err);
    }
  };
  sock.onerror = () => sock.close();
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) * (0.85 + Math.random() * 0.3);
  attempt += 1;
  setState({ ws: { state: 'closed', retryAt: Date.now() + delay, attempt } });
  retryTimer = setTimeout(connect, delay);
}

/** Skip the backoff wait (the banner's "retry now" button). */
export function reconnectNow() {
  if (retryTimer) clearTimeout(retryTimer);
  connect();
}

let started = false;
export function startSocket() {
  if (started) return;
  started = true;
  connect();
  setInterval(() => {
    if (ws && getState().ws.state === 'open' && Date.now() - lastMessageAt > SILENCE_LIMIT_MS) {
      // A half-open socket may never finish the close handshake — drop it and redial now.
      const dead = ws;
      ws = null;
      dead.close();
      scheduleReconnect();
    }
  }, 1000);
  // Coming back from sleep / tab restore: don't sit out a long backoff.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getState().ws.state === 'closed') reconnectNow();
  });
}
