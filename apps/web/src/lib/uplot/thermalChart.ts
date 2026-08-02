/**
 * The thermal-profile chart: uPlot options and series for what the block actually did during a
 * run — wall-clock time on x, block temperature on y, built from a `.alf` run report's
 * {@link ThermalProfile} (`alf.md` §7.6).
 *
 * A third builder beside `chart.ts` (cycle axis, RFU) and `calChart.ts` (temperature axis, RFU)
 * because it shares neither axis with either: this is the only plot in the app whose x is time
 * and whose y is a setpoint rather than a reading. What it does share is the SVG-overlay
 * plugin pattern and the `.chart` CSS, which is where the sharing pays.
 *
 * **Nothing here is interpolated or smoothed.** Core's decomposition emits two vertices per span
 * (`alf.md` §7.6), and the straight lines uPlot draws between them are exactly the claim being
 * made: the block moved to the setpoint over `took − hold`, then sat there. A real ramp is a
 * curve, and the report does not record its shape — drawing one would invent data.
 *
 * **One line, not two.** Ramps and holds were once separate series, dashed against solid, to
 * make the decomposition explicit. It read as two competing traces rather than one temperature
 * over time, which is the opposite of what the plot is for — the split is already visible in the
 * geometry, since a ramp is the sloped part and a hold the flat part. So the trace is a single
 * solid line, and the phase survives only in the tooltip, where it costs nothing to say.
 */

import uPlot from "uplot";
import type { ThermalProfile, ThermalSegment } from "@zpcrweb/core";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The block temperature itself — one line, ramps and holds alike (see the note above). */
const TRACE_COLOR = "#22d3ee";
/** Plate reads — the numbered points, coloured apart from the trace they sit on. */
const READ_COLOR = "#ff4fa3";
/** A `GRAD` step's row-to-row span, above and below the midpoint the trace plots. */
const GRADIENT_COLOR = "rgba(34, 211, 238, 0.4)";
const GRADIENT_DASH = [2, 3];

/**
 * Two vertices can land on the same second — a step whose hold consumed its whole span begins
 * where the previous one ended, and the log's resolution is one second (`alf.md` §7.4). uPlot's
 * aligned data needs a strictly increasing x, so a coincident vertex is nudged by this much:
 * far below one pixel at any plot width, so the jump still draws as vertical.
 */
const EPSILON = 1e-3;

/** What the cursor is over, for the host component's tooltip. */
export interface ThermalTooltipData {
  /** Seconds since the run's first logged step. */
  atSeconds: number;
  temperatureC: number;
  segment: ThermalSegment;
  /** Set when this vertex is where a plate read begins. */
  readIndex?: number;
  left: number;
  top: number;
}

export interface BuildThermalChartConfig {
  profile: ThermalProfile;
  width: number;
  height: number;
  onHover: (t: ThermalTooltipData | null) => void;
}

