/**
 * Analytical transforms over curve data. Kept in the library (not the UI) so they are
 * covered by the test suite and shared by any consumer.
 */

import {
  baselineRegion,
  endPointRfu,
  fitLinearBaseline,
  smoothPlateauTail,
  subtractBaseline,
  type BaselineMode,
  type BaselineRegion,
  type LinearBaselineFit,
} from "./baseline.js";
import {
  autoThreshold,
  baselineNoise,
  computeCq,
  resolveThreshold,
  type AutoThresholdOptions,
} from "./threshold.js";

export interface CurveBaselineResult {
  baselineRegion: BaselineRegion;
  correctedValues: number[];
  /** §5.2 noise estimate — how much the corrected curve jitters over `baselineRegion`. */
  noise: number;
  /** Endpoint rise relative to the baseline: the curve's last corrected value minus the mean
   * corrected value over `baselineRegion` (≈ the last value itself, since baseline subtraction
   * already centers the region near zero — computed explicitly so it stays correct for `"Raw"`
   * mode too, which does no subtraction). Distinct from `CqTableEntry.endRfu`, which averages the
   * last five cycles and is what the instrument reports. */
  deltaRfu: number;
  /** The line actually fitted over `baselineRegion` — `rfu = intercept + slope × cycle` — so
   * callers can plot the baseline itself. Always the linear fit, whatever `mode` is. */
  baselineFit: LinearBaselineFit;
}

/**
 * How many times {@link baselineCorrectCurve} may re-fit. The region depends on the Cq and the Cq
 * depends on the region, so the pair is iterated to a fixed point; measured over the committed
 * samples it converges in two or three passes, and the cap only bounds the rare curve that
 * oscillates between two adjacent regions (which then keeps the last one).
 */
const MAX_BASELINE_PASSES = 6;

/**
 * Baseline-correct one curve and derive its per-well metrics (`threshold.md` §3–§5).
 *
 * The region is chosen by `baselineRegion`: the whole run for a well with no Cq, stopping two
 * cycles short of the Cq for one that has it. Since the Cq is what the correction is *for*, the
 * two are iterated — correct over the whole run, take a Cq, re-fit ending before it, repeat until
 * the region stops moving. `threshold` is the value that provisional Cq is taken against; pass
 * `null` to skip the refinement entirely (the whole-run baseline), which is what the first pass of
 * {@link computeCqTable} does before any threshold exists.
 *
 * Nothing here is smoothed. CFX's exported corrected curves are unsmoothed white noise about their
 * baselines even though the run persists `pCRDigitalFilter="WeightedMean"` (`threshold.md` §1.6),
 * so the filter named in the file is not applied to the curve that gets analysed.
 */
export function baselineCorrectCurve(
  cycles: number[],
  values: number[],
  mode: BaselineMode,
  threshold: number | null = null,
): CurveBaselineResult {
  let region = baselineRegion(cycles, null);
  let correctedValues = subtractBaseline(cycles, values, region, mode);

  if (threshold != null) {
    for (let pass = 0; pass < MAX_BASELINE_PASSES; pass++) {
      const next = baselineRegion(cycles, computeCq(cycles, correctedValues, threshold));
      if (next.beginCycle === region.beginCycle && next.endCycle === region.endCycle) break;
      region = next;
      correctedValues = subtractBaseline(cycles, values, region, mode);
    }
  }

  const noise = baselineNoise(cycles, correctedValues, region);
  let regionSum = 0;
  let regionCount = 0;
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) {
      regionSum += correctedValues[i]!;
      regionCount++;
    }
  }
  const baselineMean = regionCount > 0 ? regionSum / regionCount : 0;

  return {
    baselineRegion: region,
    correctedValues,
    noise,
    deltaRfu: (correctedValues.at(-1) ?? 0) - baselineMean,
    baselineFit: fitLinearBaseline(cycles, values, region),
  };
}

