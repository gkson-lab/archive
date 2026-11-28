// Session exports: a full CSV and TCGplayer Mass Entry text ("qty Name [SETCODE] number").
import { getCard } from '../data/catalog';
import type { ScanRec } from '../data/db';
import { EDITION_LABEL, FINISH_LABEL, quote, type PriceSettings } from '../pricing/pricing';
import { eraInfo } from '../shared/era';

const CONDITION_TCG: Record<string, string> = { NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Damaged' };

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function sessionCsv(rows: ScanRec[], price: PriceSettings): string {
  const head = [
    'Quantity',
    'Name',
    'Set',
    'Set Code',
    'Number',
    'Printed Total',
    'Rarity',
    'Era',
    'Printing',
    'Edition',
    'Stamped',
    'Condition',
    'Market Price',
    'Low Price',
    'Unit Value',
    'Line Value',
    'Currency',
    'Price Updated',
    'Estimated',
    'Bulk Floor',
    'Card ID',
    'TCGplayer URL',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    const c = getCard(r.cardId);
    if (!c) continue;
    const q = quote(c, r.variant, r.condition, price);
    lines.push(
      [
        r.qty,
        c.name,
        c.set?.name ?? c.setId,
        c.set?.ptcgoCode ?? '',
        c.number,
        c.set?.printedTotal ?? '',
        c.rarity ?? '',
        c.set ? eraInfo(c.set.era, c.set.series).label : '',
        FINISH_LABEL[r.variant.finish],
        EDITION_LABEL[r.variant.edition],
        r.variant.stamped ? 'yes' : '',
        CONDITION_TCG[r.condition] ?? r.condition,
        q.market ?? '',
        q.low ?? '',
        q.unit.toFixed(2),
        (q.unit * r.qty).toFixed(2),
        q.currency,
        q.updated ?? '',
        q.estimated ? 'yes' : '',
        q.bulkFloored ? 'yes' : '',
        c.id,
        c.ptcgId ? `https://prices.pokemontcg.io/tcgplayer/${c.ptcgId}` : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

/**
 * TCGplayer Mass Entry: one line per card, "quantity name [set code] number".
 * Identical printings are merged. Variants (reverse, 1st Ed...) are chosen on TCGplayer's side.
 */
export function tcgplayerMassEntry(rows: ScanRec[]): string {
  const merged = new Map<string, number>();
  for (const r of rows) {
    const c = getCard(r.cardId);
    if (!c) continue;
    const code = c.set?.ptcgoCode ? ` [${c.set.ptcgoCode}]` : '';
    const num = /^\d+$/.test(c.number) && c.set?.printedTotal ? `${c.number}/${c.set.printedTotal}` : c.number;
    const line = `${c.name}${code} ${num}`.trim();
    merged.set(line, (merged.get(line) ?? 0) + r.qty);
  }
  return [...merged].map(([line, qty]) => `${qty} ${line}`).join('\n');
}

export function download(filename: string, text: string, type = 'text/csv') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Share sheet on mobile when available, download otherwise. */
export async function shareOrDownload(filename: string, text: string, type = 'text/csv') {
  try {
    const file = new File([text], filename, { type });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
  }
  download(filename, text, type);
}

export function safeName(s: string) {
  return s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'session';
}
