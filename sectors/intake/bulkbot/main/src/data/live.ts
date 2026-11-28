// Live sync with the card APIs, on top of the static snapshot:
//  - new sets released after the last snapshot build are pulled straight from the APIs
//    (pokemontcg.io first, TCGdex as fallback), so they show up without an app update
//  - prices for cards you scan/open are refreshed on demand
import { normalizeName } from '../shared/numbers';
import { mergePrices, setIdKey, setNameKey } from '../shared/normalize';
import type { CardPrices, CardRecord, SetInfo } from '../shared/types';
import { ptcgCard, ptcgRecentSets, ptcgSetCards, tcgdexCard, tcgdexSet, tcgdexSetList } from './api';
import { allSets, getCard, getPrices, putLiveCards } from './catalog';
import { kvGet, kvSet } from './db';

const DAY = 86400_000;

function knownSet(s: SetInfo): boolean {
  const k = setIdKey(s.id);
  const n = setNameKey(s.name);
  return allSets().some((x) => setIdKey(x.id) === k || (x.ptcgId && setIdKey(x.ptcgId) === k) || (x.tcgdexId && setIdKey(x.tcgdexId) === k) || setNameKey(x.name) === n);
}

/** Returns the number of new sets added. Runs at most once a day unless forced. */
export async function syncNewSets(force = false, onStatus?: (msg: string) => void): Promise<number> {
  const last = (await kvGet<number>('liveSetsCheckedAt')) ?? 0;
  if (!force && Date.now() - last < DAY) return 0;
  if (!navigator.onLine) return 0;
  let added = 0;
  // 1) pokemontcg.io (primary)
  try {
    const recent = await ptcgRecentSets();
    for (const s of recent.filter((x) => !knownSet(x))) {
      onStatus?.(`New set: ${s.name}`);
      const cards = await ptcgSetCards(s.id);
      await putLiveCards(cards, [s]);
      added++;
    }
  } catch {
    // 2) TCGdex fallback
    try {
      const list = await tcgdexSetList();
      const candidates = list.slice(-15); // TCGdex lists sets oldest -> newest
      for (const b of candidates) {
        if (allSets().some((x) => x.id === b.id || x.tcgdexId === b.id)) continue;
        const r = await tcgdexSet(b.id);
        if (!r || knownSet(r.set)) continue;
        onStatus?.(`New set: ${r.set.name}`);
        const cards = [];
        for (const c of r.raw.cards) {
          const full = await tcgdexCard(c.id).catch(() => null);
          if (full) cards.push(full);
        }
        await putLiveCards(cards, [r.set]);
        added++;
      }
    } catch {
      /* offline or both APIs down: the static snapshot still works */
    }
  }
  await kvSet('liveSetsCheckedAt', Date.now());
  return added;
}

/**
 * Refreshes one card's prices from the APIs if the stored copy is older than maxAgeMs.
 * TCGplayer numbers from pokemontcg.io stay primary; TCGdex adds Cardmarket + detailed variants.
 */
export async function refreshCardPrices(cardId: string, maxAgeMs = DAY): Promise<boolean> {
  const card = getCard(cardId);
  if (!card || !navigator.onLine) return false;
  const p = getPrices(cardId);
  if (p?.fetchedAt && Date.now() - p.fetchedAt < maxAgeMs) return false;
  const [a, b] = await Promise.all([
    card.ptcgId ? ptcgCard(card.ptcgId).catch(() => null) : Promise.resolve(null),
    card.tcgdexId ? tcgdexCard(card.tcgdexId).catch(() => null) : Promise.resolve(null),
  ]);
  if (!a && !b) return false;
  const prices: CardPrices | undefined = mergePrices(a?.prices, b?.prices);
  const patch: CardRecord = { ...card, ...(b?.card.regulationMark ? { regulationMark: b.card.regulationMark } : {}) };
  await putLiveCards([{ card: patch, prices }]);
  return true;
}

export function looksLikeName(s: string) {
  return normalizeName(s).length >= 3;
}
