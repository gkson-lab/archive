// Era classification. The source APIs give a free-form "series" string per set.
// Known series map to the fixed eras below; anything unknown (a future series)
// becomes its own era automatically, keyed by a slug of the series name.

export interface EraInfo {
  key: string;
  label: string;
  short: string;
  /** First release date of the era (YYYY-MM-DD), used to place promos/misc sets. */
  start: string;
  /** Border color of most cards in this era. */
  border: 'yellow' | 'silver' | 'unknown';
  /** Cards carry a regulation mark letter in the bottom-left corner. */
  regulationMarks: string[];
  /** Card numbers are zero padded to 3 digits ("025/198"). */
  paddedNumbers: boolean;
  color: string;
}

export const ERAS: EraInfo[] = [
  { key: 'wotc', label: 'WotC', short: 'WotC', start: '1999-01-01', border: 'yellow', regulationMarks: [], paddedNumbers: false, color: '#e4b44a' },
  { key: 'ex', label: 'EX', short: 'EX', start: '2003-06-18', border: 'yellow', regulationMarks: [], paddedNumbers: false, color: '#d9643b' },
  { key: 'dp', label: 'Diamond & Pearl / Platinum', short: 'DP', start: '2007-05-23', border: 'yellow', regulationMarks: [], paddedNumbers: false, color: '#5b7bd5' },
  { key: 'hgss', label: 'HeartGold & SoulSilver', short: 'HGSS', start: '2010-02-10', border: 'yellow', regulationMarks: [], paddedNumbers: false, color: '#c9a227' },
  { key: 'bw', label: 'Black & White', short: 'BW', start: '2011-04-25', border: 'yellow', regulationMarks: [], paddedNumbers: false, color: '#9aa0a6' },
  { key: 'xy', label: 'XY', short: 'XY', start: '2014-02-05', border: 'yellow', regulationMarks: [], paddedNumbers: false, color: '#3d8fd6' },
  { key: 'sm', label: 'Sun & Moon', short: 'SM', start: '2017-02-03', border: 'yellow', regulationMarks: [], paddedNumbers: false, color: '#f08a24' },
  { key: 'swsh', label: 'Sword & Shield', short: 'SWSH', start: '2020-02-07', border: 'yellow', regulationMarks: ['D', 'E', 'F'], paddedNumbers: true, color: '#2bb3c0' },
  { key: 'sv', label: 'Scarlet & Violet', short: 'SV', start: '2023-03-31', border: 'silver', regulationMarks: ['G', 'H', 'I'], paddedNumbers: true, color: '#c4314b' },
  { key: 'me', label: 'Mega Evolution', short: 'ME', start: '2025-09-26', border: 'silver', regulationMarks: ['I', 'J', 'K'], paddedNumbers: true, color: '#8c5cf0' },
];

const BY_KEY = new Map(ERAS.map((e) => [e.key, e]));

/** Series names (lowercased) from pokemontcg.io and TCGdex mapped to era keys. */
const SERIES_TO_ERA: Record<string, string> = {
  base: 'wotc',
  gym: 'wotc',
  neo: 'wotc',
  'legendary collection': 'wotc',
  'e-card': 'wotc',
  ecard: 'wotc',
  ex: 'ex',
  np: 'ex',
  'diamond & pearl': 'dp',
  platinum: 'dp',
  'heartgold & soulsilver': 'hgss',
  'call of legends': 'hgss',
  'black & white': 'bw',
  xy: 'xy',
  'sun & moon': 'sm',
  'sword & shield': 'swsh',
  'scarlet & violet': 'sv',
  'mega evolution': 'me',
};

/** Series that span eras (promos, POP, McDonald's...) and are placed by release date. */
const DATE_PLACED = new Set(['other', 'pop', 'miscellaneous', "mcdonald's collection", 'trainer kits', 'misc', 'promos']);

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function eraByDate(date: string): string {
  let key = ERAS[0].key;
  for (const e of ERAS) if (date >= e.start) key = e.key;
  return key;
}

/** Returns the era key for a set given its series name and release date. */
export function eraFor(series: string | undefined, releaseDate: string | undefined): string {
  const s = (series ?? '').trim().toLowerCase();
  if (SERIES_TO_ERA[s]) return SERIES_TO_ERA[s];
  if (!s || DATE_PLACED.has(s)) return releaseDate ? eraByDate(releaseDate) : 'other';
  // A brand-new series we have never seen: it becomes its own era.
  return slug(series!);
}

export function eraInfo(key: string, seriesName?: string): EraInfo {
  const known = BY_KEY.get(key);
  if (known) return known;
  const label = seriesName ?? key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    key,
    label,
    short: label.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4),
    start: '2100-01-01',
    border: 'unknown',
    regulationMarks: [],
    paddedNumbers: true,
    color: '#7f8c8d',
  };
}

export function eraOrder(key: string): number {
  const i = ERAS.findIndex((e) => e.key === key);
  return i === -1 ? ERAS.length : i;
}
