/**
 * A tiny software rasterizer and PNG encoder — enough to draw a chart, and nothing else.
 *
 * `tools/zpcr.mjs curves` needs to produce a picture on a machine that has Node and nothing more:
 * no browser (so uPlot, which the web app draws with, is out — it needs a DOM and a canvas), no
 * native image module, no `npm install`. So this draws into a plain RGB byte buffer and deflates
 * it into a PNG with `node:zlib`, which ships with Node.
 *
 * What it offers is deliberately minimal: anti-aliased line segments (solid or dashed), circle
 * outlines, filled rectangles, and bitmap text. Everything is coverage-based — a pixel's alpha is
 * how much of it the shape covers, computed from the distance to the shape — which is what makes
 * a 1px curve on a dark background look like the browser's rather than like a staircase.
 *
 * Coordinates are floats in pixel space with the origin at the top-left, y down, matching both
 * canvas and SVG. A coordinate of `x` sits on the *boundary* between pixel x-1 and x, so a 1px
 * horizontal line at integer y straddles two pixel rows; offset by 0.5 for a crisp hairline, the
 * same convention canvas uses.
 *
 * Not a general graphics library, and shouldn't become one: if something here starts needing
 * fills, gradients or glyph shaping, that is the signal to render in a browser instead.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/**
 * A 5×7 bitmap font, the whole of ASCII 32–126 plus the few symbols a chart axis label needs
 * (`Δ`, `σ`, `°`, `×`). Each glyph is 35 characters read in seven rows of five, `#` for ink —
 * written out longhand because it is the only form that can be checked by eye, and a font table
 * that can't be checked by eye is a font table with a broken glyph in it.
 *
 * Row 7 is the baseline; `g`, `p`, `q`, `y` and `,` use it as their descender and so sit one row
 * lower than the other lowercase letters, which is why they look shifted in the table.
 */
