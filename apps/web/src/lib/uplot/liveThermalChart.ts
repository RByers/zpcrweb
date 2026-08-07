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

/**
 * Where the x-axis ends when the run's length isn't known yet — long enough that the first minute
 * of a run doesn't draw a wildly-rescaling axis, short enough to be an honest placeholder.
 */
const FALLBACK_SPAN_S = 600;

export function buildLiveThermalChart(cfg: {
  width: number;
  height: number;
  /** The run's expected total length (`useLiveThermalHistory`), or null while it's unknown. */
  estimatedTotalS: number | null;
  onHover: (t: LiveThermalTooltipData | null) => void;
}): uPlot.Options {
  return {
    width: cfg.width,
    height: cfg.height,
    series: [{ label: "t" }, { label: "block", stroke: TRACE_COLOR, width: 2, points: { show: false } }],
    scales: {
      x: {
        time: false,
        /**
         * The whole run, from zero, rather than just the part of it that has happened — so the
         * trace advances across a still frame and its position reads as progress, instead of the
         * axis restretching every poll to keep the line filling the plot.
         *
         * `max` still wins if the run outlives its estimate: the estimate runs optimistic (see
         * `LiveThermalHistory.estimatedTotalS`), and a trace running off the right edge would be
         * worse than an axis that grows late in a long run.
         */
        range: (_u, _min, max) => [0, Math.max(cfg.estimatedTotalS ?? FALLBACK_SPAN_S, max)],
      },
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
