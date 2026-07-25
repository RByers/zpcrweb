/**
 * Baseline stages of `threshold.md` (§2–§4): smoothing a per-dye amplification curve, choosing
 * the flat pre-amplification region, and subtracting it. Deliberately stops short of
 * thresholding and Cq (§5–§6) — see `threshold.md` for those, still unimplemented.
 *
 * Pipeline: {@link skipCycles} drops leading/trailing cycles first, {@link smoothCurve} filters
 * the result, then a baseline region is either supplied manually (validated with
 * {@link clampBaselineRegion}) or found with {@link findBaselineByCurvature} /
 * {@link findBaselineByRegression} (combined by {@link autoBaselineRegion}), and finally
 * {@link subtractBaseline} applies it. `threshold.md` §9 flags this as specified but not yet
 * cross-validated against a reference instrument's own Cq — the same caveat applies here.
 */

/** `pCRDigitalFilter` — the smoothing filter applied to a curve before baselining (§2). */
export type SmoothingMode = "Disable" | "RollingBoxcar" | "WeightedMean" | "Centroid";

export interface SmoothingOptions {
  /** Default `"WeightedMean"`, the observed instrument default. */
  mode?: SmoothingMode;
  /** Window width in cycles. Default **5** (`smoothFilterWidthPref`). */
  width?: number;
}

/**
 * Smooth a curve (§2). The window shrinks near the ends rather than leaving them unsmoothed —
 * one of two defensible choices the doc calls out; this one keeps every output index defined.
 *
 * - `RollingBoxcar` — uniform average over the window.
 * - `WeightedMean` — triangular weights falling off from the centre (the observed default).
 * - `Centroid` — intensity-weighted average: each point in the window is weighted by its own
 *   (non-negative) value, pulling the result toward the window's brighter points. The doc gives
 *   no more detail than "centroid/centre-of-mass smoothing"; this is a reasonable reading, not a
 *   validated one.
 */
export function smoothCurve(values: number[], options: SmoothingOptions = {}): number[] {
  const mode = options.mode ?? "WeightedMean";
  const width = options.width ?? 5;
  if (mode === "Disable" || values.length === 0) return values.slice();

  const half = Math.floor(width / 2);
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);

    if (mode === "RollingBoxcar") {
      let sum = 0;
      for (let j = lo; j <= hi; j++) sum += values[j]!;
      return sum / (hi - lo + 1);
    }

    if (mode === "Centroid") {
      let sum = 0;
      let weight = 0;
      for (let j = lo; j <= hi; j++) {
        const w = Math.max(values[j]!, 0);
        sum += w * values[j]!;
        weight += w;
      }
      if (weight > 0) return sum / weight;
      let plain = 0;
      for (let j = lo; j <= hi; j++) plain += values[j]!;
      return plain / (hi - lo + 1);
    }

    // WeightedMean: triangular weights, peaking at the centre.
    let sum = 0;
    let weight = 0;
    for (let j = lo; j <= hi; j++) {
      const w = half + 1 - Math.abs(j - i);
      sum += w * values[j]!;
      weight += w;
    }
    return sum / weight;
  });
}

/**
 * Drop `beginSkip` leading and `endSkip` trailing cycles from consideration entirely
 * (`BeginCyclesSkip` / `EndCyclesSkip`, both default 0). Apply before smoothing or baselining.
 * `cycles` and `values` must be the same length; returns matching, equally-trimmed arrays.
 */
export function skipCycles(
  cycles: number[],
  values: number[],
  beginSkip = 0,
  endSkip = 0,
): { cycles: number[]; values: number[] } {
  const end = values.length - endSkip;
  return { cycles: cycles.slice(beginSkip, end), values: values.slice(beginSkip, end) };
}

/** A baseline region as a pair of (inclusive) 1-based cycle numbers, e.g. `baselineBeginRepeat`/`baselineEndRepeat`. */
export interface BaselineRegion {
  beginCycle: number;
  endCycle: number;
}

