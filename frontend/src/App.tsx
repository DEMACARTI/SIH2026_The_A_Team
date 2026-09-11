import { Activity, Radio, Sliders, Waves, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AdaptPanel } from './components/AdaptPanel';
import { ArchitecturePanel } from './components/ArchitectureDiagram';
import { ConsoleLog } from './components/ConsoleLog';
import { ControlPanel } from './components/ControlPanel';
import { Header } from './components/Header';
import { SignalPanel } from './components/SignalPanel';
import { SourceBanner } from './components/SourceBanner';
import { TelemetryStrip } from './components/TelemetryStrip';
import { useStore } from './store';
import s from './components/shell.module.css';

type TabId = 'arch' | 'signal' | 'adapt' | 'control';

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'arch', label: 'Architecture', icon: Radio },
  { id: 'signal', label: 'Signal', icon: Waves },
  { id: 'adapt', label: 'Adaptive logic', icon: Activity },
  { id: 'control', label: 'Control', icon: Sliders },
];

const tabFromHash = (): TabId => {
  const h = location.hash.slice(1);
  return TABS.some((t) => t.id === h) ? (h as TabId) : 'arch';
};

/**
 * Shell only: re-renders on tab switches and backend link changes. Every
 * telemetry-driven component subscribes to the store itself.
 */
export default function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const stale = useStore((st) => st.ws.state !== 'open' && st.latest !== null);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (id: TabId) => {
    setTab(id);
    history.replaceState(null, '', `#${id}`);
  };

  return (
    <div className={s.app}>
      <Header />
      <SourceBanner />
      <div className={`${s.data} ${stale ? s.stale : ''}`}>
        <TelemetryStrip />
        <nav className={s.tabs} role="tablist" aria-label="Views">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id}
              className={`${s.tab} ${tab === id ? s.tabActive : ''}`} onClick={() => select(id)}>
              <Icon size={13} aria-hidden /> {label}
            </button>
          ))}
        </nav>
        <main className={s.content} role="tabpanel">
          {tab === 'arch' && <ArchitecturePanel />}
          {tab === 'signal' && <SignalPanel />}
          {tab === 'adapt' && <AdaptPanel />}
          {tab === 'control' && <ControlPanel />}
        </main>
      </div>
      <ConsoleLog />
    </div>
  );
}