/**
 * Baseline-correct a curve that will never be quantified — a raw per-channel trace, a dark
 * overlay — for display alongside the ones that are.
 *
 * Such a curve has no threshold group to take a threshold from, so the region refinement is driven
 * by the curve's own noise instead: correct over the whole run, take {@link autoThreshold} of that
 * one noise estimate, and re-correct. That is the same rule {@link computeCqTable} applies, with a
 * cohort of one, and it is here rather than inlined in the app so a plotted baseline and a
 * quantified one can never drift apart.
 */
export function correctCurveForDisplay(
  cycles: number[],
  values: number[],
  mode: BaselineMode,
  options: AutoThresholdOptions = {},
): CurveBaselineResult {
  const wholeRun = baselineCorrectCurve(cycles, values, mode);
  return baselineCorrectCurve(cycles, values, mode, autoThreshold([wholeRun.noise], options));
}

/** Default baseline mode for every Cq in the app: `threshold.md` §4's `LinearBaseLineNormalized`.
 * Baselining is not a user choice — what the Curves view *plots* is (see its `CurveView` setting),
 * but that never feeds a Cq. */
export const ANALYSIS_BASELINE_MODE: BaselineMode = "LinearBaseLineNormalized";

/** One curve entering {@link computeCqTable}. */
export interface CqTableCurve {
  /** Identity of the curve — one well/fluorophore pair — and the key its result is filed under.
   * Duplicates are dropped (first wins) so a repeated pair can neither be double-counted in its
   * group's noise cohort nor end up with two different Cq values. */
  key: string;
  /** Threshold group (`threshold.md` §5.2): one threshold per group, resolved from the median
   * baseline noise across that group's curves. Normally the fluorophore. */
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

/** One well/fluorophore pair's analysis result — every Cq-related number the UI shows for it. */
export interface CqTableEntry extends CurveBaselineResult {
  group: string;
  /** The threshold this curve's Cq was taken against: its {@link group}'s value, unless a
   * per-curve override replaced it — see {@link thresholdSource}. */
  threshold: number;
  /** The threshold resolved for {@link group} as a whole, reported separately so a UI can show
   * what the group is on even when every curve in it overrides. */
  groupThreshold: number;
  /** Where {@link threshold} came from: §5.1's auto value, an override on the whole {@link group},
   * or one on this curve alone (which outranks both). */
  thresholdSource: "auto" | "group" | "curve";
  cq: number | null;
  /** The end-point RFU (`threshold.md` §8): the mean of the last five cycles of the corrected
   * curve, after `LinearBaseLineNormalizedCurveFit`'s plateau filter. Reproduces CFX's own
   * `End RFU` exactly. Some assays report this instead of a Cq. */
  endRfu: number;
}

export interface CqTableOptions {
  /** Manual per-group threshold overrides, keyed by {@link CqTableCurve.group}. A group with no
   * entry uses the auto threshold. On a `.pcrd` the run's own persisted
   * `thresholdOverrideValue` is what seeds these. */
  thresholdOverrides?: ReadonlyMap<string, number>;
  /**
   * Manual per-*curve* threshold overrides, keyed by {@link CqTableCurve.key} — the finest grain a
   * threshold can be set at, and the highest precedence.
   *
   * A group threshold is a median over a cohort (§5.1), which is the right default precisely
   * because it refuses to follow any single well — but that also means one well with an unusual
   * baseline can't be corrected without moving every other well with it. This is the escape hatch.
   * An overridden curve still joins its group's noise cohort: its noise is a real measurement, and
   * dropping it would silently change every *other* curve's threshold.
   */
  curveThresholdOverrides?: ReadonlyMap<string, number>;
  /** §5.1 auto-threshold tuning for groups with no override — see {@link AutoThresholdOptions}. */
  autoThreshold?: AutoThresholdOptions;
  /** Baseline subtraction mode; defaults to {@link ANALYSIS_BASELINE_MODE} and should normally be
   * left alone, so every view reports the same Cq. */
  baselineMode?: BaselineMode;
}

/**
 * **The** Cq computation: baseline-correct every curve, resolve one threshold per group from that
 * group's own noise cohort (§5.1), and derive each curve's Cq (§6) — one entry per `key`.
 *
 * Two passes, because each stage needs the other's answer:
 *
 * 1. Correct every curve over the **whole run** and resolve each group's threshold from the noise
 *    that gives.
 * 2. Re-correct each curve with that threshold, so an amplifying well's baseline stops before its
 *    own Cq (`baselineCorrectCurve`), and re-resolve the thresholds from the improved noise. The
 *    reported Cq is taken against those.
 *
 * The second pass matters because a strongly amplifying well baselined over the whole run has a
 * wildly overstated noise, which drags its group's median — and hence every well's threshold.
 *
 * Callers are expected to build this over a run's *whole* plate, once, and read individual entries
 * out of it. A Cq is not a property of a curve alone: its group's threshold is the median baseline
 * noise over the curves handed in, so computing it again over a filtered subset (only the plotted
 * wells, only the enabled targets, …) yields a *different, equally defensible* Cq for the very same
 * well. Filter the returned table for display; never re-derive it from a subset.
 */
export function computeCqTable(
  curves: CqTableCurve[],
  options: CqTableOptions = {},
): Map<string, CqTableEntry> {
  const mode = options.baselineMode ?? ANALYSIS_BASELINE_MODE;

  const unique: CqTableCurve[] = [];
  const seen = new Set<string>();
  for (const c of curves) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    unique.push(c);
  }

