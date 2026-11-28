// Catalog: syncs the static snapshot (built by scripts/build-catalog.ts and deployed with the app)
// into IndexedDB, then serves lookups/search from memory.
import { normalizeName, normalizeNumber } from '../shared/numbers';
import { mergePrices } from '../shared/normalize';
import type { CardFull, CardPrices, CardRecord, CatalogManifest, SetInfo } from '../shared/types';
import { db, kvGet, kvSet } from './db';

/**
 * Where the catalog + index live. Same origin by default (the GitHub Pages build ships them);
 * VITE_DATA_BASE overrides it at build time. App-only deploys (Vercel/Netlify without a data
 * build) automatically fall back to the public GitHub Pages data build.
 */
const PRIMARY_BASE = (import.meta.env.VITE_DATA_BASE as string | undefined)?.replace(/\/?$/, '/') ?? new URL('data/', document.baseURI).href;
const FALLBACK_BASE = ((import.meta.env.VITE_DATA_FALLBACK as string | undefined) ?? 'https://gkson-lab.github.io/bulkbot/data/').replace(/\/?$/, '/');

export class DataMissingError extends Error {}

let resolvedBase: string | null = null;

/** Finds a data build that actually exists (hosts often answer 200 + index.html for missing files). */
export async function dataBase(): Promise<string> {
  if (resolvedBase) return resolvedBase;
  const tried: string[] = [];
  for (const base of [...new Set([PRIMARY_BASE, FALLBACK_BASE])]) {
    tried.push(base);
    try {
      const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
      if (!res.ok) continue;
      const json = (await res.json()) as Partial<CatalogManifest>;
      if (!json || typeof json.cardCount !== 'number') continue;
      resolvedBase = base;
      return base;
    } catch {
      /* offline, CORS or not JSON: try the next one */
    }
  }
  if (!navigator.onLine) throw new Error('offline');
  throw new DataMissingError(
    "The card database isn't published yet. If you just deployed, wait for the \"Build card data and deploy\" GitHub workflow to finish, then reload.",
  );
}

const cards = new Map<string, CardRecord>();
const sets = new Map<string, SetInfo>();
const prices = new Map<string, CardPrices & { fetchedAt?: number }>();
let aliases: Record<string, string> = {};
let loaded = false;

export function catalogReady() {
  return loaded && cards.size > 0;
}
export function cardCount() {
  return cards.size;
}
export function allSets(): SetInfo[] {
  return [...sets.values()];
}
export function getSet(id: string) {
  return sets.get(id);
}
export function setCards(setId: string): CardRecord[] {
  return [...cards.values()].filter((c) => c.setId === setId);
}

export function resolveId(id: string): string {
  return cards.has(id) ? id : aliases[id] ?? id;
}

export function getCard(id: string): CardFull | undefined {
  const c = cards.get(resolveId(id));
  if (!c) return undefined;
  return { ...c, set: sets.get(c.setId), prices: prices.get(c.id) };
}

