/**
 * The melt chart: uPlot options and series for a run's melt step — temperature on x, and on y
 * either −dF/dT or the fluorescence it was taken from.
 *
 * A separate builder from `chart.ts`, for the reason `calChart.ts` gives at the top of itself and
 * `thermalChart.ts` repeats: that chart's x axis *is* the cycle — integer splits, every-fifth
 * labelling, per-cycle baselines, Cq rings as drag handles, min/max whiskers — and none of it
 * means anything on a ramp. A melt has no cycles, no baseline and no threshold to cross
 * (`melt.md` §1), so bending the cycle chart into one would mean suppressing most of it. What is
 * shared is what is worth sharing: the channel palette, the SVG-overlay tooltip pattern and the
 * rail-driven highlight.
 *
 * **Nothing is interpolated.** The points are what the instrument read, at the temperatures it
 * read them at, and the straight segments uPlot draws between them are the only smoothing on
 * display — the derivative's own Savitzky–Golay pass (`melt.md` §4) happens in the library,
 * before the values ever arrive here.
 */

import uPlot from "uplot";
import type { MeltCurve } from "@zpcrweb/core";
import { curveColor } from "../fluorColors";
import type { MeltView } from "../../state/useZpcrStore";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The vertical marker drawn at a curve's called melting temperature. */
const TM_COLOR = "#e6e6e6";
const TM_DASH = "3,3";

/** One plotted melt curve: a core `MeltCurve` plus how this chart should draw it. */
export interface MeltPlotCurve {
  /** Unique per line — `${row},${col}|${channel}` in channel space, `${row},${col}|${dye}` in
   * dye space. */
  key: string;
  /** What the line is named and toggled by: the channel's label in channel space, and in dye
   * space the fluorophore or the target, whichever the View toggle groups on — the same
   * `dyeLabel` the amplification chart carries, so one rail drives both charts. */
  dyeLabel: string;
  curve: MeltCurve;
}

/** Which lines a rail hover isolates; every other line dims. */
export type MeltHighlight =
  /** One or more whole wells, by display label — the same shape `chart.ts`'s `HighlightMatch`
   * uses, so the rail's existing hover state drives this chart without translation. */
  | { kind: "wells"; labels: string[] }
  | { kind: "channel"; channel: number }
  /** One fluorophore or target chip, by the label the chip carries. */
  | { kind: "target"; dyeLabel: string };

/** Per-series metadata, index-aligned with uPlot series (offset by the x row). */
export interface MeltSeriesMeta {
  plot: MeltPlotCurve;
  /** The values actually plotted — whichever of the two forms {@link MeltView} names. */
  values: number[];
  color: string;
}

export interface MeltTooltipData {
  wellLabel: string;
  /** What the hovered line is: its channel's label, or its fluorophore/target. */
  dyeLabel: string;
  color: string;
  temperatureC: number;
  /** The plotted value at the hovered temperature. */
  value: number;
  /** Both forms at this temperature, so the number on screen never loses its context. */
  rfu: number;
  derivative: number;
  /** This curve's own melting temperature, or null where none was called. */
  tmC: number | null;
  left: number;
  top: number;
}

export interface BuildMeltChartConfig {
  curves: MeltPlotCurve[];
  /** The melt's temperature axis — shared by every curve of one step. */
  temperaturesC: number[];
  view: MeltView;
  width: number;
  height: number;
  onHover: (t: MeltTooltipData | null) => void;
}

/** What a curve contributes to the y axis in each mode. */
function plotted(curve: MeltCurve, view: MeltView): number[] {
  return view === "derivative" ? curve.derivative : curve.rfu;
}

