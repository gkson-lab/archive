import { useMemo, useState } from 'preact/hooks';
import { allSets, setCards } from '../data/catalog';
import { eraInfo, eraOrder } from '../shared/era';
import type { SetInfo } from '../shared/types';
import { catalogState, catalogVersion, collection, detail, setOwned } from '../app/state';
import { CardImg, EraBadge } from './common';
import { IconBook, IconChevron } from './icons';

export function CollectionScreen() {
  void catalogVersion.value;
  const [openSet, setOpenSet] = useState<SetInfo | null>(null);
  const [onlyStarted, setOnlyStarted] = useState(true);
  const owned = collection.value;
  const sets = useMemo(() => allSets().sort((a, b) => eraOrder(a.era) - eraOrder(b.era) || a.releaseDate.localeCompare(b.releaseDate)), [catalogVersion.value]);
  const stats = useMemo(() => {
    const m = new Map<string, { owned: number; total: number; base: number; ownedBase: number }>();
    for (const s of sets) {
      const cards = setCards(s.id);
      let o = 0;
      let ob = 0;
      let base = 0;
      for (const c of cards) {
        const isBase = /^\d+$/.test(c.number) && Number(c.number) <= s.printedTotal;
        if (isBase) base++;
        if (owned.has(c.id)) {
          o++;
          if (isBase) ob++;
        }
      }
      m.set(s.id, { owned: o, total: cards.length, base: base || s.printedTotal, ownedBase: ob });
    }
    return m;
  }, [sets, owned]);

  if (openSet) return <SetView set={openSet} onBack={() => setOpenSet(null)} />;

  const totalOwned = owned.size;
  const visible = sets.filter((s) => !onlyStarted || (stats.get(s.id)?.owned ?? 0) > 0);
  const byEra = new Map<string, SetInfo[]>();
  for (const s of visible) byEra.set(s.era, [...(byEra.get(s.era) ?? []), s]);

  return (
    <div class="screen">
      <div class="page-head">
        <div style={{ flex: 1 }}>
          <h1>Collection</h1>
          <div class="sub">
            {totalOwned.toLocaleString()} cards owned · {[...stats.values()].filter((x) => x.owned > 0).length} sets started
          </div>
        </div>
      </div>
      <div class="toolbar">
        <button class="chip small" aria-pressed={onlyStarted} onClick={() => setOnlyStarted(true)}>
          Started sets
        </button>
        <button class="chip small" aria-pressed={!onlyStarted} onClick={() => setOnlyStarted(false)}>
          All sets
        </button>
      </div>
      {catalogState.value.state !== 'ready' && sets.length === 0 ? (
        <div class="empty-state">
          <h2>Loading the card database…</h2>
        </div>
      ) : visible.length === 0 ? (
        <div class="empty-state">
          <IconBook />
          <h2>Your collection is empty</h2>
          <p>Mark cards as owned from any card's details, or add a whole scan session from the Session export menu. Then track set completion here.</p>
          <button class="btn" onClick={() => setOnlyStarted(false)}>
            Browse all sets
          </button>
        </div>
      ) : (
        [...byEra].map(([era, list]) => (
          <div key={era}>
            <div class="era-title">
              <EraBadge era={era} series={list[0]?.series} />
            </div>
            <div class="list">
              {list.map((s) => {
                const st = stats.get(s.id)!;
                const pct = st.base ? Math.min(100, Math.round((st.ownedBase / st.base) * 100)) : 0;
                return (
                  <button key={s.id} class="set-row" onClick={() => setOpenSet(s)}>
                    {s.symbol ? <img src={s.symbol} alt="" loading="lazy" /> : <span />}
                    <div>
                      <b>{s.name}</b>
                      <small>
                        {' '}
                        · {st.ownedBase}/{st.base}
                        {st.total > st.base ? ` (+${st.owned - st.ownedBase}/${st.total - st.base} secret)` : ''}
                      </small>
                      <div class="progress" style={{ marginTop: 6 }}>
                        <i style={{ width: `${pct}%`, background: pct === 100 ? 'var(--good)' : undefined }} />
                      </div>
                    </div>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 800 }}>
                      {pct}% <IconChevron width={16} height={16} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SetView({ set, onBack }: { set: SetInfo; onBack: () => void }) {
  const owned = collection.value;
  const cards = useMemo(() => setCards(set.id).sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true })), [set.id]);
  const [editing, setEditing] = useState(false);
  const n = cards.filter((c) => owned.has(c.id)).length;
  return (
    <div class="screen">
      <div class="page-head">
        <button class="icon-btn" onClick={onBack} aria-label="Back" style={{ transform: 'rotate(180deg)' }}>
          <IconChevron />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 22 }}>{set.name}</h1>
          <div class="sub">
            {eraInfo(set.era, set.series).label} · {set.releaseDate.slice(0, 4)} · {n}/{cards.length} owned
          </div>
        </div>
        <button class={`chip small`} aria-pressed={editing} onClick={() => setEditing(!editing)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      <p class="small muted" style={{ marginTop: 0 }}>
        {editing ? 'Tap cards to toggle owned.' : 'Tap a card for details. Use Edit to tick off cards quickly.'}
      </p>
      <div class="grid-cards">
        {cards.map((c) => (
          <button
            key={c.id}
            class={`gcard ${owned.has(c.id) ? 'owned' : ''}`}
            onClick={() => (editing ? void setOwned(c.id, !owned.has(c.id)) : (detail.value = { cardId: c.id }))}
            aria-label={`${c.name} ${c.number}${owned.has(c.id) ? ', owned' : ''}`}
          >
            <CardImg card={c} />
            <span class="num">{c.number}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
