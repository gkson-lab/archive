// Turns a camera frame + detected quad into everything recognition needs:
// an upright 224x320 model input, OCR strips, a change-detection signature and a thumbnail.
import { flipQuad, type Quad, type RgbaImage, warpQuad } from '../vision/homography';
import { refineQuad } from '../vision/refine';
import { MODEL_H, MODEL_W, cardSignature } from '../shared/preprocess';
import { borderClass } from '../recognition/fusion';

export interface Capture {
  quad: Quad;
  rgb: Float32Array;
  rgbFlipped?: Float32Array;
  signature: Float32Array;
  border: 'yellow' | 'silver' | 'other';
  bottom: ImageData;
  title: ImageData;
  /** small upright RGBA for the thumbnail */
  preview: RgbaImage;
  src: RgbaImage;
}

let grabCanvas: HTMLCanvasElement | null = null;

/** Copies the card's bounding box (+margin) out of the live video at full resolution. */
export function grabRegion(video: HTMLVideoElement, quadVideo: Quad): { img: RgbaImage; ox: number; oy: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const xs = quadVideo.map((p) => p.x);
  const ys = quadVideo.map((p) => p.y);
  const pad = 0.06 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(vw, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(vh, Math.ceil(Math.max(...ys) + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 40 || h < 40) return null;
  grabCanvas ??= document.createElement('canvas');
  if (grabCanvas.width !== w || grabCanvas.height !== h) {
    grabCanvas.width = w;
    grabCanvas.height = h;
  }
  const ctx = grabCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, x0, y0, w, h, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return { img: { data, width: w, height: h }, ox: x0, oy: y0 };
}

function toRgbFloat(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = img.data[i * 4];
    out[i * 3 + 1] = img.data[i * 4 + 1];
    out[i * 3 + 2] = img.data[i * 4 + 2];
  }
  return out;
}

function toImageData(img: RgbaImage): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

export function captureCard(region: { img: RgbaImage; ox: number; oy: number }, quadVideo: Quad, withFlip: boolean): Capture {
  const local = quadVideo.map((p) => ({ x: p.x - region.ox, y: p.y - region.oy })) as Quad;
  const q = refineQuad(region.img, local);
  const warped = warpQuad(region.img, q, MODEL_W, MODEL_H, undefined, 2);
  const rgb = toRgbFloat(warped);
  // OCR strips at higher resolution, straight from the full-res region
  const bottom = warpQuad(region.img, q, 960, 128, { x0: 0.03, y0: 0.875, x1: 0.97, y1: 0.98 });
  const title = warpQuad(region.img, q, 720, 96, { x0: 0.06, y0: 0.03, x1: 0.78, y1: 0.105 });
  const out: Capture = {
    quad: q.map((p) => ({ x: p.x + region.ox, y: p.y + region.oy })) as Quad,
    rgb,
    signature: cardSignature(rgb, MODEL_W, MODEL_H),
    border: borderClass(rgb, MODEL_W, MODEL_H),
    bottom: toImageData(bottom),
    title: toImageData(title),
    preview: warped,
    src: region.img,
  };
  if (withFlip) out.rgbFlipped = toRgbFloat(warpQuad(region.img, flipQuad(q), MODEL_W, MODEL_H, undefined, 2));
  return out;
}

/** Re-cuts OCR strips for the 180° orientation (card held upside down). */
export function flippedStrips(c: Capture, region: RgbaImage): { bottom: ImageData; title: ImageData } {
  const q = flipQuad(c.quad);
  return {
    bottom: toImageData(warpQuad(region, q, 960, 128, { x0: 0.03, y0: 0.875, x1: 0.97, y1: 0.98 })),
    title: toImageData(warpQuad(region, q, 720, 96, { x0: 0.06, y0: 0.03, x1: 0.78, y1: 0.105 })),
  };
}

export async function makeThumb(img: RgbaImage, w = 160): Promise<Blob | undefined> {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const t = document.createElement('canvas');
  t.width = w;
  t.height = Math.round((img.height / img.width) * w);
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  return new Promise((r) => t.toBlob((b) => r(b ?? undefined), 'image/jpeg', 0.72));
}
