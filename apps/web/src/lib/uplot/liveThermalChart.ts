/**
 * The live thermal chart: block temperature against elapsed run time, built from the status-poll
 * samples an active run is producing right now (`useLiveThermalHistory`) — contrast
 * `thermalChart.ts`, which plots a *finished* run's recorded profile from its `.alf` report.
 *
 * Deliberately simpler than that one: `STATUS?` reports a temperature and an elapsed second, not a
 * step or a phase, so there's no ramp/hold/read decomposition to draw — one line, and a tooltip
 * with just those two numbers.
 */
import uPlot from "uplot";
import { elapsedLabel, timeSplits } from "./thermalChart";
import type { LiveThermalSample } from "../../state/useLiveThermalHistory";

const TRACE_COLOR = "#22d3ee";

export interface LiveThermalTooltipData {
  atSeconds: number;
  temperatureC: number;
  left: number;
  top: number;
}

export function liveThermalData(samples: LiveThermalSample[]): uPlot.AlignedData {
  return [samples.map((s) => s.atSeconds), samples.map((s) => s.blockTempC)] as uPlot.AlignedData;
}

export function buildLiveThermalChart(cfg: {
  width: number;
  height: number;
  onHover: (t: LiveThermalTooltipData | null) => void;
}): uPlot.Options {
  return {
    width: cfg.width,
    height: cfg.height,
    series: [{ label: "t" }, { label: "block", stroke: TRACE_COLOR, width: 2, points: { show: false } }],
    scales: {
      x: { time: false },
      y: {
        range: (_u, min, max) => {
          const pad = Math.max(2, (max - min) * 0.15);
          return [min - pad, max + pad];
        },
      },
    },
    axes: [
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        splits: (u, _i, min, max) =>
          timeSplits(min, max, Math.max(3, Math.floor(u.bbox.width / devicePixelRatio / 90))),
        values: (_u, splits) => splits.map((v) => elapsedLabel(v, true)),
        font: "11px ui-monospace, monospace",
      },
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        values: (_u, splits) => splits.map((v) => `${v}`),
        font: "11px ui-monospace, monospace",
        size: 38,
      },
    ],
    cursor: { focus: { prox: 24 }, points: { show: true, size: 5, stroke: TRACE_COLOR, fill: TRACE_COLOR } },
    legend: { show: false },
    hooks: {
      setCursor: [
        (u: uPlot) => {
          const idx = u.cursor.idx;
          const { left, top } = u.cursor;
          if (idx == null || left == null || top == null || left < 0) {
            cfg.onHover(null);
            return;
          }
          const x = u.data[0]?.[idx];
          const y = u.data[1]?.[idx];
          if (x == null || y == null) {
            cfg.onHover(null);
            return;
          }
          cfg.onHover({ atSeconds: x, temperatureC: y, left, top });
        },
      ],
    },
  };
}
