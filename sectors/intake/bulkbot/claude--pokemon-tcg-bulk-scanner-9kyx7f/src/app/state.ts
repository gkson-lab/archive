// App-wide reactive state (Preact signals) and the actions that change it.
import { computed, signal } from '@preact/signals';
import { getCard } from '../data/catalog';
import { db, kvGet, kvSet, uid, type Condition, type ScanRec, type SessionRec } from '../data/db';
import { DEFAULT_PRICE_SETTINGS, defaultVariant, quote, type PriceQuote, type PriceSettings } from '../pricing/pricing';
import type { VariantSelection } from '../shared/types';
import type { Quad } from '../vision/homography';
import type { ScanPhase } from '../scan/scanner';

export interface Settings {
  price: PriceSettings;
  defaultCondition: Condition;
  autoCapture: boolean;
  useOcr: boolean;
  sound: boolean;
  haptics: boolean;
  lockConfidence: number;
  keepScanPhotos: boolean;
  autoAddToCollection: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  price: DEFAULT_PRICE_SETTINGS,
  defaultCondition: 'NM',
  autoCapture: true,
  useOcr: true,
  sound: true,
  haptics: true,
  lockConfidence: 0.8,
  keepScanPhotos: true,
  autoAddToCollection: false,
};

export type Tab = 'scan' | 'session' | 'collection' | 'search' | 'settings';

export const settings = signal<Settings>(DEFAULT_SETTINGS);
export const tab = signal<Tab>('scan');
export const sessions = signal<SessionRec[]>([]);
export const sessionId = signal<string>('');
export const scans = signal<ScanRec[]>([]);
export const collection = signal<Set<string>>(new Set());
/** bumps when catalog/prices change so derived values recompute */
export const catalogVersion = signal(0);

export interface LoadState {
  state: 'idle' | 'loading' | 'ready' | 'error';
  progress: number;
  message?: string;
}
export const catalogState = signal<LoadState>({ state: 'idle', progress: 0 });
export const modelState = signal<LoadState>({ state: 'idle', progress: 0 });
export const indexState = signal<LoadState>({ state: 'idle', progress: 0 });
export const ocrState = signal<LoadState>({ state: 'idle', progress: 0 });
export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);

export const scanPhase = signal<ScanPhase>('starting');
export const scanHint = signal<string | undefined>(undefined);
export const liveQuad = signal<{ q: Quad | null; w: number; h: number }>({ q: null, w: 0, h: 0 });
export const scanStats = signal<{ detectMs: number; fps: number }>({ detectMs: 0, fps: 0 });

/** Detail sheet target: a scan row, or a bare card (from search/collection). */
export const detail = signal<{ scanId?: string; cardId?: string } | null>(null);
export const flash = signal<{ kind: 'lock' | 'hit'; at: number } | null>(null);

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  tone?: 'info' | 'error' | 'success';
}
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, opts: Partial<Omit<Toast, 'id' | 'text'>> & { ms?: number } = {}) {
  const t: Toast = { id: ++toastSeq, text, action: opts.action, tone: opts.tone };
  toasts.value = [...toasts.value.slice(-2), t];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== t.id)), opts.ms ?? 3500);
}

/* ---------------------------- derived values ---------------------------- */

export interface ScanView {
  scan: ScanRec;
  quote: PriceQuote;
  total: number;
}

export function quoteFor(scan: Pick<ScanRec, 'cardId' | 'variant' | 'condition'>): PriceQuote {
  const card = getCard(scan.cardId);
  if (!card) return { currency: settings.value.price.source === 'tcgplayer' ? 'USD' : 'EUR', estimated: false, rawUnit: 0, unit: 0, bulkFloored: false, isHit: false, rarityClass: 'common', hasPrice: false };
  return quote(card, scan.variant, scan.condition, settings.value.price);
}

export const scanViews = computed<ScanView[]>(() => {
  void catalogVersion.value;
  void settings.value;
  return scans.value.map((s) => {
    const q = quoteFor(s);
    return { scan: s, quote: q, total: Math.round(q.unit * s.qty * 100) / 100 };
  });
});

