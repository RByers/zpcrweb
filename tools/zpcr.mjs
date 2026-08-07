#!/usr/bin/env node
/**
 * `zpcr` — a command-line face on `@zpcrweb/core`'s run-analysis pipeline.
 *
 *   node tools/zpcr.mjs <run> results [--password <pw>] [--step <n>]
 *   node tools/zpcr.mjs <run> curves  [--wells A1,B2-D5] [--rows A-C] [--cols 1,5]
 *                                     [--fluors FAM,HEX] [-o out.png] [--size WxH]
 *
 * `<run>` is any of the three run formats — a CFX `.zpcr` or `.pcrd`, or a Biomeme `.bmrun`
 * (see {@link runFromFile}).
 *
 * `results` prints a run's results table — the same one the web app's Curves view shows in
 * Table mode and downloads as CSV — as CSV on stdout: one row per loaded well/fluorophore pair,
 * Cq and all.
 *
 * `curves` draws the amplification curves as a PNG: the web app's Curves chart in its default
 * Relative mode, with the same colors, the same dark background and a ring at each curve's Cq.
 * See {@link renderCurves} for what it deliberately leaves out.
 *
 * Every number here comes straight from `computeRunAnalysis`/`buildAnalysisRows`/`analysisCsv`
 * (`packages/core/src/runAnalysis.ts` and `analysisRows.ts`) — the library's own derivation, not
 * a second copy of it. This file is wiring: argv parsing, the password fallback, well selection,
 * and turning already-computed values into pixels. Nothing here touches a Cq, a threshold, or a
 * baseline; the colors come from the library too (`colors.ts`), so a curve is the same green here
 * as it is in the browser.
 *
 * Needs a built core (`npm run build`) — this runs with plain Node, no bundler, so it resolves
 * `@zpcrweb/core` to `packages/core/dist` the same way any other consumer of the published
 * package would (see `tools/cfx.mjs`'s own note).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  analysisCsv,
  buildAnalysisRows,
  channelCurveKey,
  channelLabel,
  computeRunAnalysis,
  curveColor,
  curveKey,
  parseBiomeme,
  parsePcrd,
  parseZpcr,
  parseZpcrwebSettings,
  runAnalysisSettingsFromZpcrweb,
  wellKey,
} from "../packages/core/dist/index.js";
import {
  createCanvas,
  drawText,
  strokeCircle,
  strokePolyline,
  strokeSegment,
  textHeight,
  textWidth,
  writePng,
} from "./png.mjs";

/** The local, gitignored CFX ZipCrypto password — see `AGENTS.md`'s Secrets section and
 * `packages/core/test/secrets.ts`, which this mirrors. `undefined` when there's no `secrets.json`. */
function readCfxPassword() {
  const path = new URL("../secrets.json", import.meta.url);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")).cfxPassword;
}

/**
 * Read a run from disk, whichever of the three run formats it is: a CFX `.zpcr` archive, a CFX
 * `.pcrd`, or a Biomeme `.bmrun`. All three parse to the same {@link Zpcr} document, which is
 * what makes one command work across them — the same boundary the web app keeps in its
 * `parseRun`, and the reason `computeRunAnalysis` below never asks where a run came from.
 *
 * Routed on the extension, exactly as the app routes a dropped file: each of the three names its
 * own format, so there is nothing to sniff. This used to call `zpcrFromFile` unconditionally,
 * which meant a `.bmrun` — JSON, not a zip — failed with "invalid zip data".
 */
async function runFromFile(path, password) {
  const bytes = new Uint8Array(readFileSync(path));
  if (/\.bmrun$/i.test(path)) return parseBiomeme(bytes);
  if (/\.pcrd$/i.test(path)) {
    const pcrd = parsePcrd(bytes, password ? { password } : undefined);
    if (pcrd.needsPassword) {
      throw new Error(
        `${path}: this file is encrypted. Pass --password, or set cfxPassword in secrets.json.`,
      );
    }
    if (!pcrd.zpcr) throw new Error(`${path}: ${pcrd.error ?? "could not be decoded"}`);
    return pcrd.zpcr;
  }
  return parseZpcr(bytes);
}

