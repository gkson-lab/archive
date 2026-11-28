// On-device image embedding with TensorFlow.js (WebGL, CPU fallback). The model and its
// projection ship with the app; nothing leaves the phone.
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import { MODEL_H, MODEL_W } from '../shared/preprocess';

export const MODEL_BASE = new URL('models/cardnet-v1/', document.baseURI).href;

let model: GraphModel | null = null;
let loading: Promise<void> | null = null;
export let backendName = '';

export function embedderReady() {
  return model !== null;
}

export function loadEmbedder(onProgress?: (f: number) => void): Promise<void> {
  loading ??= (async () => {
    await tf.ready();
    try {
      if (!(await tf.setBackend('webgl'))) throw new Error('no webgl');
    } catch {
      await tf.setBackend('cpu');
    }
    backendName = tf.getBackend();
    // offline copy in IndexedDB (the service worker may not control the very first visit)
    const key = `indexeddb://bulkbot-${MODEL_BASE.split('/').filter(Boolean).pop()}`;
    try {
      model = await loadGraphModel(key);
      onProgress?.(1);
    } catch {
      model = await loadGraphModel(`${MODEL_BASE}model.json`, { onProgress });
      void model.save(key).catch(() => undefined);
    }
    // warm-up compiles the WebGL shaders so the first real scan is fast
    const warm = tf.tidy(() => {
      const r = model!.execute(tf.zeros([1, MODEL_H, MODEL_W, 3]));
      return (Array.isArray(r) ? r[0] : r) as tf.Tensor;
    });
    await warm.data();
    warm.dispose();
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** rgb: packed float RGB 0..255, MODEL_H x MODEL_W. Returns the raw model feature. */
export async function embed(rgb: Float32Array): Promise<Float32Array> {
  if (!model) throw new Error('model not loaded');
  const out = tf.tidy(() => {
    const r = model!.execute(tf.tensor4d(rgb, [1, MODEL_H, MODEL_W, 3]));
    return (Array.isArray(r) ? r[0] : r) as tf.Tensor;
  });
  const data = (await out.data()) as Float32Array;
  out.dispose();
  return data;
}

/** Recover from WebGL context loss (iOS backgrounding) by reloading. */
export function resetEmbedder() {
  model?.dispose();
  model = null;
  loading = null;
}
