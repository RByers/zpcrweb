/**
 * Analytical transforms over curve data. Kept in the library (not the UI) so they are
 * covered by the test suite and shared by any consumer.
 */

/**
 * Baseline-subtract a series against one of its own points (delta-RFU). Returns a new array
 * where every value has the baseline value subtracted, so the baseline point becomes 0 and
 * the rest are expressed relative to it. This is the standard "ΔRFU" view of a qPCR
 * amplification curve.
 *
 * @param values the raw series (e.g. a curve's `mean` array)
 * @param baselineIndex index whose value is treated as the baseline (default 0, first cycle)
 * @returns a new array of the same length; empty input yields an empty array
 */
export function deltaBaseline(values: number[], baselineIndex = 0): number[] {
  if (values.length === 0) return [];
  const baseline = values[baselineIndex] ?? values[0] ?? 0;
  return values.map((v) => v - baseline);
}

/**
 * Element-wise subtraction of one series from another, `a[i] - b[i]`. Used to subtract a
 * per-cycle background (e.g. a channel's dark reading) from a well's curve. Missing entries
 * in `b` are treated as 0; the result matches the length of `a`.
 */
export function subtractSeries(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - (b[i] ?? 0));
}
