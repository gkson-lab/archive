// The live scanning loop. Designed so the user never has to fiddle with the card:
//  - the detector finds the card anywhere in the frame (any angle/distance), every frame
//  - recognition fires as soon as two consecutive detections agree (~150ms of steadiness)
//  - evidence from consecutive frames is accumulated automatically, so a glare spot or a blurry
//    frame is outvoted by the next frames instead of asking the user to move the card
//  - OCR runs in parallel and only gates the lock when reprints share the same artwork
//  - after a lock, the next card is picked up as soon as the card is swapped or removed
import { cardsByNumber, getCard, getSet } from '../data/catalog';
import { embed } from '../recognition/embedder';
import { scoreCandidates, type Fused, type OcrEvidence } from '../recognition/fusion';
import { getIndex } from '../recognition/indexStore';
import { readCardText } from '../recognition/ocr';
import { signatureSimilarity } from '../shared/preprocess';
import type { DetectRequest, DetectResponse } from '../workers/detect.worker';
import { portraitQuad, quadDelta, type Quad } from '../vision/homography';
import { captureCard, flippedStrips, grabRegion, type Capture } from './capture';

export type ScanPhase = 'starting' | 'searching' | 'tracking' | 'recognizing' | 'locked' | 'choosing' | 'paused';

export interface LockEvent {
  cardId: string;
  confidence: number;
  uncertain: boolean;
  alternatives: string[];
  capture: Capture;
  fused: Fused;
  ms: number;
}

export interface ChoiceEvent {
  options: string[];
  capture: Capture;
  fused: Fused;
}

export interface ScannerCallbacks {
  phase(p: ScanPhase, hint?: string): void;
  quad(q: Quad | null, videoW: number, videoH: number): void;
  lock(e: LockEvent): void;
  choices(e: ChoiceEvent): void;
  stats?(s: { detectMs: number; fps: number; recogMs?: number }): void;
}

export interface ScannerOptions {
  autoCapture: boolean;
  useOcr: boolean;
  /** 0.6 (fast, looser) .. 0.95 (strict) */
  lockConfidence: number;
}

const SMALL_W = 240;

export class Scanner {
  private worker: Worker;
  private small = document.createElement('canvas');
  private sctx: CanvasRenderingContext2D;
  private running = false;
  private inFlight = false;
  private reqId = 0;
  private spare: ArrayBuffer | null = null;
  private prevQuad: Quad | null = null;
  /** detector's next-best rectangles (video coords), verified by recognition when the first crop is weak */
  private alternates: Quad[] = [];
  private lastQuads: Quad[] = [];
  private missCount = 0;
  private phase: ScanPhase = 'starting';
  private recognizing = false;
  // evidence for the card currently in view
  private evidence = new Map<string, { sum: number; n: number }>();
  private frames = 0;
  private frameFloor = 0;
  private ocr: OcrEvidence | null = null;
  private ocrStarted = false;
  private cardStart = 0;
  /** increments per physical card so late OCR results can't leak onto the next card */
  private cardToken = 0;
  private flipped = false;
  private bestCapture: Capture | null = null;
  private locked: { id: string; signature: Float32Array; at: number } | null = null;
  private lastChangeCheck = 0;
  private frameTimes: number[] = [];
  private detectMs = 0;