export interface BaselineRegionConstraints {
  /** Never begin before this cycle. Default **1** — cycle 0's reading is often anomalous. */
  minBeginCycle?: number;
  /** Minimum region width in cycles. Default **3** — fewer leaves no residual to judge noise from. */
  minWidth?: number;
}

/**
 * Clamp a baseline region (manual or auto-derived) to the §3.1 constraints: never starts before
 * `minBeginCycle`, never runs past the last cycle present, and is widened up to `minWidth` if
 * too narrow (capped at the last cycle).
 */
export function clampBaselineRegion(
  region: BaselineRegion,
  cycles: number[],
  constraints: BaselineRegionConstraints = {},
): BaselineRegion {
  const minBegin = constraints.minBeginCycle ?? 1;
  const minWidth = constraints.minWidth ?? 3;
  const maxCycle = cycles.length > 0 ? Math.max(...cycles) : region.endCycle;

  const beginCycle = Math.max(region.beginCycle, minBegin);
  let endCycle = Math.min(region.endCycle, maxCycle);
  if (endCycle - beginCycle + 1 < minWidth) {
    endCycle = Math.min(maxCycle, beginCycle + minWidth - 1);
  }
  return { beginCycle, endCycle };
}

export interface DataWindowOptions {
  /** `dataWindowFractionFullCycle` — window position as a fraction of the run. Default **1**. */
  positionFraction?: number;
  /** `dataWindowWidthFractionFullCycle` — window width as a fraction of the run. Default **0.99**. */
  widthFraction?: number;
}

/**
 * `pCRBaseLineMethod="DataWindow"` (§3.3): the sub-range of the run, as 1-based cycle numbers,
 * that baseline search should consider. With the observed defaults (position 1, width 0.99) this
 * spans (nearly) the whole run, coinciding with `FullScan` — pass `{ start: 1, end: cycleCount }`
 * directly for `FullScan` rather than calling this function.
 */
export function dataWindowRange(
  cycleCount: number,
  options: DataWindowOptions = {},
): { start: number; end: number } {
  const position = options.positionFraction ?? 1;
  const width = options.widthFraction ?? 0.99;
  const end = Math.round(position * cycleCount);
  const start = end - Math.round(width * cycleCount) + 1;
  return { start: Math.max(1, Math.min(start, end)), end: Math.max(1, end) };
}

function regionIndices(cycles: number[], region: BaselineRegion): number[] {
  const idx: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) idx.push(i);
  }
  return idx;
}

function linearFit(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i]! - meanX) * (y[i]! - meanY);
    den += (x[i]! - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: meanY - slope * meanX };
}

function residualStdError(x: number[], y: number[], fit: { slope: number; intercept: number }): number {
  const n = x.length;
  if (n <= 2) return 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) sumSquares += (y[i]! - (fit.slope * x[i]! + fit.intercept)) ** 2;
  return Math.sqrt(sumSquares / (n - 2));
}

/**
 * §3.2's flatness/linearity ratios for `region`, judged against the *whole* curve's span
 * (`values` should cover every cycle, not just the region) rather than the region's own
 * scatter — a region can fit a straight line almost perfectly and still be the wrong baseline if
 * that line doesn't hold across the rest of the run (see {@link validateBaselineRegion}). Returns
 * `null` if the region has too few points to fit a line.
 */
function regionFlatnessRatios(
  cycles: number[],
  values: number[],
  region: BaselineRegion,
): { relFlat: number; relLin: number } | null {
  const idx = regionIndices(cycles, region);
  if (idx.length < 2) return null;

  const x = idx.map((i) => cycles[i]!);
  const y = idx.map((i) => values[i]!);
  const span = Math.max(...values) - Math.min(...values);
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const flatRms = Math.sqrt(y.reduce((s, v) => s + (v - meanY) ** 2, 0) / y.length);
  const fit = linearFit(x, y);
  const linRms = Math.sqrt(y.reduce((s, v, i) => s + (v - (fit.slope * x[i]! + fit.intercept)) ** 2, 0) / y.length);
  return { relFlat: span > 0 ? flatRms / span : 0, relLin: span > 0 ? linRms / span : 0 };
}

