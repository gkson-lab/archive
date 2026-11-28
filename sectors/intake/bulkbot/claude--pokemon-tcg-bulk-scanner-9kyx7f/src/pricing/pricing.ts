// Price engine: picks the right printing's price, applies condition multipliers,
// the bulk floor and the hit threshold. Pure and unit-tested.
import type { CardFull, CardPrices, Edition, Finish, VariantPrice, VariantSelection } from '../shared/types';

export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
export const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export type RarityClass = 'common' | 'uncommon' | 'rare' | 'holo' | 'reverse' | 'ultra';

export interface PriceSettings {
  source: 'tcgplayer' | 'cardmarket';
  condition: Record<Condition, number>;
  bulkFloor: { enabled: boolean; threshold: number; rates: Record<RarityClass, number> };
  hitThreshold: number;
  /** used only when a printing has no price of its own; results are flagged "est." */
  estimate: { reverseVsNormal: number; firstEdVsUnlimited: number; shadowlessVsUnlimited: number; pokeballVsReverse: number; masterballVsReverse: number; stamped: number };
}

export const DEFAULT_PRICE_SETTINGS: PriceSettings = {
  source: 'tcgplayer',
  condition: { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.35 },
  bulkFloor: {
    enabled: false,
    threshold: 0.25,
    rates: { common: 0.01, uncommon: 0.01, rare: 0.05, holo: 0.1, reverse: 0.05, ultra: 0.25 },
  },
  hitThreshold: 1,
  estimate: { reverseVsNormal: 1.5, firstEdVsUnlimited: 2.5, shadowlessVsUnlimited: 1.8, pokeballVsReverse: 2.5, masterballVsReverse: 10, stamped: 1.3 },
};

export interface PriceQuote {
  currency: 'USD' | 'EUR';
  market?: number;
  low?: number;
  mid?: number;
  high?: number;
  /** Cardmarket extras */
  avg1?: number;
  avg7?: number;
  avg30?: number;
  updated?: string;
  /** printing had no direct price; derived from another printing with a multiplier */
  estimated: boolean;
  estimateNote?: string;
  /** condition-adjusted value of one card before the bulk floor */
  rawUnit: number;
  /** value used for totals (after the bulk floor) */
  unit: number;
  bulkFloored: boolean;
  isHit: boolean;
  rarityClass: RarityClass;
  /** where the TCGplayer number came from */
  src?: 'ptcg' | 'tcgdex';
  /** false when no source has any price for this card */
  hasPrice: boolean;
}

export function rarityClass(rarity: string | undefined, finish: Finish): RarityClass {
  const r = (rarity ?? '').toLowerCase();
  let cls: RarityClass = 'common';
  if (/ultra|secret|illustration|double|hyper|special|shiny|amazing|radiant|ace spec|legend|prism|star|break|crystal|prime|lv\.x|\bex\b|\bgx\b|\bv\b|vmax|vstar|full art|rainbow|gold|trainer gallery|character|mega/.test(r)) cls = 'ultra';
  else if (/holo/.test(r)) cls = 'holo';
  else if (/rare|promo/.test(r)) cls = 'rare';
  else if (/uncommon/.test(r)) cls = 'uncommon';
  if ((finish === 'reverse' || finish === 'pokeball' || finish === 'masterball') && (cls === 'common' || cls === 'uncommon' || cls === 'rare')) cls = 'reverse';
  return cls;
}

/** The printing a freshly scanned card defaults to. */
export function defaultVariant(card: Pick<CardFull, 'prices' | 'rarity' | 'finishes'>): VariantSelection {
  const vs = card.prices?.variants ?? [];
  const has = (f: Finish) => vs.some((v) => v.finish === f && v.edition === 'unlimited' && !v.stamped) || card.finishes?.includes(f);
  let finish: Finish = 'normal';
  if (has('normal')) finish = 'normal';
  else if (has('holo')) finish = 'holo';
  else if (has('reverse')) finish = 'reverse';
  else if (/holo|ultra|secret|illustration|ex|gx|v\b/i.test(card.rarity ?? '')) finish = 'holo';
  return { finish, edition: 'unlimited', stamped: false };
}

/** Variant chips worth showing for this card (existing printings first). */
export function availableFinishes(card: Pick<CardFull, 'prices' | 'finishes'>): Finish[] {
  const set = new Set<Finish>(card.finishes ?? []);
  for (const v of card.prices?.variants ?? []) set.add(v.finish);
  const order: Finish[] = ['normal', 'holo', 'reverse', 'pokeball', 'masterball'];
  return order.filter((f) => set.has(f));
}

export function availableEditions(card: Pick<CardFull, 'prices' | 'editions' | 'set'>): Edition[] {
  const set = new Set<Edition>(['unlimited', ...(card.editions ?? [])]);
  for (const v of card.prices?.variants ?? []) set.add(v.edition);
  // WotC-era cards can always be 1st Edition / Shadowless (Base Set) even if a source omits it
  if (card.set?.era === 'wotc') set.add('1st');
  if (card.set?.id === 'base1') set.add('shadowless');
  return (['unlimited', '1st', 'shadowless'] as Edition[]).filter((e) => set.has(e));
}