  /**
   * §5.1: one threshold per group, over that group's whole noise cohort. `applyOverrides` is
   * false when the result is only used to *place* baseline regions — see below.
   */
  const thresholdsFor = (
    baselines: CurveBaselineResult[],
    applyOverrides: boolean,
  ): Map<string, number> => {
    const cohort = new Map<string, number[]>();
    const all = new Map<string, number[]>();
    unique.forEach((c, i) => {
      const noise = baselines[i]!.noise;
      all.set(c.group, [...(all.get(c.group) ?? []), noise]);
      if (c.contributesToThreshold === false) return;
      cohort.set(c.group, [...(cohort.get(c.group) ?? []), noise]);
    });
    const out = new Map<string, number>();
    for (const [group, everyone] of all) {
      out.set(
        group,
        resolveThreshold(cohort.get(group) ?? everyone, {
          overrideValue: applyOverrides ? options.thresholdOverrides?.get(group) : undefined,
          auto: options.autoThreshold,
        }),
      );
    }
    return out;
  };

  // Pass 1: whole-run baselines, and the automatic thresholds they imply.
  const firstPass = unique.map((c) => baselineCorrectCurve(c.cycles, c.values, mode));
  const placement = thresholdsFor(firstPass, false);

  // Pass 2: re-baseline against that threshold, then re-resolve from the improved noise.
  //
  // Regions are placed with the group's **automatic** threshold, never an override — of either
  // kind. Where a curve stops looking like a baseline is a property of the curve; where a user (or
  // a saved run) chose to draw the line is not, and letting an override move baselines would make
  // one well's edit change its plate-mates' noise, and through the group median their thresholds.
  const baselines = unique.map((c) =>
    baselineCorrectCurve(c.cycles, c.values, mode, placement.get(c.group) ?? 0),
  );
  const thresholdByGroup = thresholdsFor(baselines, true);

  const table = new Map<string, CqTableEntry>();
  unique.forEach((c, i) => {
    const b = baselines[i]!;
    const curveOverride = options.curveThresholdOverrides?.get(c.key);
    const groupThreshold = thresholdByGroup.get(c.group) ?? 0;
    const threshold = curveOverride ?? groupThreshold;
    const thresholdSource =
      curveOverride !== undefined
        ? "curve"
        : options.thresholdOverrides?.get(c.group) !== undefined
          ? "group"
          : "auto";
    const cq = computeCq(c.cycles, b.correctedValues, threshold);
    // The plateau filter runs after the Cq, which it cannot change (`threshold.md` §1.7), and
    // feeds only the end-point RFU.
    const endRfu = endPointRfu(smoothPlateauTail(b.correctedValues, cq));
    table.set(c.key, { ...b, group: c.group, threshold, groupThreshold, thresholdSource, cq, endRfu });
  });
  return table;
}
