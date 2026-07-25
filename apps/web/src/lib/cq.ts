import type { LinearBaselineFit } from "@zpcrweb/core";

/** Cq/Analysis always baseline-correct with the library's linear mode (`threshold.md` §4's
 * `LinearBaseLineNormalized`, auto-detected region) — baselining is no longer a user choice; see
 * `useZpcrStore.ts`'s `CurveView`, which only controls what the Curves-view chart *displays*. */
export const ANALYSIS_BASELINE_MODE = "LinearBaseLineNormalized" as const;

function formatCoefficient(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/** Render a fitted linear baseline as "2000 + 4c" (or "2000 - 4c" for a negative slope) — `c`
 * stands for the cycle number. Used everywhere a baseline is displayed or exported, in place of
 * a single diagnostic RFU value, since the fit is a line, not a point. */
export function formatBaselineFormula(fit: LinearBaselineFit): string {
  const sign = fit.slope < 0 ? "-" : "+";
  return `${formatCoefficient(fit.intercept)} ${sign} ${formatCoefficient(Math.abs(fit.slope))}c`;
}