/** `h:mm:ss` past the start of the run, or `m:ss` for a run under an hour. */
export function elapsedLabel(seconds: number, withHours: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return withHours
    ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${mm}:${String(ss).padStart(2, "0")}`;
}

/** Tick spacings that read as times rather than as round numbers of seconds. */
const TIME_STEPS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800];

function timeSplits(min: number, max: number, targetTicks: number): number[] {
  const span = Math.max(1, max - min);
  const step = TIME_STEPS.find((s) => span / s <= targetTicks) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

/** One x position on the plot, and what the profile says is happening there. */
interface Vertex {
  x: number;
  /** Block temperature — the single trace, whatever phase produced it. */
  temp: number;
  gradLow: number | null;
  gradHigh: number | null;
  read: number | null;
  segment: ThermalSegment;
  readIndex?: number;
}

/**
 * Turn the profile's spans into plot vertices — two per span, which is all a straight-line
 * segment needs. Every one feeds the same series: a span's end vertex and the next span's start
 * vertex carry the same value at the same moment, so the whole run is one unbroken line whose
 * slopes are the ramps and whose flats are the holds.
 */
function vertices(profile: ThermalProfile): Vertex[] {
  const out: Vertex[] = [];
  const readAt = new Map<number, number>();
  for (const r of profile.reads) readAt.set(r.atSeconds, r.readIndex);

  const push = (t: number, seg: ThermalSegment, v: number, isStart: boolean) => {
    const readIndex = isStart ? readAt.get(t) : undefined;
    // Strictly increasing x, per EPSILON above.
    const last = out[out.length - 1];
    const x = last && t <= last.x ? last.x + EPSILON : t;
    // A gradient's spread belongs to the hold it was held at, not to the ramp into it.
    const spread = seg.gradient && seg.phase !== "ramp" ? seg.gradient : null;
    out.push({
      x,
      temp: v,
      gradLow: spread ? spread.lowC : null,
      gradHigh: spread ? spread.highC : null,
      read: readIndex !== undefined ? v : null,
      segment: seg,
      ...(readIndex !== undefined ? { readIndex } : {}),
    });
  };

  for (const seg of profile.segments) {
    push(seg.startSeconds, seg, seg.fromC, true);
    push(seg.endSeconds, seg, seg.toC, false);
  }
  return out;
}

export function buildThermalChart(cfg: BuildThermalChartConfig): {
  data: uPlot.AlignedData;
  options: uPlot.Options;
  vertices: Vertex[];
} {
  const verts = vertices(cfg.profile);
  const withHours = cfg.profile.totalSeconds >= 3600;
  const hasGradient = verts.some((v) => v.gradLow !== null);

  const data: uPlot.AlignedData = [
    verts.map((v) => v.x),
    verts.map((v) => v.temp),
    verts.map((v) => v.gradLow),
    verts.map((v) => v.gradHigh),
    verts.map((v) => v.read),
  ] as uPlot.AlignedData;

  const options: uPlot.Options = {
    width: cfg.width,
    height: cfg.height,
    series: [
      { label: "t" },
      { label: "block", stroke: TRACE_COLOR, width: 2, points: { show: false } },
      // The gradient's low and high rows, shown only where a GRAD step is running.
      {
        label: "gradient low",
        show: hasGradient,
        stroke: GRADIENT_COLOR,
        width: 1,
        dash: GRADIENT_DASH,
        points: { show: false },
      },
      {
        label: "gradient high",
        show: hasGradient,
        stroke: GRADIENT_COLOR,
        width: 1,
        dash: GRADIENT_DASH,
        points: { show: false },
      },
      // Points only: the reads are moments on the trace, not a line of their own.
      {
        label: "plate read",
        stroke: READ_COLOR,
        fill: READ_COLOR,
        paths: () => null,
        points: { show: true, size: 6, stroke: READ_COLOR, fill: READ_COLOR },
      },
    ],
    scales: {
      x: { time: false, range: (_u, min, max) => [min, max] },
      y: {
        // Headroom above for the read numbers, which are drawn over the plot.
        range: (_u, min, max) => {
          const pad = Math.max(2, (max - min) * 0.08);
          return [min - pad, max + pad * 2];
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
        values: (_u, splits) => splits.map((v) => elapsedLabel(v, withHours)),
        label: "Time from start of run",
        labelSize: 24,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
      },
      {
        stroke: "#8aa0c0",
        grid: { stroke: "rgba(120,200,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(120,200,255,0.12)", width: 1 },
        values: (_u, splits) => splits.map((v) => `${v}`),
        label: "Block temperature (°C)",
        labelSize: 30,
        labelFont: "12px system-ui",
        font: "11px ui-monospace, monospace",
        size: 54,
      },
    ],
    cursor: { focus: { prox: 24 }, points: { show: false } },
    legend: { show: false },
    plugins: [readLabelPlugin(verts, cfg.onHover)],
  };

  return { data, options, vertices: verts };
}

/**
 * Numbers the plate reads on the plot, and reports the vertex under the cursor.
 *
 * The numbers are the point of the markers: a read's index is the `Read0000N.Plateread` it wrote
 * (`alf.md` §7.5), so the plot is what connects a curve's cycle to a wall-clock moment. A
 * 45-cycle run has 45 of them, though, and 45 labels in 800 px is a smear — so labels are thinned
 * to whatever fits, keeping the first and the last, while **every** read still gets its point.
 * Thinning the labels rather than the points keeps the count on screen honest.
 */
function readLabelPlugin(
  verts: Vertex[],
  onHover: (t: ThermalTooltipData | null) => void,
): uPlot.Plugin {
  let svg: SVGSVGElement;
  let group: SVGGElement;

  /** Minimum gap between two read numbers, in CSS pixels. */
  const LABEL_GAP = 22;

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
        group = document.createElementNS(SVG_NS, "g");
        svg.appendChild(group);
        u.over.appendChild(svg);
      },

      draw: (u: uPlot) => {
        group.replaceChildren();
        const reads = verts.filter((v) => v.readIndex !== undefined);
        if (reads.length === 0) return;

        // Which labels fit: first and last always, then as many between as clear LABEL_GAP.
        const positions = reads.map((v) => u.valToPos(v.x, "x"));
        const lastPos = positions[positions.length - 1]!;
        const show = reads.map(() => false);
        show[0] = true;
        show[show.length - 1] = true;
        let kept = positions[0]!;
        for (let i = 1; i < reads.length - 1; i++) {
          const x = positions[i]!;
          if (x - kept >= LABEL_GAP && lastPos - x >= LABEL_GAP) {
            show[i] = true;
            kept = x;
          }
        }

        reads.forEach((v, i) => {
          if (!show[i]) return;
          const x = positions[i]!;
          const y = u.valToPos(v.read!, "y");
          const text = document.createElementNS(SVG_NS, "text");
          text.setAttribute("x", String(x));
          text.setAttribute("y", String(y - 9));
          text.setAttribute("text-anchor", "middle");
          text.setAttribute("font-size", "10");
          text.setAttribute("font-family", "ui-monospace, monospace");
          text.setAttribute("fill", READ_COLOR);
          // Dark halo, so a number stays legible where it lands on the trace or the grid.
          text.setAttribute("paint-order", "stroke");
          text.setAttribute("stroke", "#0b0d12");
          text.setAttribute("stroke-width", "3");
          text.textContent = String(v.readIndex);
          group.appendChild(text);
        });
      },

      setCursor: (u: uPlot) => {
        const idx = u.cursor.idx;
        const { left, top } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) {
          onHover(null);
          return;
        }
        const v = verts[idx];
        if (!v) {
          onHover(null);
          return;
        }
        onHover({
          atSeconds: Math.round(v.x),
          temperatureC: v.temp,
          segment: v.segment,
          ...(v.readIndex !== undefined ? { readIndex: v.readIndex } : {}),
          left,
          top,
        });
      },
    },
  };
}
