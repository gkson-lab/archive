// Projection (PCA-whitening) applied to raw model features, shared by the index builder and the app.

export interface Projection {
  featDim: number;
  dims: number;
  mean: Float32Array;
  /** row-major featDim x dims */
  W: Float32Array;
  eigenvalues: Float32Array;
  alpha: number;
}

export function project(p: Projection, x: Float32Array, out = new Float32Array(p.dims)): Float32Array {
  out.fill(0);
  const { featDim: F, dims: D, mean, W } = p;
  for (let f = 0; f < F; f++) {
    const v = x[f] - mean[f];
    if (v === 0) continue;
    const row = f * D;
    for (let d = 0; d < D; d++) out[d] += v * W[row + d];
  }
  let n = 0;
  for (let d = 0; d < D; d++) n += out[d] * out[d];
  n = Math.sqrt(n) || 1;
  for (let d = 0; d < D; d++) out[d] /= n;
  return out;
}

/** Binary layout: magic "BBPJ", u32 featDim, u32 dims, f32 alpha, f32 mean[featDim], f32 W[featDim*dims] */
export function serializeProjection(p: Projection): Uint8Array {
  const header = 16;
  const buf = new ArrayBuffer(header + 4 * (p.featDim + p.featDim * p.dims));
  const dv = new DataView(buf);
  dv.setUint8(0, 0x42);
  dv.setUint8(1, 0x42);
  dv.setUint8(2, 0x50);
  dv.setUint8(3, 0x4a);
  dv.setUint32(4, p.featDim, true);
  dv.setUint32(8, p.dims, true);
  dv.setFloat32(12, p.alpha, true);
  new Float32Array(buf, header, p.featDim).set(p.mean);
  new Float32Array(buf, header + 4 * p.featDim, p.featDim * p.dims).set(p.W);
  return new Uint8Array(buf);
}

export function deserializeProjection(bytes: ArrayBuffer | Uint8Array): Projection {
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 0x42 || dv.getUint8(3) !== 0x4a) throw new Error('bad projection file');
  const featDim = dv.getUint32(4, true);
  const dims = dv.getUint32(8, true);
  const alpha = dv.getFloat32(12, true);
  const mean = new Float32Array(buf, 16, featDim);
  const W = new Float32Array(buf, 16 + 4 * featDim, featDim * dims);
  return { featDim, dims, alpha, mean, W, eigenvalues: new Float32Array(0) };
}

/** Per-row symmetric int8 quantization of L2-normalized vectors. */
export function quantizeRows(vecs: Float32Array, n: number, d: number): { q: Int8Array; scales: Float32Array } {
  const q = new Int8Array(n * d);
  const scales = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < d; j++) m = Math.max(m, Math.abs(vecs[i * d + j]));
    const s = m / 127 || 1;
    scales[i] = s;
    for (let j = 0; j < d; j++) q[i * d + j] = Math.round(vecs[i * d + j] / s);
  }
  return { q, scales };
}