  constructor(
    private video: HTMLVideoElement,
    private cb: ScannerCallbacks,
    private opts: () => ScannerOptions,
  ) {
    this.worker = new Worker(new URL('../workers/detect.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<DetectResponse>) => this.onDetect(e.data);
    this.sctx = this.small.getContext('2d', { willReadFrequently: true })!;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.setPhase('searching');
    this.loop();
  }

  stop() {
    this.running = false;
  }

  destroy() {
    this.running = false;
    this.worker.terminate();
  }

  pause() {
    this.setPhase('paused');
  }

  resume() {
    this.resetCard();
    this.setPhase('searching');
  }

  /** User picked a card from the top-3 sheet. */
  choose(cardId: string, capture: Capture, fused: Fused) {
    this.locked = { id: cardId, signature: capture.signature, at: performance.now() };
    this.cb.lock({ cardId, confidence: 1, uncertain: false, alternatives: [], capture, fused, ms: 0 });
    this.setPhase('locked');
  }

  /** User dismissed the choices: forget this card and look again. */
  dismissChoices() {
    this.resetCard();
    this.locked = null;
    this.setPhase('searching');
  }

  /** Forget the last lock so the same card can be scanned again (e.g. after undo). */
  forgetLock() {
    this.locked = null;
    this.resetCard();
    if (this.phase === 'locked') this.setPhase('searching');
  }

  private setPhase(p: ScanPhase, hint?: string) {
    if (this.phase === p && !hint) return;
    this.phase = p;
    this.cb.phase(p, hint);
  }

  private resetCard() {
    this.evidence.clear();
    this.frames = 0;
    this.frameFloor = 0;
    this.ocr = null;
    this.ocrStarted = false;
    this.flipped = false;
    this.bestCapture = null;
    this.cardStart = performance.now();
    this.cardToken++;
  }

  private loop = () => {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (!this.inFlight && this.phase !== 'paused' && this.phase !== 'choosing') this.sendFrame();
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(this.loop);
    else requestAnimationFrame(this.loop);
  };

  private sendFrame() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh || this.video.readyState < 2) return;
    const w = SMALL_W;
    const h = Math.round((vh / vw) * w);
    if (this.small.width !== w || this.small.height !== h) {
      this.small.width = w;
      this.small.height = h;
    }
    this.sctx.drawImage(this.video, 0, 0, w, h);
    const img = this.sctx.getImageData(0, 0, w, h);
    let buf = this.spare && this.spare.byteLength === img.data.byteLength ? this.spare : null;
    if (buf) new Uint8ClampedArray(buf).set(img.data);
    else buf = img.data.buffer.slice(0) as ArrayBuffer;
    this.spare = null;
    const req: DetectRequest = { id: ++this.reqId, w, h, rgba: buf, prev: this.prevQuad };
    this.inFlight = true;
    this.worker.postMessage(req, [buf]);
  }

  private onDetect(r: DetectResponse) {
    this.inFlight = false;
    this.spare = r.rgba;
    this.detectMs = this.detectMs * 0.8 + r.ms * 0.2;
    const now = performance.now();
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.cb.stats?.({ detectMs: this.detectMs, fps: this.frameTimes.length });
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const s = vw / this.small.width;
    if (!r.det || r.det.score < 0.12) {
      this.missCount++;
      if (this.missCount >= 4) {
        this.prevQuad = null;
        this.lastQuads = [];
        this.cb.quad(null, vw, vh);
        if (this.phase === 'locked' || this.phase === 'tracking' || this.phase === 'recognizing') {
          // card removed: ready for the next one (same card again counts as another copy)
          if (this.phase === 'locked') this.locked = null;
          this.resetCard();
          this.setPhase('searching', r.luma < 45 ? 'dark' : undefined);
        } else if (this.phase === 'searching' && r.luma < 45) this.setPhase('searching', 'dark');
      }
      return;
    }
    this.missCount = 0;
    const q = portraitQuad(r.det.quad);
    this.prevQuad = q;
    const qv = q.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad;
    this.alternates = (r.det.alternates ?? []).map((a) => portraitQuad(a).map((p) => ({ x: p.x * s, y: p.y * s })) as Quad);
    this.cb.quad(qv, vw, vh);
    this.lastQuads.push(q);
    if (this.lastQuads.length > 3) this.lastQuads.shift();
    const diag = Math.hypot(this.small.width, this.small.height);
    const n = this.lastQuads.length;
    const steady = n >= 2 && quadDelta(this.lastQuads[n - 1], this.lastQuads[n - 2]) < 0.012 * diag;

    if (this.phase === 'locked') {
      // is this still the card we locked? check a cheap signature twice a second
      if (this.locked && steady && now - this.lastChangeCheck > 450 && !this.recognizing) {
        this.lastChangeCheck = now;
        const region = grabRegion(this.video, qv);
        if (region) {
          const cap = captureCard(region, qv, false);
          if (signatureSimilarity(cap.signature, this.locked.signature) < 0.8) {
            this.locked = null;
            this.resetCard();
            this.setPhase('tracking');
            void this.recognize(qv, cap);
          }
        }
      }
      return;
    }
    if (this.phase === 'searching') {
      this.resetCard();
      this.setPhase('tracking');
    }
    if (steady && !this.recognizing && this.opts().autoCapture && (this.phase === 'tracking' || this.phase === 'recognizing')) {
      void this.recognize(qv);
    }
  }

