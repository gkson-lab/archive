// Card number + text helpers shared by OCR parsing, search and the catalog builder.

/** "025" -> "25", "TG01" -> "TG1", "sv045" -> "SV45", "H12" -> "H12", "4a" -> "4A". */
export function normalizeNumber(n: string | number | undefined | null): string {
  if (n === undefined || n === null) return '';
  const s = String(n).toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z]*?)0*(\d+)([A-Z!?]*)$/);
  if (!m) return s;
  return `${m[1]}${m[2]}${m[3]}`;
}

export interface OcrNumber {
  /** normalized collector number, e.g. "45" or "TG12" */
  num: string;
  /** normalized printed total if a slash form was read, e.g. "198" or "TG30" */
  total?: string;
  /** true when the digits were zero padded (SWSH and later) */
  padded: boolean;
  raw: string;
}

// no lookbehind: Safari < 16.4 can't parse it and the whole app would fail to load
const SLASH_RE = /(?:^|[^A-Z0-9])([A-Z]{0,4})(\d{1,3})\s?[/|\\]\s?([A-Z]{0,4})(\d{2,3})(?!\d)/g;
const PROMO_RE = /(?:^|[^A-Z0-9])(SWSH|SM|XY|BW|DP|HGSS|SVP|MEP|NP)\s?(?:EN\s?)?(\d{1,3})(?!\d)/g;

/** Common OCR confusions inside numbers. */
function fixDigits(s: string): string {
  return s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S(?=\d)/g, '5').replace(/B(?=\d)/g, '8');
}

function slashNumber(p1: string, d1: string, p2: string, d2: string, raw: string): OcrNumber | null {
  if (Number(d2) < 1) return null;
  // a letter prefix is only real when the total carries one too (TG12/TG30, GG01/GG70, SV49/SV94, RC5/RC25);
  // otherwise it is OCR noise or the "EN" language tag glued to the number ("EN025/165")
  const keepPrefix = p1 && p2 && p1 === p2;
  return {
    num: normalizeNumber((keepPrefix ? p1 : '') + d1),
    total: normalizeNumber((keepPrefix ? p2 : '') + d2),
    padded: d1.length === 3 && d1.startsWith('0'),
    raw,
  };
}

/** Extract every plausible collector number from an OCR text line. Best guesses first. */
export function parseCardNumbers(text: string): OcrNumber[] {
  const out: OcrNumber[] = [];
  const up = text.toUpperCase().replace(/[\u2044\u2215]/g, '/');
  for (const m of up.matchAll(SLASH_RE)) {
    const n = slashNumber(m[1], m[2], m[3], m[4], m[0].trim());
    if (n) out.push(n);
  }
  // OCR sometimes misreads digits as letters; retry with common confusions fixed
  if (out.length === 0) {
    const fixed = up.replace(/[0-9OIlSB|]{1,3}\s?\/\s?[0-9OIlSB|]{2,3}/g, (s) => fixDigits(s));
    for (const m of fixed.matchAll(SLASH_RE)) {
      const n = slashNumber(m[1], m[2], m[3], m[4], m[0]);
      if (n) out.push(n);
    }
  }
  // promo form: "SWSH123", "SM210", "SVP EN 045"
  for (const m of up.matchAll(PROMO_RE)) {
    const [, p, d] = m;
    const bare = p === 'SVP' || p === 'MEP' || p === 'NP';
    out.push({ num: normalizeNumber((bare ? '' : p) + d), padded: d.length === 3, raw: m[0].trim(), total: bare ? p : undefined });
  }
  return out;
}

/**
 * Regulation mark (D..K) as printed left of the number on SWSH and later cards:
 * "D 025/202", "G MEW EN 025/165". Only accepted right before a number, to avoid stray letters.
 */
export function parseRegulationMark(text: string): string | undefined {
  const m = text.toUpperCase().match(/(?:^|[\s([|])([D-K])[\s\])|]+(?:[A-Z0-9]{2,4}\s+EN\s+)?[A-Z]{0,2}\d{3}\s?\/\s?\d{2,3}/m);
  return m?.[1];
}

/** Set code printed on SV-era cards right before the number: "PAL EN 123/193", "MEW EN 025/165". */
export function parseSetCode(text: string): string | undefined {
  const m = text.toUpperCase().match(/(?:^|[^A-Z0-9])([A-Z0-9]{2,4})\s+EN\s+[A-Z]{0,2}\d{2,3}/);
  return m?.[1];
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Similarity in [0,1] based on character trigrams (robust to OCR noise). */
export function textSimilarity(a: string, b: string): number {
  const A = normalizeName(a).replace(/\s+/g, ' ');
  const B = normalizeName(b).replace(/\s+/g, ' ');
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s: string) => {
    const g = new Map<string, number>();
    const p = `  ${s} `;
    for (let i = 0; i < p.length - 2; i++) {
      const t = p.slice(i, i + 3);
      g.set(t, (g.get(t) ?? 0) + 1);
    }
    return g;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [k, v] of ga) inter += Math.min(v, gb.get(k) ?? 0);
  return (2 * inter) / (na + nb);
}

/** Best similarity of `needle` against any word window of `hay` (for OCR lines with junk). */
export function bestWindowSimilarity(needle: string, hay: string): number {
  const n = normalizeName(needle);
  const words = normalizeName(hay).split(' ').filter(Boolean);
  const nw = Math.max(1, n.split(' ').length);
  let best = textSimilarity(n, words.join(' '));
  for (let w = Math.max(1, nw - 1); w <= nw + 1; w++) {
    for (let i = 0; i + w <= words.length; i++) {
      best = Math.max(best, textSimilarity(n, words.slice(i, i + w).join(' ')));
    }
  }
  return best;
}
