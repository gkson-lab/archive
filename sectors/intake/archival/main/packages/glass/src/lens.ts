/**
 * liquid glass lens. a displacement map is drawn on a canvas: near the rim the backdrop is
 * pulled inward along the edge normal, and the centre is zoomed a little. the svg filter runs
 * the map through three displacement passes at slightly different scales for r, g and b, so
 * edges split into a thin spectrum, then recombines them with screen blending.
 */

const cache = new Map<string, string>();

export function displacementMap(w: number, h: number, rim = 14, zoom = 0.06): string {
  const key = `${w}x${h}:${rim}:${zoom}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(w, h);
  const r = h / 2;
  const cx = w / 2, cy = h / 2;
  const segA = r, segB = w - r; // centre line of the stadium
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const qx = Math.max(segA, Math.min(segB, px));
      let nx = px - qx, ny = py - cy;
      const dist = Math.hypot(nx, ny);
      const inside = r - dist; // distance from the rim, inward
      let dx = 0, dy = 0;
      if (inside > 0) {
        if (dist > 0) { nx /= dist; ny /= dist; }
        if (inside < rim) {
          const k = Math.pow(1 - inside / rim, 2);
          dx -= nx * k;
          dy -= ny * k;
        }
        // centre zoom: sample from slightly closer to the middle
        dx -= ((px - cx) / (w / 2)) * zoom;
        dy -= ((py - cy) / (h / 2)) * zoom;
      }
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(128 + Math.max(-1, Math.min(1, dx)) * 127);
      img.data[i + 1] = Math.round(128 + Math.max(-1, Math.min(1, dy)) * 127);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

/** svg-filter backdrops only work in chromium (windows webview2, chrome). others get frosted blur. */
export function supportsLens(): boolean {
  try {
    const ua = navigator.userAgent;
    const chromium = /Chrome\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
    return chromium && CSS.supports("backdrop-filter", "url(#x)");
  } catch {
    return false;
  }
}
