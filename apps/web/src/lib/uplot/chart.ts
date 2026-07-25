import uPlot from "uplot";
import {
  autoBaselineRegion,
  clampBaselineRegion,
  smoothCurve,
  subtractBaseline,
  type BaselineMode as CoreBaselineMode,
  type DarkCurve,
  type TemperatureCurve,
} from "@zpcrweb/core";
import { channelColor, channelLabel } from "../channelColors";
import { tempColor } from "../tempColors";
import type {
  Baseline,
  BandsMode,
  CurveBaselineMode,
  CurveBaselineRange,
  Scale,
} from "../../state/useZpcrStore";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Opacity for the portion of a well curve before its baseline region starts — see
 * {@link baselineDimStroke}. */
const PRE_BASELINE_ALPHA = 0.7;

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * A `series.stroke` function (uPlot supports a dynamic stroke callback in place of a fixed
 * color) that renders a well curve at reduced opacity ({@link PRE_BASELINE_ALPHA}) for cycles
 * before `beginCycle` — the baseline region's start — and full opacity from there on. Debugging
 * aid for the baseline-region slider: since {@link autoBaselineRegion} runs on a *smoothed* copy
 * of the curve while the actually-plotted line is raw, and a manual region applies globally
 * across curves whose real shapes differ, it's easy to lose track of which portion of a given
 * curve the current region actually excludes. Built as a horizontal `CanvasGradient` (two
 * coincident color stops at the region's pixel x-position for a hard edge) so it tracks pan/zoom
 * for free — uPlot calls `stroke` fresh on every redraw.
 */
function baselineDimStroke(
  color: string,
  beginCycle: number,
): (u: uPlot, seriesIdx: number) => string | CanvasGradient {
  return (u: uPlot) => {
    const left = u.bbox.left;
    const width = u.bbox.width;
    if (width <= 0) return color;
    const beginPx = u.valToPos(beginCycle, "x", true);
    const frac = Math.min(1, Math.max(0, (beginPx - left) / width));
    if (frac <= 0) return color; // Region starts at/before the visible range: nothing to dim.
    const grad = u.ctx.createLinearGradient(left, 0, left + width, 0);
    const dim = hexToRgba(color, PRE_BASELINE_ALPHA);
    grad.addColorStop(0, dim);
    grad.addColorStop(frac, dim);
    grad.addColorStop(Math.min(1, frac + 0.0001), color);
    grad.addColorStop(1, color);
    return grad;
  };
}

/**
 * One plotted curve, already resolved to a display label by the caller — either a plain channel
 * ("C1", channel-space) or a fluorophore name (dye-space, after color separation). Chart code
 * never guesses a dye from a channel index; see `channelColors.ts`.
 */
export interface PlotCurve {
  /** Optical channel — used only for color. */
  channel: number;
  dyeLabel: string;
  row: number;
  col: number;
  wellLabel: string;
  isReference: boolean;
  cycles: number[];
  mean: number[];
  /** Std/min/max envelope; a color-separated curve has none of its own — pass `mean` for both
   * min and max, and zeros for std, so the envelope collapses to nothing rather than lying. */
  std: number[];
  min: number[];
  max: number[];
  /** Cq (`threshold.md` §6), computed per the Analysis view's settings — `null`/undefined when
   * unamplified or not computable. Drives the chart's Cq marker and its tooltip row. */
  cq?: number | null;
  /** Diagnostic: mean raw RFU over the baseline region actually used for this curve (see
   * `CurveBaselineResult.baselineRfu`) — surfaced in the tooltip so a surprising Cq can be
   * traced back to what baseline region/level was really applied. */
  baselineRfu?: number | null;
  /** Sample name (`pltd.md`'s `conditionName`, `WellDefinition.sample`) for this curve's well,
   * when the plate assigns one — drives the rail's "sample" highlight/hover-card lookup. */
  sample?: string;
  /** Diagnostic: the baseline region's start cycle (`CurveBaselineResult.baselineRegion.beginCycle`)
   * actually used for this curve — draws the portion of the line before it at reduced opacity
   * (see `baselineDimStroke`), so it's visually obvious which part of the curve precedes (and so
   * was excluded from) the baseline fit. `null`/undefined draws the line at full opacity
   * throughout (e.g. `"raw"` baseline mode, where no region is applied). */
  baselineRegionBegin?: number | null;
}

/** Values <= 0 are undefined on a log axis; render them as gaps. Should be a no-op once
 * {@link logFloor} has shifted the curve's own minimum to 1 — kept as a fail-safe. */
function logSafe(values: number[], scale: Scale): (number | null)[] {
  if (scale !== "log") return values;
  return values.map((v) => (v <= 0 ? null : v));
}

/**
 * A curve normalized to its own baseline (or a factory delta/%) fluctuates around 0 and can
 * dip negative — undefined on a log axis. Rather than punching gaps in the line there, shift
 * the whole curve up by a constant so its own minimum reads 1 (a "min-1" baseline): the log
 * scale then shows the curve's full shape/growth, just anchored to "this curve's noise floor"
 * instead of the underlying unit's zero. A no-op when the curve is already positive (e.g. the
 * raw baseline, where RFU readings never go non-positive) or when `scale` isn't `"log"`.
 */
function logFloor(values: number[], adjust: Adjust[], scale: Scale): Adjust[] {
  if (scale !== "log" || values.length === 0) return adjust;
  const plotted = applyAdjust(values, adjust);
  const min = Math.min(...plotted);
  if (min > 0) return adjust;
  const shiftUp = 1 - min;
  return adjust.map((a) => ({ scale: a.scale, shift: a.shift + shiftUp }));
}

/**
 * How a raw value (mean, min, max, or a std offset) maps into plotted space at one cycle:
 * `plotted = raw * scale + shift`. Delta baselines are additive (`scale: 1`, `shift` is the
 * subtracted reference); the percent baseline is multiplicative (`shift: 0`, `scale` rescales
 * to % of factory) — a single {scale, shift} pair covers both without the tooltip/band code
 * needing to know which baseline produced it.
 */
interface Adjust {
  scale: number;
  shift: number;
}
const IDENTITY_ADJUST: Adjust = { scale: 1, shift: 0 };

function applyAdjust(values: number[], adjust: Adjust[]): number[] {
  return values.map((v, i) => v * adjust[i]!.scale + adjust[i]!.shift);
}

/** Fallback baseline region (`threshold.md` §3.1/§8) when auto-detection finds no confident
 * onset — cycles 2–9, clamped to the run's actual cycle count. */
function fallbackRegion(cycles: number[]) {
  return clampBaselineRegion({ beginCycle: 2, endCycle: 9 }, cycles);
}

/**
 * Curves-view baselining (`threshold.md` §2–§4, `packages/core/src/baseline.ts`): find the flat
 * pre-amplification region — either `manualRange` (the rail's baseline-range slider, clamped to
 * the run's actual cycles) or, when unset, auto-detected per curve on a smoothed copy (for
 * robust onset detection — see §2) — and subtract it from the curve's own raw values via the
 * library's `subtractBaseline`. `"raw"` skips this entirely.
 */
function algorithmAdjust(
  cycles: number[],
  values: number[],
  mode: CurveBaselineMode,
  manualRange: CurveBaselineRange,
): Adjust[] {
  if (mode === "raw" || values.length === 0) return values.map(() => IDENTITY_ADJUST);

  const region = manualRange
    ? clampBaselineRegion({ beginCycle: manualRange[0], endCycle: manualRange[1] }, cycles)
    : (autoBaselineRegion(cycles, smoothCurve(values)) ?? fallbackRegion(cycles));
  const libMode: CoreBaselineMode = mode === "constant" ? "RawBaseLineSubtracted" : "LinearBaseLineNormalized";
  const corrected = subtractBaseline(cycles, values, region, libMode);
  return values.map((v, i) => ({ scale: 1, shift: (corrected[i] ?? v) - v }));
}

/**
 * Per-cycle adjust for a well curve. ΔRFU plots drift from the matching factory value
 * (`shift = -factory`); "Drift %" plots `(live/factory - 1) * 100` — the same % deviation from
 * factory `RefCalPanel`'s "Drift %" stat shows, just per cycle instead of run-averaged, so the
 * origin is 0 (unchanged from factory), not 100. Both are Reference-view-only concepts — see
 * `ReferenceView` — and only apply when a factory value exists; everywhere else (including a
 * Reference-view channel with no factory match) baselining is `curveBaselineMode`'s library
 * algorithm, which for `"raw"` is the identity.
 */
function wellAdjust(
  cycles: number[],
  values: number[],
  factory: number[] | undefined,
  baseline: Baseline,
  curveBaselineMode: CurveBaselineMode,
  curveBaselineRange: CurveBaselineRange,
): Adjust[] {
  if (baseline === "delta" && factory) {
    return values.map((_, i) => ({ scale: 1, shift: -(factory[i] ?? 0) }));
  }
  if (baseline === "percent" && factory) {
    return values.map((_, i) => {
      const f = factory[i] ?? 0;
      return { scale: f !== 0 ? 100 / f : 1, shift: f !== 0 ? -100 : 0 };
    });
  }
  return algorithmAdjust(cycles, values, curveBaselineMode, curveBaselineRange);
}

/** A factory-calibration reference value, overlaid as a dotted flat line per (channel, col) —
 * see the Reference view. Purely a display overlay, like {@link DarkCurve}. */
export interface FactoryCurve {
  channel: number;
  col: number;
  /** Constant factory mean, repeated once per cycle so it aligns with the x axis. */
  mean: number[];
}

/** A target/fluor chip or well-grid cell to highlight — dims every other series to match the
 * cursor-proximity dimming `focus.alpha` already does for a single hovered curve, but driven by
 * hovering the rail's legend/well-grid instead of the plot itself. */
export type HighlightMatch =
  | { kind: "target"; dyeLabel: string }
  | { kind: "well"; label: string }
  | { kind: "channel"; channel: number }
  | { kind: "sample"; sample: string };

/** Per-series metadata, index-aligned with uPlot series (offset by the x row). */
export interface SeriesMeta {
  kind: "well" | "dark" | "factory" | "temp";
  /** Optical channel for well/dark series; -1 for temperature series. */
  channel: number;
  /** Reference/plate column, for a factory-overlay series; -1 for every other kind. */
  col: number;
  label: string;
  dyeLabel: string;
  isReference: boolean;
  cycles: number[];
  mean: number[];
  std: number[];
  min: number[];
  max: number[];
  /** Per-cycle raw→plotted mapping this series was drawn with; lets the tooltip/band code
   * reposition min/max/std into plotted space without recomputing which baseline applied. */
  adjust: Adjust[];
  /** See {@link PlotCurve.cq}. */
  cq?: number | null;
  /** See {@link PlotCurve.baselineRfu}. */
  baselineRfu?: number | null;
  /** See {@link PlotCurve.sample}. */
  sample?: string;
}

/** Min/max envelope for a single isolated well (drawn as a shaded band). */
interface BandData {
  color: string;
  cycles: number[];
  min: (number | null)[];
  max: (number | null)[];
}

export interface TooltipData {
  kind: "well" | "dark" | "factory" | "temp";
  label: string;
  /** Optical channel for well/dark series; -1 for temperature series. */
  channel: number;
  /** Reference/plate column, for a factory-overlay series; -1 for every other kind. */
  col: number;
  dye: string;
  color: string;
  cycle: number;
  mean: number;
  min: number;
  max: number;
  std: number;
  left: number;
  top: number;
  /** See {@link PlotCurve.cq}. */
  cq?: number | null;
  /** See {@link PlotCurve.baselineRfu}. */
  baselineRfu?: number | null;
}

export interface BuildChartConfig {
  wellCurves: PlotCurve[];
  /** Dark (LED-off) background series to overlay as dotted lines; empty draws none. Purely a
   * display overlay — never subtracted from `wellCurves`. */
  darkCurves: DarkCurve[];
  /** Factory-calibration reference values to overlay as dotted flat lines, matched to
   * `wellCurves` by (channel, col); empty draws none. See the Reference view. */
  factoryCurves: FactoryCurve[];
  /** Temperature series to plot on the right-hand °C axis (empty to hide the axis). */
  tempCurves: TemperatureCurve[];
  baseline: Baseline;
  /** Curves-view baseline algorithm; `ReferenceView` always passes `"raw"` (its baselining is
   * entirely the factory-relative `baseline` above). */
  curveBaselineMode: CurveBaselineMode;
  /** Manual baseline-region override (the rail's slider), or `null` to auto-detect per curve.
   * `ReferenceView` always passes `null`. */
  curveBaselineRange: CurveBaselineRange;
  scale: Scale;
  bands: BandsMode;
  width: number;
  height: number;
  onHover: (t: TooltipData | null) => void;
}

const REF_DASH = [3, 3];
const DARK_DOT = [1, 3];
const FACTORY_DOT = [1, 3];
const TEMP_DASH = [5, 4];
const SETPOINT_DASH = [2, 4];
/** uPlot scale key for the right-hand temperature axis. */
const TEMP_SCALE = "temp";

export function buildChart(cfg: BuildChartConfig): {
  data: uPlot.AlignedData;
  options: uPlot.Options;
  meta: SeriesMeta[];
} {
  const { wellCurves, darkCurves, factoryCurves, tempCurves, baseline, curveBaselineMode, curveBaselineRange, scale } =
    cfg;
  const cycles =
    wellCurves[0]?.cycles ?? darkCurves[0]?.cycles ?? tempCurves[0]?.cycles ?? [];

  const darkByChannel = new Map<number, DarkCurve>();
  for (const d of darkCurves) darkByChannel.set(d.channel, d);

  const factoryByKey = new Map<string, FactoryCurve>();
  for (const f of factoryCurves) factoryByKey.set(`${f.channel},${f.col}`, f);

  // Dark curves have no factory match, so the factory-relative baseline modes never apply to
  // them — only the curves-view algorithm mode does.
  const nonWellAdjust = (values: number[]): Adjust[] =>
    algorithmAdjust(cycles, values, curveBaselineMode, curveBaselineRange);

  const rows: (number | null)[][] = [cycles.map((c) => c)];
  const meta: SeriesMeta[] = [];
  const series: uPlot.Series[] = [{ label: "Cycle" }];
  // Kept alongside `meta` so computeBand (below) can reuse the exact same per-cycle mapping
  // each well curve's line was plotted with, rather than re-deriving it.
  const wellAdjusts: Adjust[][] = [];

  for (const curve of wellCurves) {
    const factory = factoryByKey.get(`${curve.channel},${curve.col}`);
    const adjust = logFloor(
      curve.mean,
      wellAdjust(
        curve.cycles,
        curve.mean,
        factory?.mean,
        baseline,
        curveBaselineMode,
        curveBaselineRange,
      ),
      scale,
    );
    wellAdjusts.push(adjust);
    rows.push(logSafe(applyAdjust(curve.mean, adjust), scale));
    meta.push({
      kind: "well",
      channel: curve.channel,
      col: curve.col,
      label: curve.wellLabel,
      dyeLabel: curve.dyeLabel,
      isReference: curve.isReference,
      cycles: curve.cycles,
      mean: curve.mean,
      std: curve.std,
      min: curve.min,
      max: curve.max,
      adjust,
      cq: curve.cq,
      baselineRfu: curve.baselineRfu,
      sample: curve.sample,
    });
    const color = channelColor(curve.channel);
    series.push({
      label: `${curve.wellLabel} · ${curve.dyeLabel}`,
      stroke:
        curve.baselineRegionBegin != null
          ? baselineDimStroke(color, curve.baselineRegionBegin)
          : color,
      width: 1,
      dash: curve.isReference ? REF_DASH : undefined,
      points: { show: false },
    });
  }

  // Cq markers: one per well curve with a defined Cq, positioned by linearly interpolating the
  // curve's already-plotted (baseline-adjusted, log-safe) values at the fractional Cq cycle —
  // the same values the line itself is drawn from.
  const cqMarkers: { x: number; y: number; color: string; seriesIdx: number }[] = [];
  wellCurves.forEach((curve, i) => {
    if (curve.cq == null) return;
    const plottedRow = rows[i + 1] as (number | null)[];
    const cycles = curve.cycles;
    let lo = -1;
    for (let j = 0; j < cycles.length - 1; j++) {
      if (curve.cq! >= cycles[j]! && curve.cq! <= cycles[j + 1]!) {
        lo = j;
        break;
      }
    }
    if (lo < 0) return;
    const y0 = plottedRow[lo];
    const y1 = plottedRow[lo + 1];
    if (y0 == null || y1 == null) return;
    const span = cycles[lo + 1]! - cycles[lo]!;
    const frac = span !== 0 ? (curve.cq! - cycles[lo]!) / span : 0;
    cqMarkers.push({
      x: curve.cq!,
      y: y0 + frac * (y1 - y0),
      color: channelColor(curve.channel),
      seriesIdx: i + 1,
    });
  });

  const presentChannels = new Set(wellCurves.map((c) => c.channel));
  for (const channel of presentChannels) {
    const dark = darkByChannel.get(channel);
    if (!dark) continue;
    const adjust = logFloor(dark.mean, nonWellAdjust(dark.mean), scale);
    rows.push(logSafe(applyAdjust(dark.mean, adjust), scale));
    meta.push({
      kind: "dark",
      channel,
      col: -1,
      label: "dark",
      dyeLabel: channelLabel(channel),
      isReference: false,
      cycles: dark.cycles,
      mean: dark.mean,
      std: dark.std,
      min: dark.min,
      max: dark.max,
      adjust,
    });
    series.push({
      label: `dark · ${channelLabel(channel)}`,
      stroke: channelColor(channel),
      width: 2,
      dash: DARK_DOT,
      points: { show: false },
    });
  }

  // The factory line is redundant once a well curve is already plotted relative to it: ΔRFU
  // would show it as a flat 0, and "%" as a flat 100 — both constant and uninformative — so
  // it's only drawn against the raw baseline, where it's the only way to see the factory
  // reference at all.
  if (baseline === "raw") {
    const presentPairs = new Set(wellCurves.map((c) => `${c.channel},${c.col}`));
    for (const key of presentPairs) {
      const factory = factoryByKey.get(key);
      if (!factory) continue;
      const adjust = logFloor(
        factory.mean,
        wellAdjust(cycles, factory.mean, factory.mean, baseline, curveBaselineMode, curveBaselineRange),
        scale,
      );
      rows.push(logSafe(applyAdjust(factory.mean, adjust), scale));
      meta.push({
        kind: "factory",
        channel: factory.channel,
        col: factory.col,
        label: "factory",
        dyeLabel: channelLabel(factory.channel),
        isReference: false,
        cycles,
        mean: factory.mean,
        std: factory.mean.map(() => 0),
        min: factory.mean,
        max: factory.mean,
        adjust,
      });
      series.push({
        label: `factory · ${channelLabel(factory.channel)} col ${factory.col + 1}`,
        stroke: channelColor(factory.channel),
        width: 2,
        dash: FACTORY_DOT,
        points: { show: false },
      });
    }
  }

  // Temperatures ride the right-hand °C axis so they can share the x axis with the curves
  // without distorting the RFU scale.
  tempCurves.forEach((t, i) => {
    rows.push(t.celsius);
    meta.push({
      kind: "temp",
      channel: -1,
      col: -1,
      label: t.label,
      dyeLabel: "",
      isReference: false,
      cycles: t.cycles,
      mean: t.celsius.map((v) => v ?? NaN),
      std: [],
      min: [],
      max: [],
      adjust: [],
    });
    series.push({
      label: `${t.label} (°C)`,
      scale: TEMP_SCALE,
      stroke: tempColor(i, t.kind),
      width: t.kind === "setpoint" ? 1 : 1.5,
      dash: t.kind === "setpoint" ? SETPOINT_DASH : TEMP_DASH,
      points: { show: false },
    });
  });

  // Min/max envelope bands. Auto shows them only when a single well (one row/col) is
  // selected, regardless of how many channels — so each channel's curve gets its own band.
  const computeBand = (c: PlotCurve, adjust: Adjust[]): BandData => {
    const min: (number | null)[] = [];
    const max: (number | null)[] = [];
    for (let i = 0; i < c.mean.length; i++) {
      const a = adjust[i] ?? IDENTITY_ADJUST;
      const mn = (c.min[i] ?? 0) * a.scale + a.shift;
      const mx = (c.max[i] ?? 0) * a.scale + a.shift;
      min.push(scale === "log" && mn <= 0 ? null : mn);
      max.push(scale === "log" && mx <= 0 ? null : mx);
    }
    return { color: channelColor(c.channel), cycles: c.cycles, min, max };
  };

  const distinctWells = new Set(wellCurves.map((c) => `${c.row},${c.col}`));
  const showBands =
    cfg.bands === "on" || (cfg.bands === "auto" && distinctWells.size === 1);
  const bands: BandData[] = showBands
    ? wellCurves.map((c, i) => computeBand(c, wellAdjusts[i]!))
    : [];

  const options: uPlot.Options = {
    width: cfg.width,
    height: cfg.height,
    series,
    scales: {
      x: { time: false },
      y: { distr: scale === "log" ? 3 : 1 },
      // Padded a little so the temperature traces don't sit flush against the plot edges.
      [TEMP_SCALE]: {
        distr: 1,
        range: (_u, min, max) => {
          const pad = Math.max(0.5, (max - min) * 0.15);
          return [min - pad, max + pad];
        },
      },
    },
    axes: [
      {
        stroke: "#8aa0c0",
        splits: (_u, _i, min, max) => {
          const out: number[] = [];
          for (let v = Math.max(1, Math.ceil(min)); v <= Math.floor(max); v++) out.push(v);
          return out;
        },
        values: (_u, splits) => splits.map((v) => (v % 5 === 0 ? String(v) : "")),
        grid: {
          stroke: "rgba(120,200,255,0.06)",
          width: 1,
          filter: (_u, splits) => splits.map((v) => (v % 5 === 0 ? v : null)),
        },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1, size: 5 },
        label: "Cycle",
        labelSize: 24,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
      },
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        label: yLabel(baseline, curveBaselineMode),
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 62,
      },
      // Right-hand temperature axis — only drawn when temperatures are shown.
      {
        scale: TEMP_SCALE,
        side: 1,
        show: tempCurves.length > 0,
        stroke: "#7f93b5",
        grid: { show: false },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        values: (_u, splits) => splits.map((v) => v.toFixed(1)),
        label: "Temperature (°C)",
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 58,
      },
    ],
    cursor: { focus: { prox: 24 }, points: { size: 6 } },
    focus: { alpha: 0.12 },
    legend: { show: false },
    plugins: [overlayPlugin(meta, bands, cqMarkers, cfg.onHover)],
  };

  return { data: rows as uPlot.AlignedData, options, meta };
}

