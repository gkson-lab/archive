/**
 * Builds the visual embedding index of every card image in the catalog.
 *
 *   1. reads public/data/cards/*.json (run `npm run catalog` first)
 *   2. downloads each card image once (cached in .cache/images)
 *   3. embeds it with the on-device model (public/models/cardnet-v1) - cached per image+model
 *   4. projects features with the model's PCA-whitening projection (fitted here if missing)
 *   5. writes int8-quantized vectors + ids to public/data/index/
 *
 * Incremental: only new/changed images are downloaded and embedded on later runs, so new sets
 * are cheap to add. Usage: npm run index [-- --refit-projection --dims 256 --limit 500]
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { MODEL_H, MODEL_W, resizeRgbaToRgbFloat } from '../src/shared/preprocess';
import { deserializeProjection, project, quantizeRows, serializeProjection } from '../src/shared/projection';
import type { CardRecord, IndexManifest } from '../src/shared/types';
import { CACHE_DIR, log, mapLimit, sha1, writeJson } from './lib/http';
import { ensureImage } from './lib/images';
import { fitPca } from './lib/pca';
import { loadTf } from './lib/tf';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const ROOT = process.cwd();
const DATA = join(ROOT, 'public', 'data');
const MODEL_DIR = join(ROOT, 'public', 'models', 'cardnet-v1');
const DIMS = Number(opt('dims', '256'));
const ALPHA = Number(opt('alpha', '0.5'));
const LIMIT = opt('limit') ? Number(opt('limit')) : undefined;
const BATCH = 16;

interface ModelMeta {
  id: string;
  inputW: number;
  inputH: number;
  featDim: number;
}

async function loadCards(): Promise<CardRecord[]> {
  const dir = join(DATA, 'cards');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const all: CardRecord[] = [];
  for (const f of files) all.push(...(JSON.parse(await readFile(join(dir, f), 'utf8')) as CardRecord[]));
  return all;
}

/** Decodes an image file to RGBA and resizes to the model input with the shared resampler. */
export async function imageToInput(file: string): Promise<Float32Array> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return resizeRgbaToRgbFloat(data, info.width, info.height, MODEL_W, MODEL_H);
}

