// Loads the prebuilt visual index (downloaded once, kept in IndexedDB) and extends it on-device
// with cards from sets newer than the index build.
import { db, kvGet, kvSet } from '../data/db';
import { allSets, dataBase, setCards } from '../data/catalog';
import { MODEL_H, MODEL_W, resizeRgbaToRgbFloat } from '../shared/preprocess';
import { deserializeProjection } from '../shared/projection';
import type { IndexManifest } from '../shared/types';
import { MODEL_BASE, embed, embedderReady } from './embedder';
import { VectorIndex } from './vindex';

let index: VectorIndex | null = null;
export function getIndex() {
  return index;
}

async function cachedBinary(key: string, url: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const d = await db();
  const hit = await d.get('blobs', key);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  let buf: ArrayBuffer;
  if (res.body && onBytes) {
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      onBytes(n);
    }
    const all = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    buf = all.buffer;
  } else buf = await res.arrayBuffer();
  await d.put('blobs', buf, key);
  return buf;
}

export async function loadIndex(onProgress?: (f: number) => void): Promise<VectorIndex> {
  let manifest: IndexManifest | undefined;
  let DATA_BASE = '';
  let missing: Error | null = null;
  try {
    DATA_BASE = await dataBase();
    const res = await fetch(`${DATA_BASE}index/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()) as IndexManifest;
    await kvSet('indexManifest', manifest);
  } catch (e) {
    missing = e as Error;
    manifest = await kvGet<IndexManifest>('indexManifest'); // offline: last known index
  }
  if (!manifest) {
    throw new Error(missing && missing.message !== 'offline' ? missing.message : 'No card index on this device yet. Connect to the internet once to download it.');
  }
  const totalBytes = manifest.count * manifest.dims + manifest.count * 4;
  let vecBytes = 0;
  const [vecBuf, scaleBuf, idsBuf, projBuf] = await Promise.all([
    cachedBinary(`idx:${manifest.vectors}`, `${DATA_BASE}index/${manifest.vectors}`, (n) => {
      vecBytes = n;
      onProgress?.(Math.min(0.99, vecBytes / totalBytes));
    }),
    cachedBinary(`idx:${manifest.scales}`, `${DATA_BASE}index/${manifest.scales}`),
    cachedBinary(`idx:${manifest.ids}`, `${DATA_BASE}index/${manifest.ids}`),
    cachedBinary(`proj:${manifest.model.id}:${manifest.hash}`, `${MODEL_BASE}projection.bin?v=${manifest.hash}`),
  ]);
  const ids = JSON.parse(new TextDecoder().decode(idsBuf)) as string[];
  const proj = deserializeProjection(projBuf);
  const vi = new VectorIndex(ids, new Int8Array(vecBuf), new Float32Array(scaleBuf), manifest.dims, proj);
  // vectors embedded on this device for cards newer than the index
  const d = await db();
  for (const lv of await d.getAll('localVectors')) {
    if (lv.model === manifest.model.id && !vi.has(lv.id)) vi.addLocal(lv.id, new Float32Array(lv.vec));
  }
  index = vi;
  onProgress?.(1);
  // drop blobs from older index builds
  for (const key of await d.getAllKeys('blobs')) {
    const k = String(key);
    if (k.startsWith('idx:') && ![manifest.vectors, manifest.scales, manifest.ids].some((f) => k === `idx:${f}`)) await d.delete('blobs', key);
  }
  return vi;
}

async function imageToInput(url: string): Promise<Float32Array> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  bmp.close?.();
  return resizeRgbaToRgbFloat(data, c.width, c.height, MODEL_W, MODEL_H);
}

/**
 * Embeds catalog cards that the prebuilt index doesn't know yet (e.g. a set released after the
 * last index build) so they become scannable right away. Runs in small idle slices.
 */
export async function extendIndexInBackground(onAdded?: (n: number) => void, maxCards = 400): Promise<number> {
  const vi = index;
  if (!vi || !embedderReady()) return 0;
  const manifest = await kvGet<IndexManifest>('indexManifest');
  if (!manifest) return 0;
  const recent = allSets()
    .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
    .slice(0, 12);
  const missing = recent.flatMap((s) => setCards(s.id)).filter((c) => c.img && !vi.has(c.id));
  if (!missing.length) return 0;
  const d = await db();
  let added = 0;
  for (const c of missing.slice(0, maxCards)) {
    if (!navigator.onLine) break;
    try {
      const feat = await embed(await imageToInput(c.img));
      const vec = vi.embed(feat);
      vi.addLocal(c.id, vec);
      await d.put('localVectors', { id: c.id, model: manifest.model.id, vec: vec.buffer.slice(0) as ArrayBuffer });
      added++;
      if (added % 10 === 0) onAdded?.(added);
    } catch {
      /* skip this card */
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  onAdded?.(added);
  return added;
}
