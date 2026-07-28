/**
 * The Calibration chart: uPlot options and series for the pure-dye response curves — block
 * temperature on x, RFU on y.
 *
 * Deliberately a separate builder from `chart.ts` rather than a mode of it: that chart's x axis
 * *is* the cycle (integer splits, every-5th labelling, per-cycle baselines, Cq rings, min/max
 * whiskers), and none of it means anything for a calibration curve, which is four measured points
 * against temperature with no baseline, threshold or Cq of its own. What the two do share is the
 * channel palette, the SVG-overlay tooltip pattern and the rail-driven highlight, which is where
 * the sharing is actually worth it.
 *
 * **Nothing is interpolated for drawing.** `calibration.md` §3 samples a dye's response at an
 * arbitrary block temperature by straight-line interpolation between the bracketing knots, so the
 * straight segments uPlot draws between the plotted knots *are* the algorithm — adding
 * intermediate points would only redraw the same lines with more vertices. The one place the
 * interpolation is evaluated explicitly is the run-temperature readout below, which reports the
 * value the analysis actually uses.
 */

import uPlot from "uplot";
import { interpolateResponse, type ResponseKnot } from "@zpcrweb/core";
import { channelColor, channelLabel } from "../channelColors";
import type { Scale } from "../../state/useZpcrStore";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Files the run's analysis doesn't use are drawn dashed — the same "this is context, not the
 * measurement" convention the reference/dark overlays use on the Curves chart. */
const EXTRA_DASH = [5, 4];
/** The empty-plate baseline in absolute mode — dotted, so it reads as the level the dye reading
 * above it is measured against rather than as a curve in its own right. */
const EMPTY_DASH = [1, 3];
/** The vertical marker at the run's own block temperature. */
const RUN_TEMP_DASH = "3,3";
const RUN_TEMP_COLOR = "#e6e6e6";

/**
 * What one line's y values are. `"response"` is the algorithm's own `max(0, dye − empty)`
 * (relative mode); `"dye"` and `"empty"` are the two raw readings that difference is taken
 * between (absolute mode), plotted as a pair per file × channel.
 */
export type CalSeriesKind = "response" | "dye" | "empty";

/** Human label for a {@link CalSeriesKind}, used in the legend and the tooltip's value row. */
export const CAL_KIND_LABEL: Record<CalSeriesKind, string> = {
  response: "response",
  dye: "dye plate",
  empty: "empty plate",
};

/** One plotted line: one calibration file's readings on one optical channel. */
export interface CalPlotSeries {
  /** Unique per line — `${fileKey}|${channel}` in relative mode, plus the kind in absolute. */
  key: string;
  /** Which level this line plots; see {@link CalSeriesKind}. */
  kind: CalSeriesKind;
  /** The calibration file this line belongs to (`calKey`), for the rail's chip highlight. */
  fileKey: string;
  dye: string;
  plateType: string;
  channel: number;
  /** True on the dye's own channel: its signal, as opposed to its crosstalk into the others. */
  primary: boolean;
  /** True when the run's analysis reads this file — drawn solid rather than dashed. */
  inUse: boolean;
  /** The line's knots, sorted by temperature. `response` carries whichever level {@link kind}
   * names — for a raw reading it is the reading itself, not a difference. */
  knots: ResponseKnot[];
}

/** Which lines a rail hover isolates; every other line dims. */
export type CalHighlight =
  | { kind: "file"; fileKey: string }
  | { kind: "channel"; channel: number };

/** Per-series metadata, index-aligned with uPlot series (offset by the x row). */
export interface CalSeriesMeta {
  series: CalPlotSeries;
  /** Plotted y per x, `null` outside the series' own measured temperature range. */
  values: (number | null)[];
}

export interface CalTooltipData {
  dye: string;
  plateType: string;
  channel: number;
  primary: boolean;
  kind: CalSeriesKind;
  color: string;
  temperatureC: number;
  response: number;
  /** True when this x is one of the file's own measured temperatures rather than a point
   * interpolated onto another file's temperature grid. */
  measured: boolean;
  left: number;
  top: number;
}