const FONT = {
  " ": ".....　.....　.....　.....　.....　.....　.....",
  "!": "..#..　..#..　..#..　..#..　..#..　.....　..#..",
  '"': ".#.#.　.#.#.　.....　.....　.....　.....　.....",
  "#": ".#.#.　.#.#.　#####　.#.#.　#####　.#.#.　.#.#.",
  $: "..#..　.####　#.#..　.###.　..#.#　####.　..#..",
  "%": "##..#　##..#　...#.　..#..　.#...　#..##　#..##",
  "&": ".##..　#..#.　.##..　##.#.　#..##　#..#.　.##.#",
  "'": "..#..　..#..　.....　.....　.....　.....　.....",
  "(": "...#.　..#..　.#...　.#...　.#...　..#..　...#.",
  ")": ".#...　..#..　...#.　...#.　...#.　..#..　.#...",
  "*": ".....　.#.#.　..#..　#####　..#..　.#.#.　.....",
  "+": ".....　..#..　..#..　#####　..#..　..#..　.....",
  ",": ".....　.....　.....　.....　.....　..#..　.#...",
  "-": ".....　.....　.....　#####　.....　.....　.....",
  ".": ".....　.....　.....　.....　.....　.....　..#..",
  "/": "....#　....#　...#.　..#..　.#...　#....　#....",
  0: ".###.　#...#　#..##　#.#.#　##..#　#...#　.###.",
  1: "..#..　.##..　..#..　..#..　..#..　..#..　.###.",
  2: ".###.　#...#　....#　...#.　..#..　.#...　#####",
  3: "#####　...#.　..#..　...#.　....#　#...#　.###.",
  4: "...#.　..##.　.#.#.　#..#.　#####　...#.　...#.",
  5: "#####　#....　####.　....#　....#　#...#　.###.",
  6: "..##.　.#...　#....　####.　#...#　#...#　.###.",
  7: "#####　....#　...#.　..#..　.#...　.#...　.#...",
  8: ".###.　#...#　#...#　.###.　#...#　#...#　.###.",
  9: ".###.　#...#　#...#　.####　....#　...#.　.##..",
  ":": ".....　..#..　..#..　.....　..#..　..#..　.....",
  ";": ".....　..#..　..#..　.....　..#..　..#..　.#...",
  "<": "...#.　..#..　.#...　#....　.#...　..#..　...#.",
  "=": ".....　.....　#####　.....　#####　.....　.....",
  ">": ".#...　..#..　...#.　....#　...#.　..#..　.#...",
  "?": ".###.　#...#　....#　...#.　..#..　.....　..#..",
  "@": ".###.　#...#　#.###　#.#.#　#.###　#....　.###.",
  A: ".###.　#...#　#...#　#####　#...#　#...#　#...#",
  B: "####.　#...#　#...#　####.　#...#　#...#　####.",
  C: ".###.　#...#　#....　#....　#....　#...#　.###.",
  D: "####.　#...#　#...#　#...#　#...#　#...#　####.",
  E: "#####　#....　#....　####.　#....　#....　#####",
  F: "#####　#....　#....　####.　#....　#....　#....",
  G: ".###.　#...#　#....　#.###　#...#　#...#　.####",
  H: "#...#　#...#　#...#　#####　#...#　#...#　#...#",
  I: ".###.　..#..　..#..　..#..　..#..　..#..　.###.",
  J: "..###　...#.　...#.　...#.　...#.　#..#.　.##..",
  K: "#...#　#..#.　#.#..　##...　#.#..　#..#.　#...#",
  L: "#....　#....　#....　#....　#....　#....　#####",
  M: "#...#　##.##　#.#.#　#.#.#　#...#　#...#　#...#",
  N: "#...#　##..#　##..#　#.#.#　#..##　#..##　#...#",
  O: ".###.　#...#　#...#　#...#　#...#　#...#　.###.",
  P: "####.　#...#　#...#　####.　#....　#....　#....",
  Q: ".###.　#...#　#...#　#...#　#.#.#　#..#.　.##.#",
  R: "####.　#...#　#...#　####.　#.#..　#..#.　#...#",
  S: ".####　#....　#....　.###.　....#　....#　####.",
  T: "#####　..#..　..#..　..#..　..#..　..#..　..#..",
  U: "#...#　#...#　#...#　#...#　#...#　#...#　.###.",
  V: "#...#　#...#　#...#　#...#　#...#　.#.#.　..#..",
  W: "#...#　#...#　#...#　#.#.#　#.#.#　##.##　#...#",
  X: "#...#　#...#　.#.#.　..#..　.#.#.　#...#　#...#",
  Y: "#...#　#...#　.#.#.　..#..　..#..　..#..　..#..",
  Z: "#####　....#　...#.　..#..　.#...　#....　#####",
  "[": ".###.　.#...　.#...　.#...　.#...　.#...　.###.",
  "\\": "#....　#....　.#...　..#..　...#.　....#　....#",
  "]": ".###.　...#.　...#.　...#.　...#.　...#.　.###.",
  "^": "..#..　.#.#.　#...#　.....　.....　.....　.....",
  _: ".....　.....　.....　.....　.....　.....　#####",
  "`": ".#...　..#..　.....　.....　.....　.....　.....",
  a: ".....　.....　.###.　....#　.####　#...#　.####",
  b: "#....　#....　####.　#...#　#...#　#...#　####.",
  c: ".....　.....　.####　#....　#....　#....　.####",
  d: "....#　....#　.####　#...#　#...#　#...#　.####",
  e: ".....　.....　.###.　#...#　#####　#....　.###.",
  f: "..##.　.#..#　.#...　####.　.#...　.#...　.#...",
  g: ".....　.....　.####　#...#　.####　....#　.###.",
  h: "#....　#....　####.　#...#　#...#　#...#　#...#",
  i: "..#..　.....　.##..　..#..　..#..　..#..　.###.",
  j: "...#.　.....　...#.　...#.　...#.　#..#.　.##..",
  k: "#....　#....　#..#.　#.#..　##...　#.#..　#..#.",
  l: ".##..　..#..　..#..　..#..　..#..　..#..　.###.",
  m: ".....　.....　##.#.　#.#.#　#.#.#　#...#　#...#",
  n: ".....　.....　####.　#...#　#...#　#...#　#...#",
  o: ".....　.....　.###.　#...#　#...#　#...#　.###.",
  p: ".....　.....　####.　#...#　####.　#....　#....",
  q: ".....　.....　.####　#...#　.####　....#　....#",
  r: ".....　.....　#.###　##...　#....　#....　#....",
  s: ".....　.....　.####　#....　.###.　....#　####.",
  t: ".#...　.#...　####.　.#...　.#...　.#..#　..##.",
  u: ".....　.....　#...#　#...#　#...#　#...#　.####",
  v: ".....　.....　#...#　#...#　#...#　.#.#.　..#..",
  w: ".....　.....　#...#　#...#　#.#.#　#.#.#　.#.#.",
  x: ".....　.....　#...#　.#.#.　..#..　.#.#.　#...#",
  y: ".....　.....　#...#　#...#　.####　....#　.###.",
  z: ".....　.....　#####　...#.　..#..　.#...　#####",
  "{": "...#.　..#..　..#..　.#...　..#..　..#..　...#.",
  "|": "..#..　..#..　..#..　..#..　..#..　..#..　..#..",
  "}": ".#...　..#..　..#..　...#.　..#..　..#..　.#...",
  "~": ".....　.....　.##.#　#..#.　.....　.....　.....",
  "Δ": "..#..　..#..　.#.#.　.#.#.　#...#　#...#　#####",
  "σ": ".....　.....　.####　##..#　#...#　#...#　.###.",
  "°": ".###.　.#.#.　.###.　.....　.....　.....　.....",
  "×": ".....　.....　#...#　.#.#.　..#..　.#.#.　#...#",
};
/** Glyph geometry. `ADVANCE` is the pen step: five ink columns plus one of tracking. */
export const GLYPH_W = 5;
export const GLYPH_H = 7;
const ADVANCE = 6;

