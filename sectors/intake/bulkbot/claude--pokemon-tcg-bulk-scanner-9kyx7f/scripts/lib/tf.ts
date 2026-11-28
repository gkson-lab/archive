// Loads TensorFlow.js for Node: native bindings (@tensorflow/tfjs-node) when installed, else the pure-JS CPU backend.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type * as tfc from '@tensorflow/tfjs-core';
import type { GraphModel } from '@tensorflow/tfjs-converter';

export type Tf = typeof tfc;

export async function loadTf(): Promise<{ tf: Tf; loadGraphModel: (path: string) => Promise<GraphModel>; native: boolean }> {
  let native = false;
  let tf: Tf;
  try {
    const mod = await import('@tensorflow/tfjs-node');
    tf = (mod as unknown as { default?: Tf }).default ?? (mod as unknown as Tf);
    native = true;
  } catch {
    tf = await import('@tensorflow/tfjs-core');
    await import('@tensorflow/tfjs-backend-cpu');
    await tf.setBackend('cpu');
  }
  const conv = await import('@tensorflow/tfjs-converter');
  const loadGraphModel = async (modelJsonPath: string) => {
    const json = JSON.parse(await readFile(modelJsonPath, 'utf8'));
    const dir = dirname(modelJsonPath);
    const handler = {
      load: async () => {
        const weightSpecs = json.weightsManifest.flatMap((g: { weights: unknown[] }) => g.weights);
        const parts = await Promise.all(
          json.weightsManifest.flatMap((g: { paths: string[] }) => g.paths).map((p: string) => readFile(join(dir, p))),
        );
        const total = parts.reduce((n: number, b: Buffer) => n + b.length, 0);
        const all = new Uint8Array(total);
        let o = 0;
        for (const b of parts) {
          all.set(b, o);
          o += b.length;
        }
        return {
          modelTopology: json.modelTopology,
          format: json.format,
          generatedBy: json.generatedBy,
          convertedBy: json.convertedBy,
          signature: json.signature,
          userDefinedMetadata: json.userDefinedMetadata,
          modelInitializer: json.modelInitializer,
          weightSpecs,
          weightData: all.buffer,
        };
      },
    };
    return conv.loadGraphModel(handler as never);
  };
  return { tf, loadGraphModel, native };
}