export const sessionTotals = computed(() => {
  let value = 0;
  let count = 0;
  let hits = 0;
  let floored = 0;
  for (const v of scanViews.value) {
    value += v.total;
    count += v.scan.qty;
    if (v.quote.isHit) hits += v.scan.qty;
    if (v.quote.bulkFloored) floored += v.scan.qty;
  }
  return { value: Math.round(value * 100) / 100, count, hits, floored, unique: scanViews.value.length };
});

export const currency = computed(() => (settings.value.price.source === 'tcgplayer' ? 'USD' : 'EUR') as 'USD' | 'EUR');
export const currentSession = computed(() => sessions.value.find((s) => s.id === sessionId.value));

/* -------------------------------- actions -------------------------------- */

export async function loadSettings() {
  const s = await kvGet<Partial<Settings>>('settings');
  if (s) settings.value = { ...DEFAULT_SETTINGS, ...s, price: { ...DEFAULT_PRICE_SETTINGS, ...s.price, bulkFloor: { ...DEFAULT_PRICE_SETTINGS.bulkFloor, ...s.price?.bulkFloor, rates: { ...DEFAULT_PRICE_SETTINGS.bulkFloor.rates, ...s.price?.bulkFloor?.rates } }, condition: { ...DEFAULT_PRICE_SETTINGS.condition, ...s.price?.condition }, estimate: { ...DEFAULT_PRICE_SETTINGS.estimate, ...s.price?.estimate } } };
}

export async function updateSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  await kvSet('settings', settings.value);
}

export async function updatePriceSettings(patch: Partial<PriceSettings>) {
  await updateSettings({ price: { ...settings.value.price, ...patch } });
}

