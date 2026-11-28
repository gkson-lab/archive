/**
 * Builds the static card catalog the app syncs from:
 *   public/data/manifest.json   versions + hashes of every chunk
 *   public/data/sets.json       every English set (pokemontcg.io + TCGdex-only sets)
 *   public/data/cards/<set>.json  card metadata per set
 *   public/data/prices/<era>.json prices per card (TCGplayer + Cardmarket), split by era
 *
 * Sources: pokemontcg.io (primary) + TCGdex (fallback, Cardmarket, detailed variants, newest sets).
 * Usage: npm run catalog [-- --max-age-hours 20 --ptcg-budget-min 25 --ptcg-cache-only --sets base1,sv1]
 */
import { join } from 'node:path';
import { eraInfo } from '../src/shared/era';
import {
  TCGDEX_EXCLUDED_SERIES,
  fromPtcgCard,
  fromPtcgSet,
  fromTcgdexCard,
  fromTcgdexSet,
  mergePrices,
  setIdKey,
  setNameKey,
  type PtcgCard,
  type PtcgSet,
  type TcgdexCard,
  type TcgdexSet,
  type TcgdexSetBrief,
} from '../src/shared/normalize';
import { normalizeNumber, textSimilarity } from '../src/shared/numbers';
import type { CardPrices, CardRecord, CatalogManifest, SetInfo } from '../src/shared/types';
import { cachedJson, fetchJson, log, mapLimit, pacer, sha1, writeJson } from './lib/http';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const OUT = join(process.cwd(), 'public', 'data');
const MAX_AGE = Number(opt('max-age-hours', '20')) * 3600_000;
const ONLY_SETS = opt('sets')?.split(',');
const PTCG = 'https://api.pokemontcg.io/v2';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const ptcgHeaders: Record<string, string> = process.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': process.env.POKEMONTCG_API_KEY } : {};

interface PtcgPage<T> {
  data: T[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
}

/**
 * pokemontcg.io, fetched one set at a time with polite pacing (the keyless limit is ~30 req/min).
 * Every set is cached separately, so a partial outage keeps the last good copy of each set
 * and the build continues; sets that never loaded are filled from TCGdex.
 */
async function loadPtcg(): Promise<{ sets: PtcgSet[]; cards: PtcgCard[] } | null> {
  const pace = pacer(process.env.POKEMONTCG_API_KEY ? 300 : 2100);
  const budgetMs = Number(opt('ptcg-budget-min', '25')) * 60_000;
  const t0 = Date.now();
  const cacheOnly = flag('ptcg-cache-only');
  const get = <T>(url: string) => {
    if (cacheOnly) return Promise.reject(new Error('cache-only mode'));
    if (Date.now() - t0 > budgetMs) return Promise.reject(new Error('pokemontcg.io time budget exceeded'));
    return pace(async () => {
      const r = await fetchJson<T>(url, { headers: ptcgHeaders, retries: 4, timeoutMs: 90_000 });
      if (!r) throw new Error(`empty response ${url}`);
      return r;
    });
  };
  let sets: PtcgSet[];
  try {
    sets = (await cachedJson(`ptcg:sets`, MAX_AGE, () => get<PtcgPage<PtcgSet>>(`${PTCG}/sets?page=1&pageSize=250`))).data;
  } catch (e) {
    log(`pokemontcg.io set list unavailable (${(e as Error).message}); continuing with TCGdex only`);
    return null;
  }
  log(`pokemontcg.io: ${sets.length} sets`);
  const cards: PtcgCard[] = [];
  let failed = 0;
  const ordered = [...sets].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate)); // newest first: prices move most
  for (const [i, s] of ordered.entries()) {
    if (ONLY_SETS && !ONLY_SETS.includes(s.id)) continue;
    try {
      const setCards = await cachedJson(`ptcg:set-cards:${s.id}`, MAX_AGE, async () => {
        const all: PtcgCard[] = [];
        for (let page = 1; page < 10; page++) {
          const r = await get<PtcgPage<PtcgCard>>(`${PTCG}/cards?q=set.id:${encodeURIComponent(s.id)}&page=${page}&pageSize=250`);
          all.push(...r.data);
          if (all.length >= r.totalCount || r.data.length === 0) break;
        }
        return all;
      });
      cards.push(...setCards);
    } catch (e) {
      failed++;
      if (failed <= 5) log(`  pokemontcg.io ${s.id} unavailable: ${(e as Error).message}`);
    }
    if ((i + 1) % 25 === 0) log(`  pokemontcg.io ${i + 1}/${ordered.length} sets, ${cards.length} cards`);
  }
  log(`pokemontcg.io: ${cards.length} cards (${failed} sets unavailable -> TCGdex fallback)`);
  const seen = new Set<string>();
  return { sets, cards: cards.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))) };
}

