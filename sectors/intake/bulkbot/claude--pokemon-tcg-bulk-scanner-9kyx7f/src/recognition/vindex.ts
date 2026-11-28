// In-memory int8 vector index with exact (brute force) cosine search.
// 21k cards x 256 dims is ~5.4M multiply-adds per query: a few ms in JS, no ANN structure needed.
import { project, type Projection } from '../shared/projection';

export interface Hit {
  row: number;
  id: string;
  score: number;
}

export class VectorIndex {
  ids: string[];
  dims: number;
  /** int8 rows (prebuilt) */
  q: Int8Array;
  scales: Float32Array;
  /** float rows added on-device (cards from sets newer than the prebuilt index) */
  extraIds: string[] = [];
  extra: Float32Array[] = [];
  private rowOf = new Map<string, number>();

  constructor(
    ids: string[],
    q: Int8Array,
    scales: Float32Array,
    dims: number,
    public proj: Projection,
  ) {
    this.ids = ids;
    this.q = q;
    this.scales = scales;
    this.dims = dims;
    ids.forEach((id, i) => this.rowOf.set(id, i));
  }

  get size() {
    return this.ids.length + this.extraIds.length;
  }

  has(id: string) {
    return this.rowOf.has(id) || this.extraIds.includes(id);
  }

  /** Projects a raw model feature into the index space (L2-normalized). */
  embed(feature: Float32Array): Float32Array {
    return project(this.proj, feature);
  }

  addLocal(id: string, vec: Float32Array) {
    const i = this.extraIds.indexOf(id);
    if (i >= 0) this.extra[i] = vec;
    else {
      this.extraIds.push(id);
      this.extra.push(vec);
    }
  }

  vectorOf(id: string): Float32Array | null {
    const r = this.rowOf.get(id);
    if (r !== undefined) {
      const v = new Float32Array(this.dims);
      const s = this.scales[r];
      const o = r * this.dims;
      for (let d = 0; d < this.dims; d++) v[d] = this.q[o + d] * s;
      return v;
    }
    const e = this.extraIds.indexOf(id);
    return e >= 0 ? this.extra[e] : null;
  }

  /** Top-k cosine matches for an already projected query vector. */
  search(qv: Float32Array, k = 24): Hit[] {
    const D = this.dims;
    const n = this.ids.length;
    const top: Hit[] = [];
    let worst = -Infinity;
    const push = (row: number, id: string, score: number) => {
      if (top.length < k) {
        top.push({ row, id, score });
        if (top.length === k) {
          top.sort((a, b) => b.score - a.score);
          worst = top[k - 1].score;
        }
        return;
      }
      if (score <= worst) return;
      // insert in order
      let i = k - 1;
      while (i > 0 && top[i - 1].score < score) {
        top[i] = top[i - 1];
        i--;
      }
      top[i] = { row, id, score };
      worst = top[k - 1].score;
    };
    const q = this.q;
    for (let r = 0; r < n; r++) {
      let acc = 0;
      const o = r * D;
      for (let d = 0; d < D; d += 4) {
        acc += qv[d] * q[o + d] + qv[d + 1] * q[o + d + 1] + qv[d + 2] * q[o + d + 2] + qv[d + 3] * q[o + d + 3];
      }
      push(r, this.ids[r], acc * this.scales[r]);
    }
    for (let e = 0; e < this.extra.length; e++) {
      const v = this.extra[e];
      let acc = 0;
      for (let d = 0; d < D; d++) acc += qv[d] * v[d];
      push(n + e, this.extraIds[e], acc);
    }
    if (top.length < k) top.sort((a, b) => b.score - a.score);
    return top;
  }

  similarity(idA: string, idB: string): number {
    const a = this.vectorOf(idA);
    const b = this.vectorOf(idB);
    if (!a || !b) return 0;
    let s = 0;
    for (let d = 0; d < this.dims; d++) s += a[d] * b[d];
    return s;
  }
}
