import { useEffect, useRef, useState } from "react";
import { useReducedMotion, IconButton, IPause, IPlay } from "@archival/ui";

/** the gk mark as a static svg: chrome letters with a thin oil rim */
export function GkMark({ size = 16, title = "gk labs" }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <defs>
        <linearGradient id="gkc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" /><stop offset=".3" stopColor="#e4e6ea" /><stop offset=".47" stopColor="#8d929c" />
          <stop offset=".52" stopColor="#6e727b" /><stop offset=".64" stopColor="#d9dce2" /><stop offset=".82" stopColor="#fff" /><stop offset="1" stopColor="#c3c7ce" />
        </linearGradient>
        <linearGradient id="gko" x1="0" y1="0" x2="1" y2=".3">
          <stop offset="0" stopColor="#ffd23d" /><stop offset=".22" stopColor="#ff4a3d" /><stop offset=".4" stopColor="#2a1f5c" />
          <stop offset=".6" stopColor="#3d6bff" /><stop offset=".8" stopColor="#19e0b0" /><stop offset="1" stopColor="#ffd23d" />
        </linearGradient>
      </defs>
      <g fontFamily="Instrument Serif, Georgia, serif" fontSize="44" textAnchor="middle">
        <text x="33" y="45.5" fill="url(#gko)">gk</text>
        <text x="32" y="45" fill="url(#gkc)" className="gk-fill">gk</text>
      </g>
    </svg>
  );
}

const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><text x="256" y="372" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="360" fill="#000">gk</text></svg>`;

/**
 * liquid metal gk mark (paper shaders). the one branded moment: it loops only inside its
 * canvas, pauses off screen and on request, and stays static with reduced motion or no webgl2.
 */
export function LiquidMark({ size = 160, autoplay = true }: { size?: number; autoplay?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const mount = useRef<any>(null);
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(autoplay && !reduced);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    const el = host.current;
    if (!el) return;
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) { setFailed(true); return; }
    let io: IntersectionObserver | null = null;
    (async () => {
      try {
        const shaders: any = await import("@paper-design/shaders");
        const blob = new Blob([MARK_SVG], { type: "image/svg+xml" });
        const file = new File([blob], "gk.svg", { type: "image/svg+xml" });
        const { pngBlob } = await shaders.toProcessedLiquidMetal(file);
        const img = new Image();
        img.src = URL.createObjectURL(pngBlob);
        await img.decode();
        if (disposed) return;
        const s = shaders.defaultObjectSizing;
        mount.current = new shaders.ShaderMount(
          el,
          shaders.liquidMetalFragmentShader,
          {
            u_colorBack: [0, 0, 0, 0], u_colorTint: [1, 1, 1, 1], u_image: img, u_repetition: 2, u_softness: 0.1,
            u_shiftRed: 0.3, u_shiftBlue: 0.3, u_distortion: 0.07, u_contour: 0.4, u_angle: 70, u_shape: 0, u_isImage: true,
            u_fit: shaders.ShaderFitOptions.contain, u_scale: 0.8, u_rotation: s.rotation, u_originX: s.originX, u_originY: s.originY,
            u_offsetX: s.offsetX, u_offsetY: s.offsetY, u_worldWidth: s.worldWidth, u_worldHeight: s.worldHeight,
          },
          { premultipliedAlpha: false, alpha: true },
          playing ? 1 : 0, 0, 2, 1920 * 1080,
        );
        io = new IntersectionObserver(([e]) => mount.current?.setSpeed(e.isIntersecting && playingRef.current ? 1 : 0));
        io.observe(el);
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      io?.disconnect();
      mount.current?.dispose?.();
      mount.current = null;
    };
  }, []);
  const playingRef = useRef(playing);
  useEffect(() => {
    playingRef.current = playing;
    mount.current?.setSpeed(playing ? 1 : 0);
  }, [playing]);

  return (
    <div className="liquid-mark" style={{ width: size, height: size }}>
      {failed ? <GkMark size={size} /> : <div ref={host} className="liquid-host" aria-hidden="true" />}
      <span className="sr-only">gk labs</span>
      {!failed && !reduced && (
        <IconButton label={playing ? "pause animation" : "play animation"} className="liquid-toggle" onClick={() => setPlaying(!playing)}>
          {playing ? <IPause size={14} /> : <IPlay size={14} />}
        </IconButton>
      )}
    </div>
  );
}
