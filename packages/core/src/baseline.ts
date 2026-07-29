/**
 * The baseline stage of `threshold.md` (§3–§4): choose the flat, pre-amplification part of a
 * per-dye amplification curve, fit a straight line to it, and subtract that line from every
 * cycle.
 *
 * The whole stage is three short functions, and every constant in it is measured against CFX's
 * own exported curves rather than tuned (`threshold.md` §1.7): the region begins at cycle
 * {@link BASELINE_BEGIN_CYCLE}, ends {@link BASELINE_END_MARGIN} cycles before the well's own Cq
 * (or at the last cycle, when the well has none), and the line is ordinary least squares. There
 * is no smoothing, no onset detection and no validity gate — see `threshold.md` §9 for what was
 * removed and why.
 *
 * The region depends on the Cq and the Cq depends on the region, so the loop is closed one level
 * up, in `analysis.ts` — see `baselineCorrectCurve`.
 */

/** A baseline region as a pair of inclusive, 1-based cycle numbers (`baselineBeginRepeat` /
 * `baselineEndRepeat`). */
export interface BaselineRegion {
  beginCycle: number;
  endCycle: number;
}

/**
 * The first cycle any baseline region may include. **3**, measured.
 *
 * Recovering CFX's own baseline line for all 24 exported curves of `20260726_S183-S185_RVP` and
 * searching for the window that reproduces it puts every well's region at cycle 3 or 4 — never at
 * 1, and never at the `baselineBeginRepeat="2"` the same file persists (`threshold.md` §1.7). The
 * physical reading is the familiar one: block and optics are still settling over the run's first
 * reads, so those points sit off the line the rest of the region describes and tilt the fit.
 */
export const BASELINE_BEGIN_CYCLE = 3;

/**
 * How many cycles before its Cq an amplifying well's baseline region stops. **2**, measured.
 *
 * The three clean positive controls in the RVP run whose window could be recovered exactly all
 * give `round(Cq) − 2` (`threshold.md` §1.7). The margin exists because the exponential's foot
 * lifts the curve measurably a cycle or two before it reaches the threshold, and a baseline fitted
 * through that foot tilts upward and drags every later value down.
 */
export const BASELINE_END_MARGIN = 2;

/** Narrowest region {@link baselineRegion} will return. Not measured — a floor, so a well with an
 * implausibly early Cq still leaves enough points for the fit and the noise estimate to mean
 * something. */
export const MIN_BASELINE_WIDTH = 5;

/**
 * §3: the baseline region for one curve.
 *
 * - **No Cq ⇒ the whole run.** A well that never amplifies has no onset to stop before, so the
 *   baseline is every cycle from {@link BASELINE_BEGIN_CYCLE} on. This is what CFX does — the
 *   window search of `threshold.md` §1.7 lands on 3–45 or 4–45 for every non-amplifying well in
 *   the RVP run — and it is the fix for the long-standing "negative curve that rises for five
 *   cycles then goes flat" bug, whose right baseline is the long flat tail, not the start.
 * - **A Cq ⇒ stop {@link BASELINE_END_MARGIN} cycles before it**, at `round(cq) − 2`.
 *
 * `cq` is the Cq computed from a *previous* correction of this same curve — see
 * `baselineCorrectCurve` in `analysis.ts`, which iterates the pair to a fixed point.
 */
export function baselineRegion(cycles: number[], cq: number | null): BaselineRegion {
  const lastCycle = cycles.length > 0 ? cycles[cycles.length - 1]! : BASELINE_BEGIN_CYCLE;
  const beginCycle = Math.min(BASELINE_BEGIN_CYCLE, lastCycle);
  const wanted = cq == null ? lastCycle : Math.round(cq) - BASELINE_END_MARGIN;
  const endCycle = Math.min(lastCycle, Math.max(wanted, beginCycle + MIN_BASELINE_WIDTH - 1));
  return { beginCycle, endCycle };
}

/** Indices of the cycles that fall inside `region`. */
function regionIndices(cycles: number[], region: BaselineRegion): number[] {
  const idx: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) idx.push(i);
  }
  return idx;
}

/** A fitted baseline line, `rfu = intercept + slope × cycle` — exposed so callers can display the
 * line itself (e.g. as "2000 + 4c") rather than only its effect. */
export interface LinearBaselineFit {
  slope: number;
  intercept: number;
}

/**
 * Fit the baseline line over `region` by ordinary least squares. Returns the zero line when no
 * cycle falls inside the region.
 */
