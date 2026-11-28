import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Self-hosts Tesseract (worker, wasm core, English LSTM data) so OCR works offline and needs no CDN. */
function tesseractAssets(): Plugin {
  const files: [string, string][] = [
    ['node_modules/tesseract.js/dist/worker.min.js', 'public/tesseract/worker.min.js'],
    ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'public/tesseract/tesseract-core-simd-lstm.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'public/tesseract/tesseract-core-lstm.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'public/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js'],
    ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'public/tesseract/eng.traineddata.gz'],
  ];
  return {
    name: 'bulkbot-tesseract-assets',
    async buildStart() {
      for (const [from, to] of files) {
        const exists = await stat(to).then(() => true, () => false);
        if (exists) continue;
        await mkdir(dirname(to), { recursive: true });
        await copyFile(join(process.cwd(), from), join(process.cwd(), to));
      }
    },
  };
}

export default defineConfig({
  // relative base: works at a domain root and under a GitHub Pages project path (/bulkbot/)
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  plugins: [
    tesseractAssets(),
    preact(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,ico}'],
        globIgnores: ['data/**', 'models/**', 'tesseract/**', 'screens/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: 'BulkBot — Pokémon card scanner',
        short_name: 'BulkBot',
        description: 'Scan Pokémon TCG bulk fast, on-device, for free.',
        theme_color: '#0b0c10',
        background_color: '#0b0c10',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        categories: ['utilities', 'productivity', 'shopping'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
