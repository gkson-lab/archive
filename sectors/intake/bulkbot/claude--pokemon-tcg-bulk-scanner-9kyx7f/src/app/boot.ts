// Startup orchestration. The UI renders immediately; heavy assets (model, index, OCR, catalog)
// stream in the background and are cached for offline use.
import { DataMissingError, catalogReady, cardCount, loadLocalCatalog, syncStaticCatalog } from '../data/catalog';
import { requestPersistence } from '../data/db';
import { syncNewSets } from '../data/live';
import { backendName, loadEmbedder } from '../recognition/embedder';
import { extendIndexInBackground, loadIndex } from '../recognition/indexStore';
import { initOcr } from '../recognition/ocr';
import { catalogState, catalogVersion, indexState, loadSessions, loadSettings, modelState, ocrState, online, settings, toast } from './state';

export async function boot() {
  window.addEventListener('online', () => (online.value = true));
  window.addEventListener('offline', () => (online.value = false));
  await loadSettings();
  await loadSessions();
  catalogState.value = { state: 'loading', progress: 0, message: 'Opening card database' };
  await loadLocalCatalog();
  if (catalogReady()) {
    catalogState.value = { state: 'ready', progress: 1, message: `${cardCount().toLocaleString()} cards` };
    catalogVersion.value++;
  }
  void requestPersistence();
  void syncCatalog();
  void loadVision();
}

export async function syncCatalog() {
  if (!navigator.onLine) {
    if (!catalogReady()) catalogState.value = { state: 'error', progress: 0, message: 'Offline — connect once to download the card database.' };
    return;
  }
  const hadCards = catalogReady();
  try {
    if (!hadCards) catalogState.value = { state: 'loading', progress: 0.02, message: 'Downloading card database' };
    const r = await syncStaticCatalog((p) => {
      if (!hadCards) catalogState.value = { state: 'loading', progress: p.done / p.total, message: 'Downloading card database' };
    });
    catalogState.value = { state: 'ready', progress: 1, message: `${cardCount().toLocaleString()} cards` };
    if (r.changed) catalogVersion.value++;
    if (hadCards && r.newSets > 0) toast(`${r.newSets} new set${r.newSets > 1 ? 's' : ''} added`, { tone: 'success' });
  } catch (e) {
    if (!catalogReady())
      catalogState.value = { state: 'error', progress: 0, message: e instanceof DataMissingError ? e.message : `Could not download the card database (${(e as Error).message}).` };
  }
  // sets released after the snapshot: straight from the APIs
  try {
    const n = await syncNewSets(false);
    if (n > 0) {
      catalogVersion.value++;
      toast(`${n} brand-new set${n > 1 ? 's' : ''} synced from the API`, { tone: 'success' });
      void extendIndexInBackground();
    }
  } catch {
    /* ignore */
  }
}

export async function loadVision() {
  modelState.value = { state: 'loading', progress: 0, message: 'Loading recognition model' };
  indexState.value = { state: 'loading', progress: 0, message: 'Loading card index' };
  const model = loadEmbedder((f) => (modelState.value = { state: 'loading', progress: f, message: 'Loading recognition model' }))
    .then(() => (modelState.value = { state: 'ready', progress: 1, message: `Model ready (${backendName})` }))
    .catch((e) => {
      modelState.value = { state: 'error', progress: 0, message: `Model failed to load: ${(e as Error).message}` };
      throw e;
    });
  const index = loadIndex((f) => (indexState.value = { state: 'loading', progress: f, message: 'Downloading card index' }))
    .then((vi) => (indexState.value = { state: 'ready', progress: 1, message: `${vi.size.toLocaleString()} cards indexed` }))
    .catch((e) => {
      indexState.value = { state: 'error', progress: 0, message: (e as Error).message };
      throw e;
    });
  try {
    await Promise.all([model, index]);
  } catch {
    return;
  }
  if (settings.value.useOcr) void startOcr();
  // cards from sets newer than the index: embed them on-device
  setTimeout(() => void extendIndexInBackground((n) => n > 0 && (indexState.value = { ...indexState.value, message: `${indexState.value.message?.split(' · ')[0]} · +${n} new cards indexed on device` })), 4000);
}

export async function startOcr() {
  if (ocrState.value.state === 'loading' || ocrState.value.state === 'ready') return;
  ocrState.value = { state: 'loading', progress: 0, message: 'Loading text reader' };
  try {
    await initOcr();
    ocrState.value = { state: 'ready', progress: 1, message: 'Text reader ready' };
  } catch (e) {
    ocrState.value = { state: 'error', progress: 0, message: `OCR unavailable: ${(e as Error).message}` };
  }
}
