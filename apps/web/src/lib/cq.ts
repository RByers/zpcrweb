import type { LinearBaselineFit } from "@zpcrweb/core";

/**
 * An RFU level, as a whole number. Fluorescence readings run to thousands and carry nothing
 * meaningful below the ones place, so decimals here are noise dressed as precision — they make
 * columns harder to scan and imply a resolution the instrument doesn't have. Applies to every
 * RFU *level* on screen: thresholds, ΔRFU, per-cycle readings, a fitted baseline's intercept.
 *
 * Deliberately not applied to quantities that merely share the unit but live on a different
 * scale: a baseline's slope (RFU per cycle, routinely under 1), a per-cycle standard deviation,
 * or the CSV export, where full precision is the point.
 */
export function formatRfu(n: number): string {
  return String(Math.round(n));
}

/**
 * A Cq, to one decimal. The second decimal is well inside the run-to-run spread of replicates —
 * on the samples in hand, triplicates differ by 0.1–0.5 cycles — so showing it invites comparisons
 * the number can't support. The CSV export keeps more digits for downstream use.
 */
export function formatCq(n: number | null | undefined): string {
  return n == null ? "—" : n.toFixed(1);
}

function formatCoefficient(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/** Render a fitted linear baseline as "2000 + 4c" (or "2000 - 4c" for a negative slope) — `c`
 * stands for the cycle number. Used everywhere a baseline is displayed or exported, in place of
 * a single diagnostic RFU value, since the fit is a line, not a point. */
export function formatBaselineFormula(fit: LinearBaselineFit): string {
  const sign = fit.slope < 0 ? "-" : "+";
  // Intercept is an RFU level (thousands); slope is RFU per cycle, often well under 1, so it keeps
  // its decimals — rounding it to a whole number would erase most baselines' drift entirely.
  return `${formatRfu(fit.intercept)} ${sign} ${formatCoefficient(Math.abs(fit.slope))}c`;
}