  private async recognize(quadVideo: Quad, pre?: Capture) {
    const index = getIndex();
    if (!index) {
      this.setPhase('tracking', 'loading');
      return;
    }
    this.recognizing = true;
    const t0 = performance.now();
    try {
      this.setPhase('recognizing');
      const region = pre ? null : grabRegion(this.video, quadVideo);
      if (!pre && !region) return;
      const tryFlip = this.frames >= 1 && this.bestVisual() < 0.5;
      let cap = pre ?? captureCard(region!, quadVideo, tryFlip || this.flipped);
      let feat = await embed(this.flipped && cap.rgbFlipped ? cap.rgbFlipped : cap.rgb);
      let hits = index.search(index.embed(feat), 24);
      if (cap.rgbFlipped && !this.flipped && hits[0] && hits[0].score < 0.5) {
        const f2 = await embed(cap.rgbFlipped);
        const h2 = index.search(index.embed(f2), 24);
        if (h2[0] && h2[0].score > hits[0].score + 0.05) {
          this.flipped = true;
          this.evidence.clear();
          this.frames = 0;
          hits = h2;
          feat = f2;
        }
      }
      // weak match: the rectangle is probably wrong (artwork frame, table pattern...) - let
      // recognition verify the detector's alternates instead of asking the user to move the card
      if (region && hits[0] && hits[0].score < 0.55) {
        for (const alt of this.alternates.slice(0, 2)) {
          const r2 = grabRegion(this.video, alt);
          if (!r2) continue;
          const c2 = captureCard(r2, alt, false);
          const f2 = await embed(c2.rgb);
          const h2 = index.search(index.embed(f2), 24);
          if (h2[0] && h2[0].score > hits[0].score + 0.03) {
            hits = h2;
            feat = f2;
            cap = c2;
            this.cb.quad(c2.quad, this.video.videoWidth, this.video.videoHeight);
          }
        }
      }
      void feat;
      if (this.flipped && region) {
        const strips = flippedStrips(cap, region.img);
        cap = { ...cap, bottom: strips.bottom, title: strips.title };
      }
      // accumulate evidence across frames
      this.frames++;
      const floor = hits.length ? hits[hits.length - 1].score : 0;
      this.frameFloor += floor;
      for (const h of hits) {
        const e = this.evidence.get(h.id) ?? { sum: 0, n: 0 };
        e.sum += h.score;
        e.n++;
        this.evidence.set(h.id, e);
      }
      if (!this.bestCapture || (hits[0]?.score ?? 0) >= this.bestVisual()) this.bestCapture = cap;
      // OCR in parallel, once per card, on the first capture
      if (this.opts().useOcr && !this.ocrStarted) {
        this.ocrStarted = true;
        const token = this.cardToken;
        void readCardText({ bottom: cap.bottom, title: cap.title }, true).then((o) => {
          if (token !== this.cardToken) return; // the card changed while reading
          if (!o) {
            // reader still loading or busy: try again on the next capture
            this.ocrStarted = false;
            return;
          }
          this.ocr = o;
          if (DEBUG) console.debug('[bulkbot] ocr', o.numbers.map((n) => `${n.num}/${n.total ?? ''}`).join(' '), o.setCode ?? '', o.regulationMark ?? '', JSON.stringify(o.title ?? ''));
          if (this.phase === 'recognizing' && !this.recognizing) this.decide(performance.now() - t0, cap);
        });
      }
      this.decide(performance.now() - t0, cap);
    } catch (e) {
      console.warn('recognition failed', e);
    } finally {
      this.recognizing = false;
    }
  }

