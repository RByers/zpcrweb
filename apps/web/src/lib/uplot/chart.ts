import uPlot from "uplot";
import {
  deltaBaseline,
  subtractSeries,
  type DarkCurve,
  type WellCurve,
} from "@zpcrweb/core";
import { channelColor, channelDye } from "../channelColors";
import type { Baseline, Scale } from "../../state/useZpcrStore";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Values <= 0 are undefined on a log axis; render them as gaps. */
function logSafe(values: number[], scale: Scale): (number | null)[] {
  if (scale !== "log") return values;
  return values.map((v) => (v <= 0 ? null : v));
}

/** Per-series metadata, index-aligned with uPlot series (offset by the x row). */
interface SeriesMeta {
  kind: "well" | "dark";
  channel: number;
  label: string;
  isReference: boolean;
  cycles: number[];
  mean: number[];
  std: number[];
  min: number[];
  max: number[];
}

/** Min/max envelope for a single isolated well (drawn as a shaded band). */
interface BandData {
  color: string;
  cycles: number[];
  min: (number | null)[];
  max: (number | null)[];
}

export interface TooltipData {
  kind: "well" | "dark";
  label: string;
  channel: number;
  dye: string;
  color: string;
  cycle: number;
  mean: number;
  min: number;
  max: number;
  std: number;
  left: number;
  top: number;
}

export interface BuildChartConfig {
  wellCurves: WellCurve[];
  darkCurves: DarkCurve[];
  baseline: Baseline;
  scale: Scale;
  subtractDark: boolean;
  width: number;
  height: number;
  onHover: (t: TooltipData | null) => void;
}

const REF_DASH = [3, 3];
const DARK_DASH = [8, 5];

export function buildChart(cfg: BuildChartConfig): {
  data: uPlot.AlignedData;
  options: uPlot.Options;
} {
  const { wellCurves, darkCurves, baseline, scale, subtractDark } = cfg;
  const cycles = wellCurves[0]?.cycles ?? darkCurves[0]?.cycles ?? [];

  const darkByChannel = new Map<number, DarkCurve>();
  for (const d of darkCurves) darkByChannel.set(d.channel, d);

  const transform = (values: number[]): number[] =>
    baseline === "delta" ? deltaBaseline(values) : values;

  const rows: (number | null)[][] = [cycles.map((c) => c)];
  const meta: SeriesMeta[] = [];
  const series: uPlot.Series[] = [{ label: "Cycle" }];

  for (const curve of wellCurves) {
    const darkMean = darkByChannel.get(curve.channel)?.mean;
    const base =
      subtractDark && darkMean ? subtractSeries(curve.mean, darkMean) : curve.mean;
    rows.push(logSafe(transform(base), scale));
    meta.push({
      kind: "well",
      channel: curve.channel,
      label: curve.wellLabel,
      isReference: curve.isReference,
      cycles: curve.cycles,
      mean: curve.mean,
      std: curve.std,
      min: curve.min,
      max: curve.max,
    });
    series.push({
      label: `${curve.wellLabel} · ${channelDye(curve.channel)}`,
      stroke: channelColor(curve.channel),
      width: 1,
      dash: curve.isReference ? REF_DASH : undefined,
      points: { show: false },
    });
  }

  if (!subtractDark) {
    const presentChannels = new Set(wellCurves.map((c) => c.channel));
    for (const channel of presentChannels) {
      const dark = darkByChannel.get(channel);
      if (!dark) continue;
      rows.push(logSafe(transform(dark.mean), scale));
      meta.push({
        kind: "dark",
        channel,
        label: "dark",
        isReference: false,
        cycles: dark.cycles,
        mean: dark.mean,
        std: dark.std,
        min: dark.min,
        max: dark.max,
      });
      series.push({
        label: `dark · ${channelDye(channel)}`,
        stroke: channelColor(channel),
        width: 2,
        dash: DARK_DASH,
        points: { show: false },
      });
    }
  }

  // Min/max envelope band when exactly one well curve is shown.
  let band: BandData | null = null;
  if (wellCurves.length === 1) {
    const c = wellCurves[0]!;
    const darkMean = darkByChannel.get(c.channel)?.mean;
    const base = subtractDark && darkMean ? subtractSeries(c.mean, darkMean) : c.mean;
    const plottedMean = transform(base);
    const min: (number | null)[] = [];
    const max: (number | null)[] = [];
    for (let i = 0; i < c.mean.length; i++) {
      const off = (plottedMean[i] ?? 0) - (c.mean[i] ?? 0);
      const mn = (c.min[i] ?? 0) + off;
      const mx = (c.max[i] ?? 0) + off;
      min.push(scale === "log" && mn <= 0 ? null : mn);
      max.push(scale === "log" && mx <= 0 ? null : mx);
    }
    band = { color: channelColor(c.channel), cycles: c.cycles, min, max };
  }

  const options: uPlot.Options = {
    width: cfg.width,
    height: cfg.height,
    series,
    scales: {
      x: { time: false },
      y: { distr: scale === "log" ? 3 : 1 },
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
        label: yLabel(baseline, subtractDark),
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 62,
      },
    ],
    cursor: { focus: { prox: 24 }, points: { size: 6 } },
    focus: { alpha: 0.12 },
    legend: { show: false },
    plugins: [overlayPlugin(meta, band, cfg.onHover)],
  };

  return { data: rows as uPlot.AlignedData, options };
}

