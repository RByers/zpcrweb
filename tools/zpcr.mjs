#!/usr/bin/env node
/**
 * `zpcr` — a command-line face on `@zpcrweb/core`'s run-analysis pipeline.
 *
 *   node tools/zpcr.mjs <run> results [--password <pw>] [--step <n>]
 *   node tools/zpcr.mjs <run> curves  [--wells A1,B2-D5] [--rows A-C] [--cols 1,5]
 *                                     [--fluors FAM,HEX] [-o out.png] [--size WxH] [--dpr N]
 *
 * `<run>` is any of the three run formats — a CFX `.zpcr` or `.pcrd`, or a Biomeme `.bmrun`
 * (see {@link runFromFile}).
 *
 * `results` prints a run's results table — the same one the web app's Curves view shows in
 * Table mode and downloads as CSV — as CSV on stdout: one row per loaded well/fluorophore pair,
 * Cq and all.
 *
 * `curves` writes those same curves as a PNG of the web app's Curves chart, in its default
 * Relative mode: not a picture that resembles the chart but one drawn *by* it, since the picture
 * is rendered by the app's own `buildChart` in headless Chrome (`tools/chartshot.mjs`). See
 * {@link chartConfig} for the display settings it asks for, and `chartshot.mjs`'s own header for
 * why the chart is run rather than reimplemented.
 *
 * Every number here comes straight from `computeRunAnalysis`/`buildAnalysisRows`/`analysisCsv`
 * (`packages/core/src/runAnalysis.ts` and `analysisRows.ts`) — the library's own derivation, not
 * a second copy of it. This file is wiring: argv parsing, the password fallback, and well
 * selection. Nothing here touches a Cq, a threshold, a baseline or a color.
 *
 * The two commands need different things installed, which is worth knowing before reaching for
 * one on a bare machine: `results` is plain Node over a built core (`npm run build`), the same
 * way `cfx.mjs` is, while `curves` also needs Chrome and the web app's source, because that is
 * where the chart lives.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  analysisCsv,
  buildAnalysisRows,
  channelCurveKey,
  channelLabel,
  computeRunAnalysis,
  curveKey,
  parseBiomeme,
  parsePcrd,
  parseZpcr,
  parseZpcrwebSettings,
  runAnalysisSettingsFromZpcrweb,
  wellKey,
} from "../packages/core/dist/index.js";
// `chartshot.mjs` is imported where `curves` needs it, not here: it pulls in esbuild and the
// Chrome harness, and `results` — the reason to reach for this tool on a machine with nothing on
// it — has no use for either. A static import would make the CSV path fail on a checkout that
// can render no chart at all.

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
      "                           [--fluors FAM,HEX] [--size 1100x620] [--dpr 1]\n" +
      "                           [--channels]\n\n" +
      "<run> is a CFX .zpcr or .pcrd, or a Biomeme .bmrun.\n\n" +
      "results  the run's results table (the web app's Curves view Table mode) as CSV\n" +
      "curves   the run's amplification curves as a PNG, as the Curves chart draws them\n\n" +
      "Well selection: --wells/--rows/--cols are a union (any match plots the well); each\n" +
      "accepts a comma-separated list whose items may be ranges. A well range spans the\n" +
      "rectangle between its ends, so --wells A1-B3 is six wells. With none given, every well\n" +
      "the plate loads is drawn. --fluors then narrows that to the named dyes.\n\n" +
      "--size is CSS pixels; --dpr multiplies them into device pixels the way a retina\n" +
      "display would. --size 640x360 --dpr 2 writes a 1280x720 PNG of the chart laid out\n" +
      "at 640 wide — sharper, not zoomed out.",
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

// ---- Curves ------------------------------------------------------------------------------

/**
 * The run's curves, in the shape the web app's chart takes them: one `PlotCurve` per plotted
 * series, carrying its analysis record rather than anything derived from it.
 *
 * Dye space when the run has a calibration to separate colors with, channel space otherwise —
 * the same automatic choice the Curves view makes (`settings.calibration ?? calibrationAvailable`),
 * and `--channels` forces the raw channels for a run that could do either. In dye space a well is
 * drawn for the dyes the plate actually loads it with; a pair the plate never loads has no curve
 * worth showing (the app hides those behind its "Unloaded" toggle).
 *
 * The `dyeLabel` here is always the dye's own name — the app's Target mode relabels a curve by
 * the target assigned to its well, which changes what the rail groups and what a tooltip says,
 * and this picture has neither. Color reads from `fluor`, so it is the same either way.
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
          channel: c.channel,
          dyeLabel: c.dye,
          fluor: c.dye,
          row: c.row,
          col: c.col,
          wellLabel: c.wellLabel,
          isReference: c.isReference,
          cycles: c.cycles,
          mean: c.mean,
          analysis: run.cqTable.get(curveKey(c.row, c.col, c.dye)),
        }))
    : run.allCurves
        .filter((c) => run.available.includes(c.channel))
        .map((c) => ({
          channel: c.channel,
          dyeLabel: channelLabel(c.channel),
          row: c.row,
          col: c.col,
          wellLabel: c.wellLabel,
          isReference: c.isReference,
          cycles: c.cycles,
          mean: c.mean,
          // Channel space is the only space with a real spread to show — see `PlotCurve.std`.
          std: c.std,
          min: c.min,
          max: c.max,
          analysis: run.plainBaselines.get(channelCurveKey(c.row, c.col, c.channel)),
        }));

  const curves = source.filter(
    (c) =>
      select(c.row, c.col) &&
      (!wanted || wanted.has((c.fluor ?? channelLabel(c.channel)).toLowerCase())),
  );
  for (const c of curves) c.sample = run.wellSample.get(wellKey(c.row, c.col));
  return { curves, dyeSpace };
}

/**
 * What the chart is asked to draw: the Curves view's own defaults, as the app opens on them.
 *
 * Relative mode (`threshold.md` §4) on a linear axis, with the overlays that are either
 * interactive or off by default left out — the dark curves, the right-hand instrument axis, the
 * min/max bands, the "draw baseline" overlay, and the threshold line the app only shows while a
 * threshold row is hovered. The Cq rings are neither optional nor configured: `buildChart` draws
 * one per curve that has a Cq.
 */