function usage() {
  console.error(
    "usage: zpcr <run> results [--password <pw>] [--step <n>]\n" +
      "       zpcr <run> curves  [--password <pw>] [--step <n>] [-o <out.png>]\n" +
      "                           [--wells A1,B2-D5] [--rows A-C] [--cols 1,5-8]\n" +
      "                           [--fluors FAM,HEX] [--size 1100x620] [--channels]\n\n" +
      "<run> is a CFX .zpcr or .pcrd, or a Biomeme .bmrun.\n\n" +
      "results  the run's results table (the web app's Curves view Table mode) as CSV\n" +
      "curves   the run's amplification curves as a PNG, as the Curves chart draws them\n\n" +
      "Well selection: --wells/--rows/--cols are a union (any match plots the well); each\n" +
      "accepts a comma-separated list whose items may be ranges. A well range spans the\n" +
      "rectangle between its ends, so --wells A1-B3 is six wells. With none given, every well\n" +
      "the plate loads is drawn. --fluors then narrows that to the named dyes.",
  );
  process.exit(1);
}

// ---- Well selection -----------------------------------------------------------------------

/** `A` → 0, `H` → 7. Rows past Z would need two letters, which no plate this reads has. */
function rowIndex(letter) {
  const i = letter.toUpperCase().charCodeAt(0) - 65;
  if (i < 0 || i > 25) throw new Error(`bad row: ${letter}`);
  return i;
}

/** `B7` → `{ row: 1, col: 6 }`, both zero-based, matching `WellCurve.row`/`col`. */
function parseWell(text) {
  const m = /^([A-Za-z])\s*(\d{1,2})$/.exec(text.trim());
  if (!m) throw new Error(`bad well: ${text}`);
  return { row: rowIndex(m[1]), col: Number(m[2]) - 1 };
}

/** Split a comma list into items, each either a single value or a `lo-hi` range. */
function parseList(text, parse) {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const dash = item.indexOf("-", 1);
      if (dash === -1) return { from: parse(item), to: parse(item) };
      return { from: parse(item.slice(0, dash)), to: parse(item.slice(dash + 1)) };
    });
}

/**
 * The `--wells`/`--rows`/`--cols` flags as one predicate over a well.
 *
 * A union, not an intersection: `--rows A --cols 12` means "row A **or** column 12", which is how
 * someone naming two parts of a plate on one command line means it. Narrowing to a single well is
 * what `--wells` is for. With no flag at all every well passes, and the caller's own "is this pair
 * loaded" check is what limits the plot.
 */
function wellSelector({ wells, rows, cols }) {
  if (!wells && !rows && !cols) return () => true;
  const wellRanges = wells ? parseList(wells, parseWell) : [];
  const rowRanges = rows ? parseList(rows, (s) => ({ row: rowIndex(s), col: 0 })) : [];
  const colRanges = cols ? parseList(cols, (s) => ({ row: 0, col: Number(s) - 1 })) : [];
  const between = (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b);
  return (row, col) =>
    // A well range covers the rectangle between its corners — A1-B3 is six wells, the block a
    // reader traces with a finger, not the twenty-four in reading order between them.
    wellRanges.some((r) => between(row, r.from.row, r.to.row) && between(col, r.from.col, r.to.col)) ||
    rowRanges.some((r) => between(row, r.from.row, r.to.row)) ||
    colRanges.some((r) => between(col, r.from.col, r.to.col));
}

// ---- Chart --------------------------------------------------------------------------------

/**
 * The Curves chart's own colors, read off the web app so the two pictures match: the panel the
 * chart sits on (`--panel`), the axis ink (`--ink-2`) and the two blue-tinged hairline strengths
 * the grid and ticks use. Curve colors are not here — those come from the library's `curveColor`,
 * which is the same call the browser chart makes.
 */
const BG = "#0b0e14";
const AXIS_INK = "#8aa0c0";
const GRID = "#78c8ff";
const GRID_ALPHA = 0.06;
const TICK_ALPHA = 0.12;
/** Cq ring geometry, matching the SVG circle the browser chart overlays on each curve. */
const CQ_RADIUS = 4.5;
const CQ_WIDTH = 1.75;
/** A reference-row curve is dashed, in the chart's own pattern. */
const REF_DASH = [3, 3];

/** Tick steps a reader can do arithmetic on: 1, 2, 2.5, 5 and their decades — the same ladder
 * uPlot climbs. Rounded *down* to the nearest of them, which errs toward a slightly denser axis
 * than the target asked for; rounding up jumps straight from 500 to 1000 and leaves a five-tick
 * axis where the browser chart draws thirteen. */