function yLabel(baseline: Baseline, subtractDark: boolean): string {
  const base = baseline === "delta" ? "ΔRFU (mean)" : "RFU (mean)";
  return subtractDark ? `${base} − dark` : base;
}

/**
 * Cursor plugin that (1) reports the nearest series for the tooltip, (2) draws an on-hover
 * whisker for the focused point — the min–max range with caps and a ±1σ box — and (3) draws
 * a shaded min/max envelope when a single well is isolated. Rendered as an SVG overlay on
 * the plot area, so it shares uPlot's coordinate system and updates on redraw/hover.
 */
function overlayPlugin(
  meta: SeriesMeta[],
  band: BandData | null,
  onHover: (t: TooltipData | null) => void,
): uPlot.Plugin {
  let svg: SVGSVGElement;
  let bandPath: SVGPathElement;
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
          overflow: "visible",
          zIndex: "5",
        });
        bandPath = document.createElementNS(SVG_NS, "path");
        bandPath.setAttribute("fill", band ? band.color : "none");
        bandPath.setAttribute("fill-opacity", "0.13");
        bandPath.setAttribute("stroke", "none");
        svg.appendChild(bandPath);

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
        if (!band) {
          bandPath?.setAttribute("d", "");
          return;
        }
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
        bandPath.setAttribute(
          "d",
          top.length ? `M${top.join("L")}L${bot.reverse().join("L")}Z` : "",
        );
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
          if (val == null) continue;
          const py = u.valToPos(val, "y");
          const dist = Math.abs(py - top);
          if (dist < bestDist) {
            bestDist = dist;
            best = s;
          }
        }
        const m = best > 0 ? meta[best - 1] : undefined;
        if (!m || bestDist > 24) {
          onHover(null);
          group.style.display = "none";
          return;
        }

        const plotted = (u.data[best] as (number | null)[])[idx] as number;
        const offset = plotted - (m.mean[idx] ?? 0);
        const x = u.valToPos(m.cycles[idx] ?? 0, "x");
        const yMax = u.valToPos((m.max[idx] ?? 0) + offset, "y");
        const yMin = u.valToPos((m.min[idx] ?? 0) + offset, "y");
        const yHi = u.valToPos(plotted + (m.std[idx] ?? 0), "y");
        const yLo = u.valToPos(plotted - (m.std[idx] ?? 0), "y");
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

        onHover({
          kind: m.kind,
          label: m.label,
          channel: m.channel,
          dye: channelDye(m.channel),
          color,
          cycle: m.cycles[idx] ?? 0,
          mean: m.mean[idx] ?? 0,
          min: m.min[idx] ?? 0,
          max: m.max[idx] ?? 0,
          std: m.std[idx] ?? 0,
          left,
          top,
        });
      },
    },
  };
}
