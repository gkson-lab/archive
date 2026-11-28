// Camera access with sensible mobile defaults, torch control and friendly error codes.

export type CameraErrorCode = 'denied' | 'nocamera' | 'busy' | 'insecure' | 'unsupported' | 'unknown';

export class CameraError extends Error {
  constructor(
    public code: CameraErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CameraHandle {
  stream: MediaStream;
  track: MediaStreamTrack;
  width: number;
  height: number;
  torchSupported: boolean;
  setTorch(on: boolean): Promise<boolean>;
  stop(): void;
}

function mapError(e: unknown): CameraError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return new CameraError('denied', 'Camera permission was denied.');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new CameraError('nocamera', 'No camera was found on this device.');
  if (name === 'NotReadableError' || name === 'AbortError') return new CameraError('busy', 'The camera is being used by another app.');
  return new CameraError('unknown', (e as Error)?.message ?? 'Could not start the camera.');
}

export async function startCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  if (!window.isSecureContext) throw new CameraError('insecure', 'The camera needs HTTPS (or localhost).');
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported', 'This browser cannot access the camera.');
  const attempts: MediaStreamConstraints[] = [
    {
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    },
    { audio: false, video: { facingMode: { ideal: 'environment' } } },
    { audio: false, video: true },
  ];
  let stream: MediaStream | null = null;
  let lastErr: unknown;
  for (const c of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) {
      lastErr = e;
      const name = (e as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') break;
    }
  }
  if (!stream) throw mapError(lastErr);
  const track = stream.getVideoTracks()[0];
  // continuous autofocus where the browser exposes it (Android Chrome)
  try {
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const advanced: Record<string, unknown>[] = [];
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
    if (advanced.length) await track.applyConstraints({ advanced } as MediaTrackConstraints);
  } catch {
    /* optional */
  }
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 3000);
    });
  }
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const torchSupported = caps.torch === true;
  return {
    stream,
    track,
    width: video.videoWidth,
    height: video.videoHeight,
    torchSupported,
    async setTorch(on: boolean) {
      if (!torchSupported) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

/** Maps video pixel coords to element coords for a <video> shown with object-fit: cover. */
export function coverTransform(videoW: number, videoH: number, viewW: number, viewH: number) {
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const ox = (viewW - videoW * scale) / 2;
  const oy = (viewH - videoH * scale) / 2;
  return {
    scale,
    toView: (x: number, y: number) => ({ x: x * scale + ox, y: y * scale + oy }),
    toVideo: (x: number, y: number) => ({ x: (x - ox) / scale, y: (y - oy) / scale }),
  };
}
