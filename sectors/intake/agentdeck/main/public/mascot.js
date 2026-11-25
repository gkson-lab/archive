// The mascot, pixel for pixel: a 12×8 grid read off the reference screenshot.
// Flat orange body, black eyes, transparent everywhere else. Drawn as SVG rects with
// crispEdges, so there is no anti-aliasing or blur at any size.
//
//   . . # # # # # # # # . .
//   . . # e # # # # e # . .
//   # # # # # # # # # # # #
//   # # # # # # # # # # # #
//   . . # # # # # # # # . .
//   . . # # # # # # # # . .
//   . . # . # . . # . # . .
//   . . # . # . . # . # . .

export const BODY = "#D77655";
export const EYE = "#000000";

const BASE = [
  "..########..",
  "..#e####e#..",
  "############",
  "############",
  "..########..",
  "..########..",
  "..#.#..#.#..",
  "..#.#..#.#..",
];

// Animation frames change only a few pixels of the base sprite.
const set = (rows, edits) => {
  const g = rows.map((r) => r.split(""));
  for (const [x, y, c] of edits) g[y][x] = c;
  return g.map((r) => r.join(""));
};
const FRAMES = {
  base: BASE,
  blink: set(BASE, [[3, 1, "#"], [8, 1, "#"]]),
  walkA: set(BASE, [[2, 7, "."], [7, 7, "."]]),
  walkB: set(BASE, [[4, 7, "."], [9, 7, "."]]),
  // both arms raised (wave / celebrate)
  armsUp: set(BASE, [
    [0, 3, "."], [1, 3, "."], [10, 3, "."], [11, 3, "."],
    [0, 1, "#"], [1, 1, "#"], [10, 1, "#"], [11, 1, "#"],
  ]),
  // one arm raised (waving hand)
  waveR: set(BASE, [[10, 3, "."], [11, 3, "."], [10, 1, "#"], [11, 1, "#"]]),
  // typing: one arm dips, then the other
  typeL: set(BASE, [[0, 2, "."], [1, 2, "."], [0, 4, "#"], [1, 4, "#"]]),
  typeR: set(BASE, [[10, 2, "."], [11, 2, "."], [10, 4, "#"], [11, 4, "#"]]),
  sleep: set(BASE, [[3, 1, "#"], [8, 1, "#"]]),
};

// What the little guy does in each mood: frame sequence, frame time, and an effect.
export const POSES = {
  idle: { seq: ["base", "base", "base", "base", "base", "base", "base", "blink"], ms: 260, fx: "bob" },
  walk: { seq: ["walkA", "base", "walkB", "base"], ms: 150, fx: "" },
  work: { seq: ["typeL", "base", "typeR", "base"], ms: 140, fx: "work" },
  think: { seq: ["base", "base", "base", "blink"], ms: 320, fx: "think" },
  wait: { seq: ["waveR", "base"], ms: 300, fx: "alert" },
  done: { seq: ["armsUp", "base", "armsUp", "base", "base", "base", "base", "base"], ms: 220, fx: "hop" },
  error: { seq: ["base", "blink"], ms: 500, fx: "shake" },
  sleep: { seq: ["sleep"], ms: 1000, fx: "zzz" },
  wave: { seq: ["armsUp", "base"], ms: 280, fx: "hop" },
};

function rects(rows) {
  let out = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      if (c === ".") { x++; continue; }
      let w = 1;
      while (row[x + w] === c) w++;
      out += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${c === "e" ? EYE : BODY}"/>`;
      x += w;
    }
  });
  return out;
}

const svgCache = new Map();
function frameSvg(name) {
  if (!svgCache.has(name)) svgCache.set(name, rects(FRAMES[name]));
  return svgCache.get(name);
}

/** A static mascot as an SVG string. `scale` is pixels per sprite pixel (keep it whole). */
export function mascotSvg(scale = 4, frame = "base") {
  const s = Math.max(1, Math.round(scale));
  return `<svg class="px" width="${12 * s}" height="${8 * s}" viewBox="0 0 12 8" shape-rendering="crispEdges" aria-hidden="true">${frameSvg(frame)}</svg>`;
}

/** An animated mascot element. Change its mood later with setPose(el, pose). */
export function mascot(pose = "idle", scale = 4, label = "") {
  const el = document.createElement("span");
  el.className = "clawd";
  el.style.setProperty("--s", Math.max(1, Math.round(scale)) + "px");
  el.innerHTML = mascotSvg(scale) + `<span class="fx" aria-hidden="true"></span>`;
  if (label) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label);
  }
  setPose(el, pose);
  return el;
}

export function mascotHtml(pose = "idle", scale = 4) {
  const s = Math.max(1, Math.round(scale));
  return `<span class="clawd" data-pose="${pose}" data-fx="${POSES[pose]?.fx ?? ""}" style="--s:${s}px">${mascotSvg(s)}<span class="fx" aria-hidden="true"></span></span>`;
}

export function setPose(el, pose) {
  if (!POSES[pose]) pose = "idle";
  if (el.dataset.pose === pose) return;
  el.dataset.pose = pose;
  el.dataset.fx = POSES[pose].fx;
  el._f = 0;
}

// One shared ticker drives every mascot on the page.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let last = 0;
function tick(t) {
  requestAnimationFrame(tick);
  if (reduceMotion.matches || t - last < 70) return;
  last = t;
  for (const el of document.querySelectorAll(".clawd")) {
    const p = POSES[el.dataset.pose] ?? POSES.idle;
    el._next ??= 0;
    if (t < el._next) continue;
    el._next = t + p.ms + (el._jitter ??= Math.random() * 40);
    el._f = ((el._f ?? -1) + 1) % p.seq.length;
    const svg = el.firstElementChild;
    const name = p.seq[el._f];
    if (svg && svg._frame !== name) {
      svg.innerHTML = frameSvg(name);
      svg._frame = name;
    }
  }
}
requestAnimationFrame(tick);

/** Map an agent's status to what the mascot is doing. */
export function poseFor(status) {
  return (
    {
      queued: "think",
      starting: "think",
      running: "work",
      waiting: "wait",
      idle: "idle",
      done: "done",
      error: "error",
      stopped: "sleep",
      "handed-off": "wave",
    }[status] ?? "idle"
  );
}

/** Favicon: the mascot itself. */
export function setFavicon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -2 12 12" shape-rendering="crispEdges">${frameSvg("base")}</svg>`;
  let link = document.querySelector("link[rel=icon]");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = "data:image/svg+xml," + encodeURIComponent(svg);
}
