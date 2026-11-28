// Browser-side access to the two free card APIs, with retries and timeouts.
// pokemontcg.io is tried first (primary), TCGdex is the fallback and the Cardmarket source.
import {
  TCGDEX_EXCLUDED_SERIES,
  fromPtcgCard,
  fromPtcgSet,
  fromTcgdexCard,
  fromTcgdexSet,
  type PtcgCard,
  type PtcgSet,
  type TcgdexCard,
  type TcgdexSet,
  type TcgdexSetBrief,
} from '../shared/normalize';
import type { CardPrices, CardRecord, SetInfo } from '../shared/types';

const PTCG = 'https://api.pokemontcg.io/v2';
const TCGDEX = 'https://api.tcgdex.net/v2/en';

async function getJson<T>(url: string, { retries = 2, timeoutMs = 15000 } = {}): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(t);
      last = e;
      if ((e as { status?: number }).status === 404) break;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }
  throw last;
}

export async function ptcgCard(id: string): Promise<{ card: CardRecord; prices: CardPrices }> {
  const r = await getJson<{ data: PtcgCard }>(`${PTCG}/cards/${encodeURIComponent(id)}`, { retries: 2 });
  return fromPtcgCard(r.data);
}

export async function tcgdexCard(id: string): Promise<{ card: CardRecord; prices: CardPrices }> {
  const r = await getJson<TcgdexCard>(`${TCGDEX}/cards/${encodeURIComponent(id)}`);
  return fromTcgdexCard(r);
}

export async function ptcgRecentSets(): Promise<SetInfo[]> {
  const r = await getJson<{ data: PtcgSet[] }>(`${PTCG}/sets?orderBy=-releaseDate&pageSize=12`, { retries: 2 });
  return r.data.map(fromPtcgSet);
}

export async function ptcgSetCards(setId: string): Promise<{ card: CardRecord; prices: CardPrices }[]> {
  const out: { card: CardRecord; prices: CardPrices }[] = [];
  for (let page = 1; page < 6; page++) {
    const r = await getJson<{ data: PtcgCard[]; totalCount: number }>(
      `${PTCG}/cards?q=set.id:${encodeURIComponent(setId)}&page=${page}&pageSize=250`,
      { retries: 3, timeoutMs: 30000 },
    );
    out.push(...r.data.map(fromPtcgCard));
    if (out.length >= r.totalCount || !r.data.length) break;
  }
  return out;
}

export async function tcgdexSetList(): Promise<TcgdexSetBrief[]> {
  return getJson<TcgdexSetBrief[]>(`${TCGDEX}/sets`);
}

export async function tcgdexSet(id: string): Promise<{ set: SetInfo; raw: TcgdexSet } | null> {
  const raw = await getJson<TcgdexSet>(`${TCGDEX}/sets/${encodeURIComponent(id)}`);
  if (TCGDEX_EXCLUDED_SERIES.has(raw.serie?.id)) return null;
  return { set: fromTcgdexSet(raw), raw };
}

/** Search the live APIs by name (used when the local catalog has no match). */
export async function searchOnline(name: string): Promise<{ card: CardRecord; prices: CardPrices }[]> {
  try {
    const q = encodeURIComponent(`name:"${name.replace(/"/g, '')}*"`);
    const r = await getJson<{ data: PtcgCard[] }>(`${PTCG}/cards?q=${q}&pageSize=30&orderBy=-set.releaseDate`, { retries: 1 });
    return r.data.map(fromPtcgCard);
  } catch {
    const r = await getJson<{ id: string; localId: string; name: string; image?: string }[]>(
      `${TCGDEX}/cards?name=${encodeURIComponent(name)}&pagination:itemsPerPage=30`,
    );
    const details = await Promise.all(r.slice(0, 20).map((b) => tcgdexCard(b.id).catch(() => null)));
    return details.filter((x): x is { card: CardRecord; prices: CardPrices } => !!x);
  }
}
