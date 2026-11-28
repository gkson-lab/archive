// Shared data model used by the app and by the build scripts.

/** One TCGplayer price row (USD). */
export interface PriceTier {
  low?: number;
  mid?: number;
  high?: number;
  market?: number;
  directLow?: number;
}

/** Cardmarket price row (EUR). */
export interface CardmarketTier {
  avg?: number;
  low?: number;
  trend?: number;
  avg1?: number;
  avg7?: number;
  avg30?: number;
}

/**
 * Normalized variant (printing) keys.
 * finish: normal | holo | reverse | pokeball | masterball
 * edition: unlimited | 1st | shadowless
 * stamp: a promo stamp is tracked separately (see VariantSelection.stamped)
 */
export type Finish = 'normal' | 'holo' | 'reverse' | 'pokeball' | 'masterball';
export type Edition = 'unlimited' | '1st' | 'shadowless';

export interface VariantSelection {
  finish: Finish;
  edition: Edition;
  stamped: boolean;
}

/** One priced printing of a card, normalized across sources. */
export interface VariantPrice {
  finish: Finish;
  edition: Edition;
  stamped?: boolean;
  /** TCGplayer prices in USD. */
  tcg?: PriceTier;
  /** Cardmarket prices in EUR. */
  cm?: CardmarketTier;
  /** Where the TCGplayer number came from. */
  src?: 'ptcg' | 'tcgdex';
}

export interface CardPrices {
  /** ISO date (YYYY-MM-DD) of the TCGplayer price update. */
  tcgUpdated?: string;
  /** ISO date of the Cardmarket price update. */
  cmUpdated?: string;
  variants: VariantPrice[];
  /** TCGplayer product URL (via pokemontcg.io redirect) if known. */
  tcgUrl?: string;
  cmUrl?: string;
}

export interface SetInfo {
  id: string;
  name: string;
  /** Raw series name from the source API, e.g. "Sword & Shield". */
  series: string;
  /** Normalized era key, see era.ts. */
  era: string;
  /** YYYY-MM-DD */
  releaseDate: string;
  /** The number printed after the slash on cards (e.g. 198 in 045/198). */
  printedTotal: number;
  /** All cards including secret rares. */
  total: number;
  /** Pokémon TCG Online / Live code, printed on SV-era cards (e.g. "SVI"). */
  ptcgoCode?: string;
  symbol?: string;
  logo?: string;
  /** Source ids for cross-referencing. */
  ptcgId?: string;
  tcgdexId?: string;
  /** Parent set for subsets like Trainer Gallery / Galarian Gallery / Shiny Vault. */
  parentId?: string;
}

export interface CardRecord {
  id: string;
  name: string;
  /** Number as printed in the corner, e.g. "4", "TG12", "SV045", "GG01". */
  number: string;
  setId: string;
  rarity?: string;
  supertype?: 'Pokémon' | 'Trainer' | 'Energy' | string;
  subtypes?: string[];
  types?: string[];
  regulationMark?: string;
  artist?: string;
  hp?: number;
  /** Small image URL (~245px wide). */
  img: string;
  /** Large image URL. */
  imgLarge?: string;
  tcgdexId?: string;
  ptcgId?: string;
  /** Printings that exist for this card (from TCGdex variants / price keys). */
  finishes?: Finish[];
  editions?: Edition[];
}

/** A card plus its set and prices, as used by the UI. */
export interface CardFull extends CardRecord {
  set?: SetInfo;
  prices?: CardPrices;
}

export interface CatalogManifest {
  version: number;
  builtAt: string;
  cardCount: number;
  setCount: number;
  sets: { id: string; hash: string; count: number }[];
  prices: { file: string; hash: string; count: number }[];
  /** tcgdex id -> primary id, for records that changed source over time. */
  aliases: Record<string, string>;
}

export interface IndexManifest {
  version: number;
  builtAt: string;
  model: { id: string; url: string; inputW: number; inputH: number; featDim: number };
  dims: number;
  count: number;
  /** int8 vectors, row-major count x dims */
  vectors: string;
  /** per-row float32 scale; vector = int8 * scale */
  scales: string;
  /** JSON array of card ids aligned with rows */
  ids: string;
  /** float32 mean[featDim] followed by float32 components[featDim x dims] */
  pca: string;
  hash: string;
}
