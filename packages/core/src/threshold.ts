/**
 * Threshold and Cq stages of `threshold.md` (§5–§6): given a baseline-corrected curve
 * ({@link subtractBaseline} in `baseline.ts`), pick a threshold RFU and derive the quantification
 * cycle, Cq, either by threshold crossing (§6.1) or by curve-shape inflection (§6.2). Also covers
 * the §7 quality gates (amplification squelch).
 *
 * `threshold.md` §9 flags this as specified but not yet cross-validated against a reference
 * instrument's own reported Cq — the same caveat `baseline.ts` carries.
 */

import { meanSquaredSuccessiveDifference, median, stdDev, whiteness } from "./stats.js";

/**
 * How {@link baselineNoise} turns a baseline region's residuals into one noise number (§5.1).
 *
 * - `successiveDifference` (**default**) — the root-mean-square *successive difference*,
 *   `sqrt(mean((r[i] − r[i−1])²) / 2)`, also called the MSSD or von Neumann estimator. Measures
 *   only cycle-to-cycle scatter, so it is blind to any smooth trend the fitted baseline failed to
 *   capture.
 * - `residualStdDev` — the plain standard deviation of the residuals. What this library shipped
 *   before, and what the textbook description of §5.1 implies.
 *
 * The two agree on a well whose baseline really is a straight line plus white noise, and diverge
 * exactly when the baseline model is wrong. That divergence is the reason for the default: a
 * standard deviation about a fitted line answers "how far is this curve from my model?", but the
 * threshold rule needs "how much does this curve jitter?" — and those coincide only when the model
 * is right. A well with a settling transient (block and optics still stabilizing over the first
 * cycles, on top of the usual linear drift) leaves residuals that trace a smooth arc rather than
 * scattering, so `residualStdDev` reports the size of that arc and the threshold inflates in
 * proportion to how badly the line mis-described the well — pushing Cq later exactly where the
 * curve is least well understood, and doing it per-well, which makes Cq incomparable across a
 * plate.
 *
 * Measured over the committed samples' loaded curves, `residualStdDev / successiveDifference` runs
 * to **4.2×** on `20260720.zpcr` and **8.7×** on `20230829_135443_CT019138_SINGLE_STEP_.zpcr`
 * (median 5.5× there, where 67 of 72 curves carry a clearly non-white baseline). On the latter the
 * old estimator put the group threshold at ≈1063 RFU and only 3 of 72 wells reported a Cq at all;
 * the successive-difference estimator puts it at ≈178. On the former it closes the specific defect
 * this option was introduced for: wells A3/B3 (HMPV Ma) and D3 (PIV3 Bo) carry the same dye and
 * near-identical curves, but A3's transient gave it a residual spread of 11.1 against D3's 2.5, so
 * the two targets' thresholds came out 3.3× apart. Under the default they are 3.7 and 2.7.
 *
 * **Where CFX stands is unknown.** Bio-Rad documents neither its noise statistic nor its
 * multiplier, and the only observable is the pair of thresholds the sample `.pcrd` persisted. What
 * those two anchors *do* say is that the successive-difference estimator makes the implied
 * multiplier far more consistent between dyes — see {@link AutoThresholdOptions.multiplier}.
 */
export type NoiseEstimator = "successiveDifference" | "residualStdDev";

export interface BaselineNoiseOptions {
  /** Which statistic to reduce the region's residuals with. Default `"successiveDifference"` —
   * see {@link NoiseEstimator}. */
  estimator?: NoiseEstimator;
  /**
   * How many cycles at the *start* of the baseline region to leave out of the noise estimate.
   * Default **1**.
   *
   * The run's first read is routinely offset from the rest of the baseline — block and optics are
   * still settling — which §3.1 already acknowledges for cycle 0. It is one anomalous point in a
   * short window, so it inflates the spread out of proportion to its meaning, and because §5.1
   * multiplies that spread by a large constant ({@link AutoThresholdOptions.multiplier}) the error
   * is amplified straight into the threshold and hence into every Cq in the group.
   *
   * This still matters under the default `successiveDifference` estimator, and if anything matters
   * slightly more: that estimator is immune to a smooth *trend* the baseline fit missed, but an
   * isolated spike enters **two** successive differences rather than one squared deviation, so a
   * lone bad read counts for more, not less. Trend robustness and outlier robustness are separate
   * properties — see {@link NoiseEstimator}.
   *
   * Only the *noise statistic* skips it. The baseline line itself is still fitted over the whole
   * region ({@link fitLinearBaseline}) and the curve is still corrected across every cycle: the
   * point is a poor estimator of scatter, not bad data.
   *
   * Ignored when it would leave fewer than 3 points, since the remaining spread would be worse than
   * the one being cleaned up.
   */
  skipLeadingCycles?: number;
}

/** The residuals {@link baselineNoise} reduces: the corrected curve over its baseline region,
 * less the leading cycles {@link BaselineNoiseOptions.skipLeadingCycles} drops. */
function noiseResiduals(
  cycles: number[],
  correctedValues: number[],
  region: { beginCycle: number; endCycle: number },
  skipLeadingCycles: number,
): number[] {
  const all: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) all.push(i);
  }
  const idx = all.length - skipLeadingCycles >= 3 ? all.slice(skipLeadingCycles) : all;
  return idx.map((i) => correctedValues[i]!);
}

/**
 * §5.1: noise estimate for one well, over its baseline region. Pass an
 * already-{@link subtractBaseline}d curve; in that region the corrected values are residuals about
 * zero, so their spread is the quantity §5.1 calls for.
 *
 * Which statistic reduces those residuals is {@link BaselineNoiseOptions.estimator}'s choice, and
 * the default is deliberately **not** the plain standard deviation — see {@link NoiseEstimator} for
 * why, and for the measurements behind it.
 *
 * The region's leading cycle is excluded by default — see {@link BaselineNoiseOptions.skipLeadingCycles}.
 */
