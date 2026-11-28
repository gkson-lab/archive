import { describe, expect, it } from 'vitest';
import { bestWindowSimilarity, normalizeNumber, parseCardNumbers, parseRegulationMark, parseSetCode, textSimilarity } from '../src/shared/numbers';

describe('normalizeNumber', () => {
  it('strips zero padding and keeps prefixes', () => {
    expect(normalizeNumber('025')).toBe('25');
    expect(normalizeNumber('TG01')).toBe('TG1');
    expect(normalizeNumber('sv045')).toBe('SV45');
    expect(normalizeNumber('4')).toBe('4');
    expect(normalizeNumber('SWSH001')).toBe('SWSH1');
  });
});

describe('parseCardNumbers (real Tesseract output)', () => {
  it('reads WotC bottom line', () => {
    const t = 'Hius. Mitsuhiro ro Arita © 1995,96,98,99 Nintendo, Creatures, GAMEFREAK. © [999 Wizards. 58/102 ®';
    expect(parseCardNumbers(t)[0]).toMatchObject({ num: '58', total: '102', padded: false });
  });
  it('ignores stray letters / EN tag before SV numbers', () => {
    expect(parseCardNumbers('(c] (I 025/165 @')[0]).toMatchObject({ num: '25', total: '165', padded: true });
    expect(parseCardNumbers('(c] MEW en 025/165 ® energy')[0]).toMatchObject({ num: '25', total: '165' });
    expect(parseCardNumbers('EN025/165')[0]).toMatchObject({ num: '25', total: '165' });
  });
  it('keeps subset prefixes when both sides carry them', () => {
    expect(parseCardNumbers('TG12/TG30')[0]).toMatchObject({ num: 'TG12', total: 'TG30' });
    expect(parseCardNumbers('GG01/GG70')[0]).toMatchObject({ num: 'GG1', total: 'GG70' });
    expect(parseCardNumbers('SV49/SV94')[0]).toMatchObject({ num: 'SV49', total: 'SV94' });
  });
  it('reads secret rares and fixes O/0 confusions', () => {
    expect(parseCardNumbers(': ©.6 215/203')[0]).toMatchObject({ num: '215', total: '203' });
    expect(parseCardNumbers('58/1O2')[0]).toMatchObject({ num: '58', total: '102' });
  });
  it('reads promos', () => {
    expect(parseCardNumbers('SWSH020').map((n) => n.num)).toContain('SWSH20');
    expect(parseCardNumbers('SVP EN 045')[0]).toMatchObject({ num: '45', total: 'SVP' });
  });
});

describe('regulation mark + set code', () => {
  it('finds marks only next to a number', () => {
    expect(parseRegulationMark('D 025/202')).toBe('D');
    expect(parseRegulationMark('G MEW EN 025/165')).toBe('G');
    expect(parseRegulationMark('i\\n\\n]\\n\\nWhen several I of these 58/102')).toBeUndefined();
  });
  it('finds the SV set code, not words ending in "en"', () => {
    expect(parseSetCode('When itis angered (c] MEW en 025/165')).toBe('MEW');
    expect(parseSetCode('When itis angered, itimmediately')).toBeUndefined();
    expect(parseSetCode('G PAL EN 123/193')).toBe('PAL');
  });
});

describe('name similarity', () => {
  it('tolerates OCR noise', () => {
    expect(textSimilarity('Pikachu', 'Pikachu')).toBe(1);
    expect(textSimilarity('Charizard', 'Charizarcl')).toBeGreaterThan(0.6);
    expect(bestWindowSimilarity('Umbreon VMAX', 'xx Umbreon VMAX 310 HP')).toBeGreaterThan(0.9);
  });
});
