// PCA with power-law whitening, fitted with randomized subspace iteration (covariance via tfjs matmul).
import type { Projection } from '../../src/shared/projection';
import type { Tf } from './tf';

/** Modified Gram-Schmidt on a column-major F x k matrix, in place. */
function orthonormalize(Q: Float64Array, F: number, k: number) {
  for (let j = 0; j < k; j++) {
    const cj = j * F;
    for (let i = 0; i < j; i++) {
      const ci = i * F;
      let d = 0;
      for (let r = 0; r < F; r++) d += Q[ci + r] * Q[cj + r];
      for (let r = 0; r < F; r++) Q[cj + r] -= d * Q[ci + r];
    }
    let n = 0;
    for (let r = 0; r < F; r++) n += Q[cj + r] * Q[cj + r];
    n = Math.sqrt(n) || 1;
    for (let r = 0; r < F; r++) Q[cj + r] /= n;
  }
}

/** Cyclic Jacobi eigen-decomposition of a symmetric n x n matrix (row-major). Returns eigenvalues and column eigenvectors. */
function jacobiEigen(A: Float64Array, n: number) {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = a[i * n + i];
  return { vals, vecs: v };
}

/**
 * Fits mean + projection W so that y = (x - mean) W, with W[:, i] = u_i / (lambda_i + eps)^(alpha/2).
 * alpha = 0 -> plain PCA, 1 -> full whitening.
 */
export async function fitPca(tf: Tf, X: Float32Array, N: number, F: number, dims: number, alpha = 0.5, iters = 10): Promise<Projection> {
  const mean = new Float32Array(F);
  for (let n = 0; n < N; n++) for (let f = 0; f < F; f++) mean[f] += X[n * F + f];
  for (let f = 0; f < F; f++) mean[f] /= N;
  // covariance on the tf backend
  const C = tf.tidy(() => {
    const x = tf.tensor2d(X, [N, F]).sub(tf.tensor1d(mean));
    return tf.matMul(x, x, true, false).div(N) as ReturnType<typeof tf.zeros>;
  });
  const k = Math.min(F, dims + 32);
  const Q = new Float64Array(F * k); // column-major
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < Q.length; i++) Q[i] = rnd();
  orthonormalize(Q, F, k);
  const toRowMajor = (cm: Float64Array) => {
    const rm = new Float32Array(F * k);
    for (let j = 0; j < k; j++) for (let r = 0; r < F; r++) rm[r * k + j] = cm[j * F + r];
    return rm;
  };
  for (let it = 0; it < iters; it++) {
    const Z = tf.tidy(() => tf.matMul(C, tf.tensor2d(toRowMajor(Q), [F, k])));
    const z = await Z.data();
    Z.dispose();
    for (let j = 0; j < k; j++) for (let r = 0; r < F; r++) Q[j * F + r] = z[r * k + j];
    orthonormalize(Q, F, k);
  }
  const Bt = tf.tidy(() => {
    const q = tf.tensor2d(toRowMajor(Q), [F, k]);
    return tf.matMul(q, tf.matMul(C, q), true, false);
  });
  const B = Float64Array.from(await Bt.data());
  Bt.dispose();
  C.dispose();
  // symmetrize
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) B[i * k + j] = B[j * k + i] = (B[i * k + j] + B[j * k + i]) / 2;
  const { vals, vecs } = jacobiEigen(B, k);
  const order = Array.from(vals.keys()).sort((a, b) => vals[b] - vals[a]).slice(0, dims);
  const W = new Float32Array(F * dims);
  const eig = new Float32Array(dims);
  const eps = 1e-6;
  for (let d = 0; d < dims; d++) {
    const col = order[d];
    eig[d] = vals[col];
    const s = 1 / Math.pow(Math.max(vals[col], 0) + eps, alpha / 2);
    for (let r = 0; r < F; r++) {
      let u = 0;
      for (let j = 0; j < k; j++) u += Q[j * F + r] * vecs[j * k + col];
      W[r * dims + d] = u * s;
    }
  }
  return { featDim: F, dims, mean, W, eigenvalues: eig, alpha };
}