export interface CurvatureBaselineOptions {
  /** Reject a candidate peak below this fraction of the tallest peak. Default **0.3**. */
  minPeakRatio?: number;
  /** Treat peaks closer than this many cycles as one. Default **4**. */
  minPeakSeparation?: number;
  /** Max residual-from-mean, relative to the curve's span, for the region to count as flat. Default **0.035**. */
  maxRelativeFlatness?: number;
  /** Max residual-from-fitted-line, relative to the curve's span, for the region to count as linear. Default **0.03**. */
  maxRelativeLinearity?: number;
  /** Cycles of margin between the detected onset and the baseline's end. Default **2** — not pinned down by the doc. */
  margin?: number;
  constraints?: BaselineRegionConstraints;
}

/**
 * §3.2(a): amplification onset is where the curve's second derivative peaks. Computes the
 * discrete second difference of `values` (pass an already-{@link smoothCurve}d curve — this
 * function does no smoothing of its own), finds the earliest strong peak after filtering
 * secondary peaks, and walks the baseline's end cycle back from `onset − margin` until the
 * region passes the §3.2 flatness/linearity checks (or exhausts down to the minimum width).
 * Returns `null` if no confident onset or no passing region is found — callers should fall back
 * to {@link findBaselineByRegression}.
 */
export function findBaselineByCurvature(
  cycles: number[],
  values: number[],
  options: CurvatureBaselineOptions = {},
): BaselineRegion | null {
  const minPeakRatio = options.minPeakRatio ?? 0.3;
  const minPeakSeparation = options.minPeakSeparation ?? 4;
  const maxRelativeFlatness = options.maxRelativeFlatness ?? 0.035;
  const maxRelativeLinearity = options.maxRelativeLinearity ?? 0.03;
  const margin = options.margin ?? 2;
  const minBegin = options.constraints?.minBeginCycle ?? 1;
  const minWidth = options.constraints?.minWidth ?? 3;

  if (values.length < 3) return null;

  const secondDiff = values.map((v, i) =>
    i === 0 || i === values.length - 1 ? 0 : values[i + 1]! - 2 * v + values[i - 1]!,
  );

  const peaks: { index: number; height: number }[] = [];
  for (let i = 1; i < secondDiff.length - 1; i++) {
    const h = secondDiff[i]!;
    if (h > 0 && h >= secondDiff[i - 1]! && h >= secondDiff[i + 1]!) peaks.push({ index: i, height: h });
  }
  if (peaks.length === 0) return null;

  const maxHeight = Math.max(...peaks.map((p) => p.height));
  const strong = peaks.filter((p) => p.height >= minPeakRatio * maxHeight);

  const merged: { index: number; height: number }[] = [];
  for (const p of strong) {
    const last = merged[merged.length - 1];
    if (last && cycles[p.index]! - cycles[last.index]! < minPeakSeparation) {
      if (p.height > last.height) merged[merged.length - 1] = p;
    } else {
      merged.push(p);
    }
  }
  if (merged.length === 0) return null;

  const onsetCycle = cycles[merged[0]!.index]!;

  for (let endCycle = onsetCycle - margin; endCycle - minBegin + 1 >= minWidth; endCycle--) {
    const region = { beginCycle: minBegin, endCycle };
    const idx = regionIndices(cycles, region);
    if (idx.length < minWidth) continue;

    const stats = regionFlatnessRatios(cycles, values, region);
    if (stats && stats.relFlat <= maxRelativeFlatness && stats.relLin <= maxRelativeLinearity) {
      return region;
    }
  }
  return null;
}

export interface RegressionBaselineOptions {
  /** Width of the initial region a line is first fit to. Default **5** — below that, the
   * residual-std-error estimate has too few degrees of freedom (width 3 gives just 1) to be
   * reliable, so an unlucky tight initial fit flags the very next noisy-but-flat point as a
   * false departure and truncates the region far too early — which then gets used for a linear
   * fit extrapolated across the whole run, turning a small slope-estimation error into a large,
   * spurious drift over many cycles. */
  initialWidth?: number;
  /** How many standard errors of the fit a new point may depart before it's rejected. Default
   * **5** — extra margin against that same low-degrees-of-freedom instability. */
  kStdErrors?: number;
  constraints?: BaselineRegionConstraints;
}

