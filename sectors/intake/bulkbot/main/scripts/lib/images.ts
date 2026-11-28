// Card image download cache for the index builder.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR, fetchRetry } from './http';

export const IMG_DIR = join(CACHE_DIR, 'images');

export function imageFile(url: string): string {
  const h = createHash('sha1').update(url).digest('hex').slice(0, 20);
  return join(IMG_DIR, h.slice(0, 2), `${h}.img`);
}

/** Downloads `url` into the cache (once). Returns the file path, or null if the image doesn't exist. */
export async function ensureImage(url: string): Promise<string | null> {
  const file = imageFile(url);
  try {
    const st = await stat(file);
    if (st.size > 512) return file;
  } catch {
    /* not cached */
  }
  const res = await fetchRetry(url, { retries: 5, timeoutMs: 60_000, okMissing: [404, 403] });
  if (!res) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 512) return null;
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, buf);
  return file;
}

export async function readImage(file: string): Promise<Buffer> {
  return readFile(file);
}
