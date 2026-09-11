import { AlertTriangle, FlaskConical, Unplug } from 'lucide-react';
import { SOURCE_LABEL } from '../format';
import { useNow } from '../hooks';
import { reconnectNow } from '../socket';
import { shallowEqual, useStore } from '../store';
import s from './shell.module.css';

/**
 * Explains, in one line, why the data on screen might not be live device data:
 * backend unreachable, device signal lost (countdown to simulation), or simulated.
 * Renders nothing when real telemetry is flowing.
 */
export function SourceBanner() {
  const v = useStore(
    (st) => ({
      ws: st.ws.state,
      retryAt: st.ws.retryAt,
      attempt: st.ws.attempt,
      source: st.latest?.source,
      simulated: st.status?.simulated ?? false,
      simulationEnabled: st.status?.simulationEnabled ?? true,
      simTimeoutMs: st.status?.simTimeoutMs ?? 5000,
      lastRealAgoMs: st.status?.lastRealAgoMs ?? null,
      lastRealSource: st.status?.lastRealSource ?? null,
      lan: st.status?.lanAddresses[0] ?? null,
      port: st.status?.port ?? 8080,
    }),
    shallowEqual,
  );
  const needsClock = v.ws === 'closed';
  const now = useNow(needsClock ? 250 : 60_000);

  if (v.ws !== 'open') {
    if (v.ws === 'connecting' && v.attempt === 0) return null; // first connect — don't flash a warning
    const secs = v.retryAt ? Math.max(0, (v.retryAt - now) / 1000) : 0;
    return (
      <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
        <Unplug size={15} className={s.bannerIcon} />
        <div className={s.bannerBody}>
          <span className={s.bannerStrong}>BACKEND UNREACHABLE</span>
          {v.ws === 'connecting' ? 'reconnecting…' : `retrying in ${secs.toFixed(1)}s (attempt ${v.attempt})`}
          {' '}— values below are frozen at the last update.
        </div>
        <button type="button" className={s.bannerBtn} onClick={reconnectNow}>retry now</button>
      </div>
    );
  }

  const real = v.source === 'serial' || v.source === 'wifi';
  const quietMs = v.lastRealAgoMs ?? Infinity;

  if (real && quietMs > 2500) {
    const takeover = Math.max(0, (v.simTimeoutMs - quietMs) / 1000);
    return (
      <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
        <AlertTriangle size={15} className={s.bannerIcon} />
        <div className={s.bannerBody}>
          <span className={s.bannerStrong}>DEVICE SIGNAL LOST</span>
          no telemetry via {v.lastRealSource ? SOURCE_LABEL[v.lastRealSource] : 'device'} for {(quietMs / 1000).toFixed(0)}s
          {v.simulationEnabled ? ` — simulation takes over in ${takeover.toFixed(0)}s` : ' — showing last received values'}
        </div>
      </div>
    );
  }

  if (v.source === 'simulated' || (!v.source && v.simulated)) {
    const host = v.lan ? `http://${v.lan}:${v.port}` : `this machine :${v.port}`;
    return (
      <div className={`${s.banner} ${s.bannerSim}`} role="status">
        <FlaskConical size={15} className={s.bannerIcon} />
        <div className={s.bannerBody}>
          <span className={s.bannerStrong}>SIMULATED DATA</span>
          {v.lastRealAgoMs == null ? 'no device has reported yet' : `no device telemetry for ${(quietMs / 1000).toFixed(0)}s`}.
          {' '}Connect the module over USB in the Control tab, or point its WiFi at <code>{host}/api/telemetry</code>.
        </div>
      </div>
    );
  }

  return null;
}
