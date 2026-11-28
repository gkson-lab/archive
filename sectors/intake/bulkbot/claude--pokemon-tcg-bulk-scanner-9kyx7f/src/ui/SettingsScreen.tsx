import { useEffect, useState } from 'preact/hooks';
import { cardCount } from '../data/catalog';
import { db, kvGet } from '../data/db';
import { syncNewSets } from '../data/live';
import { CONDITIONS, formatMoney, type RarityClass } from '../pricing/pricing';
import type { CatalogManifest, IndexManifest } from '../shared/types';
import { syncCatalog, startOcr } from '../app/boot';
import {
  catalogState,
  catalogVersion,
  indexState,
  modelState,
  ocrState,
  online,
  settings,
  toast,
  updatePriceSettings,
  updateSettings,
  type LoadState,
} from '../app/state';
import { Switch, fmtDate } from './common';

function Num({ value, onChange, step = 0.01, min = 0, label }: { value: number; onChange: (v: number) => void; step?: number; min?: number; label: string }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      value={value}
      aria-label={label}
      onChange={(e) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (!Number.isNaN(v) && v >= min) onChange(v);
      }}
    />
  );
}

const RATE_LABEL: Record<RarityClass, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare (non-holo)',
  holo: 'Holo rare',
  reverse: 'Reverse holo',
  ultra: 'Ultra rare (ex, V, GX…)',
};

