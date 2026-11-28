import { useEffect } from 'preact/hooks';
import { CollectionScreen } from '../ui/CollectionScreen';
import { DetailSheet } from '../ui/DetailSheet';
import { IconBook, IconGear, IconScan, IconSearch, IconStack, IconWifiOff } from '../ui/icons';
import { ScanScreen } from '../ui/ScanScreen';
import { SearchScreen } from '../ui/SearchScreen';
import { SessionScreen } from '../ui/SessionScreen';
import { SettingsScreen } from '../ui/SettingsScreen';
import { online, sessionTotals, tab, toasts, type Tab } from './state';

const TABS: { id: Tab; label: string; icon: typeof IconScan }[] = [
  { id: 'scan', label: 'Scan', icon: IconScan },
  { id: 'session', label: 'Session', icon: IconStack },
  { id: 'collection', label: 'Collection', icon: IconBook },
  { id: 'search', label: 'Search', icon: IconSearch },
  { id: 'settings', label: 'Settings', icon: IconGear },
];

export function App() {
  const t = tab.value;
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#', '') as Tab;
      if (TABS.some((x) => x.id === h)) tab.value = h;
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (location.hash !== `#${t}`) history.replaceState(null, '', `#${t}`);
  }, [t]);

  return (
    <>
      {/* the scan screen stays mounted so returning to it is instant; its camera only runs while active */}
      <div style={{ display: t === 'scan' ? 'contents' : 'none' }}>
        <ScanScreen active={t === 'scan'} />
      </div>
      {t === 'session' && <SessionScreen />}
      {t === 'collection' && <CollectionScreen />}
      {t === 'search' && <SearchScreen />}
      {t === 'settings' && <SettingsScreen />}
      <nav class="tabbar" aria-label="Main">
        {TABS.map((x) => (
          <button key={x.id} aria-current={t === x.id ? 'page' : undefined} onClick={() => (tab.value = x.id)}>
            <x.icon />
            {x.id === 'session' && sessionTotals.value.count > 0 ? `${x.label} (${sessionTotals.value.count})` : x.label}
          </button>
        ))}
      </nav>
      <DetailSheet />
      <div class="toasts" role="status" aria-live="polite">
        {!online.value && (
          <div class="toast">
            <IconWifiOff width={18} height={18} /> Offline — scanning works, prices are from the last sync
          </div>
        )}
        {toasts.value.map((x) => (
          <div key={x.id} class={`toast ${x.tone ?? ''}`}>
            {x.text}
            {x.action && (
              <button
                onClick={() => {
                  x.action!.run();
                  toasts.value = toasts.value.filter((y) => y.id !== x.id);
                }}
              >
                {x.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
