/**
 * Turning a melt curve into a melting temperature (`melt.md` §4–§6).
 *
 * A melt curve is a sigmoid falling with temperature: fluorescence is high while the dye is bound
 * to double-stranded product and drops as the product dissociates. The temperature that identifies
 * the product — the **Tm** — is the steepest point of that drop, which is a *peak* of the negative
 * first derivative −dF/dT rather than anything visible on the curve itself. So the shape a reader
 * wants and the number the run is for both come from the derivative, and this module computes it.
 *
 * **This is not the amplification pipeline and shares nothing with it.** No baseline is fitted, no
 * threshold is resolved and no Cq is taken: a melt has no cycles to cross a threshold at, and the
 * baseline concept of `threshold.md` §3 — a flat early region the curve later leaves — has no
 * counterpart on a ramp that is sloping from its first point. Running any of it here would produce
 * confident-looking numbers about nothing.
 */

import { meltSegmentFor, type MeltSegment } from "./melt.js";
import type { WellCurve, Zpcr } from "./types.js";

/**
 * Points excluded at each end of the derivative when looking for the peak.
 *
 * The first and last points are where both instruments' derivatives are least trustworthy — the
 * smoothing window is truncated there and the ramp is still settling — and it is exactly where
 * spurious calls land: a Biomeme export reports `60.5` (its first grid point) for several
 * signal-free wells, and an unguarded argmax over the committed CFX run puts flat wells at the
 * 95 °C edge. Two points at 0.5 °C a rung is a degree of margin.
 */
const PEAK_EDGE_EXCLUDE = 2;

/**
 * How much a curve's fluorescence must move across the ramp, as a fraction of the curve's own
 * median level, before a Tm is called for it at all (`melt.md` §5.1).
 *
 * Every curve has a highest point on its derivative, so without a gate every empty well on the
 * plate is handed a confident melting temperature. The gate is on the **curve**, not on the peak:
 * what makes a peak real is that the fluorescence it describes actually fell, and expressing that
 * as a fraction of the well's own level makes one constant work across instruments whose readings
 * differ by an order of magnitude.
 *
 * **Measured**, and the reason it is this and not a signal-to-noise ratio (`melt.md` §B.1): across
 * the two committed melt runs, curves carrying real product score 0.060 – 1.98 and curves on dark
 * channels or empty wells score 0.0008 – 0.017. This sits between, with roughly a factor of two of
 * margin either way. A noise-relative test was tried first and does **not** separate them at all —
 * a flat curve is also a smooth one, so its noise estimate collapses and its meaningless peak
 * scores as significant (real curves 1.7 – 6.6 σ, junk 1.2 – 4.0 σ, thoroughly overlapping).
 */
export const MELT_MIN_SIGNAL_FRACTION = 0.03;

/** Savitzky–Golay quadratic smoothing, window 5 — coefficients and their normalizing divisor. */
const SG5_WEIGHTS = [-3, 12, 17, 12, -3] as const;
const SG5_DIVISOR = 35;

/**
 * Savitzky–Golay smoothing of `values`, quadratic over a 5-point window.
 *
 * A melt derivative is a difference of neighbouring readings, which multiplies the readings' own
 * noise; smoothing first is what makes the peak of §5 a property of the curve rather than of the
 * loudest pair of points. Quadratic rather than a plain moving average because a moving average
 * flattens peaks — and the peak's height and position are the entire result here.
 *
 * The two points at each end keep their original values: a truncated window would bias them, and
 * {@link PEAK_EDGE_EXCLUDE} discards them for peak-finding anyway. Smoothing is in index space,
 * which is exact on the uniform grid a `SAMPLETEMP` axis gives (`melt.md` §3) and an approximation
 * on the unevenly spaced `BLOCKTEMP` fallback.
 */
export function savitzkyGolay5(values: number[]): number[] {
  if (values.length < 5) return [...values];
  const out = [...values];
  for (let i = 2; i < values.length - 2; i++) {
    let sum = 0;
    for (let j = 0; j < 5; j++) sum += (SG5_WEIGHTS[j] as number) * (values[i - 2 + j] as number);
    out[i] = sum / SG5_DIVISOR;
  }
  return out;
}

/**
 * −dF/dT per °C: smooth the curve ({@link savitzkyGolay5}), then take a central difference.
 *
 * Negated so a melting product — falling fluorescence — reads as a positive peak, which is the
 * convention every melt plot uses. The division is by the actual temperature span between the
 * neighbours rather than by an assumed increment, so an unevenly spaced axis still yields a true
 * per-°C rate. The end points repeat their neighbour's value, having no pair to sit between.
 */
