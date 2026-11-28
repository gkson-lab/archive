import { useEffect, useRef, useState } from 'preact/hooks';
import { useComputed, useSignal } from '@preact/signals';
import { getCard } from '../data/catalog';
import { refreshCardPrices } from '../data/live';
import { defaultVariant, formatMoney } from '../pricing/pricing';
import { Scanner, type ChoiceEvent, type LockEvent } from '../scan/scanner';
import { makeThumb } from '../scan/capture';
import { CameraError, coverTransform, startCamera, type CameraHandle } from '../vision/camera';
import { buzz, playHit, playLock, playUndo, unlockAudio } from '../app/feedback';
import {
  addScan,
  catalogState,
  catalogVersion,
  changeQty,
  currency,
  currentSession,
  detail,
  flash,
  indexState,
  liveQuad,
  modelState,
  quoteFor,
  restoreScan,
  scanHint,
  scanPhase,
  scanViews,
  sessionTotals,
  settings,
  tab,
  toast,
  updateScan,
} from '../app/state';
import { IconBolt, IconCamOff, IconPause, IconPlay, IconSearch, IconUndo, IconX } from './icons';
import { CardImg } from './common';

let scanner: Scanner | null = null;
export function getScanner() {
  return scanner;
}

export function ScanScreen({ active }: { active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cam = useRef<CameraHandle | null>(null);
  const [camError, setCamError] = useState<CameraError | null>(null);
  const [torch, setTorch] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fix, setFix] = useState<QuickFixState | null>(null);
  const [hitBanner, setHitBanner] = useState<string | null>(null);
  const view = useSignal({ w: 1, h: 1 });

  // camera lifecycle: only while the scan tab is visible
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const video = videoRef.current!;
    const start = async () => {
      try {
        const h = await startCamera(video);
        if (cancelled) return h.stop();
        cam.current = h;
        setCamError(null);
        scanner ??= new Scanner(video, callbacks, () => ({ autoCapture: settings.value.autoCapture, useOcr: settings.value.useOcr, lockConfidence: settings.value.lockConfidence }));
        scanner.start();
      } catch (e) {
        setCamError(e instanceof CameraError ? e : new CameraError('unknown', String(e)));
      }
    };
    void start();
    const onVis = () => {
      if (document.hidden) {
        scanner?.stop();
        cam.current?.stop();
        cam.current = null;
      } else if (!cam.current) void start();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      scanner?.stop();
      cam.current?.stop();
      cam.current = null;
      setTorch(false);
    };
  }, [active]);

  useEffect(() => {
    const el = videoRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => (view.value = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLock = async (e: LockEvent) => {
    const card = getCard(e.cardId);
    if (!card) return;
    const thumb = settings.value.keepScanPhotos ? await makeThumb(e.capture.preview) : undefined;
    const { row } = await addScan(e.cardId, { confidence: e.uncertain ? e.confidence : Math.max(e.confidence, 0.9), thumb });
    const q = quoteFor(row);
    const hit = q.isHit;
    flash.value = { kind: hit ? 'hit' : 'lock', at: Date.now() };
    if (settings.value.haptics) buzz(hit ? [40, 60, 40, 60, 80] : 28);
    if (settings.value.sound) (hit ? playHit : playLock)();
    if (hit) {
      setHitBanner(`HIT · ${card.name} · ${formatMoney(q.rawUnit, q.currency)}`);
      setTimeout(() => setHitBanner(null), 1400);
    }
    // not fully sure: keep scanning, but offer one-tap alternatives for this card
    setFix(e.uncertain ? { mode: 'fix', scanId: row.id, currentId: e.cardId, options: [e.cardId, ...e.alternatives].slice(0, 4), at: Date.now() } : null);
    // refresh this card's prices in the background (cheap: one request)
    void refreshCardPrices(e.cardId).then((changed) => changed && catalogVersion.value++);
  };

  const callbacks = {
    phase: (p: typeof scanPhase.value, hint?: string) => {
      scanPhase.value = p;
      scanHint.value = hint;
    },
    quad: (q: (typeof liveQuad.value)['q'], w: number, h: number) => (liveQuad.value = { q, w, h }),
    lock: (e: LockEvent) => void onLock(e),
    choices: (e: ChoiceEvent) => {
      setFix({ mode: 'add', options: e.options.slice(0, 4), at: Date.now() });
      if (settings.value.haptics) buzz([20, 40, 20]);
    },
  };

  const toggleTorch = async () => {
    unlockAudio();
    if (!cam.current) return;
    const ok = await cam.current.setTorch(!torch);
    if (ok) setTorch(!torch);
    else toast('This camera has no flashlight control', { tone: 'info' });
  };

  const togglePause = () => {
    unlockAudio();
    if (paused) scanner?.resume();
    else scanner?.pause();
    setPaused(!paused);
  };

  const undo = async () => {
    const latest = [...scanViews.value].sort((a, b) => b.scan.addedAt - a.scan.addedAt)[0];
    if (!latest) return;
    const before = { ...latest.scan };
    await changeQty(latest.scan.id, -1);
    scanner?.forgetLock();
    if (settings.value.sound) playUndo();
    toast(`Removed ${getCard(before.cardId)?.name ?? 'card'}`, { action: { label: 'Undo', run: () => void restoreScan(before) } });
  };

  const quadPoints = useComputed(() => {
    const lq = liveQuad.value;
    if (!lq.q || !lq.w) return '';
    const t = coverTransform(lq.w, lq.h, view.value.w, view.value.h);
    return lq.q.map((p) => t.toView(p.x, p.y)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  });

  const phase = scanPhase.value;
  const loadingVision = modelState.value.state !== 'ready' || indexState.value.state !== 'ready';
  const visionError = modelState.value.state === 'error' ? modelState.value.message : indexState.value.state === 'error' ? indexState.value.message : null;
  const fl = flash.value;
  const quadClass = phase === 'locked' ? (fl?.kind === 'hit' && Date.now() - fl.at < 1500 ? 'hit' : 'locked') : phase === 'recognizing' ? 'recognizing' : '';

  return (
    <div class="scan" onPointerDown={unlockAudio}>
      <video ref={videoRef} playsInline muted autoPlay />
      <div class={`guide ${liveQuad.value.q ? 'hidden' : ''}`} />
      <svg class={`quad ${quadClass}`} viewBox={`0 0 ${view.value.w} ${view.value.h}`} preserveAspectRatio="none">
        {quadPoints.value && <polygon points={quadPoints.value} />}
      </svg>
      {fl && Date.now() - fl.at < 1200 && <div key={fl.at} class={`flash ${fl.kind}`} />}
      {hitBanner && <div class="hit-banner">{hitBanner}</div>}

      <div class="topbar">
        <button class="chip-btn" onClick={() => (tab.value = 'session')} aria-label="Open session">
          {currentSession.value?.name ?? 'Session'}
        </button>
        <div class="spacer" />
        <button class={`icon-btn ${torch ? 'on' : ''}`} onClick={toggleTorch} aria-label="Flashlight" aria-pressed={torch}>
          <IconBolt />
        </button>
        <button class="icon-btn" onClick={togglePause} aria-label={paused ? 'Resume scanning' : 'Pause scanning'}>
          {paused ? <IconPlay /> : <IconPause />}
        </button>
      </div>

      <StatusPill phase={phase} paused={paused} loadingVision={loadingVision} visionError={visionError} />

      <Tray onUndo={undo} />

      {camError && <CameraMessage err={camError} onRetry={() => location.reload()} />}
      {fix && <QuickFix state={fix} onClose={() => setFix(null)} />}
      {void catalogVersion.value}
      {catalogState.value.state === 'error' && <div class="status-pill" style={{ top: 'auto', bottom: '120px' }}>{catalogState.value.message}</div>}
    </div>
  );
}

function StatusPill({ phase, paused, loadingVision, visionError }: { phase: string; paused: boolean; loadingVision: boolean; visionError: string | null | undefined }) {
  if (visionError)
    return (
      <div class="status-pill">
        <span class="dot" style={{ background: 'var(--bad)' }} />
        {visionError}
      </div>
    );
  if (loadingVision) {
    const m = modelState.value;
    const i = indexState.value;
    const p = (m.progress + i.progress) / 2;
    return (
      <div class="status-pill">
        <span class="dot busy" />
        {i.state !== 'ready' ? 'Downloading card index' : 'Loading model'}
        <span class="loadbar">
          <i style={{ width: `${Math.round(p * 100)}%` }} />
        </span>
      </div>
    );
  }
  if (paused)
    return (
      <div class="status-pill">
        <span class="dot" />
        Paused
      </div>
    );
  const hint = scanHint.value;
  const text =
    phase === 'recognizing'
      ? 'Reading card…'
      : phase === 'locked'
        ? 'Got it — next card'
        : phase === 'tracking'
          ? 'Hold still…'
          : phase === 'choosing'
            ? 'Which one is it?'
            : hint === 'dark'
              ? 'Too dark — try the flashlight'
              : 'Point at a card';
  return (
    <div class="status-pill">
      <span class={`dot ${phase === 'recognizing' ? 'busy' : 'live'}`} />
      {text}
    </div>
  );
}

function Tray({ onUndo }: { onUndo: () => void }) {
  const totals = sessionTotals.value;
  const recent = [...scanViews.value].sort((a, b) => b.scan.addedAt - a.scan.addedAt).slice(0, 30);
  const start = useRef<{ x: number; y: number; id: string } | null>(null);
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number } | null>(null);
  return (
    <div class="tray">
      <button class="total" onClick={() => (tab.value = 'session')} aria-label="Open session list">
        <b style={{ color: totals.hits ? 'var(--hit)' : undefined }}>{formatMoney(totals.value, currency.value)}</b>
        <span>
          {totals.count} card{totals.count === 1 ? '' : 's'}
          {totals.hits ? ` · ${totals.hits} hit${totals.hits > 1 ? 's' : ''}` : ''}
        </span>
      </button>
      <div class="strip">
        {recent.length === 0 && <div class="empty">Scanned cards show up here</div>}
        {recent.map((v, i) => {
          const card = getCard(v.scan.cardId);
          const d = dragging?.id === v.scan.id ? dragging : null;
          return (
            <button
              key={v.scan.id}
              class={`mini ${v.quote.isHit ? 'hit' : ''}`}
              style={d ? { transform: `translate(${Math.min(0, d.dx)}px, ${Math.min(0, d.dy)}px)`, opacity: Math.max(0.2, 1 - Math.abs(Math.min(d.dx, d.dy)) / 120), transition: 'none' } : undefined}
              onPointerDown={(e) => {
                start.current = { x: e.clientX, y: e.clientY, id: v.scan.id };
              }}
              onPointerMove={(e) => {
                const s = start.current;
                if (!s || s.id !== v.scan.id) return;
                const dx = e.clientX - s.x;
                const dy = e.clientY - s.y;
                if (dy < -8 && Math.abs(dy) > Math.abs(dx)) setDragging({ id: s.id, dx: 0, dy });
              }}
              onPointerUp={() => {
                const d2 = dragging;
                start.current = null;
                setDragging(null);
                if (d2 && d2.dy < -50) {
                  // swipe up removes one copy (undo)
                  const before = { ...v.scan };
                  void changeQty(v.scan.id, -1);
                  getScanner()?.forgetLock();
                  toast(`Removed ${card?.name ?? 'card'}`, { action: { label: 'Undo', run: () => void restoreScan(before) } });
                } else if (!d2) detail.value = { scanId: v.scan.id };
              }}
              onPointerCancel={() => {
                start.current = null;
                setDragging(null);
              }}
              aria-label={`${card?.name ?? 'Card'} ${formatMoney(v.quote.unit, v.quote.currency)}`}
            >
              {card?.img ? <img src={card.img} alt="" loading={i > 6 ? 'lazy' : 'eager'} draggable={false} /> : <div class="ph" />}
              {v.scan.qty > 1 && <span class="qty">×{v.scan.qty}</span>}
              {v.scan.confidence < 0.75 && <span class="unsure">?</span>}
              {v.quote.hasPrice || v.quote.bulkFloored ? formatMoney(v.quote.unit, v.quote.currency) : '—'}
            </button>
          );
        })}
      </div>
      <button class="icon-btn" style={{ background: 'var(--surface-2)' }} onClick={onUndo} aria-label="Undo last scan" disabled={!recent.length}>
        <IconUndo />
      </button>
    </div>
  );
}

function CameraMessage({ err, onRetry }: { err: CameraError; onRetry: () => void }) {
  const text: Record<string, [string, string]> = {
    denied: ['Camera access is off', 'Allow camera access for this site in your browser settings, then reload. You can still search cards by name.'],
    nocamera: ['No camera found', 'This device has no usable camera. Use Search to add cards by name or number.'],
    busy: ['Camera is busy', 'Another app is using the camera. Close it and try again.'],
    insecure: ['HTTPS required', 'Browsers only allow the camera on secure (https) pages.'],
    unsupported: ['Camera not supported', 'This browser cannot open the camera. Try Safari on iPhone or Chrome on Android.'],
    unknown: ['Could not start the camera', err.message],
  };
  const [title, body] = text[err.code] ?? text.unknown;
  return (
    <div class="cam-message">
      <div>
        <IconCamOff width={48} height={48} />
        <h2>{title}</h2>
        <p>{body}</p>
        <div class="row-actions" style={{ justifyContent: 'center' }}>
          <button class="btn primary" onClick={onRetry}>
            Try again
          </button>
          <button class="btn" onClick={() => (tab.value = 'search')}>
            Search instead
          </button>
        </div>
      </div>
    </div>
  );
}

interface QuickFixState {
  mode: 'fix' | 'add';
  scanId?: string;
  currentId?: string;
  options: string[];
  at: number;
}

/** Non-blocking one-tap correction strip shown above the tray while scanning continues. */
function QuickFix({ state, onClose }: { state: QuickFixState; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 12000);
    return () => clearTimeout(t);
  }, [state.at]);
  const pick = async (id: string) => {
    const card = getCard(id);
    if (state.mode === 'fix' && state.scanId) {
      if (id !== state.currentId && card) {
        await updateScan(state.scanId, { cardId: id, variant: defaultVariant(card) });
        toast(`Changed to ${card.name} · ${card.set?.name ?? ''}`, { tone: 'success' });
      }
    } else {
      await addScan(id, { confidence: 1 });
      toast(`Added ${card?.name}`, { tone: 'success' });
    }
    onClose();
  };
  return (
    <div class="quickfix" role="dialog" aria-label="Check this card">
      <div class="qf-head">
        <b>{state.mode === 'fix' ? 'Not 100% sure — right printing?' : "Couldn't read that card — is it one of these?"}</b>
        <button onClick={onClose} aria-label="Dismiss">
          <IconX width={18} height={18} />
        </button>
      </div>
      <div class="qf-row">
        {state.options.map((id) => {
          const c = getCard(id);
          if (!c) return null;
          return (
            <button key={id} class={`qf-opt ${id === state.currentId ? 'current' : ''}`} onClick={() => void pick(id)}>
              <CardImg card={c} />
              <span>
                {c.set?.ptcgoCode ?? c.set?.name?.slice(0, 10)} {c.number}
              </span>
            </button>
          );
        })}
        <button
          class="qf-opt"
          onClick={() => {
            if (state.mode === 'fix' && state.scanId) sessionStorage.setItem('bulkbot:replace', state.scanId);
            onClose();
            tab.value = 'search';
          }}
        >
          <div class="ph qf-search">
            <IconSearch />
          </div>
          <span>Search</span>
        </button>
      </div>
    </div>
  );
}