/**
 * §3.2(b): fit a line to a short initial region, then extend it one cycle at a time while each
 * new point stays within `kStdErrors` standard errors of the current fit. The first point that
 * departs marks amplification onset, so the region returned ends just before it. Returns `null`
 * if there aren't enough cycles to fit an initial region.
 */
export function findBaselineByRegression(
  cycles: number[],
  values: number[],
  options: RegressionBaselineOptions = {},
): BaselineRegion | null {
  const initialWidth = options.initialWidth ?? 5;
  const k = options.kStdErrors ?? 5;
  const minBegin = options.constraints?.minBeginCycle ?? 1;

  const beginIdx = cycles.findIndex((c) => c >= minBegin);
  if (beginIdx < 0) return null;
  let endIdx = beginIdx + initialWidth - 1;
  if (endIdx >= cycles.length) return null;

  for (let next = endIdx + 1; next < cycles.length; next++) {
    const x = cycles.slice(beginIdx, endIdx + 1);
    const y = values.slice(beginIdx, endIdx + 1);
    const fit = linearFit(x, y);
    const stderr = residualStdError(x, y, fit);
    const predicted = fit.slope * cycles[next]! + fit.intercept;
    const departure = Math.abs(values[next]! - predicted);
    const departs = stderr > 0 ? departure > k * stderr : departure > 0;
    if (departs) break;
    endIdx = next;
  }

  return { beginCycle: cycles[beginIdx]!, endCycle: cycles[endIdx]! };
}

export interface AutoBaselineOptions {
  curvature?: CurvatureBaselineOptions;
  regression?: RegressionBaselineOptions;
  constraints?: BaselineRegionConstraints;
}

/**
 * `autoCalculateBaseline`: run {@link findBaselineByCurvature} and fall back to
 * {@link findBaselineByRegression} when it finds nothing confident, then clamp the result to the
 * §3.1 constraints. Returns `null` if neither strategy finds a region.
 */
export function autoBaselineRegion(
  cycles: number[],
  values: number[],
  options: AutoBaselineOptions = {},
): BaselineRegion | null {
  const region =
    findBaselineByCurvature(cycles, values, { ...options.curvature, constraints: options.constraints }) ??
    findBaselineByRegression(cycles, values, { ...options.regression, constraints: options.constraints });
  return region ? clampBaselineRegion(region, cycles, options.constraints) : null;
}

export interface BaselineValidationOptions {
  /** Max residual-from-mean, relative to the curve's span, for the region to count as flat. Default **0.035**. */
  maxRelativeFlatness?: number;
  /** Max residual-from-fitted-line, relative to the curve's span, for the region to count as linear. Default **0.03**. */
  maxRelativeLinearity?: number;
  /** Narrower regions are extended (capped at the curve's last cycle) up to this many cycles
   * before the flatness/linearity check runs — see the rationale below. Default **5**, matching
   * {@link RegressionBaselineOptions.initialWidth}'s default for the same reason. */
  minValidationWidth?: number;
}

/**
 * §7's baseline-validation gate: check `region` against the same flatness/linearity bounds
 * {@link findBaselineByCurvature} requires of its own candidates (§3.2), regardless of which
 * strategy actually chose `region` — {@link findBaselineByRegression}'s iterative extension
 * stops at the first cycle that departs its *local* fit, which is only sometimes amplification
 * onset: a curve whose true baseline decays at a changing rate (steep early, shallow late, with
 * no amplification anywhere) departs a short initial fit too, leaving a region that is a
 * near-perfect straight line on its own but a poor description of the curve as a whole. Fitting
 * that region and extrapolating it across every remaining cycle then manufactures a spurious
 * rise out of pure slope-estimation error. Judging the region's residuals against the *whole*
 * curve's span (as this function does, via {@link regionFlatnessRatios}) catches that case, since
 * the mismatch shows up as the region failing flatness even though it looked fine in isolation —
 * *unless* the region is narrower than `minValidationWidth`, in which case it's extended before
 * checking: any 3-4 point window of an otherwise-smooth curve fits a line almost exactly by
 * construction (too few degrees of freedom for the residual to mean anything — the same
 * instability {@link findBaselineByRegression}'s `initialWidth` guards against), so a region that
 * narrow can pass flatness/linearity trivially regardless of whether it describes the rest of the
 * curve. This happens when a curvature-detected onset sits implausibly early (an artifact peak a
 * few cycles in, itself caused by the same steep-then-shallow non-amplifying decay described
 * above), capping the candidate region below any width the check could meaningfully trust.
 * `values` should cover every cycle — the same curve `region` was chosen from — not just the
 * region itself.
 */
