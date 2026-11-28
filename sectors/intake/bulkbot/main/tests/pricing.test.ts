import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE_SETTINGS, availableEditions, defaultVariant, quote, rarityClass, resolveVariant, type PriceSettings } from '../src/pricing/pricing';
import type { CardFull, CardPrices } from '../src/shared/types';

const prices: CardPrices = {
  tcgUpdated: '2026-11-27',
  cmUpdated: '2026-11-27',
  variants: [
    { finish: 'normal', edition: 'unlimited', tcg: { low: 0.05, mid: 0.3, market: 0.28 }, cm: { trend: 0.27, avg: 0.3, low: 0.1, avg1: 0.2, avg7: 0.25, avg30: 0.3 } },
    { finish: 'reverse', edition: 'unlimited', tcg: { low: 0.14, market: 0.58 }, cm: { trend: 0.61 } },
    { finish: 'pokeball', edition: 'unlimited', tcg: { market: 1.4 } },
  ],
};
const card: CardFull = { id: 'sv03.5-025', name: 'Pikachu', number: '025', setId: 'sv03.5', rarity: 'Common', img: '', prices, finishes: ['normal', 'reverse', 'pokeball'] };
const S: PriceSettings = DEFAULT_PRICE_SETTINGS;

describe('price engine', () => {
  it('uses the exact printing when it has a price', () => {
    const q = quote(card, { finish: 'reverse', edition: 'unlimited', stamped: false }, 'NM', S);
    expect(q.market).toBe(0.58);
    expect(q.low).toBe(0.14);
    expect(q.estimated).toBe(false);
    expect(q.currency).toBe('USD');
    expect(q.updated).toBe('2026-11-27');
  });

  it('applies condition multipliers', () => {
    const q = quote(card, { finish: 'reverse', edition: 'unlimited', stamped: false }, 'MP', S);
    expect(q.rawUnit).toBeCloseTo(0.58 * S.condition.MP, 2);
  });

  it('estimates printings without their own price and flags them', () => {
    const q = quote(card, { finish: 'masterball', edition: 'unlimited', stamped: false }, 'NM', S);
    expect(q.estimated).toBe(true);
    expect(q.market).toBeCloseTo(0.58 * S.estimate.masterballVsReverse, 2);
    expect(q.estimateNote).toMatch(/Master Ball/);
  });

  it('switches to Cardmarket in EUR', () => {
    const q = quote(card, { finish: 'normal', edition: 'unlimited', stamped: false }, 'NM', { ...S, source: 'cardmarket' });
    expect(q.currency).toBe('EUR');
    expect(q.market).toBe(0.27);
    expect(q.avg30).toBe(0.3);
  });

  it('values cheap cards at bulk rates when the bulk floor is on', () => {
    const s: PriceSettings = { ...S, bulkFloor: { ...S.bulkFloor, enabled: true, threshold: 0.25 } };
    const cheap: CardFull = { ...card, prices: { variants: [{ finish: 'normal', edition: 'unlimited', tcg: { market: 0.08 } }] } };
    const q = quote(cheap, { finish: 'normal', edition: 'unlimited', stamped: false }, 'NM', s);
    expect(q.bulkFloored).toBe(true);
    expect(q.unit).toBe(s.bulkFloor.rates.common);
    expect(q.rawUnit).toBe(0.08);
  });

  it('flags hits at the threshold', () => {
    expect(quote(card, { finish: 'pokeball', edition: 'unlimited', stamped: false }, 'NM', S).isHit).toBe(true);
    expect(quote(card, { finish: 'normal', edition: 'unlimited', stamped: false }, 'NM', S).isHit).toBe(false);
    expect(quote(card, { finish: 'normal', edition: 'unlimited', stamped: false }, 'NM', { ...S, hitThreshold: 0.2 }).isHit).toBe(true);
  });

  it('defaults to the most common printing', () => {
    expect(defaultVariant(card)).toEqual({ finish: 'normal', edition: 'unlimited', stamped: false });
    const holoOnly: CardFull = { ...card, finishes: ['holo'], prices: { variants: [{ finish: 'holo', edition: 'unlimited', tcg: { market: 9 } }] } };
    expect(defaultVariant(holoOnly).finish).toBe('holo');
  });

  it('estimates 1st Edition / Shadowless from unlimited when missing', () => {
    const wotc: CardFull = { ...card, set: { id: 'base1', name: 'Base Set', series: 'Base', era: 'wotc', releaseDate: '1999-01-09', printedTotal: 102, total: 102 }, prices: { variants: [{ finish: 'holo', edition: 'unlimited', tcg: { market: 100 } }] } };
    expect(availableEditions(wotc)).toEqual(['unlimited', '1st', 'shadowless']);
    const r = resolveVariant(wotc.prices, { finish: 'holo', edition: '1st', stamped: false }, S)!;
    expect(r.mult).toBe(S.estimate.firstEdVsUnlimited);
  });

  it('classifies rarity for bulk rates', () => {
    expect(rarityClass('Common', 'normal')).toBe('common');
    expect(rarityClass('Common', 'reverse')).toBe('reverse');
    expect(rarityClass('Rare Holo', 'holo')).toBe('holo');
    expect(rarityClass('Double Rare', 'holo')).toBe('ultra');
    expect(rarityClass('Uncommon', 'normal')).toBe('uncommon');
  });
});
