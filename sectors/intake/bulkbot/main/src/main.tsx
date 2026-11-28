import { render } from 'preact';
import { App } from './app/App';
import { boot } from './app/boot';
import { toast } from './app/state';
import './styles/app.css';

render(<App />, document.getElementById('app')!);

if (/[?&]debug\b/.test(location.search)) {
  // debugging hooks for the e2e tests / console
  void Promise.all([import('./recognition/embedder'), import('./recognition/indexStore'), import('@tensorflow/tfjs-core')]).then(([e, i, tf]) => {
    (window as unknown as Record<string, unknown>).bulkbotDebug = { embed: e.embed, getIndex: i.getIndex, tf };
  });
}
void boot();

// Service worker: offline support + caching of the model, index and card images.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void import('workbox-window').then(({ Workbox }) => {
    const wb = new Workbox('./sw.js', { scope: './' });
    wb.addEventListener('waiting', () => {
      toast('A new version of BulkBot is ready', {
        ms: 15000,
        action: {
          label: 'Reload',
          run: () => {
            wb.addEventListener('controlling', () => location.reload());
            wb.messageSkipWaiting();
          },
        },
      });
    });
    void wb.register();
  });
}
