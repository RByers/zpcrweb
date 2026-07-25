/**
 * Analytical transforms over curve data. Kept in the library (not the UI) so they are
 * covered by the test suite and shared by any consumer.
 */

/**
 * Element-wise subtraction of one series from another, `a[i] - b[i]`. Used to subtract a
 * per-cycle background (e.g. a channel's dark reading) from a well's curve. Missing entries
 * in `b` are treated as 0; the result matches the length of `a`.
 */
export function subtractSeries(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - (b[i] ?? 0));
}
