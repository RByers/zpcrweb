/**
 * The Curves/Reference chart: uPlot options, series and the SVG overlay drawn on top of them.
 *
 * **This module is a renderer, not an analysis.** It never calls into `baseline.ts`/`threshold.ts`
 * and never derives a baseline, threshold, noise estimate or Cq of its own. Every one of those
 * arrives already computed, on {@link PlotCurve.analysis}, from the run's single analysis
 * (`runAnalysis.ts`). Anything the chart draws that relates to a curve's baseline is a pure
 * function of that record — which is what makes it *impossible* for the plotted curve, the Cq
 * marker and the threshold line to disagree. They used to: this file ran a second, subtly
 * different copy of the baseline selection, so the curve on screen had been baselined over a
 * different cycle range than the Cq had.
 *
 * If something here needs a number the analysis doesn't carry, add it to `CurveAnalysis` and
 * compute it in the library — do not compute it here.
 */

import uPlot from "uplot";
import type { DarkCurve } from "@zpcrweb/core";
import { channelColor, channelLabel } from "../channelColors";
import { formatBaselineFormula } from "../cq";
import type { CurveAnalysis } from "../runAnalysis";
import type { Baseline, CurveView, Scale } from "../../state/useZpcrStore";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Opacity of the "draw baseline" overlay line, relative to its curve's own color. */
const BASELINE_LINE_ALPHA = 0.5;

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * One plotted curve, already resolved to a display label by the caller — either a plain channel
 * ("C1", channel-space) or a fluorophore name (dye-space, after color separation). Chart code
 * never guesses a dye from a channel index; see `channelColors.ts`.
 */
export interface PlotCurve {
  /** Optical channel — used only for color. Undefined for a dye-space curve whose plate doesn't
   * know the channel, which draws in the neutral color (see `channelColor`). Channel-space
   * curves always have one: they *are* a channel's readings. */
  channel?: number;
  dyeLabel: string;
  /** The raw fluorophore name, when this is a dye-space curve. Distinct from {@link dyeLabel},
   * which is the *display* grouping and carries the target name when the view groups by target.
   * Thresholds are resolved per fluorophore (see `RunAnalysis.thresholdGroupOf`), so the
   * Threshold rail's hover highlight has to match on this rather than on the label. */
  fluor?: string;
  row: number;
  col: number;
  wellLabel: string;
  isReference: boolean;
  cycles: number[];
  mean: number[];
  /**
   * Std/min/max spread across the well's readings within each scan — **channel space only**, and
   * omitted (not zero-filled) everywhere else. A color-separated curve has no spread of its own:
   * calibration.md §5 solves a single concentration per channel vector, not a distribution. These
   * used to be filled with `mean`/`mean`/`0` so the envelope "collapsed to nothing rather than
   * lying", but a collapsed envelope still draws — a zero-height whisker and three tooltip rows
   * restating the mean — which reads as a real measurement of zero spread. Absent means absent:
   * no band, no whisker, no tooltip rows. All three travel together.
   */
  std?: number[];
  min?: number[];
  max?: number[];
  /**
   * This curve's analysis record, looked up from the run's single analysis
   * (`runAnalysis.ts` — {@link CurveAnalysis}). Everything baseline-, threshold- or Cq-related the
   * chart draws is read from here: the "Relative" view plots `correctedValues`, "Draw baseline"
   * draws `baselineFit`, the Cq ring sits on `correctedValues` at `cq`, and the rail's
   * threshold-hover diagnostic marks `baselineRegion`/`noise`.
   *
   * **This module computes none of it** — see the note at the top of the file. Absent for a series
   * the run analyses no further (right-axis series), and for any curve whose record is still
   * loading.
   */
  analysis?: CurveAnalysis;
  /** Sample name (`pltd.md`'s `conditionName`, `WellDefinition.sample`) for this curve's well,
   * when the plate assigns one — drives the rail's "sample" highlight/hover-card lookup. */
  sample?: string;
}

/** Values <= 0 are undefined on a log axis; render them as gaps. Should be a no-op once
 * {@link applyLogFloor} has lifted the plot's minimum to 1 — kept as a fail-safe. */
function logSafe(values: number[], scale: Scale): (number | null)[] {
  if (scale !== "log") return values;
  return values.map((v) => (v <= 0 ? null : v));
}

/**
 * A curve normalized to its own baseline (or a factory delta/%) fluctuates around 0 and can dip
 * negative — undefined on a log axis. Rather than punching gaps in the line there, every RFU
 * series is shifted up by **one shared constant**, so that the lowest point anywhere on the plot
 * reads 1: the log scale then shows each curve's full shape and growth, anchored to "the plot's
 * noise floor" instead of the underlying unit's zero.
 *
 * Shared, not per curve. Lifting each curve by its *own* minimum used to look tidier, but it gave
 * every curve a different y offset — so two curves at the same RFU were drawn at different
 * heights, the axis labels were true of no curve in particular, and one threshold could not be
 * drawn as one line (it sat at a different pixel row for each curve, which is how the rail's
 * dotted line came to miss the Cq rings on a log scale). One shift keeps the axis meaning the same
 * thing everywhere on the plot, at the cost of lifting the quieter curves a little further than
 * they need.
 *
 * Mutates the adjusts in place, since the band and tooltip code holds the same arrays; a no-op
 * when nothing on the plot is non-positive, or when `scale` isn't `"log"`. Right-axis series ride
 * their own axis and are left alone.
 */