function sessionName(d = new Date()) {
  return `Bulk ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export async function loadSessions() {
  const d = await db();
  const all = (await d.getAll('sessions')).sort((a, b) => b.updatedAt - a.updatedAt);
  sessions.value = all;
  const last = await kvGet<string>('currentSession');
  const pick = all.find((s) => s.id === last) ?? all[0];
  if (pick) await openSession(pick.id);
  else await newSession();
  collection.value = new Set((await d.getAllKeys('collection')).map(String));
}

export async function newSession(name?: string) {
  const s: SessionRec = { id: uid(), name: name ?? sessionName(), createdAt: Date.now(), updatedAt: Date.now() };
  await (await db()).put('sessions', s);
  sessions.value = [s, ...sessions.value];
  await openSession(s.id);
  return s;
}

export async function openSession(id: string) {
  const d = await db();
  sessionId.value = id;
  await kvSet('currentSession', id);
  scans.value = (await d.getAllFromIndex('scans', 'sessionId', id)).sort((a, b) => b.addedAt - a.addedAt);
}

export async function renameSession(id: string, name: string) {
  const d = await db();
  const s = await d.get('sessions', id);
  if (!s) return;
  s.name = name.trim() || s.name;
  s.updatedAt = Date.now();
  await d.put('sessions', s);
  sessions.value = sessions.value.map((x) => (x.id === id ? s : x));
}

export async function deleteSession(id: string) {
  const d = await db();
  const tx = d.transaction(['sessions', 'scans'], 'readwrite');
  for (const k of await tx.objectStore('scans').index('sessionId').getAllKeys(id)) void tx.objectStore('scans').delete(k);
  void tx.objectStore('sessions').delete(id);
  await tx.done;
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (sessionId.value === id) {
    if (sessions.value[0]) await openSession(sessions.value[0].id);
    else await newSession();
  }
}

async function touchSession() {
  const d = await db();
  const s = await d.get('sessions', sessionId.value);
  if (s) {
    s.updatedAt = Date.now();
    await d.put('sessions', s);
    sessions.value = [s, ...sessions.value.filter((x) => x.id !== s.id)];
  }
}

const sameRow = (a: Pick<ScanRec, 'cardId' | 'variant' | 'condition'>, b: Pick<ScanRec, 'cardId' | 'variant' | 'condition'>) =>
  a.cardId === b.cardId && a.condition === b.condition && a.variant.finish === b.variant.finish && a.variant.edition === b.variant.edition && a.variant.stamped === b.variant.stamped;

/**
 * Adds a card to the current session. Scanning the same card (same printing + condition) again
 * bumps its quantity instead of adding a row. Returns the row id and the "undo" info.
 */
export async function addScan(cardId: string, opts: { confidence: number; thumb?: Blob; variant?: VariantSelection; condition?: Condition } = { confidence: 1 }) {
  const card = getCard(cardId);
  const variant = opts.variant ?? (card ? defaultVariant(card) : { finish: 'normal' as const, edition: 'unlimited' as const, stamped: false });
  const condition = opts.condition ?? settings.value.defaultCondition;
  const d = await db();
  const existing = scans.value.find((s) => sameRow(s, { cardId, variant, condition }));
  let row: ScanRec;
  if (existing) {
    row = { ...existing, qty: existing.qty + 1, addedAt: Date.now(), thumb: existing.thumb ?? opts.thumb };
  } else {
    row = { id: uid(), sessionId: sessionId.value, cardId, variant, condition, qty: 1, addedAt: Date.now(), confidence: opts.confidence, thumb: settings.value.keepScanPhotos ? opts.thumb : undefined };
  }
  await d.put('scans', row);
  scans.value = [row, ...scans.value.filter((s) => s.id !== row.id)];
  if (settings.value.autoAddToCollection) await setOwned(cardId, true);
  void touchSession();
  return { row, wasIncrement: !!existing };
}

/** Undo the most recent scan (decrements qty, or removes the row). */
export async function undoLastScan(): Promise<ScanRec | null> {
  const last = [...scans.value].sort((a, b) => b.addedAt - a.addedAt)[0];
  if (!last) return null;
  await changeQty(last.id, -1);
  return last;
}

export async function changeQty(scanId: string, delta: number) {
  const d = await db();
  const row = scans.value.find((s) => s.id === scanId);
  if (!row) return;
  const qty = row.qty + delta;
  if (qty <= 0) {
    await d.delete('scans', scanId);
    scans.value = scans.value.filter((s) => s.id !== scanId);
  } else {
    const nr = { ...row, qty };
    await d.put('scans', nr);
    scans.value = scans.value.map((s) => (s.id === scanId ? nr : s));
  }
}

export async function restoreScan(row: ScanRec) {
  await (await db()).put('scans', row);
  scans.value = [row, ...scans.value.filter((s) => s.id !== row.id)].sort((a, b) => b.addedAt - a.addedAt);
}

export async function updateScan(scanId: string, patch: Partial<Pick<ScanRec, 'variant' | 'condition' | 'cardId' | 'qty'>>) {
  const d = await db();
  const row = scans.value.find((s) => s.id === scanId);
  if (!row) return;
  const nr = { ...row, ...patch };
  // merge into an identical row if one exists
  const twin = scans.value.find((s) => s.id !== scanId && sameRow(s, nr));
  if (twin) {
    const merged = { ...twin, qty: twin.qty + nr.qty };
    await d.put('scans', merged);
    await d.delete('scans', scanId);
    scans.value = scans.value.filter((s) => s.id !== scanId).map((s) => (s.id === twin.id ? merged : s));
    detail.value = { scanId: twin.id };
    return;
  }
  await d.put('scans', nr);
  scans.value = scans.value.map((s) => (s.id === scanId ? nr : s));
}

export async function setOwned(cardId: string, owned: boolean) {
  const d = await db();
  if (owned) await d.put('collection', { cardId, addedAt: Date.now() });
  else await d.delete('collection', cardId);
  const next = new Set(collection.value);
  if (owned) next.add(cardId);
  else next.delete(cardId);
  collection.value = next;
}

export async function addSessionToCollection() {
  const ids = new Set(scans.value.map((s) => s.cardId));
  for (const id of ids) await setOwned(id, true);
  return ids.size;
}