export interface BuildCalChartConfig {
  series: CalPlotSeries[];
  /** Block temperature the run's own analysis samples these curves at (see `stepTemperature`),
   * marked with a vertical line; `null` draws none. */
  runTemperatureC: number | null;
  scale: Scale;
  width: number;
  height: number;
  onHover: (t: CalTooltipData | null) => void;
}

/** The x grid: every temperature any plotted series was measured at, ascending. */
function temperatureGrid(series: CalPlotSeries[]): number[] {
  const temps = new Set<number>();
  for (const s of series) for (const k of s.knots) temps.add(k.temperatureC);
  return [...temps].sort((a, b) => a - b);
}

/**
 * A series' value at each grid temperature. Inside its own measured range this is
 * {@link interpolateResponse} — the algorithm's own linear interpolation, which at the series'
 * own knots returns the measured value exactly, and between them lands on the straight line
 * uPlot would have drawn anyway. Outside the range it's `null`: the algorithm does extrapolate
 * past the end knots, but drawing that as if it were data would overstate what the file measured.
 */
function sample(knots: ResponseKnot[], grid: number[], scale: Scale): (number | null)[] {
  if (knots.length === 0) return grid.map(() => null);
  const lo = knots[0]!.temperatureC;
  const hi = knots[knots.length - 1]!.temperatureC;
  return grid.map((t) => {
    if (t < lo || t > hi) return null;
    const v = interpolateResponse(knots, t);
    // A response of exactly 0 is common (a dye with no measurable crosstalk into a far channel)
    // and undefined on a log axis — a gap there is the truthful rendering.
    return scale === "log" && v <= 0 ? null : v;
  });
}

export function buildCalChart(cfg: BuildCalChartConfig): {
  data: uPlot.AlignedData;
  options: uPlot.Options;
  meta: CalSeriesMeta[];
} {
  const grid = temperatureGrid(cfg.series);
  const rows: (number | null)[][] = [grid];
  const meta: CalSeriesMeta[] = [];
  const series: uPlot.Series[] = [{ label: "°C" }];

  for (const s of cfg.series) {
    const values = sample(s.knots, grid, cfg.scale);
    rows.push(values);
    meta.push({ series: s, values });
    series.push({
      label: `${s.dye} · ${s.plateType} · ${channelLabel(s.channel)} · ${CAL_KIND_LABEL[s.kind]}`,
      stroke: channelColor(s.channel),
      // The dye's own channel carries its signal; the rest is crosstalk, an order of magnitude
      // smaller and worth de-emphasising. The empty-plate baseline is context for the reading
      // above it, so it stays thin whichever channel it's on.
      width: s.primary && s.kind !== "empty" ? 2 : 1,
      // Dotted wins over dashed on an empty-plate line: which level it is matters more than
      // whether the analysis reads that file, and the dye line beside it still says the latter.
      dash: s.kind === "empty" ? EMPTY_DASH : s.inUse ? undefined : EXTRA_DASH,
      points: { show: true, size: 5 },
    });
  }

  const options: uPlot.Options = {
    width: cfg.width,
    height: cfg.height,
    series,
    scales: {
      x: { time: false, range: (_u, min, max) => [min - 2, max + 2] },
      y: { distr: cfg.scale === "log" ? 3 : 1 },
    },
    axes: [
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        values: (_u, splits) => splits.map((v) => `${v}`),
        label: "Block temperature (°C)",
        labelSize: 24,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
      },
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        label: cfg.series.some((s) => s.kind !== "response") ? "Reading (RFU)" : "Response (RFU)",
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 62,
      },
    ],
    cursor: { focus: { prox: 24 }, points: { size: 6 } },
    focus: { alpha: 0.12 },
    legend: { show: false },
    plugins: [calOverlayPlugin(meta, grid, cfg.runTemperatureC, cfg.onHover)],
  };

  return { data: rows as uPlot.AlignedData, options, meta };
}

/**
 * Rail-driven highlighting — hovering a dye chip or a channel chip isolates the lines it covers.
 * Sets each series' alpha and redraws without rebuilding paths, exactly as `chart.ts`'s
 * `applyHighlight` does, so it's cheap enough for every mouse move.
 */