/** The font table is written with a full-width space between rows purely so the seven groups of
 * five stay readable; strip it once, at load. */
const GLYPHS = new Map(
  Object.entries(FONT).map(([ch, art]) => [ch, art.replaceAll("　", "")]),
);

/** Width in pixels of `text` at `scale`, including the trailing tracking column — which is what
 * makes centring on this value land a hair left, matching how the browser measures a string. */
export function textWidth(text, scale = 1) {
  return text.length * ADVANCE * scale;
}

/** `#rgb`/`#rrggbb` → `[r, g, b]`. Anything else throws: a mistyped color should fail loudly
 * rather than quietly draw black on black. */
export function parseColor(hex) {
  const s = hex.replace("#", "");
  const full = s.length === 3 ? [...s].map((c) => c + c).join("") : s;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`bad color: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** An RGB image being drawn into: `w × h` pixels, three bytes each, no alpha channel. Shapes
 * blend into it with their own coverage, so the background is opaque from the first pixel. */
export function createCanvas(w, h, background = "#000000") {
  const data = new Uint8Array(w * h * 3);
  const cv = { w, h, data };
  fillRect(cv, 0, 0, w, h, background);
  return cv;
}

/** Blend `color` into one pixel at coverage `a` (0–1). The single point where bytes are written —
 * everything else computes a coverage and calls this. */
function blend(cv, x, y, [r, g, b], a) {
  if (a <= 0 || x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 3;
  const k = a >= 1 ? 1 : a;
  // Rounded, not truncated: a Uint8Array store truncates, and a curve crossing a hundred pixels
  // at partial coverage would lose a level per blend and drift visibly darker.
  cv.data[i] = Math.round(cv.data[i] + (r - cv.data[i]) * k);
  cv.data[i + 1] = Math.round(cv.data[i + 1] + (g - cv.data[i + 1]) * k);
  cv.data[i + 2] = Math.round(cv.data[i + 2] + (b - cv.data[i + 2]) * k);
}

export function fillRect(cv, x, y, w, h, color, alpha = 1) {
  const rgb = parseColor(color);
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(cv.w, Math.round(x + w));
  const y1 = Math.min(cv.h, Math.round(y + h));
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) blend(cv, px, py, rgb, alpha);
}

/** Squared distance from point to segment, and the parameter along it — the primitive both the
 * line and the dash walker are built on. */
function distToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  const qx = x0 + t * dx;
  const qy = y0 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/**
 * One anti-aliased segment of the given width. Coverage falls off over the last pixel of the
 * stroke's half-width, which is the cheap approximation of a box filter that makes thin diagonal
 * lines read as lines; exact area coverage would look no different at these widths.
 *
 * Joints between consecutive segments blend the same color into the same pixels twice. That is
 * harmless — blending a color over itself converges to that color — so polylines need no special
 * joint handling.
 */
export function strokeSegment(cv, x0, y0, x1, y1, color, width = 1, alpha = 1) {
  const rgb = Array.isArray(color) ? color : parseColor(color);
  const half = width / 2;
  const pad = half + 1;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const maxX = Math.min(cv.w - 1, Math.ceil(Math.max(x0, x1) + pad));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const maxY = Math.min(cv.h - 1, Math.ceil(Math.max(y0, y1) + pad));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const d = distToSegment(px + 0.5, py + 0.5, x0, y0, x1, y1);
      const cov = Math.min(1, Math.max(0, half + 0.5 - d));
      if (cov > 0) blend(cv, px, py, rgb, cov * alpha);
    }
  }
}

/**
 * A polyline through `points` (`[x, y]`, or `null` for a gap — a value the scale can't show, the
 * same hole uPlot leaves). `dash` is a `[on, off, …]` pattern in pixels whose phase carries across
 * segments, so a dashed reference curve dashes along its own length rather than restarting at
 * every cycle.
 */
export function strokePolyline(cv, points, color, { width = 1, alpha = 1, dash = null } = {}) {
  const rgb = parseColor(color);
  let phase = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    if (!dash) {
      strokeSegment(cv, a[0], a[1], b[0], b[1], rgb, width, alpha);
      continue;
    }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let travelled = 0;
    while (travelled < len) {
      const period = dash.reduce((s, d) => s + d, 0);
      let p = phase % period;
      let idx = 0;
      while (p >= dash[idx]) p -= dash[idx++];
      const remaining = dash[idx] - p;
      const step = Math.min(remaining, len - travelled);
      // A zero-length dash entry would advance nothing and spin here forever.
      if (step <= 0) break;
      if (idx % 2 === 0) {
        const t0 = travelled / len;
        const t1 = (travelled + step) / len;
        strokeSegment(
          cv,
          a[0] + (b[0] - a[0]) * t0,
          a[1] + (b[1] - a[1]) * t0,
          a[0] + (b[0] - a[0]) * t1,
          a[1] + (b[1] - a[1]) * t1,
          rgb,
          width,
          alpha,
        );
      }
      travelled += step;
      phase += step;
    }
  }
}

/** An anti-aliased circle outline — the Cq ring, and nothing else so far. Coverage is taken from
 * the distance to the ring itself, so the stroke stays even all the way round. */
export function strokeCircle(cv, cx, cy, r, color, width = 1, alpha = 1) {
  const rgb = parseColor(color);
  const half = width / 2;
  const pad = r + half + 1;
  for (let py = Math.max(0, Math.floor(cy - pad)); py <= Math.min(cv.h - 1, Math.ceil(cy + pad)); py++) {
    for (let px = Math.max(0, Math.floor(cx - pad)); px <= Math.min(cv.w - 1, Math.ceil(cx + pad)); px++) {
      const d = Math.abs(Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - r);
      const cov = Math.min(1, Math.max(0, half + 0.5 - d));
      if (cov > 0) blend(cv, px, py, rgb, cov * alpha);
    }
  }
}

/**
 * Bitmap text with its top-left at `(x, y)`, scaled by an integer factor (pixels are replicated,
 * never interpolated — a blurred 5×7 glyph is unreadable). `align` places the string relative to
 * `x`; `rotate: -90` draws it reading bottom-to-top, which is how the y-axis label is drawn.
 *
 * A character the font doesn't carry draws as `?` rather than a gap, so a missing glyph is
 * visible instead of silently eating a letter.
 */
export function drawText(cv, x, y, text, color, { scale = 1, align = "left", rotate = 0 } = {}) {
  const rgb = parseColor(color);
  const w = textWidth(text, scale);
  // `pen` runs along the reading direction and `up` across it, in glyph pixels; alignment shifts
  // the pen's origin, and the rotation decides which screen axis each maps to.
  const start = align === "center" ? -w / 2 : align === "right" ? -w : 0;
  const place = (pen, up) =>
    rotate === -90
      ? [x + up * scale, y - start - pen * scale]
      : [x + start + pen * scale, y + up * scale];
  for (let i = 0; i < text.length; i++) {
    const art = GLYPHS.get(text[i]) ?? GLYPHS.get("?");
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (art[row * GLYPH_W + col] !== "#") continue;
        const [px, py] = place(i * ADVANCE + col, row);
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++)
            blend(cv, Math.round(px) + sx, Math.round(py) + sy, rgb, 1);
      }
    }
  }
}

/** For a -90° label: the string runs along y, so its extent on screen swaps axes. */
export function textHeight(scale = 1) {
  return GLYPH_H * scale;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** Encode the canvas as an 8-bit truecolor PNG. Every scanline uses filter 0 (none): the deflate
 * pass does the compressing, and a chart of flat background plus thin lines gains little from
 * per-line prediction — not enough to justify choosing a filter per row. */
export function encodePng(cv) {
  const raw = Buffer.alloc(cv.h * (cv.w * 3 + 1));
  for (let y = 0; y < cv.h; y++) {
    raw[y * (cv.w * 3 + 1)] = 0;
    Buffer.from(cv.data.buffer, y * cv.w * 3, cv.w * 3).copy(raw, y * (cv.w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writePng(path, cv) {
  writeFileSync(path, encodePng(cv));
}