export function getPrices(id: string) {
  return prices.get(resolveId(id));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

/** Loads whatever is already in IndexedDB into memory (instant, works offline). */
export async function loadLocalCatalog() {
  const d = await db();
  const [allS, allC, allP] = await Promise.all([d.getAll('sets'), d.getAll('cards'), d.getAll('prices')]);
  for (const s of allS) sets.set(s.id, s);
  for (const c of allC) cards.set(c.id, c);
  for (const p of allP) prices.set(p.id, p);
  aliases = (await kvGet<Record<string, string>>('aliases')) ?? {};
  loaded = true;
}

export interface SyncProgress {
  done: number;
  total: number;
  label: string;
}

/**
 * Pulls changed chunks of the static catalog. Only chunks whose hash changed are downloaded,
 * so a weekly price refresh is a few hundred KB and new sets arrive without an app update.
 */
export async function syncStaticCatalog(onProgress?: (p: SyncProgress) => void): Promise<{ changed: boolean; newSets: number }> {
  const DATA_BASE = await dataBase();
  const manifest = await fetchJson<CatalogManifest>(`${DATA_BASE}manifest.json`);
  const prev = (await kvGet<CatalogManifest>('catalogManifest')) ?? null;
  const prevSet = new Map(prev?.sets.map((s) => [s.id, s.hash]) ?? []);
  const prevPrice = new Map(prev?.prices.map((p) => [p.file, p.hash]) ?? []);
  const setJobs = manifest.sets.filter((s) => prevSet.get(s.id) !== s.hash || !sets.has(s.id));
  const priceJobs = manifest.prices.filter((p) => prevPrice.get(p.file) !== p.hash);
  const total = setJobs.length + priceJobs.length + 1;
  let done = 0;
  const tick = (label: string) => onProgress?.({ done: ++done, total, label });
  const d = await db();
  const allSets = await fetchJson<SetInfo[]>(`${DATA_BASE}sets.json`);
  const newSets = allSets.filter((s) => !sets.has(s.id)).length;
  {
    const tx = d.transaction('sets', 'readwrite');
    for (const s of allSets) {
      sets.set(s.id, s);
      void tx.store.put(s);
    }
    await tx.done;
  }
  tick('sets');
  // card metadata, a few chunks in parallel
  const queue = [...setJobs];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift()!;
      const list = await fetchJson<CardRecord[]>(`${DATA_BASE}cards/${encodeURIComponent(job.id)}.json`);
      const tx = d.transaction('cards', 'readwrite');
      for (const c of list) {
        cards.set(c.id, c);
        void tx.store.put({ ...c, nameKey: normalizeName(c.name) });
      }
      await tx.done;
      tick(job.id);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // prices
  const today = new Date().toISOString().slice(0, 10);
  for (const job of priceJobs) {
    const chunk = await fetchJson<Record<string, CardPrices>>(`${DATA_BASE}${job.file}`);
    const tx = d.transaction(['prices', 'history'], 'readwrite');
    const ps = tx.objectStore('prices');
    const hs = tx.objectStore('history');
    for (const [id, p] of Object.entries(chunk)) {
      const merged = { ...p, id, fetchedAt: Date.now() };
      prices.set(id, merged);
      void ps.put(merged);
      const usd = marketUsd(p);
      const eur = trendEur(p);
      const date = p.tcgUpdated ?? today;
      if (usd !== undefined || eur !== undefined) void hs.put({ key: `${id}|${date}`, cardId: id, date, usd, eur });
    }
    await tx.done;
    tick(job.file);
  }
  aliases = { ...aliases, ...manifest.aliases };
  await kvSet('aliases', aliases);
  await kvSet('catalogManifest', manifest);
  return { changed: setJobs.length + priceJobs.length > 0, newSets };
}

/** Base market price (USD) used for history points: the cheapest common printing. */
function marketUsd(p: CardPrices): number | undefined {
  const base = p.variants.find((v) => v.edition === 'unlimited' && !v.stamped && (v.finish === 'normal' || v.finish === 'holo') && v.tcg?.market);
  return base?.tcg?.market ?? p.variants.find((v) => v.tcg?.market)?.tcg?.market;
}
function trendEur(p: CardPrices): number | undefined {
  return p.variants.find((v) => v.cm?.trend)?.cm?.trend;
}

/** Stores cards that arrived from the live APIs (new sets, on-demand lookups). */
export async function putLiveCards(entries: { card: CardRecord; prices?: CardPrices }[], newSets: SetInfo[] = []) {
  const d = await db();
  const tx = d.transaction(['cards', 'prices', 'sets', 'history'], 'readwrite');
  for (const s of newSets) {
    if (!sets.has(s.id)) {
      sets.set(s.id, s);
      void tx.objectStore('sets').put(s);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const { card, prices: p } of entries) {
    const id = resolveId(card.id);
    const existing = cards.get(id);
    const merged: CardRecord = existing ? { ...existing, ...pickDefined(card), id, setId: existing.setId } : card;
    cards.set(id, merged);
    void tx.objectStore('cards').put({ ...merged, nameKey: normalizeName(merged.name) });
    if (p) {
      const mp = mergePrices(p, prices.get(id)) ?? p;
      const rec = { ...mp, id, fetchedAt: Date.now() };
      prices.set(id, rec);
      void tx.objectStore('prices').put(rec);
      const usd = marketUsd(mp);
      if (usd !== undefined) void tx.objectStore('history').put({ key: `${id}|${mp.tcgUpdated ?? today}`, cardId: id, date: mp.tcgUpdated ?? today, usd, eur: trendEur(mp) });
    }
  }
  await tx.done;
}

function pickDefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
  return out;
}

export async function priceHistory(cardId: string) {
  const d = await db();
  const pts = await d.getAllFromIndex('history', 'cardId', resolveId(cardId));
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------ search ------------------------------ */

export interface SearchHit {
  card: CardFull;
  score: number;
}

/**
 * Manual search: names ("charizard ex"), numbers ("4/102", "025/198", "TG12"),
 * set + number ("swsh4 25", "PAL 123"), or combinations ("pikachu 58").
 */
export function searchCatalog(query: string, limit = 60): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const slash = q.match(/([A-Za-z]{0,4}\d{1,3})\s*\/\s*([A-Za-z]{0,4}\d{1,3})/);
  const tokens = normalizeName(q.replace(slash?.[0] ?? '', ' ')).split(' ').filter(Boolean);
  const numTokens = tokens.filter((t) => /\d/.test(t));
  const words = tokens.filter((t) => !/\d/.test(t));
  const setTokens = new Set(words.filter((w) => [...sets.values()].some((s) => s.ptcgoCode?.toLowerCase() === w || s.id.toLowerCase() === w)));
  const nameWords = words.filter((w) => !setTokens.has(w));
  const hits: SearchHit[] = [];
  for (const c of cards.values()) {
    let score = 0;
    const s = sets.get(c.setId);
    if (slash) {
      const n = normalizeNumber(slash[1]);
      const t = normalizeNumber(slash[2]);
      if (normalizeNumber(c.number) !== n) continue;
      score += 2;
      if (s && (normalizeNumber(String(s.printedTotal)) === t || normalizeNumber(String(s.total)) === t)) score += 2;
    }
    if (numTokens.length) {
      const id = c.id.toLowerCase();
      const ok = numTokens.some((t) => normalizeNumber(t) === normalizeNumber(c.number) || id === t || id.endsWith(`-${t}`));
      if (!ok && !slash) continue;
      if (ok) score += 1.5;
    }
    if (setTokens.size) {
      if (!s || ![...setTokens].some((t) => s.ptcgoCode?.toLowerCase() === t || s.id.toLowerCase() === t)) continue;
      score += 1.5;
    }
    if (nameWords.length) {
      const name = normalizeName(c.name);
      const all = nameWords.every((w) => name.includes(w));
      if (!all) {
        const fuzzy = nameWords.every((w) => name.split(' ').some((nw) => nw.startsWith(w.slice(0, Math.max(3, w.length - 1)))));
        if (!fuzzy) continue;
        score += 1;
      } else score += 2 + (name === nameWords.join(' ') ? 1 : 0);
    }
    if (score <= 0) continue;
    hits.push({ card: { ...c, set: s, prices: prices.get(c.id) }, score: score + (s ? Number(s.releaseDate.slice(0, 4)) / 10000 : 0) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Cards matching an OCR'd number (+ total), used when the visual index misses (new sets). */
export function cardsByNumber(num: string, total?: string): CardRecord[] {
  const out: CardRecord[] = [];
  for (const c of cards.values()) {
    if (normalizeNumber(c.number) !== num) continue;
    if (total) {
      const s = sets.get(c.setId);
      if (!s) continue;
      if (normalizeNumber(String(s.printedTotal)) !== total && normalizeNumber(String(s.total)) !== total && s.ptcgoCode?.toUpperCase() !== total) continue;
    }
    out.push(c);
  }
  return out;
}
