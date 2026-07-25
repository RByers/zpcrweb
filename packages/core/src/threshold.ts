/**
 * Threshold and Cq stages of `threshold.md` (§5–§6): given a baseline-corrected curve
 * ({@link subtractBaseline} in `baseline.ts`), pick a threshold RFU and derive the quantification
 * cycle, Cq, either by threshold crossing (§6.1) or by curve-shape inflection (§6.2). Also covers
 * the §7 quality gates (amplification squelch).
 *
 * `threshold.md` §9 flags this as specified but not yet cross-validated against a reference
 * instrument's own reported Cq — the same caveat `baseline.ts` carries.
 */

/**
 * §5.1: noise estimate for one well — the standard deviation of the baseline-corrected curve
 * over its baseline region. Pass an already-{@link subtractBaseline}d curve; in that region the
 * corrected values are residuals about zero, so their spread *is* the noise estimate the doc
 * calls for.
 */
export function baselineNoise(
  cycles: number[],
  correctedValues: number[],
  region: { beginCycle: number; endCycle: number },
): number {
  const idx: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) idx.push(i);
  }
  if (idx.length === 0) return 0;
  const values = idx.map((i) => correctedValues[i]!);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export interface AutoThresholdOptions {
  /** `T = multiplier × noise`. Default **3.2** — a reasonable value between the classic 10× and a permissive 3×. */
  multiplier?: number;
  /** Floor on the resulting threshold, in RFU. Default **0** (no floor) — the doc calls for a
   * floor without pinning a value; supply one appropriate to the instrument's noise floor. */
  minThreshold?: number;
}

/**
 * §5.1: one threshold per fluorophore (not per well) — `noiseEstimates` should be
 * {@link baselineNoise} from a subset of the well group (`subsetPopRDBaseLinePref`), and the
 * *median* of those is used so a single noisy well can't blow the threshold up. Floors the
 * result at `minThreshold` so an all-flat plate doesn't collapse the threshold toward zero.
 */
export function autoThreshold(noiseEstimates: number[], options: AutoThresholdOptions = {}): number {
  const multiplier = options.multiplier ?? 3.2;
  const minThreshold = options.minThreshold ?? 0;
  if (noiseEstimates.length === 0) return minThreshold;

  const sorted = noiseEstimates.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianNoise = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

  return Math.max(multiplier * medianNoise, minThreshold);
}

export interface ThresholdOptions {
  /** `thresholdOverrideValue`, with `autoCalculateThreshold="False"`. Authoritative when present — §5.1 is skipped entirely. */
  overrideValue?: number;
  auto?: AutoThresholdOptions;
}

/** §5: resolve the threshold to use for a fluorophore — the manual override if given, else {@link autoThreshold} over `noiseEstimates`. */
export function resolveThreshold(noiseEstimates: number[], options: ThresholdOptions = {}): number {
  if (options.overrideValue !== undefined) return options.overrideValue;
  return autoThreshold(noiseEstimates, options.auto);
}

export interface AmplificationOptions {
  /** A well counts as amplified if its total rise is at least this many multiples of `noise`. Default **10**. */
  minRiseMultiplier?: number;
}

/**
 * §7: classify a well as amplified or not, so a flat well's noise can't eventually cross a low
 * auto threshold and produce a spurious late Cq. `noise` is typically {@link baselineNoise} for
 * the same well.
 */
export function isAmplified(values: number[], noise: number, options: AmplificationOptions = {}): boolean {
  const minRiseMultiplier = options.minRiseMultiplier ?? 10;
  if (values.length === 0) return false;
  const rise = Math.max(...values) - Math.min(...values);
  return rise >= minRiseMultiplier * noise;
}

export interface CqCrossingOptions {
  /** Report no Cq if the trace's last point is below threshold (a crossing that falls back).
   * Default **on**, per the doc's recommendation. */
  requireEndsAboveThreshold?: boolean;
}

/**
 * §6.1: `algorithmCtDetection="Threshold"`. Finds where the curve crosses `threshold` for real and
 * log-interpolates between the bracketing cycles for a fractional Cq, falling back to linear
 * interpolation when either bracketing value is `<= 0` (the logarithm is undefined).
 *
 * "For real" means the start of the curve's **final** run above the threshold, not the first cycle
 * that touches it: with `requireEndsAboveThreshold` on (the default, per the doc), any earlier
 * excursion that falls back below is by definition not the amplification the trace ends in, so
 * taking the first touch would report baseline noise flickering across a low threshold as a Cq of
 * 1–2 for a well that actually amplifies at cycle 30. Where the two rules agree — a clean sigmoid
 * that crosses once — they give the identical answer.
 *
 * Edge cases:
 *
 * - Above threshold at every cycle (nothing below to cross *from*) ⇒ `null` (a failed baseline,
 *   not an early Cq).
 * - Never crosses ⇒ `null` (no amplification).
 * - Ends below threshold ⇒ `null`, unless `requireEndsAboveThreshold` is turned off — in which case
 *   the first crossing is used, there being no final above-threshold run to anchor to.
 */