export function meltDerivative(temperaturesC: number[], values: number[]): number[] {
  const n = values.length;
  if (n < 3) return new Array(n).fill(0);
  const smoothed = savitzkyGolay5(values);
  const derivative = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const span = (temperaturesC[i + 1] as number) - (temperaturesC[i - 1] as number);
    derivative[i] = span === 0 ? 0 : -((smoothed[i + 1] as number) - (smoothed[i - 1] as number)) / span;
  }
  derivative[0] = derivative[1] as number;
  derivative[n - 1] = derivative[n - 2] as number;
  return derivative;
}

/**
 * Whether a curve moved enough across the ramp for its derivative's highest point to mean
 * anything — see {@link MELT_MIN_SIGNAL_FRACTION}.
 *
 * Exported because "did this well melt at all" is a question worth asking on its own, and because
 * it is the one judgement standing between an empty well and a confident-looking Tm.
 */
export function hasMeltSignal(values: number[]): boolean {
  if (values.length < 3) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  // The median level rather than the mean: a curve that spends part of the ramp saturated or
  // dropping shouldn't have its own transition drag the yardstick it is measured against.
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const level = Math.abs(sorted[sorted.length >> 1] as number);
  if (!(level > 0)) return false;
  return (max - min) / level >= MELT_MIN_SIGNAL_FRACTION;
}

/** A called melt peak. */
export interface MeltPeak {
  /** Peak temperature, °C — the melting temperature. */
  tmC: number;
  /** The derivative's value at the peak. */
  height: number;
}

/**
 * The highest point of a derivative curve, refined to finer than the grid it was sampled on.
 *
 * A **primitive**: it locates the maximum and says where it is, and does not judge whether the
 * curve deserved to have one located. That judgement is {@link hasMeltSignal}, applied by
 * {@link computeMeltAnalysis} — kept apart because one is a property of the derivative and the
 * other of the fluorescence it came from, and mixing them made the peak finder untestable in
 * isolation. `null` only when there are too few points to have an interior maximum.
 *
 * One peak, deliberately: a melt often has more than one (a primer-dimer peak sits below the
 * product's), and they remain visible on the plotted derivative, but only the tallest is *called*.
 *
 * The refinement fits a parabola through the winning point and its two neighbours and reports its
 * vertex, which recovers a Tm between grid points — worth doing because the grid is coarse next to
 * the precision the number is read at (a 0.5 °C rung against replicate spreads of about 0.1 °C).
 */
export function meltPeak(temperaturesC: number[], derivative: number[]): MeltPeak | null {
  const first = PEAK_EDGE_EXCLUDE;
  const last = derivative.length - 1 - PEAK_EDGE_EXCLUDE;
  if (last <= first) return null;

  let best = first;
  for (let i = first; i <= last; i++) {
    if ((derivative[i] as number) > (derivative[best] as number)) best = i;
  }

  const height = derivative[best] as number;
  // A curve whose fluorescence only ever rises has no melting transition in it at all.
  if (!(height > 0)) return null;

  const y0 = derivative[best - 1] as number;
  const y1 = height;
  const y2 = derivative[best + 1] as number;
  const denominator = y0 - 2 * y1 + y2;
  // A flat trio has no vertex to find; the sample's own temperature is then the best answer.
  const raw = denominator === 0 ? 0 : (0.5 * (y0 - y2)) / denominator;
  // Clamp to half a grid step. The parabola is a *refinement* of a maximum this code has already
  // located, so its vertex belongs between that sample's neighbours; a fit through a near-flat or
  // still-rising trio (which is what the ends of the search window give) otherwise solves to a
  // vertex far outside the data — unclamped, this put melting temperatures at 38 °C on a ramp
  // that starts at 65.
  const offset = Number.isFinite(raw) ? Math.max(-0.5, Math.min(0.5, raw)) : 0;
  const below = temperaturesC[best] as number;
  const spacing =
    offset >= 0
      ? (temperaturesC[best + 1] as number) - below
      : below - (temperaturesC[best - 1] as number);

  return { tmC: below + offset * spacing, height };
}

/** One well/channel melt curve, its derivative and its Tm. */
export interface MeltCurve {
  /** Optical channel; for a `Zpcr.dyeSpace` source this indexes the dye, as everywhere else. */
  channel: number;
  /** Row index 0–8 (8 = reference row). */
  row: number;
  /** Column index 0–11. */
  col: number;
  /** Human label such as `A3`. */
  wellLabel: string;
  /** True when this curve is from the reference row. */
  isReference: boolean;
  /** Ascending °C — the segment's axis, aligned index-for-index with {@link rfu}. */
  temperaturesC: number[];
  /** Mean fluorescence at each temperature: the melt curve as measured. */
  rfu: number[];
  /**
   * −dF/dT per °C. Read from the source where it states one and derived from {@link rfu} where it
   * doesn't — one field either way, and no caller can tell which happened (`melt.md` §6).
   */
  derivative: number[];
  /** Melting temperature, °C, or null where no peak stands clear of the noise. */
  tmC: number | null;
  /** The derivative's height at {@link tmC}, or null when there is no Tm. */
  peakHeight: number | null;
}