export function fitLinearBaseline(
  cycles: number[],
  values: number[],
  region: BaselineRegion,
): LinearBaselineFit {
  const idx = regionIndices(cycles, region);
  if (idx.length === 0) return { slope: 0, intercept: 0 };
  const n = idx.length;
  const meanX = idx.reduce((s, i) => s + cycles[i]!, 0) / n;
  const meanY = idx.reduce((s, i) => s + values[i]!, 0) / n;
  let num = 0;
  let den = 0;
  for (const i of idx) {
    num += (cycles[i]! - meanX) * (values[i]! - meanY);
    den += (cycles[i]! - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * `pCRBaseLine` (§4) — what "baseline-corrected" means.
 *
 * - `Raw` — no correction.
 * - `RawBaseLineSubtracted` — subtract a constant, the region's mean.
 * - `LinearBaseLineNormalized` — subtract the fitted line, removing drift as well as offset. What
 *   the reference does, and this library's only analysis mode; `LinearBaseLineNormalizedCurveFit`
 *   (the mode a `.pcrd` names) is this plus {@link smoothPlateauTail}, which changes no reported
 *   Cq. See `threshold.md` §4.
 *
 * The `Reference…` modes, which normalize against a passive reference dye before baselining, are
 * not implemented: no sample uses them.
 */
export type BaselineMode = "Raw" | "RawBaseLineSubtracted" | "LinearBaseLineNormalized";

/**
 * §4: subtract the baseline. Returns `values` unchanged when no cycle falls inside `region`.
 */
export function subtractBaseline(
  cycles: number[],
  values: number[],
  region: BaselineRegion,
  mode: BaselineMode,
): number[] {
  if (mode === "Raw") return values.slice();

  const idx = regionIndices(cycles, region);
  if (idx.length === 0) return values.slice();

  if (mode === "RawBaseLineSubtracted") {
    const mean = idx.reduce((s, i) => s + values[i]!, 0) / idx.length;
    return values.map((v) => v - mean);
  }

  const fit = fitLinearBaseline(cycles, values, region);
  return values.map((v, i) => v - (fit.slope * cycles[i]! + fit.intercept));
}

/**
 * The tail filter of `LinearBaseLineNormalizedCurveFit` (`threshold.md` §1.7): a width-3 centred
 * mean over the corrected curve's plateau, from `floor(cq) + 3` to the second-to-last cycle. Read
 * from the unfiltered curve — a plain FIR pass, not applied in place.
 *
 * Measured exactly, on all 9 wells of the RVP run that have a Cq: with this one pass the
 * reconstruction of CFX's exported curve lands at 4–7 × 10⁻³ RFU RMS over all 45 cycles, on
 * curves spanning 4653 RFU. Two details are part of the measurement — the **last cycle is left
 * alone**, and everything before the start cycle is untouched, so the baseline, the threshold and
 * the Cq (all settled before this runs) are unaffected. It changes only the reported plateau, and
 * therefore {@link endPointRfu}.
 *
 * A curve with no Cq is returned unchanged: there is no plateau to smooth.
 */
export function smoothPlateauTail(values: number[], cq: number | null): number[] {
  if (cq == null || values.length < 3) return values.slice();
  const out = values.slice();
  const start = Math.floor(cq) + 3;
  for (let c = Math.max(start, 2); c <= values.length - 1; c++) {
    // `c` is a 1-based cycle; index c-1. The last cycle (index length-1) is deliberately excluded.
    const i = c - 1;
    out[i] = (values[i - 1]! + values[i]! + values[i + 1]!) / 3;
  }
  return out;
}

/** How many trailing cycles {@link endPointRfu} averages. **5**, measured — see that function. */
export const END_POINT_CYCLES = 5;

/**
 * The end-point RFU (`threshold.md` §8): the mean of the corrected curve's last
 * {@link END_POINT_CYCLES} values. Some assays report no Cq at all and read this instead.
 *
 * Measured: it reproduces the `End Point Results` export's **End RFU** column exactly, to the
 * CSV's full precision, for all 14 wells of the RVP run across two dyes. It is not the last value
 * (which differs by up to 320 RFU on a still-rising well), not the last 3, and not the last 10.
 */
export function endPointRfu(values: number[]): number {
  if (values.length === 0) return 0;
  const tail = values.slice(Math.max(0, values.length - END_POINT_CYCLES));
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}