async function main() {
  const meta = JSON.parse(await readFile(join(MODEL_DIR, 'cardnet.json'), 'utf8')) as ModelMeta;
  let cards = await loadCards();
  cards = cards.filter((c) => c.img);
  if (LIMIT) cards = cards.slice(0, LIMIT);
  log(`index: ${cards.length} cards, model ${meta.id}`);

  const featDir = join(CACHE_DIR, 'features', meta.id);
  await mkdir(featDir, { recursive: true });
  const featFile = (url: string) => join(featDir, `${sha1(url).slice(0, 24)}.f32`);

  // 1+2: download missing images (parallel) ------------------------------------------------
  const need: CardRecord[] = [];
  for (const c of cards) {
    try {
      await stat(featFile(c.img));
    } catch {
      need.push(c);
    }
  }
  log(`index: ${need.length} cards need embedding (${cards.length - need.length} cached)`);
  let dl = 0;
  const files = await mapLimit(need, 12, async (c) => {
    const f = await ensureImage(c.img).catch(() => null);
    const alt = !f && c.imgLarge ? await ensureImage(c.imgLarge).catch(() => null) : null;
    if (++dl % 1000 === 0) log(`  downloaded ${dl}/${need.length}`);
    return f ?? alt;
  });

  // 3: embed ---------------------------------------------------------------------------------
  if (need.length) {
    const { tf, loadGraphModel, native } = await loadTf();
    log(`tfjs backend: ${tf.getBackend()}${native ? ' (native)' : ''}`);
    const model = await loadGraphModel(join(MODEL_DIR, 'model.json'));
    const todo = need.map((c, i) => ({ c, file: files[i] })).filter((x) => x.file);
    let done = 0;
    const t0 = Date.now();
    for (let b = 0; b < todo.length; b += BATCH) {
      const batch = todo.slice(b, b + BATCH);
      const inputs = await Promise.all(batch.map((x) => imageToInput(x.file!).catch(() => null)));
      const ok = batch.filter((_, i) => inputs[i]);
      const okInputs = inputs.filter((x): x is Float32Array => !!x);
      if (!okInputs.length) continue;
      const flat = new Float32Array(okInputs.length * MODEL_W * MODEL_H * 3);
      okInputs.forEach((x, i) => flat.set(x, i * x.length));
      const out = tf.tidy(() => {
        const r = model.execute(tf.tensor4d(flat, [okInputs.length, MODEL_H, MODEL_W, 3]));
        return (Array.isArray(r) ? r[0] : r) as ReturnType<typeof tf.zeros>;
      });
      const feats = await out.data();
      out.dispose();
      await Promise.all(
        ok.map((x, i) => writeFile(featFile(x.c.img), Buffer.from(feats.buffer, feats.byteOffset + i * meta.featDim * 4, meta.featDim * 4))),
      );
      done += ok.length;
      if (done % 2000 < BATCH) log(`  embedded ${done}/${todo.length} (${((Date.now() - t0) / done).toFixed(1)} ms/card)`);
    }
  }

  // collect features ---------------------------------------------------------------------------
  const ids: string[] = [];
  const featsAll: Float32Array[] = [];
  for (const c of cards) {
    try {
      const buf = await readFile(featFile(c.img));
      featsAll.push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
      ids.push(c.id);
    } catch {
      /* image unavailable */
    }
  }
  const N = ids.length;
  const F = meta.featDim;
  log(`index: ${N} embedded cards`);

  // 4: projection ------------------------------------------------------------------------------
  const projFile = join(MODEL_DIR, 'projection.bin');
  let proj;
  const haveProj = await stat(projFile).then(() => true, () => false);
  if (haveProj && !flag('refit-projection')) {
    proj = deserializeProjection(await readFile(projFile));
    log(`projection: loaded ${proj.featDim}->${proj.dims}`);
  } else {
    const { tf } = await loadTf();
    const X = new Float32Array(N * F);
    featsAll.forEach((f, i) => X.set(f, i * F));
    log(`projection: fitting PCA ${F}->${DIMS} (alpha ${ALPHA}) on ${N} cards...`);
    proj = await fitPca(tf, X, N, F, DIMS, ALPHA);
    await writeFile(projFile, serializeProjection(proj));
    log(`projection: saved ${projFile}`);
  }

  // 5: project + quantize + write --------------------------------------------------------------
  const D = proj.dims;
  const vecs = new Float32Array(N * D);
  const tmp = new Float32Array(D);
  for (let i = 0; i < N; i++) vecs.set(project(proj, featsAll[i], tmp), i * D);
  const { q, scales } = quantizeRows(vecs, N, D);
  const outDir = join(DATA, 'index');
  await mkdir(outDir, { recursive: true });
  const hash = sha1(Buffer.from(q.buffer)).slice(0, 10);
  const vecName = `vectors-${hash}.i8`;
  const scaleName = `scales-${hash}.f32`;
  const idsName = `ids-${hash}.json`;
  await writeFile(join(outDir, vecName), Buffer.from(q.buffer));
  await writeFile(join(outDir, scaleName), Buffer.from(scales.buffer));
  await writeJson(join(outDir, idsName), ids);
  const manifest: IndexManifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    model: { id: meta.id, url: 'models/cardnet-v1/', inputW: meta.inputW, inputH: meta.inputH, featDim: F },
    dims: D,
    count: N,
    vectors: vecName,
    scales: scaleName,
    ids: idsName,
    pca: '../../models/cardnet-v1/projection.bin',
    hash,
  };
  await writeJson(join(outDir, 'manifest.json'), manifest, true);
  log(`index: wrote ${N} x ${D} int8 (${(q.byteLength / 1e6).toFixed(1)} MB) -> ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