export function applyCalHighlight(
  u: uPlot,
  meta: CalSeriesMeta[],
  match: CalHighlight | null,
): void {
  meta.forEach((m, i) => {
    const isMatch =
      !match ||
      (match.kind === "file"
        ? m.series.fileKey === match.fileKey
        : m.series.channel === match.channel);
    u.series[i + 1]!.alpha = isMatch ? 1 : 0.12;
  });
  u.redraw(false, false);
}

/**
 * Cursor plugin: reports the nearest series for the text tooltip (same nearest-in-y hit test as
 * the Curves chart) and draws the vertical run-temperature marker — the block temperature the
 * analysis actually samples these curves at, which is the whole reason the shape of them matters.
 */
function calOverlayPlugin(
  meta: CalSeriesMeta[],
  grid: number[],
  runTemperatureC: number | null,
  onHover: (t: CalTooltipData | null) => void,
): uPlot.Plugin {
  let svg: SVGSVGElement;
  let runLine: SVGLineElement;
  let runLabel: SVGTextElement;

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
        runLine = document.createElementNS(SVG_NS, "line");
        runLine.setAttribute("stroke", RUN_TEMP_COLOR);
        runLine.setAttribute("stroke-width", "1.5");
        runLine.setAttribute("stroke-dasharray", RUN_TEMP_DASH);
        runLabel = document.createElementNS(SVG_NS, "text");
        runLabel.setAttribute("font-size", "11");
        runLabel.setAttribute("font-family", "ui-monospace, monospace");
        runLabel.setAttribute("fill", RUN_TEMP_COLOR);
        // Dark halo under the fill, so the label stays legible wherever it lands.
        runLabel.setAttribute("paint-order", "stroke");
        runLabel.setAttribute("stroke", "#0b0d12");
        runLabel.setAttribute("stroke-width", "3");
        svg.append(runLine, runLabel);
        u.over.appendChild(svg);
      },

      draw: (u: uPlot) => {
        if (runTemperatureC == null) {
          runLine.style.display = "none";
          runLabel.style.display = "none";
          return;
        }
        const x = u.valToPos(runTemperatureC, "x");
        if (!Number.isFinite(x)) {
          runLine.style.display = "none";
          runLabel.style.display = "none";
          return;
        }
        runLine.style.display = "";
        runLabel.style.display = "";
        runLine.setAttribute("x1", String(x));
        runLine.setAttribute("x2", String(x));
        runLine.setAttribute("y1", "0");
        runLine.setAttribute("y2", String(u.bbox.height / devicePixelRatio));
        // Flip the label to the left of the line when it would otherwise run off the plot.
        const width = u.bbox.width / devicePixelRatio;
        const flip = x > width - 90;
        runLabel.setAttribute("x", String(x + (flip ? -6 : 6)));
        runLabel.setAttribute("text-anchor", flip ? "end" : "start");
        runLabel.setAttribute("y", "14");
        runLabel.textContent = `run ${runTemperatureC.toFixed(1)} °C`;
      },

      setCursor: (u: uPlot) => {
        const idx = u.cursor.idx;
        const { left, top } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) {
          onHover(null);
          return;
        }
        let best = -1;
        let bestDist = Infinity;
        for (let s = 1; s < u.series.length; s++) {
          const val = (u.data[s] as (number | null)[])[idx];
          if (val == null || Number.isNaN(val)) continue;
          const dist = Math.abs(u.valToPos(val, "y") - top);
          if (dist < bestDist) {
            bestDist = dist;
            best = s;
          }
        }
        const m = best > 0 ? meta[best - 1] : undefined;
        const value = m?.values[idx];
        // Proximity-gated like the Curves chart's tooltip, so it doesn't follow the pointer
        // across the whole plot height.
        if (!m || value == null || bestDist > 24) {
          onHover(null);
          return;
        }
        const temperatureC = grid[idx] ?? 0;
        onHover({
          dye: m.series.dye,
          plateType: m.series.plateType,
          channel: m.series.channel,
          primary: m.series.primary,
          kind: m.series.kind,
          color: channelColor(m.series.channel),
          temperatureC,
          response: value,
          measured: m.series.knots.some((k) => k.temperatureC === temperatureC),
          left,
          top,
        });
      },
    },
  };
}