function pick(vs: VariantPrice[], f: Finish, e: Edition, stamped: boolean, src: PriceSettings['source']) {
  return vs.find((v) => v.finish === f && v.edition === e && !!v.stamped === stamped && (src === 'tcgplayer' ? v.tcg : v.cm));
}

interface Resolved {
  v: VariantPrice;
  mult: number;
  note?: string;
}

/** Finds a price for the selection, falling back to related printings with a flagged multiplier. */
export function resolveVariant(prices: CardPrices | undefined, sel: VariantSelection, s: PriceSettings): Resolved | null {
  const vs = prices?.variants ?? [];
  if (!vs.length) return null;
  const src = s.source;
  const e = s.estimate;
  const direct = pick(vs, sel.finish, sel.edition, sel.stamped, src);
  if (direct) return { v: direct, mult: 1 };
  let mult = 1;
  const notes: string[] = [];
  let finish = sel.finish;
  let edition = sel.edition;
  if (sel.stamped) {
    mult *= e.stamped;
    notes.push(`stamp ×${e.stamped}`);
  }
  let hit = pick(vs, finish, edition, false, src);
  if (!hit && edition !== 'unlimited') {
    const m = edition === '1st' ? e.firstEdVsUnlimited : e.shadowlessVsUnlimited;
    // shadowless 1st edition does exist as its own price on some sources
    hit = pick(vs, finish, 'unlimited', false, src);
    if (hit) {
      mult *= m;
      notes.push(`${edition === '1st' ? '1st Ed.' : 'Shadowless'} ×${m}`);
      edition = 'unlimited';
    }
  }
  if (!hit && (finish === 'pokeball' || finish === 'masterball')) {
    const m = finish === 'pokeball' ? e.pokeballVsReverse : e.masterballVsReverse;
    hit = pick(vs, 'reverse', edition, false, src);
    if (hit) {
      mult *= m;
      notes.push(`${finish === 'pokeball' ? 'Poké Ball' : 'Master Ball'} ×${m}`);
      finish = 'reverse';
    }
  }
  if (!hit && finish === 'reverse') {
    hit = pick(vs, 'normal', edition, false, src);
    if (hit) {
      mult *= e.reverseVsNormal;
      notes.push(`reverse ×${e.reverseVsNormal}`);
    }
  }
  if (!hit) {
    // fall back to whatever this card has, preferring the most common printing
    const order: Finish[] = ['normal', 'holo', 'reverse'];
    for (const f of order) {
      hit = pick(vs, f, 'unlimited', false, src) ?? pick(vs, f, edition, false, src);
      if (hit) break;
    }
    hit ??= vs.find((v) => (src === 'tcgplayer' ? v.tcg : v.cm));
    if (hit && (hit.finish !== sel.finish || hit.edition !== sel.edition)) notes.push(`priced as ${hit.finish}`);
  }
  if (!hit) return null;
  return { v: hit, mult, note: notes.join(', ') || undefined };
}

const round = (n: number | undefined, m: number) => (n === undefined ? undefined : Math.round(n * m * 100) / 100);

export function quote(card: CardFull, sel: VariantSelection, cond: Condition, s: PriceSettings): PriceQuote {
  const r = resolveVariant(card.prices, sel, s);
  const cls = rarityClass(card.rarity, sel.finish);
  const currency = s.source === 'tcgplayer' ? 'USD' : 'EUR';
  const condMult = s.condition[cond] ?? 1;
  let q: PriceQuote = { currency, estimated: false, rawUnit: 0, unit: 0, bulkFloored: false, isHit: false, rarityClass: cls, hasPrice: false };
  if (r) {
    const m = r.mult;
    if (s.source === 'tcgplayer' && r.v.tcg) {
      const t = r.v.tcg;
      q = { ...q, market: round(t.market ?? t.mid, m), low: round(t.low, m), mid: round(t.mid, m), high: round(t.high, m), updated: card.prices?.tcgUpdated, src: r.v.src };
    } else if (r.v.cm) {
      const c = r.v.cm;
      q = { ...q, market: round(c.trend ?? c.avg, m), low: round(c.low, m), mid: round(c.avg, m), avg1: round(c.avg1, m), avg7: round(c.avg7, m), avg30: round(c.avg30, m), updated: card.prices?.cmUpdated };
    }
    q.estimated = r.mult !== 1 || !!r.note;
    q.estimateNote = r.note;
  }
  const base = q.market ?? q.mid ?? q.low ?? 0;
  q.hasPrice = base > 0;
  q.rawUnit = Math.round(base * condMult * 100) / 100;
  q.unit = q.rawUnit;
  if (s.bulkFloor.enabled && q.rawUnit < s.bulkFloor.threshold) {
    q.unit = s.bulkFloor.rates[cls] ?? 0;
    q.bulkFloored = true;
  }
  q.isHit = q.rawUnit >= s.hitThreshold;
  return q;
}

export function formatMoney(v: number | undefined, currency: 'USD' | 'EUR'): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  const sym = currency === 'USD' ? '$' : '€';
  if (v >= 1000) return `${sym}${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `${sym}${v.toFixed(2)}`;
}

export const FINISH_LABEL: Record<Finish, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse: 'Reverse',
  pokeball: 'Poké Ball',
  masterball: 'Master Ball',
};
export const EDITION_LABEL: Record<Edition, string> = { unlimited: 'Unlimited', '1st': '1st Edition', shadowless: 'Shadowless' };
