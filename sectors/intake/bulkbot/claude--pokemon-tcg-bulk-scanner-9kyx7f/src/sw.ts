/// <reference lib="webworker" />
// Service worker: precaches the app shell, caches the heavy on-device assets (model, OCR, index)
// and card images for offline scanning.
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

// take control of the page right away so OCR/model files get cached during the first session
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

const sameOrigin = (url: URL) => url.origin === self.location.origin;

// Recognition model + projection, Tesseract: large, versioned by path -> cache first.
registerRoute(
  ({ url }) => sameOrigin(url) && (url.pathname.includes('/models/') || url.pathname.includes('/tesseract/')),
  new CacheFirst({ cacheName: 'bulkbot-ml', plugins: [new CacheableResponsePlugin({ statuses: [200] })] }),
);

// Index binaries have content hashes in their names -> cache first.
registerRoute(
  ({ url }) => sameOrigin(url) && url.pathname.includes('/data/index/') && !url.pathname.endsWith('manifest.json'),
  new CacheFirst({ cacheName: 'bulkbot-index', plugins: [new ExpirationPlugin({ maxEntries: 12 })] }),
);

// Manifests and catalog chunks: fresh when online, cached when offline.
registerRoute(
  ({ url }) => sameOrigin(url) && url.pathname.includes('/data/'),
  new NetworkFirst({ cacheName: 'bulkbot-data', networkTimeoutSeconds: 6, plugins: [new ExpirationPlugin({ maxEntries: 600 })] }),
);

// Card images from the API CDNs.
registerRoute(
  ({ url }) => ['images.pokemontcg.io', 'images.scrydex.com', 'assets.tcgdex.net'].includes(url.hostname),
  new CacheFirst({
    cacheName: 'bulkbot-card-images',
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] }), new ExpirationPlugin({ maxEntries: 4000, maxAgeSeconds: 120 * 86400, purgeOnQuotaError: true })],
  }),
);

// Live API calls (prices of a scanned card, new sets): network first, cached copy offline.
registerRoute(
  ({ url }) => url.hostname === 'api.pokemontcg.io' || url.hostname === 'api.tcgdex.net',
  new NetworkFirst({ cacheName: 'bulkbot-api', networkTimeoutSeconds: 10, plugins: [new ExpirationPlugin({ maxEntries: 800, maxAgeSeconds: 14 * 86400 })] }),
);

// Set symbols / logos.
registerRoute(
  ({ url, request }) => request.destination === 'image' && !sameOrigin(url),
  new StaleWhileRevalidate({ cacheName: 'bulkbot-misc-images', plugins: [new ExpirationPlugin({ maxEntries: 600 })] }),
);
