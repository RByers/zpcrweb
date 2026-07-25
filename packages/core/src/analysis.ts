/**
 * Analytical transforms over curve data. Kept in the library (not the UI) so they are
 * covered by the test suite and shared by any consumer.
 */

import {
  autoBaselineRegion,
  clampBaselineRegion,
  smoothCurve,
  subtractBaseline,
  type BaselineMode,
  type BaselineRegion,
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
  correctedValues: number[];
  /** §5.1 noise estimate — the baseline-corrected residual spread over `baselineRegion`. */
  noise: number;
  /** §7 amplification gate — see {@link isAmplified}. */
  amplified: boolean;
  /** Endpoint rise relative to the baseline: the curve's last corrected value minus the mean
   * corrected value over `baselineRegion` (≈ the last value itself, since baseline subtraction
   * already centers the region near zero — computed explicitly so it stays correct for `"Raw"`
   * mode too, which does no subtraction). */
  deltaRfu: number;
}

/**
 * Baseline-correct a curve and derive the per-well quality metrics `threshold.md` §5/§7 need:
 * the baseline region (auto-detected on a smoothed copy, same as the Curves view's chart
 * preview, unless `manualRegion` overrides it), the corrected values, the noise estimate, the
 * amplification verdict, and the endpoint ΔRFU. Shared by the Curves view's baseline
 * subtraction and the Analysis view's Cq/ΔRFU table, so both report numbers computed the same
 * way from the same settings.
 */
export function baselineCorrectCurve(
  cycles: number[],
  values: number[],
  mode: BaselineMode,
  manualRegion?: BaselineRegion | null,
  amplification?: AmplificationOptions,
): CurveBaselineResult {
  const region = manualRegion
    ? clampBaselineRegion(manualRegion, cycles)
    : (autoBaselineRegion(cycles, smoothCurve(values)) ?? fallbackRegion(cycles));
  const correctedValues = subtractBaseline(cycles, values, region, mode);
  const noise = baselineNoise(cycles, correctedValues, region);
  const amplified = isAmplified(correctedValues, noise, amplification);

  const idx: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) idx.push(i);
  }
  const baselineMean =
    idx.length > 0 ? idx.reduce((s, i) => s + correctedValues[i]!, 0) / idx.length : 0;
  const deltaRfu = (correctedValues.at(-1) ?? 0) - baselineMean;

  return { baselineRegion: region, correctedValues, noise, amplified, deltaRfu };
}