  private bestVisual(): number {
    let best = 0;
    for (const e of this.evidence.values()) best = Math.max(best, e.sum / Math.max(1, this.frames));
    return best;
  }

  private fuse(): Fused {
    const index = getIndex()!;
    const ids = new Set(this.evidence.keys());
    // OCR rescue: cards matching the printed number (covers sets newer than the index)
    for (const n of this.ocr?.numbers ?? []) {
      if (!n.total) continue;
      for (const c of cardsByNumber(n.num, n.total).slice(0, 6)) ids.add(c.id);
    }
    const missing = this.frames ? this.frameFloor / this.frames : 0;
    const cands = [...ids]
      .map((id) => {
        const card = getCard(id);
        if (!card) return null;
        const e = this.evidence.get(id);
        // frames where the card wasn't in the top-k count at that frame's floor score
        const visual = e ? (e.sum + (this.frames - e.n) * missing * 0.9) / Math.max(1, this.frames) : index.has(id) ? missing * 0.8 : 0.45;
        return { id, card, set: getSet(card.setId), visual };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return scoreCandidates(cands, this.ocr, { border: this.bestCapture?.border }, (a, b) => index.similarity(a, b));
  }

  private decide(elapsed: number, cap: Capture) {
    if (this.phase !== 'recognizing') return;
    const fused = this.fuse();
    const best = fused.best;
    if (!best) return;
    const age = performance.now() - this.cardStart;
    const need = this.opts().lockConfidence;
    const ocrPending = this.opts().useOcr && this.ocr === null && age < 1600;
    const alternatives = fused.ranked.slice(1, 4).map((r) => r.id);
    if (DEBUG)
      console.debug(
        '[bulkbot] decide',
        `frames=${this.frames} age=${age.toFixed(0)} conf=${fused.confidence.toFixed(2)} amb=${fused.printingAmbiguous}`,
        fused.ranked.slice(0, 3).map((r) => `${r.id}:${r.visual.toFixed(3)}/${r.score.toFixed(3)}[${r.why.join(',')}]`).join(' '),
      );
    const lock = (uncertain: boolean) => {
      this.locked = { id: best.id, signature: cap.signature, at: performance.now() };
      this.setPhase('locked');
      this.cb.lock({ cardId: best.id, confidence: uncertain ? Math.min(fused.confidence, 0.7) : fused.confidence, uncertain, alternatives, capture: this.bestCapture ?? cap, fused, ms: age });
      void elapsed;
    };
    if (fused.confidence >= need && !(fused.printingAmbiguous && ocrPending)) return lock(false);
    if (fused.printingAmbiguous && ocrPending) return; // a moment for the number to be read
    // Never block the flow: after a short look, keep the best guess (flagged "?" with one-tap
    // alternatives) and move on. Only clearly unreadable cards are skipped (with suggestions).
    if (this.frames >= 3 || age > 1500) {
      if (best.visual >= 0.5 || best.why.includes('number')) return lock(true);
      if (this.frames >= 5 || age > 2600) {
        this.locked = { id: '', signature: cap.signature, at: performance.now() };
        this.setPhase('locked', 'unreadable');
        this.cb.choices({ options: fused.ranked.slice(0, 3).map((r) => r.id), capture: this.bestCapture ?? cap, fused });
      }
    }
  }
}

const DEBUG = typeof location !== 'undefined' && /[?&#]debug\b/.test(location.href + (globalThis.localStorage?.getItem?.('bulkbotDebug') ? '&debug' : ''));
