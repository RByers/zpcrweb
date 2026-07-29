/**
 * The threshold and Cq stages of `threshold.md` (§5–§6): given a baseline-corrected curve
 * (`subtractBaseline` in `baseline.ts`), pick a threshold RFU and report the cycle at which the
 * curve crosses it.
 *
 * **The crossing rule is measured, not inferred.** Fed CFX's own corrected curves and its own
 * threshold, {@link computeCq} reproduces all 14 Cq values and all 10 no-Cq wells of
 * `20260726_S183-S185_RVP` to ~1e-10 cycles — see `threshold.md` §1.2 and the regression test in
 * `test/cfxExport.test.ts`. The *threshold* is the opposite case: CFX's automatic rule is not
 * documented, not observable, and the one auto value ever recovered from it rules out the obvious
 * models — see {@link AutoThresholdOptions.multiplier}.
 */

import { BASELINE_BEGIN_CYCLE, type BaselineRegion } from "./baseline.js";

/** Median of a series. Returns 0 for an empty series; averages the middle pair when even. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Population standard deviation. Returns 0 for an empty series. */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/**
 * Converts a median absolute second difference into an estimate of σ. **0.6053**, and it is
 * arithmetic rather than a tuning knob: for white noise of standard deviation σ, second
 * differences are Gaussian with variance 6σ², so their median absolute value is
 * `0.6745 × √6 × σ = 1.6521σ`.
 */
const SECOND_DIFFERENCE_SIGMA = 1 / (0.674489750196082 * Math.sqrt(6));

/**
 * §5.1: the baseline noise of one well — how much its corrected curve jitters from cycle to
 * cycle, over the baseline region. Pass an already-corrected curve: inside the region its values
 * *are* the residuals about the fitted line.
 *
 * The estimator is the **median absolute second difference**, scaled to σ. That is a deliberate
 * choice over the two obvious alternatives, and the reason is that the statistic has to survive
 * being computed over a region the baseline does *not* describe:
 *
 * - A **standard deviation** about the fitted line answers "how far is this curve from my model?",
 *   not "how much does it jitter". The two coincide only when the model is right. Measured over
 *   the committed samples, `stdDev ÷ jitter` runs to 4.2× on `20260720_FirstQualification.zpcr`
 *   and 8.7× on `20230829_135443_CT019138_SINGLE_STEP_.zpcr` — that ratio is baseline mis-fit
 *   being reported as noise, per well, which makes Cq incomparable across a plate.
 * - **Root-mean-square successive differences** (the MSSD, what this library used to ship) fix the
 *   *offset* half of that but not the rest: a leftover slope puts a constant into every
 *   difference, and a single amplifying well leaves a huge one in the differences over its rise.
 *   Both matter here, because `computeCqTable`'s first pass deliberately baselines every curve
 *   over the whole run — including the exponential — to find out where the rise is.
 *
 * A median of second differences is blind to both: second differences of any straight line are
 * zero, and a rise occupying a minority of the region cannot move a median. On a curve whose
 * region really is a line plus white noise all three estimators agree, which is what makes this a
 * strict improvement rather than a different answer.
 *
 * Falls back to the standard deviation below 4 points, where there are too few second differences
 * to take a median of.
 */
export function baselineNoise(
  cycles: number[],
  correctedValues: number[],
  region: BaselineRegion,
): number {
  const residuals: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) {
      residuals.push(correctedValues[i]!);
    }
  }
  if (residuals.length === 0) return 0;
  if (residuals.length < 4) return stdDev(residuals);

  const secondDifferences: number[] = [];
  for (let i = 2; i < residuals.length; i++) {
    secondDifferences.push(Math.abs(residuals[i]! - 2 * residuals[i - 1]! + residuals[i - 2]!));
  }
  return SECOND_DIFFERENCE_SIGMA * median(secondDifferences);
}

export interface AutoThresholdOptions {
  /**
   * `T = multiplier × median baseline noise` over the fluorophore's wells. Default **20**.
   *
   * **This is the one number in the pipeline that is neither measured nor derivable**, and the
   * evidence says the *form* of the rule is wrong, not just the constant. The RVP run pins two of
   * its three dyes' thresholds and bounds the third (`threshold.md` §5.2):
   *
   * | Fluor | Threshold CFX used | Baseline noise | Implied multiplier |
   * |---|---|---|---|
   * | FAM | 92.0212554931641 (persisted override) | ~2.3 | ~40× |
   * | Tex 615 | 8.06451415811512 (CFX's own auto value, recovered) | ~2.5 | ~3× |
   * | Cy5 | **> 278** (a well rising to 278 RFU gets no Cq) | ~1.8 | > 150× |
   *
   * Three dyes on one plate, in the same cycles, with baseline noise within 40% of each other, and
   * thresholds spanning 35×. No multiple of any noise statistic fits that, and neither does any
   * curve-shape quantity: Cy5's threshold must exceed 278 RFU while every Cy5 curve on the plate
   * is flat noise, so nothing read off those curves' shapes can produce it. (That last point
   * retires the "per-curve shape threshold" this document used to propose; see `threshold.md` §5.2.)
   *
   * So the shipped rule is a *defensible default*, not a reproduction of the instrument's: a
   * threshold a few tens of multiples above the noise floor sits above the jitter of a flat well
   * and below the exponential's shoulder on an amplifying one. When exact agreement with CFX
   * matters, supply the threshold instead of computing it — a `.pcrd` that persists
   * `thresholdOverrideValue` gives it directly, and the web app seeds its per-fluorophore
   * override from that and puts this multiplier on a slider.
   */
  multiplier?: number;
}