function applyLogFloor(rows: (number | null)[][], meta: SeriesMeta[], scale: Scale): void {
  if (scale !== "log") return;
  let min = Infinity;
  meta.forEach((m, i) => {
    if (m.kind === "aux") return;
    for (const v of rows[i + 1]!) if (v != null && v < min) min = v;
  });
  if (!Number.isFinite(min) || min > 0) return;
  const shiftUp = 1 - min;
  // The "draw baseline" overlay deliberately shares its parent curve's `adjust` array, so shift
  // each array once rather than once per series that points at it.
  const shifted = new Set<Adjust[]>();
  meta.forEach((m, i) => {
    if (m.kind === "aux") return;
    if (!shifted.has(m.adjust)) {
      shifted.add(m.adjust);
      for (const a of m.adjust) a.shift += shiftUp;
    }
    const row = rows[i + 1]!;
    for (let j = 0; j < row.length; j++) if (row[j] != null) row[j]! += shiftUp;
  });
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

/** See {@link SeriesMeta.plotDelta} — the plotted line minus the analysis' corrected values. */
function plotDelta(
  values: number[],
  adjust: Adjust[],
  analysis: CurveAnalysis | undefined,
): number[] | undefined {
  if (!analysis) return undefined;
  return values.map((v, i) => {
    const a = adjust[i] ?? IDENTITY_ADJUST;
    return v * a.scale + a.shift - (analysis.correctedValues[i] ?? v);
  });
}

/** Linear interpolation of a per-cycle series at a fractional cycle — used to evaluate
 * {@link SeriesMeta.plotDelta} at a Cq, which lands between two reads. Exact for the quantities
 * it's applied to: `plotDelta` is either constant or the fitted baseline, both linear in cycle. */
function interpolateAt(cycles: number[], values: number[], cycle: number): number | null {
  for (let i = 0; i < cycles.length - 1; i++) {
    const c0 = cycles[i]!;
    const c1 = cycles[i + 1]!;
    if (cycle < c0 || cycle > c1) continue;
    const v0 = values[i];
    const v1 = values[i + 1];
    if (v0 == null || v1 == null) return null;
    const span = c1 - c0;
    return span === 0 ? v0 : v0 + ((cycle - c0) / span) * (v1 - v0);
  }
  return null;
}

/**
 * Curves-view baselining: `"relative"` plots the curve's already-corrected values from its
 * analysis record — the very same array the Cq was computed on — expressed as the per-cycle shift
 * that turns the raw curve into it. `"absolute"` plots the curve unmodified, as does any series
 * with no analysis record to draw on.
 *
 * That the shift is *derived* from `correctedValues` rather than re-fitted is the whole mechanism:
 * there is one baseline per curve in the app, and this is a projection of it.
 */
function algorithmAdjust(
  values: number[],
  analysis: CurveAnalysis | undefined,
  view: CurveView,
): Adjust[] {
  // Fresh objects per cycle, never a shared constant: `applyLogFloor` shifts adjusts in place.
  if (view === "absolute" || !analysis) return values.map(() => ({ scale: 1, shift: 0 }));
  const corrected = analysis.correctedValues;
  return values.map((v, i) => ({ scale: 1, shift: (corrected[i] ?? v) - v }));
}

/**
 * Per-cycle adjust for a well curve. ΔRFU plots drift from the matching factory value
 * (`shift = -factory`); "Drift %" plots `(live/factory - 1) * 100` — the same % deviation from
 * factory `RefCalPanel`'s "Drift %" stat shows, just per cycle instead of run-averaged, so the
 * origin is 0 (unchanged from factory), not 100. Both are Reference-view-only concepts — see
 * `ReferenceView` — and only apply when a factory value exists; everywhere else (including a
 * Reference-view channel with no factory match) baselining is `curveView`'s library algorithm,
 * which for `"absolute"` is the identity.
 */
function wellAdjust(
  values: number[],
  analysis: CurveAnalysis | undefined,
  factory: number[] | undefined,
  baseline: Baseline,
  curveView: CurveView,
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
  return algorithmAdjust(values, analysis, curveView);
}

/** A dark (LED-off) overlay series, carrying the same kind of analysis record a well curve does so
 * the "Relative" view can baseline it the same way — it quantifies nothing, so the record is the
 * baseline-only kind (`RunAnalysis.plainBaselines`). */
export type PlotDarkCurve = DarkCurve & { analysis?: CurveAnalysis };

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
  | { kind: "fluor"; fluor: string }
  /** One curve: a single well/fluorophore pair, the finest grain the chart can isolate. */
  | { kind: "curve"; label: string; fluor: string }
  | { kind: "well"; label: string }
  | { kind: "channel"; channel: number }
  | { kind: "sample"; sample: string }
  /** One plate column — the Reference view's R1–R12 chips, which select columns rather than
   * wells (every reference curve sits in the same row). */
  | { kind: "refcol"; col: number };

/** Per-series metadata, index-aligned with uPlot series (offset by the x row). */
export interface SeriesMeta {
  /** `"baseline"` is the "draw baseline" overlay line — a pure display series, excluded from
   * cursor hit-testing (see `setCursor` below) since it carries no meaningful tooltip of its
   * own. */
  kind: "well" | "dark" | "factory" | "aux" | "baseline";
  /** Optical channel for well/dark series; -1 for a right-axis series. Undefined for a
   * dye-space series whose channel isn't known (see {@link PlotCurve.channel}). */
  channel?: number;
  /** Reference/plate column, for a factory-overlay series; -1 for every other kind. */
  col: number;
  label: string;
  dyeLabel: string;
  /** See {@link PlotCurve.fluor}. */
  fluor?: string;
  isReference: boolean;
  cycles: number[];
  mean: number[];
  /** See {@link PlotCurve.std} — absent for every series that has no real spread (dye-space
   * curves, the baseline overlay, the factory reference, right-axis series). */
  std?: number[];
  min?: number[];
  max?: number[];
  /** Per-cycle raw→plotted mapping this series was drawn with; lets the tooltip/band code
   * reposition min/max/std into plotted space without recomputing which baseline applied. */
  adjust: Adjust[];
  /** See {@link PlotCurve.analysis}. */
  analysis?: CurveAnalysis;
  /**
   * Per cycle, how far the *plotted* line sits above this series' baseline-corrected values —
   * `plotted[i] − correctedValues[i]`, the offset between the space thresholds and Cq live in and
   * the space the curve is actually drawn in. Zero in the "Relative" view on a linear scale;
   * a constant there under a log scale ({@link logFloor}'s per-curve shift); the fitted baseline
   * itself in the "Absolute" view.
   *
   * It exists so the threshold line can be placed *by construction* rather than by re-deriving
   * where the curve crosses: a threshold `T` is at `T + plotDelta` on screen, and that is where
   * the line is drawn. The Cq ring uses it too, to project its `correctedValues`-space y onto the
   * same screen space. Absent for a series with no analysis record.
   */
  plotDelta?: number[];
  /** See {@link PlotCurve.sample}. */
  sample?: string;
  /** For `kind: "baseline"` only: index into `meta`/`u.series` (well series, not row/col index —
   * see `applyHighlight`) of the well curve this baseline overlays. Lets highlight state be
   * copied from the parent rather than re-derived, so a baseline can never show/hide out of step
   * with its own curve. */
  parentIndex?: number;
}

/** Min/max envelope for one plotted curve — a well's lit wells, or a dark overlay's LED-off
 * ones (drawn as a shaded band). */
interface BandData {
  color: string;
  cycles: number[];
  min: (number | null)[];
  max: (number | null)[];
}

/**
 * One series on the chart's right-hand axis — instrument context (temperatures, LED currents)
 * rather than plate data. Format-agnostic on purpose: the chart draws whatever
 * `rightAxis.ts` maps onto this shape and knows nothing about what it means.
 */
export interface AuxCurve {
  /** Stable identity of the underlying field, e.g. `BLOCKTEMP` / `LEDCURRENT01`. */
  key: string;
  /** Short display name, e.g. `Block` / `Ch1`. */
  label: string;
  color: string;
  /** A configured set point rather than a reading — drawn with a finer dash. */
  setpoint?: boolean;
  cycles: number[];
  /** One value per cycle, aligned with {@link cycles}; `null` where the read lacked the field. */
  values: (number | null)[];
}

/**
 * The chart's whole right-hand axis: the series on it plus how to label and format it. One axis,
 * one unit — temperatures and LED currents can't occupy it at once (see `rightAxis.ts`). No
 * curves hides the axis entirely.
 */
export interface AuxAxis {
  /** Axis label, e.g. `Temperature (°C)`. */
  label: string;
  /** Unit shown in each series' name and in the tooltip, e.g. `°C` / `DAC`. */
  unit: string;
  /** Tooltip row label for a value on this axis, e.g. `temp` / `LED`. */
  rowLabel: string;
  /** Decimal places for the axis ticks and the rail's value preview. */
  decimals: number;
  /** Decimal places for a value in the hovercard, where the extra precision is the point. */
  tipDecimals: number;
  curves: AuxCurve[];
}

export interface TooltipData {
  kind: "well" | "dark" | "factory" | "aux";
  label: string;
  /** Optical channel for well/dark series; -1 for a right-axis series. Undefined for a
   * dye-space series whose channel isn't known (see {@link PlotCurve.channel}). */
  channel?: number;
  /** Reference/plate column, for a factory-overlay series; -1 for every other kind. */
  col: number;
  dye: string;
  color: string;
  cycle: number;
  /** How to name the x value in the tooltip — "cycle" normally, or the {@link
   * BuildChartConfig.xAxis} label's own term (e.g. "column") when the axis isn't time. */
  xName: string;
  /** The x value already rendered for display (e.g. `"R4"`), when `xAxis.tickLabel` supplies
   * one; otherwise the tooltip prints {@link cycle} as-is. */
  xText?: string;
  mean: number;
  /** See {@link PlotCurve.std}; all three absent together when this series has no real spread,
   * and the tooltip then omits the rows entirely. */
  min?: number;
  max?: number;
  std?: number;
  left: number;
  top: number;
  /** `CurveAnalysis.cq` for the hovered curve (`threshold.md` §6) — absent where the run computes
   * none (channel space, the dark/factory overlays). */
  cq?: number | null;
  /** For `kind: "aux"` only: how to present the value — {@link AuxAxis.rowLabel},
   * {@link AuxAxis.unit} and {@link AuxAxis.decimals} of the axis it was read off. */
  rowLabel?: string;
  unit?: string;
  decimals?: number;
  /** The linear baseline this curve was actually corrected with (`CurveAnalysis.baselineFit`),
   * rendered as a formula (e.g. "2000 + 4c"), so a surprising Cq can be traced back to it. */
  baselineFormula?: string | null;
}

export interface BuildChartConfig {
  wellCurves: PlotCurve[];
  /** Dark (LED-off) background series to overlay as dotted lines; empty draws none. Purely a
   * display overlay — never subtracted from `wellCurves`. */
  darkCurves: PlotDarkCurve[];
  /** Factory-calibration reference values to overlay as dotted flat lines, matched to
   * `wellCurves` by (channel, col); empty draws none. See the Reference view. */
  factoryCurves: FactoryCurve[];
  /**
   * Whether to *draw* the factory lines (default true). Separate from `factoryCurves` being
   * empty, because these values do double duty: they are also the reference the ΔRFU and
   * Drift % baselines are computed against (`wellAdjust`). Clearing the array to hide the lines
   * would silently break those two modes, so the Reference view's "Show factory" toggle gates
   * the drawing and leaves the data in place.
   */
  drawFactory?: boolean;
  /**
   * Overrides the x axis' presentation. Omitted, it's the cycle axis every view uses: labelled
   * "Cycle", ticked every 5. The Reference view's column mode supplies its own, where x is a
   * plate column rather than a cycle and every one of the ≤12 positions needs its own `R{n}`
   * tick — nothing else about `buildChart` changes, since a series is just (x[], y[]) and
   * column mode only alters what x *means*.
   */
  xAxis?: {
    label: string;
    /** Renders one tick value; when given, every split is labelled rather than every fifth. */
    tickLabel?: (v: number) => string;
    /** The exact tick positions, when the axis is categorical rather than continuous. */
    splits?: number[];
  };
  /** What rides the right-hand axis — temperatures or LED currents, never both (see
   * `rightAxis.ts`); an axis with no curves hides itself. */
  aux: AuxAxis;
  baseline: Baseline;
  /** Curves-view display mode; `ReferenceView` always passes `"absolute"` (its baselining is
   * entirely the factory-relative `baseline` above). */
  curveView: CurveView;
  /** Overlay each well curve's auto-detected linear baseline, at 50% opacity of its own color.
   * `ReferenceView` always passes `false`. */
  drawBaseline: boolean;
  scale: Scale;
  /** Draw each well curve's min/max envelope band. `ReferenceView` always passes `false`. */
  bands: boolean;
  width: number;
  height: number;
  onHover: (t: TooltipData | null) => void;
}

const REF_DASH = [3, 3];
/** Dark and factory are both flat, same-colored overlays on the same chart (the Reference view
 * can show both at once), so they must not share a pattern — they were both `[1, 3]` until the
 * Reference view gained its dark overlay and made them indistinguishable. Dark is the dash-dot;
 * the factory line keeps the fine dot it has always had on this view. */
const DARK_DOT = [5, 3, 1, 3];
const FACTORY_DOT = [1, 3];
const AUX_DASH = [5, 4];
/** Set points are configured thresholds, not readings — a finer dash than a measured series. */
const SETPOINT_DASH = [2, 4];
/** uPlot scale key for the right-hand auxiliary axis (temperatures or LED currents). */
const AUX_SCALE = "aux";

/** Mutable holder for the rail-driven threshold-hover line (see {@link setThresholdLine}) — a
 * plain object rather than a plugin option so its value can be updated on every hover without
 * tearing down and rebuilding the whole uPlot instance. */
export interface ThresholdLineState {
  /** Baseline-subtracted RFU value to draw a dotted horizontal line at; `null` draws none.
   * Only meaningful when the chart is plotting `curveView: "relative"` — the space the
   * threshold/noise/Cq math (`threshold.md` §5–§6) actually operates in. */
  value: number | null;
  /** Whether to also mark each highlighted curve's own baseline region and label its noise.
   * Independent of {@link value}: hovering a whole fluorophore draws just its threshold line
   * (a dozen σ labels at once was unreadable), while hovering one curve — where the region is
   * the point — draws both. */
  regions: boolean;
}

/** Update the threshold-hover line/region overlay and redraw without rebuilding series/paths —
 * the same cheap-redraw pattern {@link applyHighlight} uses. */
export function setThresholdLine(
  u: uPlot,
  state: ThresholdLineState,
  value: number | null,
  regions = false,
): void {
  state.value = value;
  state.regions = regions;
  u.redraw(false, false);
}

export function buildChart(cfg: BuildChartConfig): {
  data: uPlot.AlignedData;
  options: uPlot.Options;
  meta: SeriesMeta[];
  thresholdLineState: ThresholdLineState;
} {
  const { wellCurves, darkCurves, factoryCurves, aux, baseline, curveView, scale } = cfg;
  const xTick = cfg.xAxis?.tickLabel;
  /** What the tooltip calls the x value. Derived from the axis label so the two always agree
   * ("Reference column" → "column"); "cycle" when the axis is the default time series. */
  const xName = cfg.xAxis ? cfg.xAxis.label.split(" ").pop()!.toLowerCase() : "cycle";
  const auxCurves = aux.curves;
  const cycles =
    wellCurves[0]?.cycles ?? darkCurves[0]?.cycles ?? auxCurves[0]?.cycles ?? [];

  const darkByChannel = new Map<number, PlotDarkCurve>();
  for (const d of darkCurves) darkByChannel.set(d.channel, d);

  const factoryByKey = new Map<string, FactoryCurve>();
  for (const f of factoryCurves) factoryByKey.set(`${f.channel},${f.col}`, f);

  // Dark curves have no factory match, so the factory-relative baseline modes never apply to
  // them — only the curves-view algorithm mode does.
  const nonWellAdjust = (values: number[], analysis?: CurveAnalysis): Adjust[] =>
    algorithmAdjust(values, analysis, curveView);

  const rows: (number | null)[][] = [cycles.map((c) => c)];
  const meta: SeriesMeta[] = [];
  const series: uPlot.Series[] = [{ label: "Cycle" }];
  // Kept alongside `meta` so computeBand (below) can reuse the exact same per-cycle mapping
  // each well curve's line was plotted with, rather than re-deriving it.
  const wellAdjusts: Adjust[][] = [];

  for (const curve of wellCurves) {
    const factory = factoryByKey.get(`${curve.channel},${curve.col}`);
    const adjust = wellAdjust(curve.mean, curve.analysis, factory?.mean, baseline, curveView);
    wellAdjusts.push(adjust);
    rows.push(applyAdjust(curve.mean, adjust));
    meta.push({
      kind: "well",
      channel: curve.channel,
      col: curve.col,
      label: curve.wellLabel,
      dyeLabel: curve.dyeLabel,
      fluor: curve.fluor,
      isReference: curve.isReference,
      cycles: curve.cycles,
      mean: curve.mean,
      std: curve.std,
      min: curve.min,
      max: curve.max,
      adjust,
      analysis: curve.analysis,
      sample: curve.sample,
    });
    series.push({
      label: `${curve.wellLabel} · ${curve.dyeLabel}`,
      stroke: channelColor(curve.channel),
      width: 1,
      dash: curve.isReference ? REF_DASH : undefined,
      points: { show: false },
    });
  }

  // "Draw baseline": overlay each well curve's own auto-detected linear baseline (the same fit
  // `algorithmAdjust` subtracts under "relative") as a separate series at reduced opacity of the
  // curve's own color — plotted through the curve's own adjust, so it reads correctly in either
  // view (the actual trend line under "absolute"; a near-zero reference line under "relative",
  // since subtracting it from itself is ~0). Appended after every well series (not interleaved)
  // so the Cq-marker loop below can keep assuming well curve i lives at row/series index i + 1.
  if (cfg.drawBaseline) {
    wellCurves.forEach((curve, i) => {
      const adjust = wellAdjusts[i]!;
      const fit = curve.analysis?.baselineFit;
      if (!fit) return;
      const baselineRaw = curve.cycles.map((c) => fit.intercept + fit.slope * c);
      rows.push(applyAdjust(baselineRaw, adjust));
      meta.push({
        kind: "baseline",
        channel: curve.channel,
        col: -1,
        label: curve.wellLabel,
        dyeLabel: curve.dyeLabel,
        fluor: curve.fluor,
        isReference: false,
        cycles: curve.cycles,
        mean: baselineRaw,
        adjust,
        parentIndex: i,
      });
      series.push({
        label: `${curve.wellLabel} · ${curve.dyeLabel} baseline`,
        stroke: hexToRgba(channelColor(curve.channel), BASELINE_LINE_ALPHA),
        width: 1,
        points: { show: false },
      });
    });
  }

  // A curve with no known channel contributes no dark overlay — there's no channel to overlay.
  const presentChannels = new Set(
    wellCurves.map((c) => c.channel).filter((ch): ch is number => ch !== undefined),
  );
  // Kept for the same reason as `wellAdjusts`: a dark curve's band has to be mapped with the
  // exact adjust its line was plotted with.
  const darkPlotted: { dark: PlotDarkCurve; adjust: Adjust[] }[] = [];
  for (const channel of presentChannels) {
    const dark = darkByChannel.get(channel);
    if (!dark) continue;
    const adjust = nonWellAdjust(dark.mean, dark.analysis);
    darkPlotted.push({ dark, adjust });
    rows.push(applyAdjust(dark.mean, adjust));
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
  if (baseline === "raw" && cfg.drawFactory !== false) {
    const presentPairs = new Set(wellCurves.map((c) => `${c.channel},${c.col}`));
    for (const key of presentPairs) {
      const factory = factoryByKey.get(key);
      if (!factory) continue;
      // A factory reference is a stored constant, not a measured curve, so it has no baseline of
      // its own to subtract — only the factory-relative modes (which are what this line *is*)
      // apply. The Reference view, the only caller that supplies these, passes `"absolute"`.
      const adjust = wellAdjust(factory.mean, undefined, factory.mean, baseline, curveView);
      rows.push(applyAdjust(factory.mean, adjust));
      meta.push({
        kind: "factory",
        channel: factory.channel,
        col: factory.col,
        label: "factory",
        dyeLabel: channelLabel(factory.channel),
        isReference: false,
        cycles,
        // A factory reference is a single stored value per cycle, not a distribution — no spread.
        mean: factory.mean,
        adjust,
      });
      series.push({
        // `col < 0` means the series spans every column rather than pinning one (the Reference
        // view's column mode), so there is no column to name.
        label:
          factory.col >= 0
            ? `factory · ${channelLabel(factory.channel)} col ${factory.col + 1}`
            : `factory · ${channelLabel(factory.channel)}`,
        stroke: channelColor(factory.channel),
        width: 2,
        dash: FACTORY_DOT,
        points: { show: false },
      });
    }
  }

  // Instrument context (temperatures or LED currents) rides the right-hand axis so it can share
  // the x axis with the curves without distorting the RFU scale.
  auxCurves.forEach((c) => {
    rows.push(c.values);
    meta.push({
      kind: "aux",
      channel: -1,
      col: -1,
      label: c.label,
      dyeLabel: "",
      isReference: false,
      cycles: c.cycles,
      mean: c.values.map((v) => v ?? NaN),
      adjust: [],
    });
    series.push({
      label: `${c.label} (${aux.unit})`,
      scale: AUX_SCALE,
      stroke: c.color,
      width: c.setpoint ? 1 : 1.5,
      dash: c.setpoint ? SETPOINT_DASH : AUX_DASH,
      points: { show: false },
    });
  });

  // Everything above is plotted in its own natural units; these three passes finish the job for
  // the whole plot at once, in order: lift every series onto a plottable log floor (one shared
  // shift), record where each series' threshold now sits relative to the drawn line, and blank
  // whatever is still non-positive. Done here rather than per series precisely so the shift is
  // one number for the plot instead of one per curve — see `applyLogFloor`.
  applyLogFloor(rows, meta, scale);
  meta.forEach((m, i) => {
    m.plotDelta = plotDelta(m.mean, m.adjust, m.analysis);
    if (m.kind !== "aux") rows[i + 1] = logSafe(rows[i + 1] as number[], scale);
  });

  // Cq markers: one ring per well curve with a defined Cq, placed on the curve itself —
  // interpolating `correctedValues` (the array Cq is measured against) at the fractional Cq and
  // projecting it through `plotDelta` onto screen space.
  //
  // This used to read `(cq, threshold)` directly, on the assumption that Cq is by definition the
  // cycle at which the corrected curve reaches its threshold. That holds for this library's own
  // `computeCq` (a linear crossing of `correctedValues` against `threshold`, so the two
  // interpolations agree exactly), but not for a file-sourced analysis like a Biomeme run's: the
  // device's reported Cq is not derived from its reported threshold crossing its own
  // `baselineData` (`biomeme.md` §3), so the ring landed on the threshold line instead of the
  // curve. Interpolating `correctedValues` is exact for `computeCq` and honest for a file's Cq.
  const cqMarkers: { x: number; y: number; color: string; seriesIdx: number }[] = [];
  wellCurves.forEach((curve, i) => {
    const { cq, correctedValues } = curve.analysis ?? {};
    if (cq == null || correctedValues == null) return;
    const value = interpolateAt(curve.cycles, correctedValues, cq);
    const delta = interpolateAt(curve.cycles, meta[i]!.plotDelta ?? [], cq);
    if (value == null || delta == null) return;
    cqMarkers.push({
      x: cq,
      y: value + delta,
      color: channelColor(curve.channel),
      seriesIdx: i + 1,
    });
  });

  // Baseline-region ticks: for each "draw baseline" overlay, two small ticks marking the exact
  // cycle range (`analysis.baselineRegion`) the fit was actually computed from. The overlay line
  // itself is drawn across every cycle (so it reads correctly under "relative", where it's the
  // near-zero reference the whole curve was corrected against) — without the ticks it looks like
  // the fit was taken over the whole run rather than just the flat region at its start.
  const baselineTicks: { x: number; y: number; color: string; seriesIdx: number }[] = [];
  meta.forEach((m, i) => {
    if (m.kind !== "baseline" || m.parentIndex == null) return;
    const region = wellCurves[m.parentIndex]?.analysis?.baselineRegion;
    if (!region) return;
    const row = rows[i + 1] as (number | null)[];
    for (const c of [region.beginCycle, region.endCycle]) {
      const idx = m.cycles.indexOf(c);
      if (idx === -1) continue;
      const y = row[idx];
      if (y == null) continue;
      baselineTicks.push({ x: c, y, color: channelColor(m.channel), seriesIdx: i + 1 });
    }
  });

  // Min/max envelope bands — one per plotted well curve, so each channel of a well gets its own,
  // plus one per plotted dark curve, whose DARKDATA record carries the same per-cycle spread over
  // the LED-off wells that WELLDATA does over the lit ones. Curves with no spread of their own
  // (dye space) get no band at all rather than a flat one.
  const computeBand = (
    c: { channel?: number; cycles: number[]; mean: number[]; min?: number[]; max?: number[] },
    adjust: Adjust[],
  ): BandData | null => {
    if (!c.min || !c.max) return null;
    const min: (number | null)[] = [];
    const max: (number | null)[] = [];
    for (let i = 0; i < c.mean.length; i++) {
      const a = adjust[i] ?? IDENTITY_ADJUST;
      const mn = (c.min[i] ?? 0) * a.scale + a.shift;
      const mx = (c.max[i] ?? 0) * a.scale + a.shift;
      // A read missing this channel's record pivots to NaN (`toDarkCurves`); plot a gap, not a
      // path command SVG will choke on.
      const gap = !Number.isFinite(mn) || !Number.isFinite(mx);
      min.push(gap || (scale === "log" && mn <= 0) ? null : mn);
      max.push(gap || (scale === "log" && mx <= 0) ? null : mx);
    }
    return { color: channelColor(c.channel), cycles: c.cycles, min, max };
  };

  const bands: BandData[] = cfg.bands
    ? [
        ...wellCurves.map((c, i) => computeBand(c, wellAdjusts[i]!)),
        ...darkPlotted.map(({ dark, adjust }) => computeBand(dark, adjust)),
      ].filter((b): b is BandData => b != null)
    : [];

  const thresholdLineState: ThresholdLineState = { value: null, regions: false };

  const options: uPlot.Options = {
    width: cfg.width,
    height: cfg.height,
    series,
    scales: {
      x: { time: false },
      y: { distr: scale === "log" ? 3 : 1 },
      // Padded a little so the right-axis traces don't sit flush against the plot edges.
      [AUX_SCALE]: {
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
        splits: xTick
          ? () => cfg.xAxis?.splits ?? cycles
          : (_u, _i, min, max) => {
              const out: number[] = [];
              for (let v = Math.max(1, Math.ceil(min)); v <= Math.floor(max); v++) out.push(v);
              return out;
            },
        // A categorical axis labels every position; the cycle axis would be unreadable that way,
        // so it keeps its every-fifth thinning.
        values: (_u, splits) =>
          splits.map((v) => (xTick ? xTick(v) : v % 5 === 0 ? String(v) : "")),
        grid: {
          stroke: "rgba(120,200,255,0.06)",
          width: 1,
          filter: (_u, splits) => splits.map((v) => (xTick || v % 5 === 0 ? v : null)),
        },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1, size: 5 },
        label: cfg.xAxis?.label ?? "Cycle",
        labelSize: 24,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
      },
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        label: yLabel(baseline, curveView),
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 62,
      },
      // Right-hand auxiliary axis — only drawn when something occupies it.
      {
        scale: AUX_SCALE,
        side: 1,
        show: auxCurves.length > 0,
        stroke: "#7f93b5",
        grid: { show: false },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        values: (_u, splits) => splits.map((v) => v.toFixed(aux.decimals)),
        label: aux.label,
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 58,
      },
    ],
    cursor: { focus: { prox: 24 }, points: { size: 6 } },
    focus: { alpha: 0.12 },
    legend: { show: false },
    plugins: [
      overlayPlugin(
        meta,
        bands,
        cqMarkers,
        baselineTicks,
        thresholdLineState,
        aux,
        xName,
        xTick,
        cfg.onHover,
      ),
    ],
  };

  return { data: rows as uPlot.AlignedData, options, meta, thresholdLineState };
}

