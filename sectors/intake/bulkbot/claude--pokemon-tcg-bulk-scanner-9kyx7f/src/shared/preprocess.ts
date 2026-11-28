// Image preprocessing shared by the browser and the index builder, so a card warped from the
// camera and a reference scan from the API go through exactly the same resampling.

export const MODEL_W = 224;
export const MODEL_H = 320;

/** Background used where the source is transparent (rounded corners of API scans). */
export const BG = [32, 32, 34] as const;

interface Tap {
  idx: Int32Array;
  w: Float32Array;
  n: Uint8Array;
  maxTaps: number;
}

function taps(srcLen: number, dstLen: number): Tap {
  const scale = srcLen / dstLen;
  const maxTaps = scale > 1 ? Math.ceil(scale) + 2 : 2;
  const idx = new Int32Array(dstLen * maxTaps);
  const w = new Float32Array(dstLen * maxTaps);
  const n = new Uint8Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    let k = 0;
    if (scale > 1) {
      // area average over [i*scale, (i+1)*scale)
      const a = i * scale;
      const b = a + scale;
      for (let s = Math.floor(a); s < Math.ceil(b) && k < maxTaps; s++) {
        const ov = Math.min(b, s + 1) - Math.max(a, s);
        if (ov <= 0) continue;
        idx[i * maxTaps + k] = Math.min(srcLen - 1, Math.max(0, s));
        w[i * maxTaps + k] = ov / scale;
        k++;
      }
    } else {
      // bilinear
      const c = (i + 0.5) * scale - 0.5;
      const s0 = Math.floor(c);
      const f = c - s0;
      idx[i * maxTaps] = Math.min(srcLen - 1, Math.max(0, s0));
      w[i * maxTaps] = 1 - f;
      idx[i * maxTaps + 1] = Math.min(srcLen - 1, Math.max(0, s0 + 1));
      w[i * maxTaps + 1] = f;
      k = 2;
    }
    n[i] = k;
  }
  return { idx, w, n, maxTaps };
}

const tapCache = new Map<string, Tap>();
function cachedTaps(srcLen: number, dstLen: number) {
  const key = `${srcLen}>${dstLen}`;
  let t = tapCache.get(key);
  if (!t) {
    t = taps(srcLen, dstLen);
    if (tapCache.size > 64) tapCache.clear();
    tapCache.set(key, t);
  }
  return t;
}

/**
 * Resample an RGBA image to dstW x dstH and return packed RGB float32 (0..255),
 * compositing transparency over BG. Separable area/bilinear filter.
 */
export function resizeRgbaToRgbFloat(
  src: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW = MODEL_W,
  dstH = MODEL_H,
  out: Float32Array = new Float32Array(dstW * dstH * 3),
): Float32Array {
  // premultiply against background into a float RGB buffer
  const rgb = new Float32Array(srcW * srcH * 3);
  for (let i = 0, j = 0; i < srcW * srcH; i++, j += 3) {
    const a = src[i * 4 + 3] / 255;
    rgb[j] = src[i * 4] * a + BG[0] * (1 - a);
    rgb[j + 1] = src[i * 4 + 1] * a + BG[1] * (1 - a);
    rgb[j + 2] = src[i * 4 + 2] * a + BG[2] * (1 - a);
  }
  const tx = cachedTaps(srcW, dstW);
  const ty = cachedTaps(srcH, dstH);
  // horizontal pass -> tmp (srcH x dstW)
  const tmp = new Float32Array(srcH * dstW * 3);
  for (let y = 0; y < srcH; y++) {
    const row = y * srcW * 3;
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      const base = x * tx.maxTaps;
      for (let k = 0; k < tx.n[x]; k++) {
        const s = row + tx.idx[base + k] * 3;
        const wt = tx.w[base + k];
        r += rgb[s] * wt;
        g += rgb[s + 1] * wt;
        b += rgb[s + 2] * wt;
      }
      const o = (y * dstW + x) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  // vertical pass -> out (dstH x dstW)
  for (let y = 0; y < dstH; y++) {
    const base = y * ty.maxTaps;
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < ty.n[y]; k++) {
        const s = (ty.idx[base + k] * dstW + x) * 3;
        const wt = ty.w[base + k];
        r += tmp[s] * wt;
        g += tmp[s + 1] * wt;
        b += tmp[s + 2] * wt;
      }
      const o = (y * dstW + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/** Quick perceptual signature (16x16 grayscale, mean-removed) used to notice "a different card is now in view". */
export function cardSignature(rgb: Float32Array, w: number, h: number): Float32Array {
  const S = 16;
  const sig = new Float32Array(S * S);
  const cw = w / S;
  const ch = h / S;
  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      let acc = 0;
      let n = 0;
      for (let y = Math.floor(sy * ch); y < Math.floor((sy + 1) * ch); y += 2) {
        for (let x = Math.floor(sx * cw); x < Math.floor((sx + 1) * cw); x += 2) {
          const o = (y * w + x) * 3;
          acc += 0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2];
          n++;
        }
      }
      sig[sy * S + sx] = acc / Math.max(1, n);
    }
  }
  let mean = 0;
  for (const v of sig) mean += v;
  mean /= sig.length;
  let norm = 0;
  for (let i = 0; i < sig.length; i++) {
    sig[i] -= mean;
    norm += sig[i] * sig[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < sig.length; i++) sig[i] /= norm;
  return sig;
}

export function signatureSimilarity(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
