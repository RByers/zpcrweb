import uPlot from "uplot";
import { deltaBaseline, type WellCurve } from "@zpcrweb/core";
import { channelColor, channelDye } from "../channelColors";
import type { Baseline, Scale } from "../../state/useZpcrStore";

/** Values <= 0 are undefined on a log axis; render them as gaps. */
function logSafe(values: (number | null)[]): (number | null)[] {
  return values.map((v) => (v == null || v <= 0 ? null : v));
}

/**
 * Build uPlot's aligned data from the visible curves. `data[0]` is the shared cycle axis;
 * each subsequent row is one curve's plotted y-values (raw or delta-baselined, log-guarded).
 * The returned `meta` array is index-aligned with the series (offset by the x row) so the
 * tooltip can recover full stats for the hovered line.
 */
export function buildChartData(
  curves: WellCurve[],
  baseline: Baseline,
  scale: Scale,
): { data: uPlot.AlignedData; meta: WellCurve[] } {
  const cycles = curves[0]?.cycles ?? [];
  const rows: (number | null)[][] = [cycles.map((c) => c)];
  for (const curve of curves) {
    let values: (number | null)[] =
      baseline === "delta" ? deltaBaseline(curve.mean) : curve.mean.slice();
    if (scale === "log") values = logSafe(values);
    rows.push(values);
  }
  return { data: rows as uPlot.AlignedData, meta: curves };
}

export interface TooltipData {
  wellLabel: string;
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

/** A cursor plugin that finds the nearest series under the pointer and reports its stats. */
function tooltipPlugin(
  meta: WellCurve[],
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
        // Nearest series by vertical distance at this x index.
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
        if (best < 0 || bestDist > 24) {
          onHover(null);
          return;
        }
        const curve = meta[best - 1];
        if (!curve) {
          onHover(null);
          return;
        }
        onHover({
          wellLabel: curve.wellLabel,
          channel: curve.channel,
          dye: channelDye(curve.channel),
          color: channelColor(curve.channel),
          cycle: curve.cycles[idx] ?? 0,
          mean: curve.mean[idx] ?? 0,
          min: curve.min[idx] ?? 0,
          max: curve.max[idx] ?? 0,
          std: curve.std[idx] ?? 0,
          left: left,
          top: top,
        });
      },
    },
  };
}

/** Build uPlot options for the given series metadata and dimensions. */
export function buildChartOptions(
  meta: WellCurve[],
  baseline: Baseline,
  scale: Scale,
  width: number,
  height: number,
  onHover: (t: TooltipData | null) => void,
): uPlot.Options {
  const series: uPlot.Series[] = [
    { label: "Cycle" },
    ...meta.map((curve) => ({
      label: `${curve.wellLabel} · ${channelDye(curve.channel)}`,
      stroke: channelColor(curve.channel),
      width: 1,
      points: { show: false },
    })),
  ];

  return {
    width,
    height,
    series,
    scales: {
      x: { time: false },
      y: { distr: scale === "log" ? 3 : 1 },
    },
    axes: [
      {
        stroke: "#8aa0c0",
        // Cycles are integers: one split per cycle. A tick renders on every cycle, but the
        // gridline and the axis label appear only every 5 cycles, so the axis never shows
        // fractional values like 2.5 or 7.5.
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
        label: baseline === "delta" ? "ΔRFU (mean)" : "RFU (mean)",
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 60,
      },
    ],
    cursor: {
      focus: { prox: 24 },
      points: { size: 6 },
    },
    focus: { alpha: 0.12 },
    legend: { show: false },
    plugins: [tooltipPlugin(meta, onHover)],
  };
}
