import uPlot from "uplot";
import type { DarkCurve, TemperatureCurve } from "@zpcrweb/core";
import { channelColor, channelLabel } from "../channelColors";
import { tempColor } from "../tempColors";
import type { Baseline, BandsMode, Scale } from "../../state/useZpcrStore";

const SVG_NS = "http://www.w3.org/2000/svg";

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
}

/** Values <= 0 are undefined on a log axis; render them as gaps. */
function logSafe(values: number[], scale: Scale): (number | null)[] {
  if (scale !== "log") return values;
  return values.map((v) => (v <= 0 ? null : v));
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

/**
 * Per-cycle adjust for a well curve. ΔRFU plots drift from the matching factory value when one
 * exists (`shift = -factory`), else drift from the run's own first cycle (deltaBaseline's
 * behavior). "%" plots the value as a percentage of the matching factory value; with no factory
 * value to divide by, it has no defined meaning, so it falls back to raw (identity) like ΔRFU
 * falls back to deltaBaseline.
 */
function wellAdjust(values: number[], factory: number[] | undefined, baseline: Baseline): Adjust[] {
  if (baseline === "delta" && factory) {
    return values.map((_, i) => ({ scale: 1, shift: -(factory[i] ?? 0) }));
  }
  if (baseline === "delta") {
    const shift = -(values[0] ?? 0);
    return values.map(() => ({ scale: 1, shift }));
  }
  if (baseline === "percent" && factory) {
    return values.map((_, i) => {
      const f = factory[i] ?? 0;
      return { scale: f !== 0 ? 100 / f : 1, shift: 0 };
    });
  }
  return values.map(() => IDENTITY_ADJUST);
}

/** A factory-calibration reference value, overlaid as a dotted flat line per (channel, col) —
 * see the Reference view. Purely a display overlay, like {@link DarkCurve}. */
export interface FactoryCurve {
  channel: number;
  col: number;
  /** Constant factory mean, repeated once per cycle so it aligns with the x axis. */
  mean: number[];
}

/** Per-series metadata, index-aligned with uPlot series (offset by the x row). */
interface SeriesMeta {
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
} {
  const { wellCurves, darkCurves, factoryCurves, tempCurves, baseline, scale } = cfg;
  const cycles =
    wellCurves[0]?.cycles ?? darkCurves[0]?.cycles ?? tempCurves[0]?.cycles ?? [];

  const darkByChannel = new Map<number, DarkCurve>();
  for (const d of darkCurves) darkByChannel.set(d.channel, d);

  const factoryByKey = new Map<string, FactoryCurve>();
  for (const f of factoryCurves) factoryByKey.set(`${f.channel},${f.col}`, f);

  // Dark/temp series have no factory match, so "%" has no meaning for them — deltaBaseline
  // still applies under ΔRFU, but percent falls back to identity (raw values).
  const nonWellAdjust = (values: number[]): Adjust[] =>
    baseline === "delta"
      ? values.map(() => ({ scale: 1, shift: -(values[0] ?? 0) }))
      : values.map(() => IDENTITY_ADJUST);

  const rows: (number | null)[][] = [cycles.map((c) => c)];
  const meta: SeriesMeta[] = [];
  const series: uPlot.Series[] = [{ label: "Cycle" }];
  // Kept alongside `meta` so computeBand (below) can reuse the exact same per-cycle mapping
  // each well curve's line was plotted with, rather than re-deriving it.
  const wellAdjusts: Adjust[][] = [];

  for (const curve of wellCurves) {
    const factory = factoryByKey.get(`${curve.channel},${curve.col}`);
    const adjust = wellAdjust(curve.mean, factory?.mean, baseline);
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
    });
    series.push({
      label: `${curve.wellLabel} · ${curve.dyeLabel}`,
      stroke: channelColor(curve.channel),
      width: 1,
      dash: curve.isReference ? REF_DASH : undefined,
      points: { show: false },
    });
  }

  const presentChannels = new Set(wellCurves.map((c) => c.channel));
  for (const channel of presentChannels) {
    const dark = darkByChannel.get(channel);
    if (!dark) continue;
    const adjust = nonWellAdjust(dark.mean);
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

  // The factory line is redundant (and misleading — it'd plot as a flat 0) once ΔRFU is
  // computed relative to it above, so it's only drawn against the raw/percent baselines —
  // under "%" it plots as a flat 100, a visible reference for "on-spec".
  if (baseline !== "delta") {
    const presentPairs = new Set(wellCurves.map((c) => `${c.channel},${c.col}`));
    for (const key of presentPairs) {
      const factory = factoryByKey.get(key);
      if (!factory) continue;
      const adjust = wellAdjust(factory.mean, factory.mean, baseline);
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
        label: yLabel(baseline),
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
    plugins: [overlayPlugin(meta, bands, cfg.onHover)],
  };

  return { data: rows as uPlot.AlignedData, options };
}

function yLabel(baseline: Baseline): string {
  if (baseline === "delta") return "ΔRFU (mean)";
  if (baseline === "percent") return "RFU (% of factory)";
  return "RFU (mean)";
}

/**
 * Cursor plugin that (1) reports the nearest series for the tooltip, (2) draws an on-hover
 * whisker for the focused point — the min–max range with caps and a ±1σ box — and (3) draws
 * a shaded min/max envelope when a single well is isolated. Rendered as an SVG overlay on
 * the plot area, so it shares uPlot's coordinate system and updates on redraw/hover.
 */
function overlayPlugin(
  meta: SeriesMeta[],
  bands: BandData[],
  onHover: (t: TooltipData | null) => void,
): uPlot.Plugin {
  let svg: SVGSVGElement;
  let bandGroup: SVGGElement;
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
        bandGroup = document.createElementNS(SVG_NS, "g");
        svg.appendChild(bandGroup);

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
        if (!m || bestDist > 24) {
          onHover(null);
          group.style.display = "none";
          return;
        }

        const plotted = (u.data[best] as (number | null)[])[idx] as number;

        if (m.kind === "temp") {
          // A temperature is a single scalar per read — no min/max/σ to whisker.
          group.style.display = "none";
          onHover({
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
          });
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

        onHover({
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
        });
      },
    },
  };
}
