// On-device OCR with self-hosted Tesseract (LSTM, English). Reads the collector-number strip
// and the name line of a warped card to pin down the exact printing.
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { parseCardNumbers, parseRegulationMark, parseSetCode } from '../shared/numbers';
import type { OcrEvidence } from './fusion';

const BASE = new URL('tesseract/', document.baseURI).href;
let workerP: Promise<Worker> | null = null;
let busy = false;

export function ocrLoaded() {
  return workerP !== null;
}

export function initOcr(): Promise<Worker> {
  workerP ??= (async () => {
    const w = await createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${BASE}worker.min.js`,
      corePath: BASE,
      langPath: BASE,
      gzip: true,
      workerBlobURL: false,
      cacheMethod: 'write',
    });
    await w.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
    });
    return w;
  })();
  workerP.catch(() => {
    workerP = null;
  });
  return workerP;
}

/** Grayscale + contrast stretch + 2x upscale: Tesseract reads tiny card print much better. */
function prepare(img: ImageData, upscale = 2): HTMLCanvasElement {
  const { width: w, height: h, data } = img;
  const gray = new Uint8ClampedArray(w * h);
  let lo = 255;
  let hi = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) {
    const v = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    gray[i] = v;
    hist[v]++;
  }
  // 2% / 98% percentiles for robust stretching
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > w * h * 0.02) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc > w * h * 0.02) {
      hi = v;
      break;
    }
  }
  const range = Math.max(30, hi - lo);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, ((gray[i] - lo) * 255) / range));
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  if (upscale === 1) return c;
  const u = document.createElement('canvas');
  u.width = w * upscale;
  u.height = h * upscale;
  const uctx = u.getContext('2d')!;
  uctx.imageSmoothingQuality = 'high';
  uctx.drawImage(c, 0, 0, u.width, u.height);
  return u;
}

export interface OcrInput {
  bottom: ImageData;
  title?: ImageData;
}

/**
 * Reads the bottom strip (number, set code, regulation mark) and optionally the title line.
 * Returns null if OCR isn't ready or another read is in progress (the scanner never waits on it).
 */
export async function readCardText(input: OcrInput, wantTitle: boolean): Promise<OcrEvidence | null> {
  if (!workerP || busy) return null;
  busy = true;
  try {
    const w = await workerP;
    const bottom = await w.recognize(prepare(input.bottom));
    const text = bottom.data.text ?? '';
    const ev: OcrEvidence = {
      numbers: parseCardNumbers(text),
      regulationMark: parseRegulationMark(text.split('\n').slice(-3).join(' ')),
      setCode: parseSetCode(text),
      bottomText: text,
    };
    if (wantTitle && input.title) {
      const t = await w.recognize(prepare(input.title, 2));
      ev.title = (t.data.text ?? '').replace(/\s+/g, ' ').trim();
    }
    return ev;
  } catch {
    return null;
  } finally {
    busy = false;
  }
}