/**
 * Externally-driven curve highlighting, for hovering a target/fluor chip or a well-grid cell in
 * the rail (as opposed to `focus.alpha` above, which handles hovering the plot itself via
 * uPlot's own single-nearest-series cursor focus). Sets each well series' `alpha` directly and
 * redraws without rebuilding paths, so it's cheap enough to call on every mouse move. `match:
 * null` restores full opacity.
 */
export function applyHighlight(u: uPlot, meta: SeriesMeta[], match: HighlightMatch | null): void {
  // Baselines don't get their own match test — deferred to a second pass below — so a baseline
  // can never show/hide out of step with the curve it overlays, no matter how `isMatch`'s match
  // kinds evolve.
  meta.forEach((m, i) => {
    if (m.kind === "baseline") return;
    const isMatch =
      !match ||
      (m.kind === "well" &&
        ((match.kind === "well" && m.label === match.label) ||
          (match.kind === "target" && m.dyeLabel === match.dyeLabel) ||
          (match.kind === "fluor" && m.fluor === match.fluor) ||
          (match.kind === "curve" && m.label === match.label && m.fluor === match.fluor) ||
          (match.kind === "channel" && m.channel === match.channel) ||
          (match.kind === "sample" && m.sample === match.sample) ||
          (match.kind === "refcol" && m.col === match.col)));
    u.series[i + 1]!.alpha = isMatch ? 1 : 0.12;
  });
  meta.forEach((m, i) => {
    if (m.kind !== "baseline" || m.parentIndex == null) return;
    u.series[i + 1]!.alpha = u.series[m.parentIndex + 1]!.alpha;
  });
  u.redraw(false, false);
}