export function SettingsScreen() {
  const s = settings.value;
  const p = s.price;
  const cur = p.source === 'tcgplayer' ? 'USD' : 'EUR';
  const [meta, setMeta] = useState<{ catalog?: CatalogManifest; index?: IndexManifest; usage?: number; quota?: number }>({});
  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      setMeta({ catalog: await kvGet('catalogManifest'), index: await kvGet('indexManifest'), usage: est?.usage, quota: est?.quota });
    })();
  }, [catalogVersion.value]);

  return (
    <div class="screen">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <div class="sub">Everything runs on this device. No account, no ads.</div>
        </div>
      </div>

      <div class="settings-group">
        <h2>Scanning</h2>
        <div class="setting">
          <div class="lbl">
            Auto-capture
            <small>Lock cards automatically once they're recognized</small>
          </div>
          <Switch checked={s.autoCapture} onChange={(v) => void updateSettings({ autoCapture: v })} label="Auto-capture" />
        </div>
        <div class="setting">
          <div class="lbl">
            Read card numbers (OCR)
            <small>Confirms the exact printing and set. Uses a 6 MB text reader.</small>
          </div>
          <Switch
            checked={s.useOcr}
            onChange={(v) => {
              void updateSettings({ useOcr: v });
              if (v) void startOcr();
            }}
            label="OCR"
          />
        </div>
        <div class="setting">
          <div class="lbl">
            Lock sensitivity
            <small>{s.lockConfidence < 0.75 ? 'Fast — locks sooner, may need more corrections' : s.lockConfidence > 0.88 ? 'Strict — waits for more certainty' : 'Balanced'}</small>
          </div>
          <input type="range" min={0.6} max={0.95} step={0.05} value={s.lockConfidence} onInput={(e) => void updateSettings({ lockConfidence: Number((e.target as HTMLInputElement).value) })} aria-label="Lock sensitivity" />
        </div>
        <div class="setting">
          <div class="lbl">Sound</div>
          <Switch checked={s.sound} onChange={(v) => void updateSettings({ sound: v })} label="Sound" />
        </div>
        <div class="setting">
          <div class="lbl">Haptics</div>
          <Switch checked={s.haptics} onChange={(v) => void updateSettings({ haptics: v })} label="Haptics" />
        </div>
        <div class="setting">
          <div class="lbl">
            Keep scan photos
            <small>Small snapshot of each scan so you can double-check later</small>
          </div>
          <Switch checked={s.keepScanPhotos} onChange={(v) => void updateSettings({ keepScanPhotos: v })} label="Keep scan photos" />
        </div>
        <div class="setting">
          <div class="lbl">
            Add scans to collection
            <small>Mark every scanned card as owned</small>
          </div>
          <Switch checked={s.autoAddToCollection} onChange={(v) => void updateSettings({ autoAddToCollection: v })} label="Auto add to collection" />
        </div>
      </div>

      <div class="settings-group">
        <h2>Pricing</h2>
        <div class="setting stack">
          <div class="lbl">
            Price source
            <small>TCGplayer (USD) from the Pokémon TCG API, or Cardmarket (EUR) via TCGdex</small>
          </div>
          <div class="chips">
            <button class="chip small" aria-pressed={p.source === 'tcgplayer'} onClick={() => void updatePriceSettings({ source: 'tcgplayer' })}>
              TCGplayer
            </button>
            <button class="chip small" aria-pressed={p.source === 'cardmarket'} onClick={() => void updatePriceSettings({ source: 'cardmarket' })}>
              Cardmarket
            </button>
          </div>
        </div>
        <div class="setting">
          <div class="lbl">
            Hit threshold
            <small>Cards worth at least this flash gold</small>
          </div>
          <Num value={p.hitThreshold} step={0.25} label="Hit threshold" onChange={(v) => void updatePriceSettings({ hitThreshold: v })} />
        </div>
        <div class="setting stack">
          <div class="lbl">Default condition</div>
          <div class="chips">
            {CONDITIONS.map((c) => (
              <button key={c} class="chip small" aria-pressed={s.defaultCondition === c} onClick={() => void updateSettings({ defaultCondition: c })}>
                {c}
              </button>
            ))}
          </div>
        </div>
        {CONDITIONS.slice(1).map((c) => (
          <div class="setting" key={c}>
            <div class="lbl">
              {c} multiplier
              <small>Share of Near Mint value</small>
            </div>
            <Num value={p.condition[c]} step={0.05} label={`${c} multiplier`} onChange={(v) => void updatePriceSettings({ condition: { ...p.condition, [c]: Math.min(1, v) } })} />
          </div>
        ))}
      </div>

      <div class="settings-group">
        <h2>Bulk floor</h2>
        <div class="setting">
          <div class="lbl">
            Value cheap cards at buylist rates
            <small>Cards under the threshold count at bulk prices instead of market</small>
          </div>
          <Switch checked={p.bulkFloor.enabled} onChange={(v) => void updatePriceSettings({ bulkFloor: { ...p.bulkFloor, enabled: v } })} label="Bulk floor" />
        </div>
        <div class="setting">
          <div class="lbl">Threshold ({cur})</div>
          <Num value={p.bulkFloor.threshold} step={0.05} label="Bulk threshold" onChange={(v) => void updatePriceSettings({ bulkFloor: { ...p.bulkFloor, threshold: v } })} />
        </div>
        {(Object.keys(RATE_LABEL) as RarityClass[]).map((k) => (
          <div class="setting" key={k}>
            <div class="lbl">
              {RATE_LABEL[k]}
              <small>{formatMoney(p.bulkFloor.rates[k] * 1000, cur)} per 1,000</small>
            </div>
            <Num value={p.bulkFloor.rates[k]} step={0.005} label={`${RATE_LABEL[k]} rate`} onChange={(v) => void updatePriceSettings({ bulkFloor: { ...p.bulkFloor, rates: { ...p.bulkFloor.rates, [k]: v } } })} />
          </div>
        ))}
      </div>

      <div class="settings-group">
        <h2>Estimates for printings without their own price</h2>
        {(
          [
            ['reverseVsNormal', 'Reverse holo vs normal'],
            ['firstEdVsUnlimited', '1st Edition vs unlimited'],
            ['shadowlessVsUnlimited', 'Shadowless vs unlimited'],
            ['pokeballVsReverse', 'Poké Ball vs reverse'],
            ['masterballVsReverse', 'Master Ball vs reverse'],
            ['stamped', 'Promo stamp'],
          ] as const
        ).map(([k, label]) => (
          <div class="setting" key={k}>
            <div class="lbl">
              {label}
              <small>Used only when no source prices that printing; shown as "est."</small>
            </div>
            <Num value={p.estimate[k]} step={0.1} label={label} onChange={(v) => void updatePriceSettings({ estimate: { ...p.estimate, [k]: v } })} />
          </div>
        ))}
      </div>

      <div class="settings-group">
        <h2>Data</h2>
        <Status label="Card database" st={catalogState.value} extra={meta.catalog ? `snapshot ${fmtDate(meta.catalog.builtAt)} · ${cardCount().toLocaleString()} cards` : undefined} />
        <Status label="Card index" st={indexState.value} extra={meta.index ? `built ${fmtDate(meta.index.builtAt)}` : undefined} />
        <Status label="Recognition model" st={modelState.value} />
        <Status label="Text reader (OCR)" st={ocrState.value} />
        <div class="setting">
          <div class="lbl">
            Storage used
            <small>{meta.usage ? `${(meta.usage / 1e6).toFixed(0)} MB of ${(meta.quota! / 1e9).toFixed(1)} GB available` : 'unknown'}</small>
          </div>
        </div>
        <div class="setting">
          <button
            class="btn block"
            disabled={!online.value}
            onClick={async () => {
              toast('Syncing…');
              await syncCatalog();
              const n = await syncNewSets(true);
              catalogVersion.value++;
              toast(n ? `${n} new set${n > 1 ? 's' : ''} added` : 'Card database is up to date', { tone: 'success' });
            }}
          >
            {online.value ? 'Sync now' : 'Offline'}
          </button>
        </div>
        <div class="setting">
          <button
            class="btn block danger"
            onClick={async () => {
              if (!confirm('Delete the downloaded card database and index? Your sessions and collection are kept.')) return;
              const d = await db();
              for (const store of ['cards', 'prices', 'sets', 'blobs', 'localVectors', 'history'] as const) await d.clear(store);
              await d.delete('kv', 'catalogManifest');
              await d.delete('kv', 'indexManifest');
              location.reload();
            }}
          >
            Clear downloaded data
          </button>
        </div>
      </div>
      <p class="small muted" style={{ textAlign: 'center' }}>
        BulkBot · card data from the Pokémon TCG API and TCGdex · prices are estimates, not offers. Not affiliated with Nintendo, The Pokémon Company, TCGplayer or Cardmarket.
      </p>
    </div>
  );
}

function Status({ label, st, extra }: { label: string; st: LoadState; extra?: string }) {
  const color = st.state === 'ready' ? 'var(--good)' : st.state === 'error' ? 'var(--bad)' : st.state === 'loading' ? 'var(--blue)' : 'var(--faint)';
  return (
    <div class="setting">
      <span class="dot" style={{ background: color }} />
      <div class="lbl">
        {label}
        <small>
          {st.message ?? st.state}
          {st.state === 'loading' && st.progress > 0 ? ` · ${Math.round(st.progress * 100)}%` : ''}
          {extra ? ` · ${extra}` : ''}
        </small>
      </div>
    </div>
  );
}