export function baselineNoise(
  cycles: number[],
  correctedValues: number[],
  region: { beginCycle: number; endCycle: number },
  options: BaselineNoiseOptions = {},
): number {
  const residuals = noiseResiduals(
    cycles,
    correctedValues,
    region,
    options.skipLeadingCycles ?? 1,
  );
  if (residuals.length === 0) return 0;
  // Below 3 points the successive differences are too few to average, so fall back to the spread.
  if ((options.estimator ?? "successiveDifference") === "residualStdDev" || residuals.length < 3) {
    return stdDev(residuals);
  }
  return Math.sqrt(meanSquaredSuccessiveDifference(residuals) / 2);
}

/**
 * **von Neumann's ratio** for a baseline region's residuals — mean squared successive difference
 * divided by variance. A scale-free measure of how much of the residual is white noise rather than
 * structure the baseline fit failed to describe:
 *
 * - **≈ 2** — white noise. Successive residuals are independent, so their differences carry twice
 *   the variance of the residuals themselves. This is the value a correctly-modelled baseline gives.
 * - **→ 0** — strongly serially correlated. The residuals trace a smooth path (a settling
 *   transient, a curved drift, or the foot of amplification pulled into the region), which means
 *   the straight-line baseline is the wrong model over this region.
 * - **> 2** — alternating/anti-correlated residuals, e.g. an over-smoothed or aliased trace.
 *
 * The useful property is that it needs **no tuning constant and no scale**: unlike §3.2's
 * flatness/linearity bounds — which are fractions of the curve's *whole span*, and so grow
 * permissive exactly on the high-rising wells where a mis-fit baseline does the most damage — the
 * ratio has a known null value that is the same for every curve, dye, run and instrument.
 *
 * Measured on the committed samples this separates cleanly with a wide margin: every curve whose
 * baseline is visibly mis-modelled lands at 0.03–0.5, every clean one at 1.4–2.5. Returns `2` (the
 * white-noise null) when the residuals have no spread to judge, so a flat-line curve is not
 * reported as structured.
 */
export function residualWhiteness(
  cycles: number[],
  correctedValues: number[],
  region: { beginCycle: number; endCycle: number },
  options: BaselineNoiseOptions = {},
): number {
  const residuals = noiseResiduals(
    cycles,
    correctedValues,
    region,
    options.skipLeadingCycles ?? 1,
  );
  return whiteness(residuals);
}

export interface AutoThresholdOptions {
  /**
   * `T = multiplier × noise`. Default **20**.
   *
   * Far above the textbook 3–10× because `noise` here is not the quantity those figures describe.
   * They assume the raw well-to-well scatter of the baseline cycles; {@link baselineNoise} measures
   * the residual left over after §2 smoothing *and* subtraction of a line fitted tightly to the
   * pre-amplification region, which is a much smaller number. Multiplying that residual by 3.2 puts
   * the threshold a few RFU above baseline on a curve that rises by thousands, so the crossing
   * lands deep in the exponential's foot and every Cq comes out systematically early.
   *
   * The order of magnitude comes from the only ground truth available: the thresholds CFX itself
   * persisted in `20260720_Luna_noRT.pcrd` (`autoCalculateThreshold="False"`, so these are the
   * values the instrument's own analysis used). The plate loads three fluorophores and exactly two
   * of them carry an override — `fluorId` 5 (FAM) and 12 (Texas Red), both 210.72; `fluorId` 4
   * (Cy5) is left on `autoCalculateThreshold="True"` and is **not** an anchor. Dividing those by
   * this pipeline's median {@link baselineNoise} over the four loaded wells of each dye:
   *
   * | Fluor | CFX `thresholdOverrideValue` | via `residualStdDev` | via `successiveDifference` |
   * |---|---|---|---|
   * | FAM | 210.72 | 2.33 → **90.3×** | 2.47 → **85.3×** |
   * | Texas Red | 210.72 | 5.08 → **41.5×** | 2.65 → **79.6×** |
   *
   * This is the sharpest evidence for the default {@link NoiseEstimator}: under `residualStdDev`
   * the two anchors disagree by 2.2×, so "the" multiplier would depend on which dye it was
   * calibrated against — disqualifying for a constant meant to generalize. Under the default they
   * agree within 7%. The estimator change did not move the anchors closer by construction; it moved
   * them closer because Texas Red's cohort happened to carry more baseline mis-fit than FAM's, and
   * removing that from the statistic removed the disagreement with it.
   *
   * The shipped default of 20 nonetheless sits well *below* the ≈80 those anchors now imply, and
   * that gap is a deliberate, unresolved judgement call rather than a measurement: re-anchoring to
   * ≈80 lands every Cq on the samples in hand later than the curves suggest. Two anchors from one
   * run on one instrument, sharing a single override value, are not enough to overrule that — see
   * `threshold.md` §9. What they do settle is the scale: tens of multiples of this residual, not
   * the textbook 3–10×. `computeCqTable`'s `autoThreshold` option makes it adjustable, and the web
   * app puts it on a slider for exactly this reason.
   *
   * Expressing the same anchors as a fraction of the wells' amplification instead (7.5% and 10.1%
   * of median ΔRFU) fits them more loosely and disagrees sharply on other plates, which is why the
   * rule stays noise-relative.
   */
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
  const multiplier = options.multiplier ?? 20;
  const minThreshold = options.minThreshold ?? 0;
  if (noiseEstimates.length === 0) return minThreshold;
  return Math.max(multiplier * median(noiseEstimates), minThreshold);
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
