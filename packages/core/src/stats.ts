/**
 * Small statistical primitives shared by the baseline (§3) and threshold (§5) stages of
 * `threshold.md`. Split into their own module so `baseline.ts` and `threshold.ts` can both use
 * them without either importing the other — `analysis.ts` sits above both.
 */

/** Population standard deviation. Returns 0 for an empty series. */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/**
 * Mean squared successive difference — `mean((v[i] − v[i−1])²)`. The numerator of both the MSSD
 * noise estimate (`threshold.ts`'s `baselineNoise`) and {@link whiteness}. Returns 0 for a series
 * shorter than 2.
 */
export function meanSquaredSuccessiveDifference(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < values.length; i++) sum += (values[i]! - values[i - 1]!) ** 2;
  return sum / (values.length - 1);
}

/**
 * **von Neumann's ratio**: mean squared successive difference divided by variance. A scale-free
 * measure of how much of a residual series is white noise rather than structure:
 *
 * - **≈ 2** — white noise; successive values are independent, so their differences carry twice the
 *   variance of the values themselves.
 * - **→ 0** — strongly serially correlated; the series traces a smooth path, meaning whatever model
 *   produced these residuals is the wrong shape for the data.
 * - **> 2** — alternating / anti-correlated.
 *
 * Needs no tuning constant and no scale: the null value is 2 for every series, whatever its
 * magnitude. Returns 2 (the null) when there is too little data or no spread to judge, so a
 * constant series is never reported as structured.
 */
export function whiteness(values: number[]): number {
  if (values.length < 3) return 2;
  const variance = stdDev(values) ** 2;
  if (variance === 0) return 2;
  return meanSquaredSuccessiveDifference(values) / variance;
}

/** Median of a series. Returns 0 for an empty series; averages the middle pair when even. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
