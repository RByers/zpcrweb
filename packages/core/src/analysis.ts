/**
 * Analytical transforms over curve data. Kept in the library (not the UI) so they are
 * covered by the test suite and shared by any consumer.
 */

import {
  autoBaselineRegion,
  clampBaselineRegion,
  fitLinearBaseline,
  smoothCurve,
  subtractBaseline,
  validateBaselineRegion,
  type BaselineMode,
  type BaselineRegion,
  type LinearBaselineFit,
} from "./baseline.js";
import { baselineNoise, isAmplified, type AmplificationOptions } from "./threshold.js";

/**
 * Element-wise subtraction of one series from another, `a[i] - b[i]`. Used to subtract a
 * per-cycle background (e.g. a channel's dark reading) from a well's curve. Missing entries
 * in `b` are treated as 0; the result matches the length of `a`.
 */
export function subtractSeries(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - (b[i] ?? 0));
}

/** Fallback baseline region (`threshold.md` §3.1/§8) when auto-detection finds no confident
 * onset — cycles 2–9, clamped to the run's actual cycle count. Mirrors the web app's chart
 * baseline preview so both land on the same region in the same edge case. */
function fallbackRegion(cycles: number[]): BaselineRegion {
  return clampBaselineRegion({ beginCycle: 2, endCycle: 9 }, cycles);
}

export interface CurveBaselineResult {
  baselineRegion: BaselineRegion;
  /** §7 baseline-validation gate — see {@link validateBaselineRegion}. `false` means
   * `baselineRegion` failed the flatness/linearity check against the curve's full span, so
   * `correctedValues`/`amplified`/`deltaRfu` are an extrapolation artifact rather than a
   * trustworthy correction: `amplified` is forced `false` in that case regardless of the rise. */
  baselineValid: boolean;
  correctedValues: number[];
  /** §5.1 noise estimate — the baseline-corrected residual spread over `baselineRegion`. */
  noise: number;
  /** §7 amplification gate — see {@link isAmplified}. Always `false` when `baselineValid` is
   * `false`. */
  amplified: boolean;
  /** Endpoint rise relative to the baseline: the curve's last corrected value minus the mean
   * corrected value over `baselineRegion` (≈ the last value itself, since baseline subtraction
   * already centers the region near zero — computed explicitly so it stays correct for `"Raw"`
   * mode too, which does no subtraction). */
  deltaRfu: number;
  /** Mean of the *raw* (uncorrected) `values` over `baselineRegion` — the actual RFU level a
   * curve's baseline was anchored to. A diagnostic: two settings that *look* like they should
   * agree (e.g. the same displayed cycle range, once as an auto-detected preview and once as an
   * explicit manual override) can still land on a very different `baselineRegion` — auto-detection
   * runs per curve and can span most or all of a flat curve's cycles, while a manual override is
   * one fixed region applied to every curve — so `baselineRfu` lets a user confirm what was
   * actually used, rather than inferring it from a possibly-surprising Cq. */
  baselineRfu: number;
  /** The linear baseline actually fitted over `baselineRegion` — `rfu = intercept + slope *
   * cycle` — so callers can display the baseline itself (e.g. "2000 + 4c") rather than just the
   * subtracted result. Always the linear fit, regardless of `mode`: even `"Raw"`/
   * `"RawBaseLineSubtracted"` callers get the real trend line for display purposes. */
  baselineFit: LinearBaselineFit;
}

/**
 * Baseline-correct a curve and derive the per-well quality metrics `threshold.md` §5/§7 need:
 * the baseline region (always auto-detected on a smoothed copy, the same as the Curves view's
 * chart), the corrected values, the noise estimate, the amplification verdict, and the endpoint
 * ΔRFU. Shared by the Curves view's baseline subtraction and the Analysis view's Cq/ΔRFU table,
 * so both report numbers computed the same way from the same settings.
 */
export function baselineCorrectCurve(
  cycles: number[],
  values: number[],
  mode: BaselineMode,
  amplification?: AmplificationOptions,
): CurveBaselineResult {
  const smoothed = smoothCurve(values);
  const region = autoBaselineRegion(cycles, smoothed) ?? fallbackRegion(cycles);
  const baselineValid = validateBaselineRegion(cycles, smoothed, region);
  const correctedValues = subtractBaseline(cycles, values, region, mode);
  const noise = baselineNoise(cycles, correctedValues, region);
  const amplified = baselineValid && isAmplified(correctedValues, noise, amplification);

  const idx: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) idx.push(i);
  }
  const baselineMean =
    idx.length > 0 ? idx.reduce((s, i) => s + correctedValues[i]!, 0) / idx.length : 0;
  const deltaRfu = (correctedValues.at(-1) ?? 0) - baselineMean;
  const baselineRfu = idx.length > 0 ? idx.reduce((s, i) => s + values[i]!, 0) / idx.length : 0;
  const baselineFit = fitLinearBaseline(cycles, values, region);

  return {
    baselineRegion: region,
    baselineValid,
    correctedValues,
    noise,
    amplified,
    deltaRfu,
    baselineRfu,
    baselineFit,
  };
}
