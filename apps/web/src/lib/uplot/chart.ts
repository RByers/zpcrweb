import uPlot from "uplot";
import {
  deltaBaseline,
  subtractSeries,
  type DarkCurve,
  type WellCurve,
} from "@zpcrweb/core";
import { channelColor, channelDye } from "../channelColors";
import type { Baseline, Scale } from "../../state/useZpcrStore";

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

/**
 * Build uPlot data + options from the visible well curves and the dark curves.
 *
 * - Each well curve is optionally dark-subtracted (per its channel), then optionally
 *   ΔRFU-baselined, then log-guarded.
 * - Reference-row curves are drawn dashed.
 * - When dark subtraction is OFF, one dashed line per present channel shows that channel's
 *   dark (LED-off) background level, transformed the same way as the curves.
 */
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

  // Well curves.
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

  // Dark baselines (only when not subtracting), one per channel that has visible curves.
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
        // Integer cycles: a tick per cycle, gridline + label only every 5.
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
    plugins: [tooltipPlugin(meta, cfg.onHover)],
  };

  return { data: rows as uPlot.AlignedData, options };
}

function yLabel(baseline: Baseline, subtractDark: boolean): string {
  const base = baseline === "delta" ? "ΔRFU (mean)" : "RFU (mean)";
  return subtractDark ? `${base} − dark` : base;
}

/** A cursor plugin that finds the nearest series under the pointer and reports its stats. */
function tooltipPlugin(
  meta: SeriesMeta[],
  onHover: (t: TooltipData | null) => void,
): uPlot.Plugin {
  return {
    hooks: {
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
          return;
        }
        onHover({
          kind: m.kind,
          label: m.label,
          channel: m.channel,
          dye: channelDye(m.channel),
          color: channelColor(m.channel),
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
