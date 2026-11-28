// IndexedDB schema: catalog cache, index binaries, sessions/scans, collection and price history.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CardPrices, CardRecord, SetInfo, VariantSelection } from '../shared/types';

export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';

export interface SessionRec {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScanRec {
  id: string;
  sessionId: string;
  cardId: string;
  variant: VariantSelection;
  condition: Condition;
  qty: number;
  addedAt: number;
  /** recognition confidence at scan time (0..1); manual picks = 1 */
  confidence: number;
  /** small JPEG of what the camera actually saw */
  thumb?: Blob;
}

export interface PricePoint {
  key: string; // cardId|date
  cardId: string;
  date: string;
  usd?: number;
  eur?: number;
}

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  sets: { key: string; value: SetInfo };
  cards: { key: string; value: CardRecord & { nameKey: string }; indexes: { setId: string; nameKey: string; ptcgId: string } };
  prices: { key: string; value: CardPrices & { id: string; fetchedAt: number } };
  history: { key: string; value: PricePoint; indexes: { cardId: string } };
  blobs: { key: string; value: ArrayBuffer };
  localVectors: { key: string; value: { id: string; model: string; vec: ArrayBuffer } };
  sessions: { key: string; value: SessionRec };
  scans: { key: string; value: ScanRec; indexes: { sessionId: string; cardId: string } };
  collection: { key: string; value: { cardId: string; addedAt: number } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db(): Promise<IDBPDatabase<Schema>> {
  dbp ??= openDB<Schema>('bulkbot', 1, {
    upgrade(d) {
      d.createObjectStore('kv');
      d.createObjectStore('sets', { keyPath: 'id' });
      const cards = d.createObjectStore('cards', { keyPath: 'id' });
      cards.createIndex('setId', 'setId');
      cards.createIndex('nameKey', 'nameKey');
      cards.createIndex('ptcgId', 'ptcgId');
      d.createObjectStore('prices', { keyPath: 'id' });
      const h = d.createObjectStore('history', { keyPath: 'key' });
      h.createIndex('cardId', 'cardId');
      d.createObjectStore('blobs');
      d.createObjectStore('localVectors', { keyPath: 'id' });
      d.createObjectStore('sessions', { keyPath: 'id' });
      const scans = d.createObjectStore('scans', { keyPath: 'id' });
      scans.createIndex('sessionId', 'sessionId');
      scans.createIndex('cardId', 'cardId');
      d.createObjectStore('collection', { keyPath: 'cardId' });
    },
    blocked() {
      // another tab holds an older version open
    },
  });
  return dbp;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

export async function kvSet(key: string, value: unknown) {
  await (await db()).put('kv', value, key);
}

export function uid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ask the browser not to evict our data (best effort). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}