export function buildMeltChart(cfg: BuildMeltChartConfig): {
  data: uPlot.AlignedData;
  options: uPlot.Options;
  meta: MeltSeriesMeta[];
} {
  const rows: number[][] = [cfg.temperaturesC];
  const meta: MeltSeriesMeta[] = [];
  const series: uPlot.Series[] = [{ label: "°C" }];

  for (const plot of cfg.curves) {
    const values = plotted(plot.curve, cfg.view);
    // A dye-space melt colors by the dye, a channel-space one by the channel — the same rule
    // (and the same function) the amplification chart follows.
    const color = curveColor({ fluor: plot.curve.dye, channel: plot.curve.channel });
    rows.push(values);
    meta.push({ plot, values, color });
    series.push({
      label: `${plot.curve.wellLabel} · ${plot.dyeLabel}`,
      stroke: color,
      width: 1,
      // uPlot draws a marker on every reading by default once the points are far enough apart,
      // and a melt's 61 of them clear that threshold easily — which put a dot on every sample of
      // every curve. The Curves chart hides them on every series it draws and this matches it.
      // (`calChart.ts` is the one chart that shows them, because a calibration curve is four
      // measured knots and which four they are is the point; a 61-point ramp reads as a curve.)
      // The cursor's own hover point is a separate thing and stays — see `cursor` below.
      points: { show: false },
    });
  }

  const options: uPlot.Options = {
    width: cfg.width,
    height: cfg.height,
    series,
    scales: {
      x: { time: false },
      // Always linear: a derivative is signed and crosses zero at every point the curve stops
      // falling, which a log axis cannot show at all.
      y: { distr: 1 },
    },
    axes: [
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        values: (_u, splits) => splits.map((v) => `${v}`),
        label: "Temperature (°C)",
        labelSize: 24,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
      },
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        label: cfg.view === "derivative" ? "−dF/dT (RFU/°C)" : "Fluorescence (RFU)",
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 62,
      },
    ],
    cursor: { focus: { prox: 24 }, points: { size: 6 } },
    focus: { alpha: 0.12 },
    legend: { show: false },
    plugins: [meltOverlayPlugin(meta, cfg.temperaturesC, cfg.view, cfg.onHover)],
  };

  return { data: rows as unknown as uPlot.AlignedData, options, meta };
}

/**
 * Rail-driven highlighting — the same cheap redraw `chart.ts`'s `applyHighlight` and
 * `calChart.ts`'s `applyCalHighlight` do: set each series' alpha and redraw without rebuilding
 * paths, so it survives being called on every mouse move.
 */
export function applyMeltHighlight(
  u: uPlot,
  meta: MeltSeriesMeta[],
  match: MeltHighlight | null,
): void {
  meta.forEach((m, i) => {
    const isMatch =
      !match ||
      (match.kind === "channel"
        ? m.plot.curve.channel === match.channel
        : match.kind === "target"
          ? m.plot.dyeLabel === match.dyeLabel
          : match.labels.includes(m.plot.curve.wellLabel));
    u.series[i + 1]!.alpha = isMatch ? 1 : 0.12;
  });
  u.redraw(false, false);
}

/**
 * Cursor plugin: reports the nearest series for the tooltip, and — in derivative mode — draws a
 * vertical marker at each called melting temperature.
 *
 * The markers are drawn only when few enough curves are plotted to tell them apart. A melt step
 * carries one curve per well per channel (576 on a full 96-well run), and a plot with hundreds of
 * near-identical vertical lines on it says less than one with none: past the limit the Tm is read
 * from the table and the hover card instead.
 */
const MAX_TM_MARKERS = 12;

/** Label geometry, in CSS pixels: 11px monospace advance, line height, and the gap to the peak. */
const LABEL_CHAR_W = 6.6;
const LABEL_LINE_H = 13;
const LABEL_PEAK_GAP = 6;

interface LabelBox {
  left: number;
  right: number;
  y: number;
}

/**
 * The plotted value at a called melting temperature.
 *
 * A Tm is interpolated between two readings (`melt.md` §5), so it rarely lands on one — this
 * interpolates the plotted curve the same linear way, which is also the way uPlot draws the
 * segment, so the returned point sits exactly on the line as displayed. Null when the temperature
 * is outside the ramp, or the readings either side of it are missing.
 */
function valueAtTemperature(
  temperaturesC: number[],
  values: number[],
  tm: number,
): number | null {
  for (let i = 1; i < temperaturesC.length; i++) {
    const t0 = temperaturesC[i - 1]!;
    const t1 = temperaturesC[i]!;
    if (tm < Math.min(t0, t1) || tm > Math.max(t0, t1)) continue;
    const v0 = values[i - 1];
    const v1 = values[i];
    if (v0 == null || v1 == null || Number.isNaN(v0) || Number.isNaN(v1)) return null;
    const span = t1 - t0;
    return span === 0 ? v0 : v0 + ((tm - t0) / span) * (v1 - v0);
  }
  return null;
}

/**
 * Where to draw one Tm label: just above the peak it names, which is what separates labels that
 * a shared top edge used to stack on top of each other — two melts a fraction of a degree apart
 * are still different heights.
 *
 * Peaks of near-equal height put their labels back on the same line, so a label that would collide
 * with one already placed steps up a line at a time until it clears (and back down if that runs it
 * off the top of the plot). Only labels whose x ranges actually overlap are considered.
 */