/**
 * §5.2: one threshold per fluorophore, from the median baseline noise across that dye's wells.
 *
 * The *median*, so one unusually noisy well can't move the group; per **fluorophore**, because
 * that is the grouping the file format itself uses (`fluorDataAnalysisParam fluorId=…`) and the
 * one the physics supports — baseline noise is a property of the dye, the optics and the well,
 * while a target is a biological label attached to the same physical measurement.
 */
export function autoThreshold(noiseEstimates: number[], options: AutoThresholdOptions = {}): number {
  if (noiseEstimates.length === 0) return 0;
  return (options.multiplier ?? 20) * median(noiseEstimates);
}

export interface ThresholdOptions {
  /** `thresholdOverrideValue`, with `autoCalculateThreshold="False"` — authoritative when present,
   * and the only way to reproduce a reference Cq exactly (§5.3). */
  overrideValue?: number;
  auto?: AutoThresholdOptions;
}

/** §5: the manual override if there is one, else {@link autoThreshold}. */
export function resolveThreshold(noiseEstimates: number[], options: ThresholdOptions = {}): number {
  if (options.overrideValue !== undefined) return options.overrideValue;
  return autoThreshold(noiseEstimates, options.auto);
}

/**
 * A crossing whose local slope is below this many RFU per cycle is ignored — a curve lying flat
 * along the threshold produces no Cq rather than an arbitrary one. Part of the measured rule.
 */
const MIN_CROSSING_SLOPE = 1e-5;

/**
 * §6: **the** Cq — the fractional cycle at which a baseline-corrected curve crosses `threshold`.
 *
 * ```
 * if T < min(y) or T > max(y):  no Cq                    ← the only gate there is
 * for each upward crossing i (y[i] ≥ T > y[i−1]):
 *   skip it if the local slope is below MIN_CROSSING_SLOPE
 *   xc  = cycle[i−1] + (T − y[i−1]) / (y[i] − y[i−1])    ← two-point LINEAR interpolation
 *   run = how many further cycles keep strictly increasing
 * take the crossing with the longest run; ties go to the later one
 * ```
 *
 * Every clause is measured against CFX's own output (`threshold.md` §1.2), and three of them
 * replaced something this library used to do differently:
 *
 * - **Linear interpolation on the cycle number.** Not logarithmic (physically appealing, and
 *   simply not what produces the reported numbers — it lands a few hundredths of a cycle early),
 *   and no half-cycle offset: solving 9 reported Cq values back for the threshold that would
 *   produce them gives the same threshold to 1e-12 under `x = cycle`, and a ±10% scatter under
 *   `x = cycle + ½`.
 * - **Longest following increasing run**, not the start of the final above-threshold run. On a
 *   clean sigmoid the two agree; on a noise spike followed by decline the run rule still reports a
 *   Cq, and CFX does too.
 * - **`T ∈ [min, max]` is the only reason to withhold a Cq.** Not "the trace ends below the
 *   threshold", not an amplification squelch, not a baseline-validity check. A well whose whole
 *   corrected curve sits *above* the threshold gets no Cq — which is the real reason an obviously
 *   amplifying well can report nothing, and worth surfacing in a UI as "baseline above threshold"
 *   rather than "no amplification": they look identical in the output and mean opposite things.
 *
 * **One narrowing of the measured rule, and the only one: the search starts at
 * {@link BASELINE_BEGIN_CYCLE}**, the first cycle the baseline was fitted to describe. `min`/`max`
 * are taken over the same range. This is not a quality gate — it adds no test a curve can fail —
 * it is the domain the model is defined on. §3 excludes the run's first reads from the fit
 * *because* block and optics are still settling there, so the corrected values at those cycles are
 * extrapolations of a line deliberately told not to model them; reading a Cq off them is
 * incoherent. Observed on well F1 of `20230829_135443_CT019138_SINGLE_STEP_.zpcr`, a well that
 * never amplifies: its raw trace decays steeply over the first cycles, leaving corrected values of
 * 55.0 and 63.9 at cycles 1–2 that straddle a 57.9 threshold, and the resulting Cq of **1.32** was
 * the only crossing on the curve. The reference cannot settle this one — no exported well has a
 * transient like it — but every Cq CFX does report is far past cycle 3, so nothing measured is
 * given up.
 */
export function computeCq(cycles: number[], values: number[], threshold: number): number | null {
  const n = values.length;
  if (n === 0) return null;
  // The analysed range: the cycles the baseline was fitted to describe. See the note below.
  const from = cycles.findIndex((c) => c >= BASELINE_BEGIN_CYCLE);
  if (from < 1) return null;
  const analysed = values.slice(from - 1);
  if (threshold < Math.min(...analysed) || threshold > Math.max(...analysed)) return null;

  let best: { run: number; cq: number } | null = null;
  let i = from;
  while (i < n) {
    if (values[i]! >= threshold && values[i - 1]! < threshold) {
      const slope = values[i]! - values[i - 1]!;
      if (Math.abs(slope) >= MIN_CROSSING_SLOPE) {
        const cq = cycles[i - 1]! + (threshold - values[i - 1]!) / slope;
        let run = 0;
        while (i + run + 1 < n && values[i + run + 1]! > values[i + run]!) run++;
        // `>=`, so a later crossing wins an otherwise equal contest.
        if (!best || run >= best.run) best = { run, cq };
        i += run;
      }
    }
    i++;
  }
  return best ? best.cq : null;
}
