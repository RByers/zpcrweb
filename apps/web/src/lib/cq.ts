import type { BaselineMode } from "@zpcrweb/core";
import type { CurveBaselineMode } from "../state/useZpcrStore";

/** `threshold.md` §4's library baseline modes, mapped from the Curves view's
 * `CurveBaselineMode` exactly as `lib/uplot/chart.ts`'s `algorithmAdjust` does — so the
 * Analysis table and the Curves view's Cq markers agree with the chart's own baselining. */
export function libBaselineMode(mode: CurveBaselineMode): BaselineMode {
  if (mode === "constant") return "RawBaseLineSubtracted";
  if (mode === "linear") return "LinearBaseLineNormalized";
  return "Raw";
}