/**
 * Externally-driven curve highlighting, for hovering a target/fluor chip or a well-grid cell in
 * the rail (as opposed to `focus.alpha` above, which handles hovering the plot itself via
 * uPlot's own single-nearest-series cursor focus). Sets each well series' `alpha` directly and
 * redraws without rebuilding paths, so it's cheap enough to call on every mouse move. `match:
 * null` restores full opacity.
 */
export function applyHighlight(u: uPlot, meta: SeriesMeta[], match: HighlightMatch | null): void {
  meta.forEach((m, i) => {
    const isMatch =
      !match ||
      (m.kind === "well" &&
        ((match.kind === "well" && m.label === match.label) ||
          (match.kind === "target" && m.dyeLabel === match.dyeLabel) ||
          (match.kind === "channel" && m.channel === match.channel) ||
          (match.kind === "sample" && m.sample === match.sample)));
    u.series[i + 1]!.alpha = isMatch ? 1 : 0.12;
  });
  u.redraw(false, false);
}

function yLabel(baseline: Baseline, curveBaselineMode: CurveBaselineMode): string {
  if (baseline === "delta") return "ΔRFU (mean)";
  if (baseline === "percent") return "Drift (%)";
  if (curveBaselineMode === "constant") return "RFU (baseline subtracted)";
  if (curveBaselineMode === "linear") return "RFU (linear baseline)";
  return "RFU (mean)";
}