export function validateBaselineRegion(
  cycles: number[],
  values: number[],
  region: BaselineRegion,
  options: BaselineValidationOptions = {},
): boolean {
  const maxRelativeFlatness = options.maxRelativeFlatness ?? 0.035;
  const maxRelativeLinearity = options.maxRelativeLinearity ?? 0.03;
  const minValidationWidth = options.minValidationWidth ?? 5;

  const width = region.endCycle - region.beginCycle + 1;
  const checkRegion =
    width >= minValidationWidth
      ? region
      : {
          beginCycle: region.beginCycle,
          endCycle: Math.min(
            cycles.length > 0 ? Math.max(...cycles) : region.endCycle,
            region.beginCycle + minValidationWidth - 1,
          ),
        };

  const stats = regionFlatnessRatios(cycles, values, checkRegion);
  return stats !== null && stats.relFlat <= maxRelativeFlatness && stats.relLin <= maxRelativeLinearity;
}

/**
 * `pCRBaseLine` (§4), restricted to the three modes a first implementation covers — `Raw`,
 * `RawBaseLineSubtracted` and `LinearBaseLineNormalized`. The `…CurveFit` and `Reference…`
 * variants are not implemented: the doc leaves the curve-fit refinement unpinned (§9), and
 * reference-normalization needs a reference dye/well this module doesn't have.
 */
export type BaselineMode = "Raw" | "RawBaseLineSubtracted" | "LinearBaseLineNormalized";

/** A fitted baseline line, `rfu = intercept + slope * cycle` — the coefficients behind
 * `LinearBaseLineNormalized`'s subtraction, exposed so callers can display the line itself
 * (e.g. as "2000 + 4c") rather than just the corrected result. */
export interface LinearBaselineFit {
  slope: number;
  intercept: number;
}

/**
 * Fit the linear baseline (§4's `LinearBaseLineNormalized`) over `region`: ordinary least
 * squares through the region's own points. Returns the zero line (`{ slope: 0, intercept: 0 }`)
 * if no cycle in `values` falls within `region`.
 */
export function fitLinearBaseline(
  cycles: number[],
  values: number[],
  region: BaselineRegion,
): LinearBaselineFit {
  const idx = regionIndices(cycles, region);
  if (idx.length === 0) return { slope: 0, intercept: 0 };
  const x = idx.map((i) => cycles[i]!);
  const y = idx.map((i) => values[i]!);
  return linearFit(x, y);
}

/**
 * Subtract the baseline (§4). `RawBaseLineSubtracted` subtracts the mean of the region;
 * `LinearBaseLineNormalized` fits a line to the region ({@link fitLinearBaseline}) and subtracts
 * it across every cycle, removing drift as well as offset. If no cycle in `values` falls within
 * `region`, returns `values` unchanged.
 */
export function subtractBaseline(
  cycles: number[],
  values: number[],
  region: BaselineRegion,
  mode: BaselineMode,
): number[] {
  if (mode === "Raw") return values.slice();

  const idx = regionIndices(cycles, region);
  if (idx.length === 0) return values.slice();

  if (mode === "RawBaseLineSubtracted") {
    const mean = idx.reduce((s, i) => s + values[i]!, 0) / idx.length;
    return values.map((v) => v - mean);
  }

  const fit = fitLinearBaseline(cycles, values, region);
  return values.map((v, i) => v - (fit.slope * cycles[i]! + fit.intercept));
}
