/**
 * Small statistical primitives for the threshold stage of `threshold.md` (§5), in their own module
 * so `baseline.ts` and `threshold.ts` can both use them without either importing the other.
 */

/** Population standard deviation. Returns 0 for an empty series. */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/** Median of a series. Returns 0 for an empty series; averages the middle pair when even. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