function yLabel(baseline: Baseline, curveView: CurveView): string {
  if (baseline === "delta") return "ΔRFU (mean)";
  if (baseline === "percent") return "Drift (%)";
  if (curveView === "relative") return "RFU (linear baseline)";
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
const THRESHOLD_LINE_DASH = "2,3";
/** Highlighter yellow for the baseline-region diagnostic (see below) — deliberately not a
 * curve's own color, since tracing the segment in that same hue was next to invisible against a
 * dark background at any low opacity. High-contrast against both the dark theme and every
 * channel color in `channelColors.ts`. */
const REGION_MARK_COLOR = "#fde047";

function overlayPlugin(
  meta: SeriesMeta[],
  bands: BandData[],
  cqMarkers: { x: number; y: number; color: string; seriesIdx: number }[],
  baselineTicks: { x: number; y: number; color: string; seriesIdx: number }[],
  thresholdLineState: ThresholdLineState,
  /** How to present a right-axis value in the hovercard (see {@link AuxAxis}). */
  aux: AuxAxis,
  /** How the tooltip names and renders the x value — "cycle" and raw numbers by default; the
   * Reference view's column mode passes "column" and an `R{n}` renderer (see `xAxis`). */
  xName: string,
  xTick: ((v: number) => string) | undefined,
  onHover: (t: TooltipData | null) => void,
): uPlot.Plugin {
  let svg: SVGSVGElement;
  let bandGroup: SVGGElement;
  let cqGroup: SVGGElement;
  let baselineTickGroup: SVGGElement;
  let thresholdGroup: SVGGElement;
  let regionGroup: SVGGElement;
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

        baselineTickGroup = document.createElementNS(SVG_NS, "g");
        svg.appendChild(baselineTickGroup);

        thresholdGroup = document.createElementNS(SVG_NS, "g");
        svg.appendChild(thresholdGroup);

        regionGroup = document.createElementNS(SVG_NS, "g");
        svg.appendChild(regionGroup);

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

        // Cq markers: one small ring per curve with a defined Cq, at the point where its corrected
        // curve reaches its threshold (see `cqMarkers`).
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

        // Baseline-region ticks: a short vertical tick at each end of the cycle range a "draw
        // baseline" overlay was actually fit over (see `baselineTicks`), in the overlay's own
        // color at full strength — the overlay line itself is drawn at reduced opacity, so
        // without these the region boundary is invisible against it.
        while (baselineTickGroup.childElementCount > baselineTicks.length) {
          baselineTickGroup.lastElementChild!.remove();
        }
        while (baselineTickGroup.childElementCount < baselineTicks.length) {
          baselineTickGroup.appendChild(line());
        }
        baselineTicks.forEach((m, i) => {
          const l = baselineTickGroup.children[i] as SVGLineElement;
          const x = u.valToPos(m.x, "x");
          const y = u.valToPos(m.y, "y");
          l.setAttribute("x1", String(x));
          l.setAttribute("x2", String(x));
          l.setAttribute("y1", String(y - 5));
          l.setAttribute("y2", String(y + 5));
          l.setAttribute("stroke", m.color);
          l.setAttribute("stroke-opacity", String(u.series[m.seriesIdx]!.alpha ?? 1));
        });

        // Rail-driven threshold-hover line: a dotted horizontal line at the hovered target's
        // threshold RFU, spanning the full plotted cycle range and drawn where each highlighted
        // curve actually carries that threshold — `tv + plotDelta` (see `SeriesMeta.plotDelta`),
        // the same projection the Cq rings use, so the line always runs through them.
        //
        // In practice that is one line — every curve on a plot shares one `plotDelta` in the
        // "Relative" view (0 on a linear scale, `applyLogFloor`'s shared offset on a log one) — but
        // it is drawn per highlighted curve and deduplicated by pixel row rather than assumed, so
        // the line cannot drift away from the rings it belongs to whatever the projection does.
        const tv = thresholdLineState.value;
        // Kept for the noise-label placement further down, so it can steer clear of the lines
        // rather than risk landing right on top of one.
        const thresholdYs: number[] = [];
        if (tv != null && u.scales.x!.min != null && u.scales.x!.max != null) {
          const x1 = u.valToPos(u.scales.x!.min, "x");
          const x2 = u.valToPos(u.scales.x!.max, "x");
          const seen = new Set<number>();
          if (Number.isFinite(x1) && Number.isFinite(x2)) {
            meta.forEach((m, i) => {
              if (m.kind !== "well" || !m.plotDelta) return;
              if ((u.series[i + 1]!.alpha ?? 1) < 1) return;
              const y = u.valToPos(tv + (m.plotDelta[0] ?? 0), "y");
              if (!Number.isFinite(y)) return;
              const row = Math.round(y);
              if (seen.has(row)) return;
              seen.add(row);
              thresholdYs.push(y);
            });
          }
          while (thresholdGroup.childElementCount > thresholdYs.length) {
            thresholdGroup.lastElementChild!.remove();
          }
          while (thresholdGroup.childElementCount < thresholdYs.length) {
            const l = line();
            l.setAttribute("stroke", "#e6e6e6");
            l.setAttribute("stroke-dasharray", THRESHOLD_LINE_DASH);
            thresholdGroup.appendChild(l);
          }
          thresholdYs.forEach((y, i) => {
            const l = thresholdGroup.children[i] as SVGLineElement;
            l.setAttribute("x1", String(x1));
            l.setAttribute("x2", String(x2));
            l.setAttribute("y1", String(y));
            l.setAttribute("y2", String(y));
          });
        } else {
          thresholdGroup.replaceChildren();
        }

        // Rail-driven threshold-hover diagnostic: for whichever curves the hover isolated (the
        // well series `applyHighlight` left at full opacity), highlight the exact cycle range its
        // own baseline-region auto-detection used and label its noise estimate. The region is
        // per-curve, so two wells in the same target can show different ranges — the point of
        // the indicator is making that visible rather than assumed. Which is also why it is drawn
        // only when the hover isolated *one* curve (`state.regions`): drawn for a whole
        // fluorophore's wells at once, the σ labels overlapped into noise of a different kind.
        //
        // Drawn in a fixed highlighter color (not the curve's own), with a dark halo under both
        // the marker and the text: tracing the segment in the curve's own hue just made it a
        // marginally thicker version of itself, next to invisible against a dark background at
        // low opacity. A small dot in the curve's real color anchors the label back to which
        // line it belongs to.
        const activeRegions: { seriesIdx: number; m: SeriesMeta }[] = [];
        if (thresholdLineState.regions) {
          meta.forEach((m, i) => {
            if (m.kind !== "well" || !m.analysis) return;
            const seriesIdx = i + 1;
            if ((u.series[seriesIdx]!.alpha ?? 1) < 1) return;
            activeRegions.push({ seriesIdx, m });
          });
        }
        while (regionGroup.childElementCount > activeRegions.length) {
          regionGroup.lastElementChild!.remove();
        }
        while (regionGroup.childElementCount < activeRegions.length) {
          const g = document.createElementNS(SVG_NS, "g");
          const halo = document.createElementNS(SVG_NS, "polyline");
          halo.setAttribute("fill", "none");
          halo.setAttribute("stroke", "#0b0d12");
          halo.setAttribute("stroke-width", "7");
          halo.setAttribute("stroke-linecap", "round");
          const mark = document.createElementNS(SVG_NS, "polyline");
          mark.setAttribute("fill", "none");
          mark.setAttribute("stroke", REGION_MARK_COLOR);
          mark.setAttribute("stroke-width", "3");
          mark.setAttribute("stroke-linecap", "round");
          const dot = document.createElementNS(SVG_NS, "circle");
          dot.setAttribute("r", "3.5");
          dot.setAttribute("stroke", "#0b0d12");
          dot.setAttribute("stroke-width", "1.5");
          const text = document.createElementNS(SVG_NS, "text");
          text.setAttribute("font-size", "12");
          text.setAttribute("font-weight", "700");
          text.setAttribute("font-family", "ui-monospace, monospace");
          text.setAttribute("fill", REGION_MARK_COLOR);
          // A dark stroke "halo" under the fill, so the label stays legible over whatever curve
          // color or gridline it happens to land on.
          text.setAttribute("paint-order", "stroke");
          text.setAttribute("stroke", "#0b0d12");
          text.setAttribute("stroke-width", "3");
          g.append(halo, mark, dot, text);
          regionGroup.appendChild(g);
        }
        activeRegions.forEach(({ seriesIdx, m }, gi) => {
          const g = regionGroup.children[gi] as SVGGElement;
          const [halo, mark, dot, text] = [...g.children] as [
            SVGPolylineElement,
            SVGPolylineElement,
            SVGCircleElement,
            SVGTextElement,
          ];
          const wellColor = (u.series[seriesIdx]!.stroke as string) ?? "#8aa0c0";
          const rowData = u.data[seriesIdx] as (number | null)[];
          const region = m.analysis!.baselineRegion;
          const pts: string[] = [];
          let lastX = NaN;
          let lastY = NaN;
          for (let i = 0; i < m.cycles.length; i++) {
            const c = m.cycles[i]!;
            if (c < region.beginCycle || c > region.endCycle) continue;
            const y = rowData[i];
            if (y == null) continue;
            const px = u.valToPos(c, "x");
            const py = u.valToPos(y, "y");
            if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
            pts.push(`${px},${py}`);
            lastX = px;
            lastY = py;
          }
          const pointsAttr = pts.join(" ");
          halo.setAttribute("points", pointsAttr);
          mark.setAttribute("points", pointsAttr);
          const visible = pts.length > 1 && Number.isFinite(lastX) && Number.isFinite(lastY);
          halo.setAttribute("stroke-opacity", visible ? "0.85" : "0");
          mark.setAttribute("stroke-opacity", visible ? "0.95" : "0");
          if (visible) {
            dot.setAttribute("cx", String(lastX));
            dot.setAttribute("cy", String(lastY));
            dot.setAttribute("fill", wellColor);
            dot.style.display = "";
            // Default above the point; flip below when that would land within a line's-width of
            // a dotted threshold line, which otherwise routinely cuts right through the text —
            // the two are drawn at similar RFU by construction (the region ends near where a
            // curve approaches its own threshold).
            const nearThresholdLine = thresholdYs.some((ty) => Math.abs(lastY - 12 - ty) < 8);
            text.setAttribute("x", String(lastX + 8));
            text.setAttribute("y", String(lastY + (nearThresholdLine ? 18 : -8)));
            text.textContent = `σ${m.analysis!.noise.toFixed(1)}`;
            text.style.display = "";
          } else {
            dot.style.display = "none";
            text.style.display = "none";
          }
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
          // The "draw baseline" overlay is a pure display line, not something to hover.
          if (meta[s - 1]?.kind === "baseline") continue;
          const val = (u.data[s] as (number | null)[])[idx];
          if (val == null || Number.isNaN(val)) continue;
          // Right-axis series live on the right-hand scale, so project through the
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

        if (m.kind === "aux") {
          // A right-axis reading is a single scalar per read — no min/max/σ to whisker.
          group.style.display = "none";
          onHover(
            near
              ? {
                  kind: "aux",
                  label: m.label,
                  channel: -1,
                  col: -1,
                  dye: "",
                  color: (u.series[best]!.stroke as string) ?? "#8aa0c0",
                  cycle: m.cycles[idx] ?? 0,
                  xName,
                  xText: xTick ? xTick(m.cycles[idx] ?? 0) : undefined,
                  mean: plotted,
                  rowLabel: aux.rowLabel,
                  unit: aux.unit,
                  decimals: aux.tipDecimals,
                  left,
                  top,
                }
              : null,
          );
          return;
        }

        // A series with no spread (dye space — see `PlotCurve.std`) gets no whisker and no
        // min/max/σ tooltip rows, rather than a zero-height whisker restating the mean.
        const spread =
          m.min && m.max && m.std
            ? { min: m.min[idx] ?? 0, max: m.max[idx] ?? 0, std: m.std[idx] ?? 0 }
            : null;
        const a = m.adjust[idx] ?? IDENTITY_ADJUST;
        const x = u.valToPos(m.cycles[idx] ?? 0, "x");
        const yMax = u.valToPos((spread?.max ?? 0) * a.scale + a.shift, "y");
        const yMin = u.valToPos((spread?.min ?? 0) * a.scale + a.shift, "y");
        const stdOff = (spread?.std ?? 0) * a.scale;
        const yHi = u.valToPos(plotted + stdOff, "y");
        const yLo = u.valToPos(plotted - stdOff, "y");
        const color = channelColor(m.channel);

        if (spread && [x, yMax, yMin, yHi, yLo].every(Number.isFinite)) {
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
                // Never "baseline" here — that kind is skipped in the hit-test loop above.
                kind: m.kind as TooltipData["kind"],
                label: m.label,
                channel: m.channel,
                col: m.col,
                dye: m.dyeLabel,
                color,
                cycle: m.cycles[idx] ?? 0,
                xName,
                xText: xTick ? xTick(m.cycles[idx] ?? 0) : undefined,
                mean: m.mean[idx] ?? 0,
                ...(spread ?? {}),
                left,
                top,
                cq: m.analysis?.cq,
                // Only for a curve the run actually quantifies (dye space — a `threshold` means a
                // Cq was taken against it). A channel curve carries a baseline so the "Relative"
                // view can plot it, but quoting that fit in the tooltip would read as an analysis
                // of a signal the app deliberately doesn't analyse — see `RunAnalysis.cqTable`.
                baselineFormula:
                  m.analysis?.threshold != null
                    ? formatBaselineFormula(m.analysis.baselineFit)
                    : null,
              }
            : null,
        );
      },
    },
  };
}