export function findThresholdCrossing(
  cycles: number[],
  values: number[],
  threshold: number,
  options: CqCrossingOptions = {},
): number | null {
  const requireEndsAboveThreshold = options.requireEndsAboveThreshold ?? true;
  if (values.length === 0) return null;

  let crossIndex = -1;
  if (requireEndsAboveThreshold) {
    if (values.at(-1)! < threshold) return null;
    // The final run above threshold begins just after the last sub-threshold cycle.
    let lastBelow = -1;
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i]! < threshold) {
        lastBelow = i;
        break;
      }
    }
    if (lastBelow < 0) return null;
    crossIndex = lastBelow + 1;
  } else {
    if (values[0]! >= threshold) return null;
    for (let i = 1; i < values.length; i++) {
      if (values[i]! >= threshold) {
        crossIndex = i;
        break;
      }
    }
  }
  if (crossIndex < 0 || crossIndex >= values.length) return null;

  const prev = values[crossIndex - 1]!;
  const curr = values[crossIndex]!;
  const cPrev = cycles[crossIndex - 1]!;
  const cCurr = cycles[crossIndex]!;
  if (curr === prev) return cCurr;

  if (prev > 0 && curr > 0) {
    const frac = (Math.log(threshold) - Math.log(prev)) / (Math.log(curr) - Math.log(prev));
    return cPrev + frac * (cCurr - cPrev);
  }

  const frac = (threshold - prev) / (curr - prev);
  return cPrev + frac * (cCurr - cPrev);
}

/**
 * §6.2: `algorithmCtDetection="NoThreshold"`. Reports Cq as the cycle of the curve's
 * second-derivative maximum — the point of steepest acceleration, i.e. the start of the
 * exponential phase — needing no threshold at all. Only meaningful for a curve with an actual
 * sigmoidal shape; a flat or linear trace has no dominant peak, so this returns `null` rather
 * than pick an arbitrary cycle. Amplification (the "does this curve have a shape at all" case)
 * should still be checked separately with {@link isAmplified} — this function does not do it.
 */
export function findInflectionCq(cycles: number[], values: number[]): number | null {
  if (values.length < 3) return null;

  const secondDiff = values.map((v, i) =>
    i === 0 || i === values.length - 1 ? -Infinity : values[i + 1]! - 2 * v + values[i - 1]!,
  );

  let maxIndex = -1;
  let maxValue = -Infinity;
  for (let i = 1; i < secondDiff.length - 1; i++) {
    if (secondDiff[i]! > maxValue) {
      maxValue = secondDiff[i]!;
      maxIndex = i;
    }
  }
  if (maxIndex < 0 || maxValue <= 0) return null;

  return cycles[maxIndex]!;
}

/** `algorithmCtDetection`. */
export type CqAlgorithm = "Threshold" | "NoThreshold";

export interface CqOptions {
  /** Default `"Threshold"`, the observed instrument default. */
  algorithm?: CqAlgorithm;
  /** Required when `algorithm` is `"Threshold"`. */
  threshold?: number;
  /** When given, gates the result on {@link isAmplified} first — both algorithms report `null` for an unamplified well. */
  noise?: number;
  amplification?: AmplificationOptions;
  crossing?: CqCrossingOptions;
  /** §7's baseline-validation gate — pass `false` (typically `CurveBaselineResult.baselineValid`
   * from `analysis.ts`, which runs `baseline.ts`'s `validateBaselineRegion`) to report no Cq
   * outright. A region that fails that check produces a corrected curve that's an artifact of
   * extrapolating a locally-fit line across cycles it doesn't describe, so any crossing or
   * inflection found in it is not trustworthy however clean it looks — checked before
   * `noise`/`isAmplified`, since a spurious rise like that routinely clears the amplification
   * squelch too. */
  baselineValid?: boolean;
}

/**
 * §6 + §7 combined: apply the §7 baseline-validation and amplification squelches (when
 * `baselineValid`/`noise` are given), then compute Cq with whichever algorithm
 * `options.algorithm` selects — {@link findThresholdCrossing} or {@link findInflectionCq}.
 * `cycles`/`values` should already be baseline-corrected ({@link subtractBaseline} in
 * `baseline.ts`).
 */
export function computeCq(cycles: number[], values: number[], options: CqOptions = {}): number | null {
  const algorithm = options.algorithm ?? "Threshold";
  if (options.baselineValid === false) return null;
  if (options.noise !== undefined && !isAmplified(values, options.noise, options.amplification)) return null;

  if (algorithm === "Threshold") {
    if (options.threshold === undefined) {
      throw new Error("computeCq: threshold is required for the Threshold algorithm");
    }
    return findThresholdCrossing(cycles, values, options.threshold, options.crossing);
  }
  return findInflectionCq(cycles, values);
}