async function loadTcgdexSets(): Promise<TcgdexSet[]> {
  const briefs = (await cachedJson(`tcgdex:sets`, MAX_AGE, () => fetchJson<TcgdexSetBrief[]>(`${TCGDEX}/sets`))) ?? [];
  const sets = await mapLimit(briefs, 6, (b) =>
    cachedJson(`tcgdex:set:${b.id}`, MAX_AGE, () => fetchJson<TcgdexSet>(`${TCGDEX}/sets/${encodeURIComponent(b.id)}`)).catch(() => null),
  );
  const ok = sets.filter((s): s is TcgdexSet => !!s && !TCGDEX_EXCLUDED_SERIES.has(s.serie?.id));
  log(`TCGdex: ${ok.length} sets (Pocket excluded)`);
  return ok;
}

async function loadTcgdexCards(sets: TcgdexSet[], want: (setId: string, localId: string) => boolean) {
  const wanted = sets.flatMap((s) => (s.cards ?? []).map((c) => ({ set: s, brief: c }))).filter((x) => want(x.set.id, x.brief.localId));
  log(`TCGdex: fetching ${wanted.length} card details`);
  let done = 0;
  return mapLimit(wanted, 8, async ({ set, brief }) => {
    const card = await cachedJson(`tcgdex:card:${brief.id}`, MAX_AGE, () =>
      fetchJson<TcgdexCard>(`${TCGDEX}/cards/${encodeURIComponent(brief.id)}`, { okMissing: [404] }),
    ).catch(() => null);
    if (++done % 2000 === 0) log(`  ${done}/${wanted.length}`);
    return { set, brief, card };
  });
}