function placeLabel(
  placed: LabelBox[],
  left: number,
  width: number,
  peakY: number,
  height: number,
): number {
  const right = left + width;
  const min = LABEL_LINE_H;
  const max = height - 2;
  const clamp = (y: number) => Math.max(min, Math.min(max, y));
  const hits = (y: number) =>
    placed.some(
      (p) => p.left < right && left < p.right && Math.abs(p.y - y) < LABEL_LINE_H,
    );

  // A peak off the top of the y range, or one whose value couldn't be read, falls back to the
  // top edge the labels used to share.
  let y = clamp(Number.isFinite(peakY) ? peakY - LABEL_PEAK_GAP : min);
  const start = y;
  while (hits(y) && y - LABEL_LINE_H >= min) y -= LABEL_LINE_H;
  if (hits(y)) {
    y = start;
    while (hits(y) && y + LABEL_LINE_H <= max) y += LABEL_LINE_H;
  }
  placed.push({ left, right, y });
  return y;
}

function meltOverlayPlugin(
  meta: MeltSeriesMeta[],
  temperaturesC: number[],
  view: MeltView,
  onHover: (t: MeltTooltipData | null) => void,
): uPlot.Plugin {
  let svg: SVGSVGElement;
  let marks: SVGGElement;

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
        marks = document.createElementNS(SVG_NS, "g");
        svg.append(marks);
        u.over.appendChild(svg);
      },

      draw: (u: uPlot) => {
        marks.replaceChildren();
        if (view !== "derivative") return;
        const called = meta.filter((m) => m.plot.curve.tmC != null);
        if (called.length === 0 || called.length > MAX_TM_MARKERS) return;
        const height = u.bbox.height / devicePixelRatio;
        const width = u.bbox.width / devicePixelRatio;
        // Labels are placed at the peak each marker names, and nudged apart only where two of
        // them would actually overlap — see `placeLabel`.
        const placed: LabelBox[] = [];
        for (const m of called) {
          const tm = m.plot.curve.tmC as number;
          const x = u.valToPos(tm, "x");
          if (!Number.isFinite(x)) continue;
          const line = document.createElementNS(SVG_NS, "line");
          line.setAttribute("x1", String(x));
          line.setAttribute("x2", String(x));
          line.setAttribute("y1", "0");
          line.setAttribute("y2", String(height));
          line.setAttribute("stroke", m.color);
          line.setAttribute("stroke-width", "1");
          line.setAttribute("stroke-dasharray", TM_DASH);
          line.setAttribute("opacity", "0.7");
          const label = document.createElementNS(SVG_NS, "text");
          const text = `${tm.toFixed(1)} °C`;
          const flip = x > width - 56;
          const textWidth = text.length * LABEL_CHAR_W;
          const left = flip ? x - 4 - textWidth : x + 4;
          const peak = valueAtTemperature(temperaturesC, m.values, tm);
          const peakY = peak == null ? NaN : u.valToPos(peak, "y");
          const y = placeLabel(placed, left, textWidth, peakY, height);
          label.setAttribute("x", String(x + (flip ? -4 : 4)));
          label.setAttribute("text-anchor", flip ? "end" : "start");
          label.setAttribute("y", String(y));
          label.setAttribute("font-size", "11");
          label.setAttribute("font-family", "ui-monospace, monospace");
          label.setAttribute("fill", TM_COLOR);
          label.setAttribute("paint-order", "stroke");
          label.setAttribute("stroke", "#0b0d12");
          label.setAttribute("stroke-width", "3");
          label.textContent = text;
          marks.append(line, label);
        }
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
        // Proximity-gated like the other two charts, so the card doesn't follow the pointer
        // across the whole plot height.
        if (!m || bestDist > 24) {
          onHover(null);
          return;
        }
        onHover({
          wellLabel: m.plot.curve.wellLabel,
          dyeLabel: m.plot.dyeLabel,
          color: m.color,
          temperatureC: temperaturesC[idx] ?? 0,
          value: m.values[idx] ?? 0,
          rfu: m.plot.curve.rfu[idx] ?? 0,
          derivative: m.plot.curve.derivative[idx] ?? 0,
          tmC: m.plot.curve.tmC,
          left,
          top,
        });
      },
    },
  };
}