function niceStep(rough) {
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  return (norm >= 10 ? 10 : norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1) * mag;
}

/**
 * A y range and its tick positions: the data's own extent, padded a little so no curve touches
 * the frame, then rounded outward to whole ticks. Degenerate input (one flat curve, or none at
 * all) still yields a usable range rather than a zero-height axis.
 */
function yAxisTicks(min, max, target = 7) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) [min, max] = [0, 1];
  if (min === max) [min, max] = [min - 1, max + 1];
  const pad = (max - min) * 0.06;
  const step = niceStep((max - min + 2 * pad) / target);
  const lo = Math.floor((min - pad) / step) * step;
  const hi = Math.ceil((max + pad) / step) * step;
  const ticks = [];
  // Accumulating with a multiply rather than repeated addition keeps 0.1-sized steps from
  // drifting into 0.30000000000000004 by the time they reach the axis labels.
  for (let i = 0; lo + i * step <= hi + step * 1e-6; i++) ticks.push(lo + i * step);
  return { lo, hi, ticks, step };
}

/** Label a y tick with just enough decimals for its step to be visible, and group the thousands —
 * RFU runs to five figures, and the browser chart groups them for the same reason. */
function tickLabel(v, step) {
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) + 0.2)));
  const text = v.toFixed(decimals);
  if (text === "-0" || text === `-0.${"0".repeat(decimals)}`) return (0).toFixed(decimals);
  const [whole, frac] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * Draw the curves, and return the canvas.
 *
 * This is the browser chart's **Relative** view (`threshold.md` §4) with the defaults the app
 * opens on: each curve is plotted as its analysis' `correctedValues` — the very array its Cq was
 * measured against — on a linear axis, and each curve with a Cq gets a ring where it crosses.
 * Nothing is re-derived here; every value is read off the run's single analysis, which is what
 * keeps the ring on the curve.
 *
 * Deliberately not drawn, because they are all interactive or secondary in the app and a still
 * image is neither: the hover tooltip and whisker, the min/max envelope bands, the "draw
 * baseline" overlay, the dark-curve and right-hand instrument axes, and the threshold line
 * (which the app only shows while a threshold row is hovered).
 */
