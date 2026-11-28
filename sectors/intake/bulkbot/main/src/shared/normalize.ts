// Normalizers that turn raw pokemontcg.io / TCGdex payloads into the shared model.
// Used both by the build scripts and by the in-app live sync.
import { eraFor } from './era';
import { normalizeName, normalizeNumber } from './numbers';
import type { CardPrices, CardRecord, CardmarketTier, Edition, Finish, PriceTier, SetInfo, VariantPrice } from './types';

/* ------------------------------------------------------------------ */
/* pokemontcg.io                                                        */
/* ------------------------------------------------------------------ */

export interface PtcgSet {
  id: string;
  name: string;
  series: string;
  printedTotal?: number;
  total: number;
  ptcgoCode?: string;
  releaseDate: string;
  images?: { symbol?: string; logo?: string };
}

export interface PtcgCard {
  id: string;
  name: string;
  supertype?: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  number: string;
  artist?: string;
  rarity?: string;
  regulationMark?: string;
  set: PtcgSet;
  images: { small: string; large?: string };
  tcgplayer?: { url?: string; updatedAt?: string; prices?: Record<string, Record<string, number | null>> };
  cardmarket?: { url?: string; updatedAt?: string; prices?: Record<string, number | null> } | null;
}

const isoDate = (d?: string) => (d ? d.slice(0, 10).replace(/\//g, '-') : undefined);

function cleanTier(t: Record<string, number | null | undefined> | undefined, map: Record<string, keyof PriceTier>): PriceTier | undefined {
  if (!t) return undefined;
  const out: PriceTier = {};
  let any = false;
  for (const [src, dst] of Object.entries(map)) {
    const v = t[src];
    if (typeof v === 'number' && v > 0) {
      out[dst] = Math.round(v * 100) / 100;
      any = true;
    }
  }
  return any ? out : undefined;
}

const PTCG_TIER = { low: 'low', mid: 'mid', high: 'high', market: 'market', directLow: 'directLow' } as const;
const TCGDEX_TIER = { lowPrice: 'low', midPrice: 'mid', highPrice: 'high', marketPrice: 'market', directLowPrice: 'directLow' } as const;

/** Maps a TCGplayer price key (either API's spelling) to finish + edition. */
export function tcgKeyToVariant(key: string): { finish: Finish; edition: Edition } {
  const k = key.toLowerCase();
  const edition: Edition = k.includes('1st') ? '1st' : 'unlimited';
  if (k.includes('reverse')) return { finish: 'reverse', edition };
  if (k.includes('holo')) return { finish: 'holo', edition };
  return { finish: 'normal', edition };
}

function cmTier(p: Record<string, number | null | undefined> | undefined, prefix: '' | 'reverseHolo'): CardmarketTier | undefined {
  if (!p) return undefined;
  const pick = (a: string, b: string) => {
    const v = p[prefix ? `${prefix}${b}` : a];
    return typeof v === 'number' && v > 0 ? Math.round(v * 100) / 100 : undefined;
  };
  const t: CardmarketTier = {
    avg: pick('averageSellPrice', 'Sell'),
    low: pick('lowPrice', 'Low'),
    trend: pick('trendPrice', 'Trend'),
    avg1: pick('avg1', 'Avg1'),
    avg7: pick('avg7', 'Avg7'),
    avg30: pick('avg30', 'Avg30'),
  };
  return Object.values(t).some((v) => v !== undefined) ? t : undefined;
}

export function fromPtcgSet(s: PtcgSet): SetInfo {
  const releaseDate = isoDate(s.releaseDate) ?? '1999-01-01';
  return {
    id: s.id,
    name: s.name,
    series: s.series,
    era: eraFor(s.series, releaseDate),
    releaseDate,
    printedTotal: s.printedTotal ?? s.total,
    total: s.total,
    ptcgoCode: s.ptcgoCode,
    symbol: s.images?.symbol,
    logo: s.images?.logo,
    ptcgId: s.id,
    parentId: subsetParent(s.id),
  };
}

/** swsh9tg -> swsh9, swsh12pt5gg -> swsh12pt5, swsh45sv -> swsh45, cel25c -> cel25, me55c -> me55 */
export function subsetParent(id: string): string | undefined {
  const m = id.match(/^(.*?\d(?:pt\d)?)(tg|gg|sv|c)$/);
  return m ? m[1] : undefined;
}

export function fromPtcgCard(c: PtcgCard): { card: CardRecord; prices: CardPrices } {
  const card: CardRecord = {
    id: c.id,
    name: c.name,
    number: c.number,
    setId: c.set.id,
    rarity: c.rarity,
    supertype: c.supertype,
    subtypes: c.subtypes?.length ? c.subtypes : undefined,
    types: c.types?.length ? c.types : undefined,
    regulationMark: c.regulationMark,
    artist: c.artist,
    hp: c.hp ? Number(c.hp) || undefined : undefined,
    img: c.images.small,
    imgLarge: c.images.large,
    ptcgId: c.id,
  };
  const variants: VariantPrice[] = [];
  for (const [key, tier] of Object.entries(c.tcgplayer?.prices ?? {})) {
    const v = tcgKeyToVariant(key);
    const t = cleanTier(tier ?? undefined, PTCG_TIER);
    if (t) variants.push({ ...v, tcg: t, src: 'ptcg' });
  }
  // Cardmarket (via pokemontcg.io) - stale but useful as fallback
  const cm = cmTier(c.cardmarket?.prices ?? undefined, '');
  const cmRev = cmTier(c.cardmarket?.prices ?? undefined, 'reverseHolo');
  if (cm) attachCm(variants, baseFinish(card, variants), 'unlimited', cm);
  if (cmRev) attachCm(variants, 'reverse', 'unlimited', cmRev);
  card.finishes = uniq(variants.map((v) => v.finish));
  return {
    card,
    prices: {
      tcgUpdated: isoDate(c.tcgplayer?.updatedAt),
      cmUpdated: isoDate(c.cardmarket?.updatedAt),
      variants,
      tcgUrl: c.tcgplayer?.url,
      cmUrl: c.cardmarket?.url ?? undefined,
    },
  };
}

function baseFinish(card: CardRecord, variants: VariantPrice[]): Finish {
  if (variants.some((v) => v.finish === 'normal')) return 'normal';
  if (variants.some((v) => v.finish === 'holo')) return 'holo';
  return /holo|rare/i.test(card.rarity ?? '') && !/^rare$/i.test(card.rarity ?? '') ? 'holo' : 'normal';
}

function attachCm(variants: VariantPrice[], finish: Finish, edition: Edition, cm: CardmarketTier) {
  const v = variants.find((x) => x.finish === finish && x.edition === edition && !x.stamped);
  if (v) v.cm = v.cm ?? cm;
  else variants.push({ finish, edition, cm });
}

function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

/* ------------------------------------------------------------------ */
/* TCGdex                                                               */
/* ------------------------------------------------------------------ */

export interface TcgdexSetBrief {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount: { total: number; official: number };
}

export interface TcgdexSet extends TcgdexSetBrief {
  releaseDate?: string;
  serie: { id: string; name: string };
  tcgOnline?: string;
  abbreviation?: { official?: string };
  cards: { id: string; localId: string; name: string; image?: string }[];
}

interface TcgdexPricing {
  cardmarket?: Record<string, number | string | null> | null;
  tcgplayer?: Record<string, unknown> | null;
}

export interface TcgdexCard {
  id: string;
  localId: string;
  name: string;
  image?: string;
  category?: string;
  rarity?: string;
  illustrator?: string;
  hp?: number;
  types?: string[];
  stage?: string;
  trainerType?: string;
  energyType?: string;
  regulationMark?: string;
  set: { id: string; name: string; cardCount?: { official: number; total: number } };
  variants?: { normal?: boolean; reverse?: boolean; holo?: boolean; firstEdition?: boolean; wPromo?: boolean };
  variants_detailed?: {
    type: string;
    subtype?: string;
    size?: string;
    stamp?: string[];
    foil?: string;
    pricing?: TcgdexPricing;
  }[];
  pricing?: TcgdexPricing;
  updated?: string;
}

export const TCGDEX_EXCLUDED_SERIES = new Set(['tcgp']);

export function fromTcgdexSet(s: TcgdexSet): SetInfo {
  const releaseDate = s.releaseDate?.slice(0, 10) ?? '1999-01-01';
  return {
    id: s.id,
    name: s.name,
    series: s.serie.name,
    era: eraFor(s.serie.name, releaseDate),
    releaseDate,
    printedTotal: s.cardCount.official || s.cardCount.total,
    total: s.cardCount.total,
    ptcgoCode: s.abbreviation?.official ?? s.tcgOnline,
    symbol: s.symbol ? `${s.symbol}.png` : undefined,
    logo: s.logo ? `${s.logo}.png` : undefined,
    tcgdexId: s.id,
  };
}

export function tcgdexImage(base: string | undefined, quality: 'low' | 'high' = 'low', ext: 'png' | 'webp' | 'jpg' = 'png') {
  return base ? `${base}/${quality}.${ext}` : '';
}

const CATEGORY: Record<string, string> = { Pokemon: 'Pokémon', Trainer: 'Trainer', Energy: 'Energy' };

function tcgdexTcgTier(t: Record<string, unknown> | null | undefined, finish: Finish, edition: Edition): PriceTier | undefined {
  if (!t) return undefined;
  const keys = Object.keys(t).filter((k) => k !== 'unit' && k !== 'updated' && t[k] && typeof t[k] === 'object');
  if (keys.length === 0) return undefined;
  const want = keys.find((k) => {
    const v = tcgKeyToVariant(k);
    return v.finish === (finish === 'pokeball' || finish === 'masterball' ? 'reverse' : finish) && v.edition === edition;
  });
  // Ball / special products often expose a single "holofoil" price.
  const key = want ?? (keys.length === 1 ? keys[0] : undefined);
  return key ? cleanTier(t[key] as Record<string, number>, TCGDEX_TIER) : undefined;
}

function tcgdexCmTier(c: Record<string, number | string | null> | null | undefined, reverse: boolean): CardmarketTier | undefined {
  if (!c) return undefined;
  const sfx = reverse ? '-holo' : '';
  const g = (k: string) => {
    const v = c[`${k}${sfx}`];
    return typeof v === 'number' && v > 0 ? Math.round(v * 100) / 100 : undefined;
  };
  const t: CardmarketTier = { avg: g('avg'), low: g('low'), trend: g('trend'), avg1: g('avg1'), avg7: g('avg7'), avg30: g('avg30') };
  return Object.values(t).some((v) => v !== undefined) ? t : undefined;
}

export function fromTcgdexCard(c: TcgdexCard, setId = c.set.id): { card: CardRecord; prices: CardPrices } {
  const card: CardRecord = {
    id: c.id,
    name: c.name,
    number: c.localId,
    setId,
    rarity: c.rarity && c.rarity !== 'None' ? c.rarity : undefined,
    supertype: c.category ? CATEGORY[c.category] ?? c.category : undefined,
    subtypes: [c.stage, c.trainerType, c.energyType].filter(Boolean) as string[],
    types: c.types,
    regulationMark: c.regulationMark,
    artist: c.illustrator,
    hp: c.hp,
    img: tcgdexImage(c.image, 'low', 'webp'),
    imgLarge: tcgdexImage(c.image, 'high', 'webp'),
    tcgdexId: c.id,
  };
  if (!card.subtypes?.length) delete card.subtypes;
  const variants: VariantPrice[] = [];
  let tcgUpdated: string | undefined;
  let cmUpdated: string | undefined;
  for (const v of c.variants_detailed ?? []) {
    if (v.size && v.size !== 'standard') continue;
    const finish: Finish =
      v.foil === 'pokeball' ? 'pokeball' : v.foil === 'masterball' ? 'masterball' : v.type === 'reverse' ? 'reverse' : v.type === 'holo' ? 'holo' : 'normal';
    if (v.foil && finish !== 'pokeball' && finish !== 'masterball') continue; // cosmos/cracked-ice etc: skip
    const stamps = (v.stamp ?? []).filter((s) => s !== '1st-edition');
    const edition: Edition = v.stamp?.includes('1st-edition') ? '1st' : v.subtype?.startsWith('shadowless') ? 'shadowless' : 'unlimited';
    if (v.subtype && !['unlimited', 'shadowless'].includes(v.subtype)) continue; // red-cheek, copyright variants
    const tcg = tcgdexTcgTier(v.pricing?.tcgplayer, finish, edition === 'shadowless' ? 'unlimited' : edition);
    const cm = tcgdexCmTier(v.pricing?.cardmarket ?? undefined, finish === 'reverse');
    tcgUpdated ??= (v.pricing?.tcgplayer?.updated as string | undefined)?.slice(0, 10);
    cmUpdated ??= (v.pricing?.cardmarket?.updated as string | undefined)?.slice(0, 10);
    const stamped = stamps.length > 0;
    if (variants.some((x) => x.finish === finish && x.edition === edition && !!x.stamped === stamped)) continue;
    variants.push({ finish, edition, stamped: stamped || undefined, tcg, cm, src: 'tcgdex' });
  }
  // Many cards carry prices only at the card level (pricing.tcgplayer / pricing.cardmarket):
  // fill variants that came without their own numbers.
  if (c.pricing) {
    for (const v of variants) {
      if (v.finish === 'pokeball' || v.finish === 'masterball' || v.stamped) continue;
      if (!v.tcg && c.pricing.tcgplayer) {
        v.tcg = tcgdexTcgTier(c.pricing.tcgplayer, v.finish, v.edition === 'shadowless' ? 'unlimited' : v.edition);
        if (v.tcg) tcgUpdated ??= (c.pricing.tcgplayer.updated as string | undefined)?.slice(0, 10);
      }
      if (!v.cm && c.pricing.cardmarket && v.edition === 'unlimited') {
        v.cm = tcgdexCmTier(c.pricing.cardmarket, v.finish === 'reverse');
        if (v.cm) cmUpdated ??= (c.pricing.cardmarket.updated as string | undefined)?.slice(0, 10);
      }
    }
  }
  if (variants.length === 0 && c.variants) {
    const fin: Finish[] = [];
    if (c.variants.normal) fin.push('normal');
    if (c.variants.holo) fin.push('holo');
    if (c.variants.reverse) fin.push('reverse');
    for (const f of fin) variants.push({ finish: f, edition: 'unlimited', src: 'tcgdex' });
    if (c.variants.firstEdition) variants.push({ finish: c.variants.holo ? 'holo' : 'normal', edition: '1st', src: 'tcgdex' });
    // top-level pricing (older API shape)
    const p = c.pricing;
    if (p?.tcgplayer) {
      tcgUpdated = (p.tcgplayer.updated as string | undefined)?.slice(0, 10);
      for (const v of variants) v.tcg = tcgdexTcgTier(p.tcgplayer, v.finish, v.edition);
    }
    if (p?.cardmarket) {
      cmUpdated = (p.cardmarket.updated as string | undefined)?.slice(0, 10);
      for (const v of variants) v.cm = tcgdexCmTier(p.cardmarket, v.finish === 'reverse');
    }
  }
  card.finishes = uniq(variants.map((v) => v.finish));
  card.editions = uniq(variants.map((v) => v.edition));
  return { card, prices: { tcgUpdated, cmUpdated, variants } };
}

/**
 * Merge prices: TCGplayer numbers from pokemontcg.io stay primary (as specified),
 * TCGdex fills the gaps (shadowless, Poké Ball/Master Ball, stamps, missing variants)
 * and supplies Cardmarket prices.
 */
export function mergePrices(primary: CardPrices | undefined, extra: CardPrices | undefined): CardPrices | undefined {
  if (!primary) return extra;
  if (!extra) return primary;
  const out: CardPrices = { ...primary, variants: primary.variants.map((v) => ({ ...v })) };
  for (const ev of extra.variants) {
    const pv = out.variants.find((v) => v.finish === ev.finish && v.edition === ev.edition && !!v.stamped === !!ev.stamped);
    if (!pv) {
      out.variants.push({ ...ev });
      continue;
    }
    if (!pv.tcg && ev.tcg) {
      pv.tcg = ev.tcg;
      pv.src = 'tcgdex';
    }
    if (ev.cm) pv.cm = ev.cm; // TCGdex Cardmarket data is fresher than pokemontcg.io's copy
  }
  if (extra.cmUpdated && (!out.cmUpdated || extra.cmUpdated > out.cmUpdated)) out.cmUpdated = extra.cmUpdated;
  if (!out.tcgUpdated) out.tcgUpdated = extra.tcgUpdated;
  return out;
}

/* ------------------------------------------------------------------ */
/* Matching between the two sources                                     */
/* ------------------------------------------------------------------ */

/** Canonical key for set ids across sources: sv01 ~ sv1, sv03.5 ~ sv3pt5, swsh12.5 ~ swsh12pt5. */
export function setIdKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/\.(\d)/g, 'pt$1')
    .replace(/([a-z])0+(\d)/g, '$1$2');
}

export function setNameKey(name: string): string {
  return normalizeName(name.replace(/&/g, 'and')).replace(/\b(set|the|pokemon|tcg)\b/g, '').replace(/\s+/g, '');
}

export function cardNumberKey(n: string): string {
  return normalizeNumber(n);
}