function main() {
  return run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

async function run() {
  // Card ids are TCGdex ids (TCGdex is reliable and covers every set, so ids never churn when
  // pokemontcg.io is flaky). pokemontcg.io stays the primary source for TCGplayer prices, images
  // and card fields whenever it answers; TCGdex fills gaps, brings Cardmarket and detailed variants.
  const ptcg = await loadPtcg();
  const setsOut = new Map<string, SetInfo>();
  const cardsOut = new Map<string, CardRecord>();
  const pricesOut = new Map<string, CardPrices>();
  const aliases: Record<string, string> = {};

  // --- index pokemontcg.io data -------------------------------------------------------
  const ptcgSets = new Map<string, SetInfo>();
  const ptcgSetByKey = new Map<string, SetInfo>();
  const ptcgSetByName = new Map<string, SetInfo[]>();
  const ptcgFamily = (setId: string) => ptcgSets.get(setId)?.parentId ?? setId;
  const ptcgByFamilyNumber = new Map<string, { card: CardRecord; prices: CardPrices }[]>();
  for (const s of ptcg?.sets ?? []) {
    const si = fromPtcgSet(s);
    ptcgSets.set(si.id, si);
    ptcgSetByKey.set(setIdKey(si.id), si);
    const nk = setNameKey(si.name);
    ptcgSetByName.set(nk, [...(ptcgSetByName.get(nk) ?? []), si]);
  }
  for (const raw of ptcg?.cards ?? []) {
    if (!ptcgSets.has(raw.set.id)) ptcgSets.set(raw.set.id, fromPtcgSet(raw.set));
    const rec = fromPtcgCard(raw);
    const k = `${ptcgFamily(rec.card.setId)}|${normalizeNumber(rec.card.number)}`;
    ptcgByFamilyNumber.set(k, [...(ptcgByFamilyNumber.get(k) ?? []), rec]);
  }

  const matchSet = (t: TcgdexSet): SetInfo | undefined => {
    const byId = ptcgSetByKey.get(setIdKey(t.id));
    if (byId) return byId;
    const td = t.releaseDate ?? '';
    const near = (s: SetInfo) => !td || Math.abs(Date.parse(s.releaseDate) - Date.parse(td)) < 60 * 86400_000;
    const byName = (ptcgSetByName.get(setNameKey(t.name)) ?? []).find(near);
    if (byName) return byName;
    const code = t.abbreviation?.official ?? t.tcgOnline;
    if (code) {
      for (const s of ptcgSets.values()) if (s.ptcgoCode === code && near(s) && !s.parentId && Math.abs(s.total - t.cardCount.total) < 40) return s;
    }
    return undefined;
  };

  // --- TCGdex is the backbone --------------------------------------------------------------
  const tcgdexSets = await loadTcgdexSets();
  const details = await loadTcgdexCards(tcgdexSets, () => true);
  const matchedPtcgIds = new Set<string>();
  const ptcgSetToCanon = new Map<string, string>();
  for (const t of tcgdexSets) {
    const si = fromTcgdexSet(t);
    const m = matchSet(t);
    if (m) {
      si.ptcgId = m.id;
      si.ptcgoCode ??= m.ptcgoCode;
      si.symbol ??= m.symbol;
      si.logo ??= m.logo;
      if (m.printedTotal && si.printedTotal !== m.printedTotal && t.cardCount.official === 0) si.printedTotal = m.printedTotal;
      ptcgSetToCanon.set(m.id, si.id);
      for (const sub of ptcgSets.values()) if (sub.parentId === m.id) ptcgSetToCanon.set(sub.id, si.id);
    }
    setsOut.set(si.id, si);
  }
  let matched = 0;
  for (const { set, brief, card: raw } of details) {
    const si = setsOut.get(set.id)!;
    const t = raw ? fromTcgdexCard(raw, set.id) : null;
    const m = si.ptcgId ? ptcgByFamilyNumber.get(`${ptcgFamily(si.ptcgId)}|${normalizeNumber(brief.localId)}`) ?? [] : [];
    const p = m.length === 1 ? m[0] : m.find((x) => textSimilarity(x.card.name, brief.name) > 0.6);
    if (!t && !p) continue;
    let card: CardRecord;
    let prices: CardPrices | undefined;
    if (p) {
      matched++;
      matchedPtcgIds.add(p.card.id);
      card = {
        ...(t?.card ?? {}),
        ...p.card,
        id: brief.id,
        setId: set.id,
        number: t?.card.number ?? brief.localId,
        tcgdexId: brief.id,
        ptcgId: p.card.id,
        img: p.card.img || t?.card.img || '',
        imgLarge: p.card.imgLarge ?? t?.card.imgLarge,
        regulationMark: p.card.regulationMark ?? t?.card.regulationMark,
        finishes: [...new Set([...(p.card.finishes ?? []), ...(t?.card.finishes ?? [])])],
        editions: t?.card.editions,
      };
      prices = mergePrices(p.prices, t?.prices);
      aliases[p.card.id] = brief.id;
    } else {
      card = t!.card;
      prices = t!.prices;
    }
    // cards without an image stay in the catalog: searchable and matchable by OCR, just not visually
    cardsOut.set(card.id, card);
    if (prices) pricesOut.set(card.id, prices);
  }
  // pokemontcg.io cards that TCGdex doesn't have
  let added = 0;
  for (const list of ptcgByFamilyNumber.values()) {
    for (const { card, prices } of list) {
      if (matchedPtcgIds.has(card.id) || cardsOut.has(card.id)) continue;
      const canonSet = ptcgSetToCanon.get(card.setId);
      if (canonSet) card.setId = canonSet;
      else if (!setsOut.has(card.setId)) setsOut.set(card.setId, ptcgSets.get(card.setId)!);
      cardsOut.set(card.id, card);
      pricesOut.set(card.id, prices);
      added++;
    }
  }
  log(`merged: ${cardsOut.size} cards (${matched} matched with pokemontcg.io, ${added} only on pokemontcg.io)`);

  // --- write -------------------------------------------------------------------------
  const sets = [...setsOut.values()]
    .filter((s) => [...cardsOut.values()].some((c) => c.setId === s.id))
    .filter((s) => !ONLY_SETS || ONLY_SETS.includes(s.id))
    .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.id.localeCompare(b.id));
  const bySet = new Map<string, CardRecord[]>();
  for (const c of cardsOut.values()) {
    if (!setsOut.has(c.setId)) continue;
    bySet.set(c.setId, [...(bySet.get(c.setId) ?? []), c]);
  }
  const manifest: CatalogManifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    cardCount: 0,
    setCount: sets.length,
    sets: [],
    prices: [],
    aliases,
  };
  const numSort = (a: CardRecord, b: CardRecord) => a.number.localeCompare(b.number, 'en', { numeric: true });
  for (const s of sets) {
    const cards = (bySet.get(s.id) ?? []).sort(numSort);
    const text = await writeJson(join(OUT, 'cards', `${s.id}.json`), cards);
    manifest.sets.push({ id: s.id, hash: sha1(text).slice(0, 12), count: cards.length });
    manifest.cardCount += cards.length;
  }
  await writeJson(join(OUT, 'sets.json'), sets);
  const byEra = new Map<string, Record<string, CardPrices>>();
  for (const s of sets) {
    const bucket = byEra.get(s.era) ?? {};
    for (const c of bySet.get(s.id) ?? []) {
      const p = pricesOut.get(c.id);
      if (p && p.variants.length) bucket[c.id] = p;
    }
    byEra.set(s.era, bucket);
  }
  for (const [era, prices] of byEra) {
    const file = `prices/${era}.json`;
    const text = await writeJson(join(OUT, file), prices);
    manifest.prices.push({ file, hash: sha1(text).slice(0, 12), count: Object.keys(prices).length });
  }
  await writeJson(join(OUT, 'manifest.json'), manifest, true);
  const eras = [...new Set(sets.map((s) => s.era))].map((e) => `${eraInfo(e).short}:${sets.filter((s) => s.era === e).length}`);
  log(`wrote ${manifest.cardCount} cards in ${sets.length} sets -> ${OUT}`);
  log(`eras ${eras.join(' ')}`);
}

main();
