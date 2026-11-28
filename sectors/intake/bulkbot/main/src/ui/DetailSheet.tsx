import { useEffect, useMemo, useState } from 'preact/hooks';
import { getCard, priceHistory } from '../data/catalog';
import { refreshCardPrices } from '../data/live';
import type { PricePoint } from '../data/db';
import {
  CONDITIONS,
  EDITION_LABEL,
  FINISH_LABEL,
  availableEditions,
  availableFinishes,
  defaultVariant,
  formatMoney,
  quote,
  type Condition,
} from '../pricing/pricing';
import { eraInfo } from '../shared/era';
import type { Edition, Finish, VariantSelection } from '../shared/types';
import {
  addScan,
  catalogVersion,
  changeQty,
  collection,
  detail,
  restoreScan,
  scans,
  setOwned,
  settings,
  tab,
  toast,
  updatePriceSettings,
  updateScan,
} from '../app/state';
import { CardImg, EraBadge, Sheet, Sparkline, fmtDate } from './common';
import { IconExternal } from './icons';
import { getScanner } from './ScanScreen';

export function DetailSheet() {
  const target = detail.value;
  if (!target) return null;
  return <DetailInner key={target.scanId ?? target.cardId} scanId={target.scanId} cardId={target.cardId} />;
}

function DetailInner({ scanId, cardId }: { scanId?: string; cardId?: string }) {
  void catalogVersion.value;
  const scan = scanId ? scans.value.find((s) => s.id === scanId) : undefined;
  const card = getCard(scan?.cardId ?? cardId ?? '');
  const [variant, setVariant] = useState<VariantSelection>(() => scan?.variant ?? (card ? defaultVariant(card) : { finish: 'normal', edition: 'unlimited', stamped: false }));
  const [condition, setCondition] = useState<Condition>(scan?.condition ?? settings.value.defaultCondition);
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const close = () => (detail.value = null);

  useEffect(() => {
    if (!card) return;
    void refreshCardPrices(card.id).then((changed) => changed && catalogVersion.value++);
    void priceHistory(card.id).then(setHistory);
  }, [card?.id]);
  useEffect(() => {
    if (!scan?.thumb) return;
    const u = URL.createObjectURL(scan.thumb);
    setThumbUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [scan?.thumb]);

  const q = useMemo(() => (card ? quote(card, variant, condition, settings.value.price) : null), [card, variant, condition, settings.value, catalogVersion.value]);
  if (!card || !q) {
    return (
      <Sheet onClose={close} label="Card">
        <p class="muted">This card isn't in the local database yet. Sync again from Settings.</p>
      </Sheet>
    );
  }
  const finishes = availableFinishes(card);
  const allFinishes: Finish[] = ['normal', 'holo', 'reverse', 'pokeball', 'masterball'];
  const editions = availableEditions(card);
  const owned = collection.value.has(card.id);
  const era = card.set ? eraInfo(card.set.era, card.set.series) : null;

  const apply = (v: VariantSelection, c: Condition) => {
    setVariant(v);
    setCondition(c);
    if (scan) void updateScan(scan.id, { variant: v, condition: c });
  };
  const setFinish = (f: Finish) => apply({ ...variant, finish: f }, condition);
  const setEdition = (e: Edition) => apply({ ...variant, edition: e }, condition);

  // sparkline: local snapshots + Cardmarket 30/7/1-day averages
  const spark = (() => {
    const pts = history.filter((h) => (q.currency === 'USD' ? h.usd : h.eur) !== undefined).map((h) => ({ date: h.date, v: (q.currency === 'USD' ? h.usd : h.eur)! }));
    if (pts.length >= 2) return { pts, label: `${pts.length} price snapshots` };
    if (q.avg30 && q.avg7 && q.avg1) return { pts: [{ date: '30d', v: q.avg30 }, { date: '7d', v: q.avg7 }, { date: '1d', v: q.avg1 }, ...(q.market ? [{ date: 'now', v: q.market }] : [])], label: '30-day → today (Cardmarket averages)' };
    return null;
  })();

  return (
    <Sheet onClose={close} label={card.name}>
      <div class="card-hero">
        <CardImg card={card} class="card-img" large />
        <div class="meta" style={{ flex: 1 }}>
          <h3>{card.name}</h3>
          {card.set && <EraBadge era={card.set.era} series={card.set.series} />}
          <div class="set-line">
            {card.set?.symbol && <img src={card.set.symbol} alt="" />}
            <b>{card.set?.name ?? card.setId}</b>
          </div>
          <div>
            No. <b>{card.number}{card.set?.printedTotal && /^\d+$/.test(card.number) ? `/${card.set.printedTotal}` : ''}</b>
            {card.regulationMark ? <> · Reg. <b>{card.regulationMark}</b></> : null}
          </div>
          <div>{card.rarity ?? 'Rarity unknown'}{card.supertype ? ` · ${card.supertype}` : ''}{card.types?.length ? ` · ${card.types.join('/')}` : ''}</div>
          {era && card.set && <div class="small">{era.label} · {fmtDate(card.set.releaseDate)}</div>}
          {card.artist && <div class="small">Illus. {card.artist}</div>}
        </div>
      </div>

      <div class="section">
        <div class="price-grid">
          <div class="price-cell main">
            <div>
              <span>{settings.value.price.source === 'tcgplayer' ? 'TCGplayer market' : 'Cardmarket trend'}{condition !== 'NM' ? ` · ${condition}` : ''}</span>
              <b style={{ color: q.isHit ? 'var(--hit)' : undefined }}>{q.hasPrice ? formatMoney(q.rawUnit, q.currency) : 'No price yet'}</b>
              {q.estimated && <span class="est">est.</span>}
            </div>
            {q.bulkFloored && <span class="tag gold">bulk {formatMoney(q.unit, q.currency)}</span>}
          </div>
          <div class="price-cell">
            <span>Low</span>
            <b>{formatMoney(q.low, q.currency)}</b>
          </div>
          <div class="price-cell">
            <span>{settings.value.price.source === 'tcgplayer' ? 'Mid' : 'Avg'}</span>
            <b>{formatMoney(q.mid, q.currency)}</b>
          </div>
          <div class="price-cell">
            <span>{settings.value.price.source === 'tcgplayer' ? 'High' : '30d avg'}</span>
            <b>{formatMoney(settings.value.price.source === 'tcgplayer' ? q.high : q.avg30, q.currency)}</b>
          </div>
        </div>
        <div class="price-note">
          Updated {fmtDate(q.updated)}
          {q.src === 'tcgdex' && settings.value.price.source === 'tcgplayer' ? ' · via TCGdex' : ''}
          {q.estimateNote ? ` · ${q.estimateNote}` : ''}
          {' · '}
          <button style={{ color: 'var(--accent)', fontWeight: 700 }} onClick={() => void updatePriceSettings({ source: settings.value.price.source === 'tcgplayer' ? 'cardmarket' : 'tcgplayer' })}>
            Show {settings.value.price.source === 'tcgplayer' ? 'Cardmarket €' : 'TCGplayer $'}
          </button>
        </div>
        {spark && (
          <div style={{ marginTop: 10 }}>
            <Sparkline points={spark.pts} color="auto" />
            <div class="small muted">{spark.label}</div>
          </div>
        )}
      </div>

      <div class="section">
        <label>Printing</label>
        <div class="chips">
          {allFinishes
            .filter(
              (f) =>
                finishes.includes(f) ||
                f === variant.finish ||
                // reverse holos exist from Legendary Collection (May 2002) on
                (f === 'reverse' && (card.set?.releaseDate ?? '') >= '2002-05-24') ||
                ((f === 'pokeball' || f === 'masterball') && (card.set?.era === 'sv' || card.set?.era === 'me')),
            )
            .map((f) => (
              <button key={f} class="chip" aria-pressed={variant.finish === f} onClick={() => setFinish(f)}>
                {FINISH_LABEL[f]}
              </button>
            ))}
        </div>
        {(editions.length > 1 || card.set?.era === 'wotc') && (
          <div class="chips" style={{ marginTop: 8 }}>
            {editions.map((e) => (
              <button key={e} class="chip" aria-pressed={variant.edition === e} onClick={() => setEdition(e)}>
                {EDITION_LABEL[e]}
              </button>
            ))}
          </div>
        )}
        <div class="chips" style={{ marginTop: 8 }}>
          <button class="chip small" aria-pressed={variant.stamped} onClick={() => apply({ ...variant, stamped: !variant.stamped }, condition)}>
            Promo stamp
          </button>
        </div>
      </div>

      <div class="section">
        <label>Condition</label>
        <div class="chips">
          {CONDITIONS.map((c) => (
            <button key={c} class="chip" aria-pressed={condition === c} onClick={() => apply(variant, c)}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {scan && (
        <div class="section" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Quantity</label>
            <div class="stepper">
              <button onClick={() => void changeQty(scan.id, -1).then(() => !scans.value.find((s) => s.id === scan.id) && close())} aria-label="One less">
                −
              </button>
              <output>{scan.qty}</output>
              <button onClick={() => void changeQty(scan.id, 1)} aria-label="One more">
                +
              </button>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <label class="section-title">Line value</label>
            <b style={{ fontSize: 20 }}>{formatMoney(q.unit * scan.qty, q.currency)}</b>
          </div>
          {thumbUrl && (
            <div style={{ textAlign: 'center' }}>
              <img class="your-scan" src={thumbUrl} alt="Your scan" />
              <div class="small muted">your scan</div>
            </div>
          )}
        </div>
      )}

      <div class="row-actions">
        {scan ? (
          <>
            <button class={`btn ${owned ? 'primary' : ''}`} onClick={() => void setOwned(card.id, !owned)}>
              {owned ? '✓ In collection' : 'Add to collection'}
            </button>
            <button
              class="btn"
              onClick={() => {
                close();
                tab.value = 'search';
                toast('Search for the right card, then tap it to replace', { tone: 'info' });
                sessionStorage.setItem('bulkbot:replace', scan.id);
              }}
            >
              Wrong card?
            </button>
            <button
              class="btn danger"
              onClick={() => {
                const before = { ...scan };
                void changeQty(scan.id, -scan.qty);
                getScanner()?.forgetLock();
                close();
                toast(`Removed ${card.name}`, { action: { label: 'Undo', run: () => void restoreScan(before) } });
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <>
            <button
              class="btn primary"
              onClick={() => {
                void addScan(card.id, { confidence: 1, variant, condition });
                toast(`Added ${card.name}`, { tone: 'success' });
                close();
              }}
            >
              Add to session
            </button>
            <button class={`btn ${owned ? 'primary' : ''}`} onClick={() => void setOwned(card.id, !owned)}>
              {owned ? '✓ Owned' : 'Mark owned'}
            </button>
          </>
        )}
        {card.ptcgId && (
          <a class="btn" href={`https://prices.pokemontcg.io/tcgplayer/${card.ptcgId}`} target="_blank" rel="noopener noreferrer">
            TCGplayer <IconExternal width={16} height={16} />
          </a>
        )}
      </div>
    </Sheet>
  );
}
