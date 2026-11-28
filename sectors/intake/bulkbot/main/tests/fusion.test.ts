import { describe, expect, it } from 'vitest';
import { scoreCandidates } from '../src/recognition/fusion';
import { eraFor } from '../src/shared/era';
import type { CardRecord, SetInfo } from '../src/shared/types';

const base: SetInfo = { id: 'base1', name: 'Base Set', series: 'Base', era: 'wotc', releaseDate: '1999-01-09', printedTotal: 102, total: 102 };
const base2: SetInfo = { id: 'base4', name: 'Base Set 2', series: 'Base', era: 'wotc', releaseDate: '2000-02-24', printedTotal: 130, total: 130 };
const mew: SetInfo = { id: 'sv03.5', name: '151', series: 'Scarlet & Violet', era: 'sv', releaseDate: '2023-09-22', printedTotal: 165, total: 207, ptcgoCode: 'MEW' };
const card = (id: string, name: string, number: string, setId: string, extra: Partial<CardRecord> = {}): CardRecord => ({ id, name, number, setId, img: '', ...extra });

describe('fusion', () => {
  it('uses the OCR number to separate same-art reprints', () => {
    const c1 = { id: 'base1-58', card: card('base1-58', 'Pikachu', '58', 'base1'), set: base, visual: 0.78 };
    const c2 = { id: 'base4-87', card: card('base4-87', 'Pikachu', '87', 'base4'), set: base2, visual: 0.79 };
    const sameArt = () => 0.97;
    const noOcr = scoreCandidates([c2, c1], null, {}, sameArt);
    expect(noOcr.printingAmbiguous).toBe(true);
    expect(noOcr.confidence).toBeLessThanOrEqual(0.6);
    const withOcr = scoreCandidates([c2, c1], { numbers: [{ num: '58', total: '102', padded: false, raw: '58/102' }] }, {}, sameArt);
    expect(withOcr.best?.id).toBe('base1-58');
    expect(withOcr.numberConfirmed).toBe(true);
    expect(withOcr.confidence).toBeGreaterThan(0.9);
  });

  it('is confident when one card clearly wins visually', () => {
    const r = scoreCandidates(
      [
        { id: 'sv03.5-025', card: card('sv03.5-025', 'Pikachu', '025', 'sv03.5'), set: mew, visual: 0.83 },
        { id: 'x', card: card('x', 'Raichu', '26', 'sv03.5'), set: mew, visual: 0.45 },
      ],
      null,
      {},
      () => 0.3,
    );
    expect(r.best?.id).toBe('sv03.5-025');
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  it('never trusts a weak visual match', () => {
    const r = scoreCandidates([{ id: 'a', card: card('a', 'A', '1', 'base1'), set: base, visual: 0.4 }], null, {}, () => 0);
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('uses border color and set code as era cues', () => {
    const yellow = { id: 'y', card: card('y', 'Pikachu', '25', 'base1'), set: base, visual: 0.7 };
    const silver = { id: 's', card: card('s', 'Pikachu', '25', 'sv03.5'), set: mew, visual: 0.7 };
    expect(scoreCandidates([yellow, silver], null, { border: 'silver' }, () => 0.5).best?.id).toBe('s');
    expect(scoreCandidates([yellow, silver], { numbers: [], setCode: 'MEW' }, {}, () => 0.5).best?.id).toBe('s');
  });
});

describe('eras', () => {
  it('maps API series to eras and places unknown series automatically', () => {
    expect(eraFor('Base', '1999-01-09')).toBe('wotc');
    expect(eraFor('E-Card', '2002-09-15')).toBe('wotc');
    expect(eraFor('Platinum', '2009-02-11')).toBe('dp');
    expect(eraFor('Mega Evolution', '2025-09-26')).toBe('me');
    expect(eraFor('POP', '2005-08-01')).toBe('ex');
    expect(eraFor('Other', '2021-10-08')).toBe('swsh');
    expect(eraFor('Some Future Series', '2028-01-01')).toBe('some-future-series');
  });
});