/**
 * Cursor plugin that (1) reports the nearest series for the text tooltip, (2) draws an
 * on-hover whisker for the nearest series' point — the min–max range with caps and a ±1σ
 * box — and (3) draws a shaded min/max envelope when a single well is isolated. The whisker
 * tracks uPlot's own hover-point markers (shown across the whole hovered column, not gated
 * by vertical distance), while the text tooltip stays proximity-gated. Rendered as an SVG
 * overlay on the plot area, so it shares uPlot's coordinate system and updates on
 * redraw/hover.
 */
function overlayPlugin(
  meta: SeriesMeta[],
  bands: BandData[],
  cqMarkers: { x: number; y: number; color: string; seriesIdx: number }[],
  onHover: (t: TooltipData | null) => void,
): uPlot.Plugin {
  let svg: SVGSVGElement;
  let bandGroup: SVGGElement;
  let cqGroup: SVGGElement;
  let group: SVGGElement;
  let vline: SVGLineElement;
  let capMax: SVGLineElement;
  let capMin: SVGLineElement;
  let stdRect: SVGRectElement;

  const line = (): SVGLineElement => {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("stroke-width", "1.5");
    return l;
  };

  return {
    hooks: {
      init: (u: uPlot) => {
        svg = document.createElementNS(SVG_NS, "svg");
        Object.assign(svg.style, {
          position: "absolute",
          left: "0",
          top: "0",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          overflow: "hidden",
          zIndex: "5",
        });
        bandGroup = document.createElementNS(SVG_NS, "g");
        svg.appendChild(bandGroup);

        cqGroup = document.createElementNS(SVG_NS, "g");
        svg.appendChild(cqGroup);

        group = document.createElementNS(SVG_NS, "g");
        group.style.display = "none";
        stdRect = document.createElementNS(SVG_NS, "rect");
        stdRect.setAttribute("fill-opacity", "0.4");
        stdRect.setAttribute("stroke", "none");
        vline = line();
        capMax = line();
        capMin = line();
        group.append(stdRect, vline, capMax, capMin);
        svg.appendChild(group);
        u.over.appendChild(svg);
      },

      draw: (u: uPlot) => {
        // Sync one <path> child per band, then set each envelope path.
        while (bandGroup.childElementCount > bands.length) {
          bandGroup.lastElementChild!.remove();
        }
        while (bandGroup.childElementCount < bands.length) {
          const p = document.createElementNS(SVG_NS, "path");
          p.setAttribute("fill-opacity", "0.13");
          p.setAttribute("stroke", "none");
          bandGroup.appendChild(p);
        }
        bands.forEach((band, bi) => {
          const path = bandGroup.children[bi] as SVGPathElement;
          path.setAttribute("fill", band.color);
          const top: string[] = [];
          const bot: string[] = [];
          for (let i = 0; i < band.cycles.length; i++) {
            const mx = band.max[i];
            const mn = band.min[i];
            if (mx == null || mn == null) continue;
            const x = u.valToPos(band.cycles[i]!, "x");
            top.push(`${x},${u.valToPos(mx, "y")}`);
            bot.push(`${x},${u.valToPos(mn, "y")}`);
          }
          path.setAttribute(
            "d",
            top.length ? `M${top.join("L")}L${bot.reverse().join("L")}Z` : "",
          );
        });

        // Cq markers: one small ring per curve with a defined Cq, at its (interpolated)
        // position on the plotted line.
        while (cqGroup.childElementCount > cqMarkers.length) {
          cqGroup.lastElementChild!.remove();
        }
        while (cqGroup.childElementCount < cqMarkers.length) {
          const c = document.createElementNS(SVG_NS, "circle");
          c.setAttribute("r", "4.5");
          c.setAttribute("fill", "none");
          c.setAttribute("stroke-width", "1.75");
          cqGroup.appendChild(c);
        }
        cqMarkers.forEach((m, i) => {
          const c = cqGroup.children[i] as SVGCircleElement;
          c.setAttribute("cx", String(u.valToPos(m.x, "x")));
          c.setAttribute("cy", String(u.valToPos(m.y, "y")));
          c.setAttribute("stroke", m.color);
          c.setAttribute("stroke-opacity", String(u.series[m.seriesIdx]!.alpha ?? 1));
        });
      },

      setCursor: (u: uPlot) => {
        const idx = u.cursor.idx;
        const { left, top } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) {
          onHover(null);
          group.style.display = "none";
          return;
        }
        let best = -1;
        let bestDist = Infinity;
        for (let s = 1; s < u.series.length; s++) {
          const val = (u.data[s] as (number | null)[])[idx];
          if (val == null || Number.isNaN(val)) continue;
          // Temperature series live on the right-hand scale, so project through the
          // series' own scale rather than assuming "y".
          const py = u.valToPos(val, u.series[s]!.scale ?? "y");
          const dist = Math.abs(py - top);
          if (dist < bestDist) {
            bestDist = dist;
            best = s;
          }
        }
        const m = best > 0 ? meta[best - 1] : undefined;
        if (!m) {
          onHover(null);
          group.style.display = "none";
          return;
        }
        // The whisker tracks uPlot's own hover-point markers, which are drawn per series
        // for the whole hovered column regardless of vertical distance from the cursor.
        // The text hovercard stays proximity-gated so it doesn't follow the mouse across
        // the whole chart height.
        const near = bestDist <= 24;

        const plotted = (u.data[best] as (number | null)[])[idx] as number;

        if (m.kind === "temp") {
          // A temperature is a single scalar per read — no min/max/σ to whisker.
          group.style.display = "none";
          onHover(
            near
              ? {
                  kind: "temp",
                  label: m.label,
                  channel: -1,
                  col: -1,
                  dye: "",
                  color: (u.series[best]!.stroke as string) ?? "#8aa0c0",
                  cycle: m.cycles[idx] ?? 0,
                  mean: plotted,
                  min: plotted,
                  max: plotted,
                  std: 0,
                  left,
                  top,
                }
              : null,
          );
          return;
        }

        const a = m.adjust[idx] ?? IDENTITY_ADJUST;
        const x = u.valToPos(m.cycles[idx] ?? 0, "x");
        const yMax = u.valToPos((m.max[idx] ?? 0) * a.scale + a.shift, "y");
        const yMin = u.valToPos((m.min[idx] ?? 0) * a.scale + a.shift, "y");
        const stdOff = (m.std[idx] ?? 0) * a.scale;
        const yHi = u.valToPos(plotted + stdOff, "y");
        const yLo = u.valToPos(plotted - stdOff, "y");
        const color = channelColor(m.channel);

        if ([x, yMax, yMin, yHi, yLo].every(Number.isFinite)) {
          const set = (el: SVGElement, attrs: Record<string, number | string>) => {
            for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
          };
          set(vline, { x1: x, x2: x, y1: yMax, y2: yMin, stroke: color });
          set(capMax, { x1: x - 5, x2: x + 5, y1: yMax, y2: yMax, stroke: color });
          set(capMin, { x1: x - 5, x2: x + 5, y1: yMin, y2: yMin, stroke: color });
          set(stdRect, {
            x: x - 4,
            width: 8,
            y: Math.min(yHi, yLo),
            height: Math.abs(yLo - yHi),
            fill: color,
          });
          group.style.display = "";
        } else {
          group.style.display = "none";
        }

        onHover(
          near
            ? {
                kind: m.kind,
                label: m.label,
                channel: m.channel,
                col: m.col,
                dye: m.dyeLabel,
                color,
                cycle: m.cycles[idx] ?? 0,
                mean: m.mean[idx] ?? 0,
                min: m.min[idx] ?? 0,
                max: m.max[idx] ?? 0,
                std: m.std[idx] ?? 0,
                left,
                top,
                cq: m.cq,
                baselineRfu: m.baselineRfu,
              }
            : null,
        );
      },
    },
  };
}
