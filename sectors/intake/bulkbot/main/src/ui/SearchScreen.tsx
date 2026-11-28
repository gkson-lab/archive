import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getCard, putLiveCards, searchCatalog, type SearchHit } from '../data/catalog';
import { searchOnline } from '../data/api';
import { defaultVariant, formatMoney, quote } from '../pricing/pricing';
import { eraInfo } from '../shared/era';
import { addScan, catalogVersion, detail, online, settings, tab, toast, updateScan } from '../app/state';
import { CardImg } from './common';
import { IconSearch, IconX } from './icons';

export function SearchScreen() {
  void catalogVersion.value;
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [onlineHits, setOnlineHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const replacing = sessionStorage.getItem('bulkbot:replace');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 140);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => setOnlineHits(null), [debounced]);

  const hits = useMemo(() => (debounced.trim().length >= 2 ? searchCatalog(debounced) : []), [debounced, catalogVersion.value]);

  const pick = async (id: string) => {
    if (replacing) {
      sessionStorage.removeItem('bulkbot:replace');
      const card = getCard(id);
      await updateScan(replacing, { cardId: id, variant: card ? defaultVariant(card) : undefined });
      toast(`Replaced with ${card?.name}`, { tone: 'success' });
      tab.value = 'session';
      detail.value = { scanId: replacing };
      return;
    }
    detail.value = { cardId: id };
  };

  const quickAdd = async (id: string) => {
    await addScan(id, { confidence: 1 });
    toast(`Added ${getCard(id)?.name}`, { tone: 'success', action: { label: 'Scan', run: () => (tab.value = 'scan') } });
  };

  const searchApis = async () => {
    setBusy(true);
    try {
      const found = await searchOnline(debounced.replace(/\d+\s*\/\s*\d+/, '').trim() || debounced);
      await putLiveCards(found);
      catalogVersion.value++;
      setOnlineHits(found.map((f) => ({ card: getCard(f.card.id) ?? f.card, score: 1 })));
    } catch {
      toast('The card APIs did not answer. Try again in a bit.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const list = onlineHits ?? hits;
  return (
    <div class="screen">
      <div class="page-head">
        <div style={{ flex: 1 }}>
          <h1>{replacing ? 'Replace card' : 'Search'}</h1>
          <div class="sub">Name, number (4/102, 025/198, TG12), or set code + number (PAL 123)</div>
        </div>
        {replacing && (
          <button
            class="chip small"
            onClick={() => {
              sessionStorage.removeItem('bulkbot:replace');
              tab.value = 'session';
            }}
          >
            Cancel
          </button>
        )}
      </div>
      <div class="search-box">
        <IconSearch />
        <input
          ref={input}
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="charizard, 58/102, swsh4 25…"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          aria-label="Search cards"
        />
        {q && (
          <button onClick={() => setQ('')} aria-label="Clear">
            <IconX />
          </button>
        )}
      </div>
      {debounced.trim().length < 2 ? (
        <div class="empty-state">
          <IconSearch />
          <h2>Find any card</h2>
          <p>For cards too damaged to scan. Results come from the on-device database, so search works offline.</p>
        </div>
      ) : list.length === 0 ? (
        <div class="empty-state">
          <h2>No matches on this device</h2>
          <p>{online.value ? 'Try the live card APIs (new or rare promos might not be in the snapshot yet).' : "You're offline — connect to search the live APIs."}</p>
          {online.value && (
            <button class="btn primary" onClick={searchApis} disabled={busy}>
              {busy ? 'Searching…' : 'Search online'}
            </button>
          )}
        </div>
      ) : (
        <div class="list">
          {list.map(({ card }) => {
            const full = getCard(card.id) ?? card;
            const qv = quote(full, defaultVariant(full), settings.value.defaultCondition, settings.value.price);
            return (
              <div key={card.id} class="item">
                <button class="hit-area" onClick={() => void pick(card.id)}>
                  <CardImg card={full} />
                  <div class="main">
                    <b>{full.name}</b>
                    <small>
                      {full.set?.name ?? full.setId} · #{full.number}
                      {full.set?.printedTotal && /^\d+$/.test(full.number) ? `/${full.set.printedTotal}` : ''}
                    </small>
                    <div class="tags">
                      {full.set && (
                        <span class="tag" style={{ color: eraInfo(full.set.era).color }}>
                          {eraInfo(full.set.era, full.set.series).short}
                        </span>
                      )}
                      {full.rarity && <span class="tag">{full.rarity}</span>}
                    </div>
                  </div>
                  <div class="val">{qv.hasPrice ? formatMoney(qv.rawUnit, qv.currency) : <span class="muted small">no price</span>}</div>
                </button>
                {!replacing && (
                  <button class="add" onClick={() => void quickAdd(card.id)} aria-label={`Add ${full.name} to session`}>
                    +
                  </button>
                )}
              </div>
            );
          })}
          {!onlineHits && online.value && (
            <button class="btn block" onClick={searchApis} disabled={busy}>
              {busy ? 'Searching the APIs…' : 'Not here? Search the live APIs'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