/** A run's melt step, every curve on it, and the Tm each one gives. */
export interface MeltAnalysis {
  /** The step this covers, and its temperature axis. */
  segment: MeltSegment;
  /** One entry per well and channel, reference row excluded. */
  curves: MeltCurve[];
  /** Optical channels that hold data, ascending. */
  available: number[];
  /**
   * Whether the derivatives were read from the source or computed here. Uniform across a run and
   * worth *reporting* ("as reported by the instrument"), but never a fork: both kinds go through
   * the same {@link meltPeak}, so a Tm means one thing whatever produced the file.
   */
  derivativeSource: "file" | "computed";
}

/** Options for {@link computeMeltAnalysis}. */
export interface MeltAnalysisOptions {
  /** Include reference-row wells (row 8). Default false, as for amplification curves. */
  includeReference?: boolean;
}

/**
 * **The** melt derivation: every curve of one melt step, with its derivative and its Tm.
 *
 * Melt curves are analysed in **channel space** — one curve per optical channel, with no
 * channel→dye color separation. A melt is read on a single channel in practice, and staying in
 * channel space is what lets this work with no plate definition and no password, which the
 * committed CFX melt run requires (its plate is encrypted). A `Zpcr.dyeSpace` source is already
 * per-dye and needs no separation to begin with, so both kinds arrive here in the same shape.
 *
 * > **Future:** a high-resolution melt analysis would want to correct each reading for the dye's
 * > own temperature response before differentiating — fluorescence falls with temperature whether
 * > or not anything is melting, and steeply (measured from the committed calibration set: FAM
 * > −18%, Cy5 −38% between 60 and 80 °C), so part of every melt curve's slope is thermal quenching
 * > rather than dissociation. It is deliberately not done here, because the `.Dcal` response
 * > curves stop at **80 °C** while a melt runs to 95 °C: correcting the top third of the ramp
 * > would mean extrapolating a calibration well past its last measurement, and `interpolateResponse`
 * > extrapolates rather than clamping. Worth revisiting if calibration data above 80 °C appears.
 * > It would shift peak heights, not peak positions, so the Tm this reports is unaffected.
 */
export function computeMeltAnalysis(
  zpcr: Zpcr,
  segment: MeltSegment,
  options: MeltAnalysisOptions = {},
): MeltAnalysis {
  const includeReference = options.includeReference ?? false;
  const wellCurves = zpcr.curves({ step: segment.step, includeReference });

  let derivativeSource: "file" | "computed" = "computed";
  const curves: MeltCurve[] = wellCurves.map((curve: WellCurve) => {
    // The source's own derivative where it has one, ours where it doesn't. This is the only place
    // in the codebase that difference exists.
    const stated = curve.meltDerivativePerC;
    let derivative: number[];
    if (stated && stated.length === curve.mean.length) {
      derivative = stated;
      derivativeSource = "file";
    } else {
      derivative = meltDerivative(segment.temperaturesC, curve.mean);
    }
    // A peak is only called for a curve whose fluorescence actually moved: every curve has a
    // highest point, and an empty well's is noise (see `hasMeltSignal`).
    const peak = hasMeltSignal(curve.mean) ? meltPeak(segment.temperaturesC, derivative) : null;
    return {
      channel: curve.channel,
      row: curve.row,
      col: curve.col,
      wellLabel: curve.wellLabel,
      isReference: curve.isReference,
      temperaturesC: segment.temperaturesC,
      rfu: curve.mean,
      derivative,
      tmC: peak ? peak.tmC : null,
      peakHeight: peak ? peak.height : null,
    };
  });

  return {
    segment,
    curves,
    available: zpcr.channels(),
    derivativeSource,
  };
}

/**
 * The melt analysis for whichever step is selected, or undefined when that step isn't a melt —
 * the one call a view needs to decide between melt mode and the amplification view.
 */
export function computeMeltAnalysisFor(
  zpcr: Zpcr,
  step: number | undefined,
  options: MeltAnalysisOptions = {},
): MeltAnalysis | undefined {
  const segment = meltSegmentFor(zpcr, step);
  return segment ? computeMeltAnalysis(zpcr, segment, options) : undefined;
}
