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
import {
  baselineNoise,
  computeCq,
  isAmplified,
  resolveThreshold,
  type AmplificationOptions,
  type AutoThresholdOptions,
  type CqAlgorithm,
} from "./threshold.js";

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
  // Onset detection reads the smoothed curve (it hunts a second-derivative peak); the start-trim
  // reads the raw one, since smoothing is serial correlation by construction and would make every
  // region look mis-modelled. See `refineBaselineStart`.
  const region = autoBaselineRegion(cycles, smoothed, { rawValues: values }) ?? fallbackRegion(cycles);
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

/** Default baseline mode for every Cq in the app: `threshold.md` §4's `LinearBaseLineNormalized`
 * over the auto-detected region. Baselining is not a user choice — what the Curves view *plots*
 * is (see its `CurveView` setting), but that never feeds a Cq. */
export const ANALYSIS_BASELINE_MODE: BaselineMode = "LinearBaseLineNormalized";

/** One curve entering {@link computeCqTable}. */
export interface CqTableCurve {
  /** Identity of the curve — one well/fluorophore pair — and the key its result is filed under.
   * Duplicates are dropped (first wins) so a repeated pair can neither be double-counted in its
   * group's noise cohort nor end up with two different Cq values.
   *
   * Well/*fluor*, not well/target: a well can load two dyes that share one group (both untargeted,
   * say), and they are two distinct curves with two distinct Cq values. Since each well/fluor pair
   * carries at most one target, one entry per key is still exactly one Cq per well/target. */
  key: string;
  /** Threshold group (`threshold.md` §5.1): one threshold per group, resolved from the median
   * baseline noise across that group's curves. Normally the target/gene name — with untargeted
   * wells (NTC/NRT and the like) sharing one catch-all group rather than being left out: a well
   * with no target still gets a real Cq. */
  group: string;
  cycles: number[];
  values: number[];
  /** Whether this curve joins its group's noise cohort — default `true`. Set `false` for a curve
   * that should still *get* a Cq but shouldn't influence the group's threshold, i.e. a well/fluor
   * pair the plate never loaded (real signal isn't expected there, so its noise shouldn't set the
   * bar for wells that were loaded). Never use it to reflect a display filter: that's exactly the
   * subset-dependence this table exists to eliminate. A group whose curves *all* opt out falls
   * back to using them all, rather than resolving a meaningless zero threshold. */
  contributesToThreshold?: boolean;
}

/** One well/target pair's analysis result — every Cq-related number the UI shows for it. */
export interface CqTableEntry extends CurveBaselineResult {
  group: string;
  /** The threshold this curve's Cq was actually taken against: the §5.1 value resolved for
   * {@link group} and shared by every curve in it, unless a per-curve override replaced it —
   * see {@link thresholdSource}. */
  threshold: number;
  /** The threshold resolved for {@link group} as a whole — §5.1's auto value, or a manual override
   * on the group. Equal to {@link threshold} unless a per-curve override replaced it, and reported
   * separately so a UI can show what the group is on without having to find a curve that didn't
   * override it (there might not be one). */
  groupThreshold: number;
  /** Where {@link threshold} came from: §5.1's auto value, a manual override on the whole
   * {@link group}, or a manual override on this curve alone (which outranks the other two). */
  thresholdSource: "auto" | "group" | "curve";
  cq: number | null;
}

export interface CqTableOptions {
  /** §6, see {@link CqAlgorithm}. Default `"Threshold"`. */
  algorithm?: CqAlgorithm;
  /** Manual per-group threshold overrides, keyed by {@link CqTableCurve.group}. A group with no
   * entry uses the auto threshold. */
  thresholdOverrides?: ReadonlyMap<string, number>;
  /**
   * Manual per-*curve* threshold overrides, keyed by {@link CqTableCurve.key} — the finest grain a
   * threshold can be set at, and the highest precedence: a curve listed here uses that value
   * whatever its group resolved to, override or auto.
   *
   * A group threshold is a median over a cohort (§5.1), which is the right default precisely
   * because it refuses to follow any single well — but that also means one well with an unusual
   * baseline can't be corrected by moving the group without moving every other well with it. This
   * is the escape hatch for that well.
   *
   * An overridden curve still joins its group's noise cohort: its baseline noise is a real
   * measurement, and dropping it would silently change every *other* curve's threshold as a side
   * effect of editing this one.
   */
  curveThresholdOverrides?: ReadonlyMap<string, number>;
  /** §5.1 auto-threshold tuning for groups with no override — see {@link AutoThresholdOptions}. */
  autoThreshold?: AutoThresholdOptions;
  /** Baseline subtraction mode; defaults to {@link ANALYSIS_BASELINE_MODE} and should normally be
   * left alone, so every view reports the same Cq. */
  baselineMode?: BaselineMode;
  amplification?: AmplificationOptions;
}

