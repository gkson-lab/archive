// Small, dependency-light HTTP helpers for the build scripts:
// proxy support, retries with backoff, timeouts, a concurrency limiter and an on-disk cache.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) {
  // Node's built-in fetch ignores proxy env vars; route it through the proxy when one is configured.
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export const CACHE_DIR = process.env.BULKBOT_CACHE ?? join(process.cwd(), '.cache');

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FetchOpts {
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Treat these statuses as final (no retry), returning null. */
  okMissing?: number[];
  method?: string;
  body?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** fetch() with exponential backoff on network errors, 429 and 5xx. Returns null for okMissing statuses. */
export async function fetchRetry(url: string, opts: FetchOpts = {}): Promise<Response | null> {
  const retries = opts.retries ?? 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'bulkbot-index-builder/1.0 (+open source)', ...opts.headers },
        signal: ctrl.signal,
        method: opts.method,
        body: opts.body,
      });
      clearTimeout(timer);
      if (res.ok) return res;
      if (opts.okMissing?.includes(res.status)) return null;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, url);
        const ra = Number(res.headers.get('retry-after'));
        await res.body?.cancel();
        await sleep(ra > 0 ? ra * 1000 : Math.min(30_000, 400 * 2 ** attempt + Math.random() * 300));
        continue;
      }
      await res.body?.cancel();
      throw new HttpError(res.status, url);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
      await sleep(Math.min(30_000, 400 * 2 ** attempt + Math.random() * 300));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchRetry(url, opts);
    if (!res) return null;
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // truncated/HTML error page: retry
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Invalid JSON from ${url}`);
}

/** Run async jobs with a fixed concurrency. Results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function sha1(data: string | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * JSON cache keyed by a string; entries older than maxAgeMs are refetched.
 * If refetching fails and a stale copy exists, the stale copy is returned (stale-if-error),
 * so a flaky upstream never wipes data that a previous build already had.
 */
export async function cachedJson<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
  const file = join(CACHE_DIR, 'json', `${sha1(key)}.json`);
  let stale: T | undefined;
  try {
    const st = await stat(file);
    const value = JSON.parse(await readFile(file, 'utf8')) as T;
    if (Date.now() - st.mtimeMs < maxAgeMs) return value;
    stale = value;
  } catch {
    /* miss */
  }
  try {
    const value = await load();
    if (value !== null && value !== undefined) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value));
    }
    return value;
  } catch (e) {
    if (stale !== undefined) return stale;
    throw e;
  }
}

/** Serializes calls and keeps at least `gapMs` between their starts (polite API pacing). */
export function pacer(gapMs: number) {
  let last = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = p.catch(() => undefined);
    return p;
  };
}

export async function writeJson(file: string, value: unknown, pretty = false) {
  await mkdir(dirname(file), { recursive: true });
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await writeFile(file, text);
  return text;
}

export function log(...args: unknown[]) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...args);
}