function renderCurves(curves, { width, height, yLabel }) {
  const cv = createCanvas(width, height, BG);
  const cycles = curves[0]?.cycles ?? [];
  const padTop = 12;
  const padRight = 14;
  // Left gutter: the axis label reading upward, then the tick values, then the plot. Bottom:
  // tick values under the axis, then the "Cycle" label under those.
  const tickText = textHeight();
  const padBottom = tickText * 2 + 14;

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const c of curves) {
    for (const v of c.values) {
      if (!Number.isFinite(v)) continue;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  // The ticks depend only on the plot's *height*, which the left gutter can't change — so they
  // can be chosen first and the gutter then sized to whatever the widest label turned out to be
  // ("-1,000" is twice the width of "0"). One tick per ~60px of axis is about the density uPlot
  // lands on, and about as close as labels this size can sit without crowding.
  const plotHeight = height - padTop - padBottom;
  const y = yAxisTicks(yMin, yMax, Math.max(3, Math.round(plotHeight / 60)));
  const widest = Math.max(...y.ticks.map((t) => textWidth(tickLabel(t, y.step))));
  const plot = {
    x0: tickText + 6 + widest + 8,
    y0: padTop,
    x1: width - padRight,
    y1: height - padBottom,
  };
  const xMin = cycles.length ? cycles[0] : 1;
  const xMax = cycles.length ? cycles[cycles.length - 1] : 2;
  const toX = (c) => plot.x0 + ((c - xMin) / (xMax - xMin || 1)) * (plot.x1 - plot.x0);
  const toY = (v) => plot.y1 - ((v - y.lo) / (y.hi - y.lo || 1)) * (plot.y1 - plot.y0);

  // Grid and ticks first, so every curve draws over them — the same stacking uPlot uses.
  for (const t of y.ticks) {
    const py = Math.round(toY(t)) + 0.5;
    strokeSegment(cv, plot.x0, py, plot.x1, py, GRID, 1, GRID_ALPHA);
    strokeSegment(cv, plot.x0 - 4, py, plot.x0, py, GRID, 1, TICK_ALPHA);
    drawText(cv, plot.x0 - 8, py - (tickText - 1) / 2, tickLabel(t, y.step), AXIS_INK, {
      align: "right",
    });
  }
  // The cycle axis ticks every cycle but labels and grids only every fifth: labelling all forty
  // would be unreadable, which is the call the browser chart makes too.
  for (const c of cycles) {
    const px = Math.round(toX(c)) + 0.5;
    strokeSegment(cv, px, plot.y1, px, plot.y1 + 5, GRID, 1, TICK_ALPHA);
    if (c % 5 !== 0) continue;
    strokeSegment(cv, px, plot.y0, px, plot.y1, GRID, 1, GRID_ALPHA);
    drawText(cv, px, plot.y1 + 9, String(c), AXIS_INK, { align: "center" });
  }
  strokeSegment(cv, plot.x0 + 0.5, plot.y0, plot.x0 + 0.5, plot.y1, AXIS_INK, 1, 0.35);
  strokeSegment(cv, plot.x0, plot.y1 + 0.5, plot.x1, plot.y1 + 0.5, AXIS_INK, 1, 0.35);
  drawText(cv, (plot.x0 + plot.x1) / 2, height - tickText - 3, "Cycle", AXIS_INK, {
    align: "center",
  });
  drawText(cv, 3, (plot.y0 + plot.y1) / 2, yLabel, AXIS_INK, { align: "center", rotate: -90 });

  for (const c of curves) {
    const points = c.values.map((v, i) =>
      Number.isFinite(v) ? [toX(c.cycles[i]), toY(v)] : null,
    );
    strokePolyline(cv, points, c.color, { width: 1, dash: c.isReference ? REF_DASH : null });
  }
  // Cq rings last so a dense plate doesn't bury them under the curves drawn after.
  for (const c of curves) {
    if (c.cqPoint == null) continue;
    strokeCircle(cv, toX(c.cqPoint.cycle), toY(c.cqPoint.value), CQ_RADIUS, c.color, CQ_WIDTH);
  }
  if (curves.length === 0) {
    drawText(cv, (plot.x0 + plot.x1) / 2, (plot.y0 + plot.y1) / 2, "no curves selected", AXIS_INK, {
      align: "center",
    });
  }
  return cv;
}

/** Linear interpolation of a per-cycle series at a fractional cycle — a Cq lands between two
 * reads, and this is where on the curve it lands. Mirrors the browser chart's own marker
 * placement: the ring sits on `correctedValues`, never on the threshold. */
function interpolateAt(cycles, values, cycle) {
  for (let i = 0; i + 1 < cycles.length; i++) {
    const c0 = cycles[i];
    const c1 = cycles[i + 1];
    if (cycle < c0 || cycle > c1) continue;
    const v0 = values[i];
    const v1 = values[i + 1];
    if (v0 == null || v1 == null) return null;
    return c1 === c0 ? v0 : v0 + ((cycle - c0) / (c1 - c0)) * (v1 - v0);
  }
  return null;
}

/**
 * The run's curves, filtered and reduced to what the renderer needs.
 *
 * Dye space when the run has a calibration to separate colors with, channel space otherwise —
 * the same automatic choice the Curves view makes (`settings.calibration ?? calibrationAvailable`),
 * and `--channels` forces the raw channels for a run that could do either. In dye space a well is
 * drawn for the dyes the plate actually loads it with; a pair the plate never loads has no curve
 * worth showing (the app hides them behind its "Unloaded" toggle).
 */
function collectCurves(run, { select, fluors, channels }) {
  const dyeSpace = channels ? false : run.calibrationAvailable && run.allFluorCurves.length > 0;
  const wanted = fluors
    ? new Set(fluors.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;

  const source = dyeSpace
    ? run.allFluorCurves
        .filter((c) => run.wellFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false)
        .map((c) => ({
          ...c,
          fluor: c.dye,
          label: `${c.wellLabel} · ${c.dye}`,
          analysis: run.cqTable.get(curveKey(c.row, c.col, c.dye)),
        }))
    : run.allCurves
        .filter((c) => run.available.includes(c.channel))
        .map((c) => ({
          ...c,
          fluor: undefined,
          label: `${c.wellLabel} · ${channelLabel(c.channel)}`,
          analysis: run.plainBaselines.get(channelCurveKey(c.row, c.col, c.channel)),
        }));

  const curves = [];
  for (const c of source) {
    if (!select(c.row, c.col)) continue;
    if (wanted && !wanted.has((c.fluor ?? channelLabel(c.channel)).toLowerCase())) continue;
    // Relative view: plot the analysis' corrected values, the array the Cq was measured against.
    // A curve the run has no record for (nothing to baseline against) falls back to its raw mean,
    // which is what "absolute" would have drawn.
    const values = c.analysis?.correctedValues ?? c.mean;
    const cq = c.analysis?.cq ?? null;
    const at = cq == null ? null : interpolateAt(c.cycles, values, cq);
    curves.push({
      label: c.label,
      color: curveColor({ fluor: c.fluor, channel: c.channel }),
      isReference: c.isReference,
      cycles: c.cycles,
      values,
      cqPoint: at == null ? null : { cycle: cq, value: at },
    });
  }
  return { curves, dyeSpace };
}

// ---- CLI ----------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const [file, cmd, ...rest] = argv;
  if (!file || !cmd) usage();
  if (cmd !== "results" && cmd !== "curves") {
    console.error(`unknown command: ${cmd}`);
    usage();
  }

  const opts = {};
  let password;
  let step;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--password") password = rest[++i];
    else if (flag === "--step") step = Number(rest[++i]);
    else if (cmd === "curves" && (flag === "-o" || flag === "--out")) opts.out = rest[++i];
    else if (cmd === "curves" && flag === "--wells") opts.wells = rest[++i];
    else if (cmd === "curves" && flag === "--rows") opts.rows = rest[++i];
    else if (cmd === "curves" && flag === "--cols") opts.cols = rest[++i];
    else if (cmd === "curves" && flag === "--fluors") opts.fluors = rest[++i];
    else if (cmd === "curves" && flag === "--size") opts.size = rest[++i];
    else if (cmd === "curves" && flag === "--channels") opts.channels = true;
    else usage();
  }

  // The password is needed *before* parsing a `.pcrd`, whose whole document sits inside an
  // encrypted zip entry — unlike a `.zpcr`, where only the plate data is encrypted and the
  // password can wait until `plates()` below.
  if (password == null) password = readCfxPassword();
  const zpcr = await runFromFile(file, password);

  let plateEntry = zpcr.plates(password)[0];
  if (plateEntry?.pltd.needsPassword) {
    console.error(
      `${file}: plate data is password-protected. Pass --password, or set cfxPassword in secrets.json.`,
    );
    process.exit(1);
  }
  if (plateEntry?.pltd.error) {
    console.error(`${file}: failed to decode plate data: ${plateEntry.pltd.error}`);
    process.exit(1);
  }

  const settings = runAnalysisSettingsFromZpcrweb(parseZpcrwebSettings(zpcr));
  // A `.pcrd` that CFX saved with `autoCalculateThreshold="False"` carries the threshold the
  // instrument's own analysis used, per fluorophore (`threshold.md` §5.3) — `zpcrweb.json`
  // outranks it, since that's this library's own record of the same decision, written later.
  if (!settings.thresholdOverrides && zpcr.persistedThresholds) {
    settings.thresholdOverrides = zpcr.persistedThresholds;
  }

  const activeStep = step != null && !Number.isNaN(step) ? step : (zpcr.steps()[0]?.step ?? undefined);

  const run = computeRunAnalysis(zpcr, settings, activeStep, password);

  if (cmd === "results") {
    process.stdout.write(analysisCsv(buildAnalysisRows(run, () => true)));
    return;
  }

  const { curves, dyeSpace } = collectCurves(run, {
    select: wellSelector(opts),
    fluors: opts.fluors,
    channels: opts.channels,
  });
  const [width, height] = (opts.size ?? "1100x620")
    .split("x")
    .map((n) => Math.max(200, Number(n) || 0));
  const out = opts.out ?? `${basename(file, extname(file))}-curves.png`;
  const cv = renderCurves(curves, { width, height, yLabel: "RFU (linear baseline)" });
  writePng(out, cv);
  const cqs = curves.filter((c) => c.cqPoint != null).length;
  console.error(
    `${out}: ${curves.length} curve${curves.length === 1 ? "" : "s"} ` +
      `(${dyeSpace ? "dye space" : "channel space"}, ${cqs} with a Cq), ${width}×${height}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