/**
 * **The** Cq computation: baseline-correct every curve, resolve one threshold per group from that
 * group's own noise cohort (§5.1), and derive each curve's Cq (§6) — returning one entry per
 * `key`.
 *
 * This is deliberately the single implementation, and callers are expected to build it over a
 * run's *whole* plate, once, and then read individual entries out of it. (The one thing that *is*
 * per-curve is {@link CqTableOptions.curveThresholdOverrides}, an explicit user decision about one
 * curve — not a threshold re-derived from a subset.) A Cq is not a property of
 * a curve alone: its group's threshold is the median baseline noise over the curves handed in, so
 * computing it a second time over a filtered subset (only the plotted wells, only the enabled
 * targets, …) yields a *different, equally defensible* Cq for the very same well — which is how
 * one view came to show a Cq where another showed none. Filter the returned table for display;
 * never re-derive it from a subset.
 */
export function computeCqTable(
  curves: CqTableCurve[],
  options: CqTableOptions = {},
): Map<string, CqTableEntry> {
  const algorithm = options.algorithm ?? "Threshold";
  const mode = options.baselineMode ?? ANALYSIS_BASELINE_MODE;

  const unique: CqTableCurve[] = [];
  const seen = new Set<string>();
  for (const c of curves) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    unique.push(c);
  }

  const baselines = unique.map((c) =>
    baselineCorrectCurve(c.cycles, c.values, mode, options.amplification),
  );

  // §5.1: one threshold per group, over that group's whole noise cohort.
  const cohortByGroup = new Map<string, number[]>();
  const allByGroup = new Map<string, number[]>();
  unique.forEach((c, i) => {
    const noise = baselines[i]!.noise;
    const all = allByGroup.get(c.group) ?? [];
    all.push(noise);
    allByGroup.set(c.group, all);
    if (c.contributesToThreshold === false) return;
    const cohort = cohortByGroup.get(c.group) ?? [];
    cohort.push(noise);
    cohortByGroup.set(c.group, cohort);
  });
  const thresholdByGroup = new Map<string, number>();
  for (const [group, all] of allByGroup) {
    const noises = cohortByGroup.get(group) ?? all;
    thresholdByGroup.set(
      group,
      resolveThreshold(noises, {
        overrideValue: options.thresholdOverrides?.get(group),
        auto: options.autoThreshold,
      }),
    );
  }

  const table = new Map<string, CqTableEntry>();
  unique.forEach((c, i) => {
    const b = baselines[i]!;
    // Per-curve override outranks the group's threshold, whether that was itself an override or
    // §5.1's auto value — it is the more specific statement about this exact curve.
    const curveOverride = options.curveThresholdOverrides?.get(c.key);
    const groupThreshold = thresholdByGroup.get(c.group) ?? 0;
    const threshold = curveOverride ?? groupThreshold;
    const thresholdSource =
      curveOverride !== undefined
        ? "curve"
        : options.thresholdOverrides?.get(c.group) !== undefined
          ? "group"
          : "auto";
    const cq = computeCq(c.cycles, b.correctedValues, {
      algorithm,
      threshold: algorithm === "Threshold" ? threshold : undefined,
      noise: b.noise,
      amplification: options.amplification,
      baselineValid: b.baselineValid,
    });
    table.set(c.key, { ...b, group: c.group, threshold, groupThreshold, thresholdSource, cq });
  });
  return table;
}
