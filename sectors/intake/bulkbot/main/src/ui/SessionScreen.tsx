import { useMemo, useState } from 'preact/hooks';
import { getCard } from '../data/catalog';
import { FINISH_LABEL, formatMoney } from '../pricing/pricing';
import { ERAS, eraInfo, eraOrder } from '../shared/era';
import { safeName, sessionCsv, shareOrDownload, tcgplayerMassEntry } from '../sessions/export';
import {
  addSessionToCollection,
  currency,
  currentSession,
  deleteSession,
  detail,
  newSession,
  openSession,
  renameSession,
  scanViews,
  sessionId,
  sessionTotals,
  sessions,
  settings,
  tab,
  toast,
  type ScanView,
} from '../app/state';
import { CardImg, Sheet } from './common';
import { IconDownload, IconPlus, IconStack } from './icons';

type SortKey = 'value' | 'recent' | 'name' | 'set' | 'era' | 'rarity' | 'type';

export function SessionScreen() {
  const [sort, setSort] = useState<SortKey>('value');
  const [era, setEra] = useState('');
  const [rarity, setRarity] = useState('');
  const [type, setType] = useState('');
  const [hitsOnly, setHitsOnly] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const totals = sessionTotals.value;
  const views = scanViews.value;

  const rows = useMemo(() => {
    const decorated = views.map((v) => ({ v, card: getCard(v.scan.cardId) }));
    let list = decorated.filter(({ v, card }) => {
      if (hitsOnly && !v.quote.isHit) return false;
      if (era && card?.set?.era !== era) return false;
      if (rarity && (card?.rarity ?? 'Unknown') !== rarity) return false;
      if (type && !(card?.types ?? [card?.supertype ?? '']).includes(type)) return false;
      return true;
    });
    const by: Record<SortKey, (a: (typeof list)[0], b: (typeof list)[0]) => number> = {
      value: (a, b) => b.v.total - a.v.total,
      recent: (a, b) => b.v.scan.addedAt - a.v.scan.addedAt,
      name: (a, b) => (a.card?.name ?? '').localeCompare(b.card?.name ?? ''),
      set: (a, b) => (a.card?.set?.releaseDate ?? '').localeCompare(b.card?.set?.releaseDate ?? '') || (a.card?.number ?? '').localeCompare(b.card?.number ?? '', 'en', { numeric: true }),
      era: (a, b) => eraOrder(a.card?.set?.era ?? '') - eraOrder(b.card?.set?.era ?? '') || b.v.total - a.v.total,
      rarity: (a, b) => (a.card?.rarity ?? '').localeCompare(b.card?.rarity ?? '') || b.v.total - a.v.total,
      type: (a, b) => (a.card?.types?.[0] ?? a.card?.supertype ?? '').localeCompare(b.card?.types?.[0] ?? b.card?.supertype ?? '') || b.v.total - a.v.total,
    };
    list = [...list].sort(by[sort]);
    return list;
  }, [views, sort, era, rarity, type, hitsOnly]);

  const facets = useMemo(() => {
    const eras = new Set<string>();
    const rarities = new Set<string>();
    const types = new Set<string>();
    for (const v of views) {
      const c = getCard(v.scan.cardId);
      if (c?.set) eras.add(c.set.era);
      rarities.add(c?.rarity ?? 'Unknown');
      for (const t of c?.types ?? [c?.supertype ?? '']) if (t) types.add(t);
    }
    return {
      eras: [...eras].sort((a, b) => eraOrder(a) - eraOrder(b)),
      rarities: [...rarities].sort(),
      types: [...types].sort(),
    };
  }, [views]);

  const s = currentSession.value;
  return (
    <div class="screen">
      <div class="page-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1
            style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            onClick={() => {
              const name = prompt('Session name', s?.name ?? '');
              if (name && s) void renameSession(s.id, name);
            }}
          >
            {s?.name ?? 'Session'}
          </h1>
          <div class="sub">Tap the name to rename · {sessions.value.length} saved session{sessions.value.length === 1 ? '' : 's'}</div>
        </div>
        <button class="icon-btn" onClick={() => setShowSessions(true)} aria-label="All sessions">
          <IconStack />
        </button>
        <button class="icon-btn" onClick={() => setShowExport(true)} aria-label="Export" disabled={!views.length}>
          <IconDownload />
        </button>
      </div>

      <div class="stat-row">
        <div class="stat">
          <span>Value</span>
          <b>{formatMoney(totals.value, currency.value)}</b>
        </div>
        <div class="stat">
          <span>Cards</span>
          <b>{totals.count}</b>
        </div>
        <div class={`stat ${totals.hits ? 'gold' : ''}`}>
          <span>Hits ≥ {formatMoney(settings.value.price.hitThreshold, currency.value)}</span>
          <b>{totals.hits}</b>
        </div>
      </div>
      {settings.value.price.bulkFloor.enabled && totals.floored > 0 && (
        <div class="small muted" style={{ marginTop: -6, marginBottom: 10 }}>
          {totals.floored} card{totals.floored === 1 ? '' : 's'} under {formatMoney(settings.value.price.bulkFloor.threshold, currency.value)} valued at bulk rates
        </div>
      )}

      <div class="toolbar">
        <select class="chip small" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)} aria-label="Sort by">
          <option value="value">Sort: Value</option>
          <option value="recent">Sort: Recent</option>
          <option value="name">Sort: Name</option>
          <option value="set">Sort: Set</option>
          <option value="era">Sort: Era</option>
          <option value="rarity">Sort: Rarity</option>
          <option value="type">Sort: Type</option>
        </select>
        <button class="chip small" aria-pressed={hitsOnly} onClick={() => setHitsOnly(!hitsOnly)}>
          Hits only
        </button>
        <select class="chip small" value={era} onChange={(e) => setEra((e.target as HTMLSelectElement).value)} aria-label="Filter by era">
          <option value="">All eras</option>
          {facets.eras.map((e) => (
            <option key={e} value={e}>
              {eraInfo(e).label}
            </option>
          ))}
        </select>
        <select class="chip small" value={rarity} onChange={(e) => setRarity((e.target as HTMLSelectElement).value)} aria-label="Filter by rarity">
          <option value="">All rarities</option>
          {facets.rarities.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select class="chip small" value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)} aria-label="Filter by type">
          <option value="">All types</option>
          {facets.types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {views.length === 0 ? (
        <div class="empty-state">
          <IconStack />
          <h2>No cards in this session yet</h2>
          <p>Head to Scan and hold cards in front of the camera. They'll pile up here with prices.</p>
          <button class="btn primary" onClick={() => (tab.value = 'scan')}>
            Start scanning
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div class="empty-state">
          <h2>Nothing matches these filters</h2>
        </div>
      ) : (
        <div class="list">
          {rows.map(({ v, card }) => (
            <Row key={v.scan.id} v={v} name={card?.name} />
          ))}
        </div>
      )}

      {showSessions && <SessionsSheet onClose={() => setShowSessions(false)} />}
      {showExport && (
        <Sheet onClose={() => setShowExport(false)} label="Export session">
          <h3>Export</h3>
          <p class="muted small">CSV opens in Excel, Numbers and Google Sheets. Mass Entry text pastes into TCGplayer's Mass Entry box.</p>
          <div class="list">
            <button
              class="btn block"
              onClick={() => {
                void shareOrDownload(`${safeName(s?.name ?? 'session')}.csv`, sessionCsv(views.map((x) => x.scan), settings.value.price));
                setShowExport(false);
              }}
            >
              Download CSV (all details)
            </button>
            <button
              class="btn block"
              onClick={() => {
                void shareOrDownload(`${safeName(s?.name ?? 'session')}-tcgplayer.txt`, tcgplayerMassEntry(views.map((x) => x.scan)), 'text/plain');
                setShowExport(false);
              }}
            >
              TCGplayer Mass Entry (.txt)
            </button>
            <button
              class="btn block"
              onClick={async () => {
                await navigator.clipboard?.writeText(tcgplayerMassEntry(views.map((x) => x.scan)));
                toast('Mass Entry list copied', { tone: 'success' });
                setShowExport(false);
              }}
            >
              Copy Mass Entry to clipboard
            </button>
            <button
              class="btn block"
              onClick={async () => {
                const n = await addSessionToCollection();
                toast(`${n} cards marked as owned`, { tone: 'success' });
                setShowExport(false);
              }}
            >
              Add all to my collection
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Row({ v, name }: { v: ScanView; name?: string }) {
  const card = getCard(v.scan.cardId);
  const variant = v.scan.variant;
  return (
    <button class={`item ${v.quote.isHit ? 'hit' : ''}`} onClick={() => (detail.value = { scanId: v.scan.id })}>
      <CardImg card={card} />
      <div class="main">
        <b>
          {v.scan.qty > 1 ? `${v.scan.qty}× ` : ''}
          {name ?? 'Unknown card'}
        </b>
        <small>
          {card?.set?.name ?? card?.setId} · #{card?.number}
        </small>
        <div class="tags">
          {card?.set && (
            <span class="tag" style={{ color: eraInfo(card.set.era).color }}>
              {eraInfo(card.set.era, card.set.series).short}
            </span>
          )}
          {variant.finish !== 'normal' && <span class="tag">{FINISH_LABEL[variant.finish]}</span>}
          {variant.edition !== 'unlimited' && <span class="tag">{variant.edition === '1st' ? '1st Ed' : 'Shadowless'}</span>}
          {variant.stamped && <span class="tag">Stamp</span>}
          {v.scan.condition !== 'NM' && <span class="tag">{v.scan.condition}</span>}
          {v.quote.isHit && <span class="tag gold">HIT</span>}
          {v.scan.confidence < 0.75 && <span class="tag" style={{ color: 'var(--warn)' }}>check</span>}
        </div>
      </div>
      <div class="val">
        {v.quote.hasPrice || v.quote.bulkFloored ? formatMoney(v.total, v.quote.currency) : <span class="muted">no price</span>}
        <small>
          {v.scan.qty > 1 ? `${formatMoney(v.quote.unit, v.quote.currency)} ea` : v.quote.bulkFloored ? 'bulk rate' : v.quote.estimated ? 'est.' : ''}
        </small>
      </div>
    </button>
  );
}

function SessionsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onClose={onClose} label="Sessions">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ flex: 1 }}>Sessions</h3>
        <button
          class="btn primary"
          onClick={async () => {
            const name = prompt('Name for the new session', '') ?? undefined;
            await newSession(name || undefined);
            onClose();
            tab.value = 'scan';
          }}
        >
          <IconPlus width={18} height={18} /> New
        </button>
      </div>
      <div class="list">
        {sessions.value.map((x) => (
          <div key={x.id} class="item" style={{ cursor: 'pointer' }}>
            <div class="main" onClick={() => void openSession(x.id).then(onClose)}>
              <b>
                {x.id === sessionId.value ? '● ' : ''}
                {x.name}
              </b>
              <small>Updated {new Date(x.updatedAt).toLocaleString()}</small>
            </div>
            <button
              class="btn small"
              style={{ minHeight: 36 }}
              onClick={() => {
                const name = prompt('Rename session', x.name);
                if (name) void renameSession(x.id, name);
              }}
            >
              Rename
            </button>
            <button
              class="btn danger"
              style={{ minHeight: 36 }}
              onClick={() => {
                if (confirm(`Delete "${x.name}" and its scans?`)) void deleteSession(x.id);
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <p class="small muted" style={{ marginTop: 12 }}>
        Sessions are saved on this device. Eras: {ERAS.map((e) => e.short).join(' · ')}
      </p>
    </Sheet>
  );
}
