// Combines visual similarity with OCR and era cues into a ranked, calibrated candidate list.
// Pure functions: unit-tested and shared by the live scanner.
import { eraInfo } from '../shared/era';
import { bestWindowSimilarity, normalizeNumber, type OcrNumber } from '../shared/numbers';
import type { CardRecord, SetInfo } from '../shared/types';

export interface OcrEvidence {
  numbers: OcrNumber[];
  regulationMark?: string;
  setCode?: string;
  title?: string;
  /** raw bottom-strip text, for name matching fallback */
  bottomText?: string;
}

export interface VisualEvidence {
  /** id -> accumulated visual similarity (mean over frames that saw it) */
  scores: Map<string, number>;
  frames: number;
  /** border class measured on the warped card */
  border?: 'yellow' | 'silver' | 'other';
}

export interface Scored {
  id: string;
  card: CardRecord;
  set?: SetInfo;
  visual: number;
  score: number;
  prob: number;
  why: string[];
}

export interface Fused {
  ranked: Scored[];
  best?: Scored;
  confidence: number;
  /** true when the top candidates look identical (reprints) and need the number to tell apart */
  printingAmbiguous: boolean;
  /** OCR number matched the chosen card */
  numberConfirmed: boolean;
}

const W = {
  number: 0.16,
  total: 0.1,
  numberMismatch: -0.08,
  name: 0.1,
  regMark: 0.05,
  regMismatch: -0.04,
  setCode: 0.08,
  border: 0.025,
  borderMismatch: -0.04,
};

export function scoreCandidates(
  cands: { id: string; card: CardRecord; set?: SetInfo; visual: number }[],
  ocr: OcrEvidence | null,
  visual: Pick<VisualEvidence, 'border'>,
  sameArt: (a: string, b: string) => number,
): Fused {
  if (!cands.length) return { ranked: [], confidence: 0, printingAmbiguous: false, numberConfirmed: false };
  const out: Scored[] = cands.map((c) => {
    let score = c.visual;
    const why: string[] = [];
    const num = normalizeNumber(c.card.number);
    const printed = c.set ? String(c.set.printedTotal) : '';
    if (ocr?.numbers.length) {
      const hitNum = ocr.numbers.find((n) => n.num === num);
      if (hitNum) {
        score += W.number;
        why.push('number');
        if (hitNum.total && (hitNum.total === normalizeNumber(printed) || (c.set && hitNum.total === normalizeNumber(String(c.set.total))))) {
          score += W.total;
          why.push('set total');
        }
      } else if (ocr.numbers.some((n) => n.total && n.total === normalizeNumber(printed))) {
        // right set, different number: likely a different card from the same set
        score += W.total * 0.5;
        why.push('set total');
      } else {
        score += W.numberMismatch;
      }
    }
    if (ocr?.title) {
      const ns = bestWindowSimilarity(c.card.name, ocr.title);
      if (ns > 0.55) {
        score += W.name * ((ns - 0.55) / 0.45);
        why.push('name');
      }
    }
    if (ocr?.regulationMark && c.card.regulationMark) {
      if (ocr.regulationMark === c.card.regulationMark) {
        score += W.regMark;
        why.push('regulation mark');
      } else score += W.regMismatch;
    }
    if (ocr?.setCode && c.set?.ptcgoCode && ocr.setCode === c.set.ptcgoCode.toUpperCase()) {
      score += W.setCode;
      why.push('set code');
    }
    if (visual.border && visual.border !== 'other' && c.set) {
      const eraBorder = eraInfo(c.set.era).border;
      if (eraBorder === visual.border) score += W.border;
      else if (eraBorder !== 'unknown') score += W.borderMismatch;
    }
    return { id: c.id, card: c.card, set: c.set, visual: c.visual, score, prob: 0, why };
  });
  out.sort((a, b) => b.score - a.score);
  // softmax with a temperature tuned so a 0.06 score gap ~ 3:1 odds
  const T = 0.055;
  const m = out[0].score;
  let z = 0;
  for (const s of out) z += Math.exp((s.score - m) / T);
  for (const s of out) s.prob = Math.exp((s.score - m) / T) / z;
  const best = out[0];
  // reprints with identical art: visual cannot separate them, only the number/set can
  const twins = out.slice(1, 6).filter((s) => sameArt(best.id, s.id) > 0.93);
  const numberConfirmed = best.why.includes('number');
  const printingAmbiguous = twins.length > 0 && !numberConfirmed && !best.why.includes('set code');
  let confidence = best.prob;
  // absolute floor: a weak visual match is never confident
  if (best.visual < 0.55) confidence *= Math.max(0, (best.visual - 0.35) / 0.2);
  if (printingAmbiguous) confidence = Math.min(confidence, 0.6);
  return { ranked: out, best, confidence, printingAmbiguous, numberConfirmed };
}

/** Classifies the border color of a warped, upright card (RGB float 0..255, w x h). */
export function borderClass(rgb: Float32Array, w: number, h: number): 'yellow' | 'silver' | 'other' {
  let yellow = 0;
  let silver = 0;
  let n = 0;
  const bw = Math.max(2, Math.round(w * 0.022));
  const sample = (x: number, y: number) => {
    const o = (y * w + x) * 3;
    const r = rgb[o];
    const g = rgb[o + 1];
    const b = rgb[o + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx : 0;
    n++;
    if (sat > 0.3 && r > b * 1.4 && g > b * 1.25 && mx > 70) yellow++;
    else if (sat < 0.16 && mx > 110) silver++;
  };
  for (let y = Math.round(h * 0.15); y < h * 0.85; y += 3) {
    sample(bw, y);
    sample(w - 1 - bw, y);
  }
  for (let x = Math.round(w * 0.15); x < w * 0.85; x += 3) {
    sample(x, bw);
    sample(x, h - 1 - bw);
  }
  if (yellow > n * 0.45) return 'yellow';
  if (silver > n * 0.45) return 'silver';
  return 'other';
}