function chartConfig(curves, { width, height, dpr }) {
  return {
    wellCurves: curves,
    darkCurves: [],
    factoryCurves: [],
    drawFactory: false,
    // An axis with no curves on it hides itself, so these labels are never drawn.
    aux: { label: "", unit: "", rowLabel: "", decimals: 1, tipDecimals: 1, curves: [] },
    baseline: "raw",
    curveView: "relative",
    drawBaseline: false,
    scale: "linear",
    bands: false,
    width,
    height,
    dpr,
  };
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
    else if (cmd === "curves" && flag === "--dpr") opts.dpr = rest[++i];
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
  // `--size` is CSS pixels and `--dpr` multiplies them into device pixels, exactly as a browser
  // on a retina display would: `--size 640x360 --dpr 2` is a 1280×720 file of the chart laid out
  // at 640 wide, not the smaller-lettered chart `--size 1280x720` would lay out.
  const dpr = Math.min(4, Math.max(1, Number(opts.dpr) || 1));
  // An empty selection would render a blank rectangle — the app has a rail and an empty-state
  // message to explain itself with, a PNG on disk has neither. Say so and write nothing.
  if (curves.length === 0) {
    console.error(
      `${file}: nothing to plot — no ${dyeSpace ? "loaded well/dye pair" : "channel curve"} matches that selection.`,
    );
    process.exit(1);
  }

  const out = opts.out ?? `${basename(file, extname(file))}-curves.png`;
  const { renderChartPng } = await import("./chartshot.mjs");
  writeFileSync(out, await renderChartPng(chartConfig(curves, { width, height, dpr })));
  const cqs = curves.filter((c) => c.analysis?.cq != null).length;
  console.error(
    `${out}: ${curves.length} curve${curves.length === 1 ? "" : "s"} ` +
      `(${dyeSpace ? "dye space" : "channel space"}, ${cqs} with a Cq), ${width}×${height}` +
      (dpr === 1 ? "" : ` @${dpr}x = ${width * dpr}×${height * dpr}`),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
