import { describe, it, expect } from "vitest";
import {
  parseZpcr,
  smoothCurve,
  skipCycles,
  clampBaselineRegion,
  dataWindowRange,
  findBaselineByCurvature,
  findBaselineByRegression,
  autoBaselineRegion,
  validateBaselineRegion,
  subtractBaseline,
  fitLinearBaseline,
} from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("smoothCurve", () => {
  it("disable returns a copy of the input, unchanged", () => {
    const input = [1, 5, 2, 8, 3];
    const out = smoothCurve(input, { mode: "Disable" });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("RollingBoxcar averages a flat window over the centre", () => {
    const out = smoothCurve([0, 0, 10, 0, 0], { mode: "RollingBoxcar", width: 5 });
    expect(out[2]).toBeCloseTo(2, 5); // (0+0+10+0+0)/5
  });

  it("shrinks the window at the edges instead of leaving them unsmoothed", () => {
    const out = smoothCurve([10, 0, 0, 0, 0], { mode: "RollingBoxcar", width: 5 });
    // index 0's window has no left neighbours: [10, 0, 0] (indices 0-2) -> mean 10/3
    expect(out[0]).toBeCloseTo(10 / 3, 5);
  });

  it("WeightedMean weights the centre more than a boxcar would", () => {
    const values = [0, 0, 10, 0, 0];
    const boxcar = smoothCurve(values, { mode: "RollingBoxcar", width: 5 })[2]!;
    const weighted = smoothCurve(values, { mode: "WeightedMean", width: 5 })[2]!;
    expect(weighted).toBeGreaterThan(boxcar);
  });

  it("Centroid pulls the result toward the window's larger values", () => {
    const values = [1, 1, 1, 1, 100];
    const out = smoothCurve(values, { mode: "Centroid", width: 5 });
    // centred at index 2, the 100 at index 4 dominates the intensity weighting
    expect(out[2]).toBeGreaterThan(10);
  });

  it("Centroid falls back to a plain average when every value in the window is <= 0", () => {
    const out = smoothCurve([-1, -2, -3], { mode: "Centroid", width: 3 });
    expect(out[1]).toBeCloseTo(-2, 5);
  });

  it("does not mutate the input", () => {
    const input = [1, 2, 3, 4, 5];
    smoothCurve(input, { mode: "WeightedMean" });
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it("smooths the real B3/channel-0 curve without wildly distorting the plateau", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const smoothed = smoothCurve(curve.mean, { mode: "WeightedMean", width: 5 });
    expect(smoothed).toHaveLength(curve.mean.length);
    // the last cycle is still on the rising part of the curve, so a centred-but-edge-shrunk
    // window pulls it down somewhat -- but nowhere near the flat baseline level (~3350).
    expect(smoothed.at(-1)!).toBeGreaterThan(8000);
  });
});

describe("skipCycles", () => {
  it("drops leading and trailing cycles, keeping cycles/values aligned", () => {
    const cycles = [1, 2, 3, 4, 5];
    const values = [10, 20, 30, 40, 50];
    const out = skipCycles(cycles, values, 1, 2);
    expect(out.cycles).toEqual([2, 3]);
    expect(out.values).toEqual([20, 30]);
  });

  it("defaults to skipping nothing", () => {
    const out = skipCycles([1, 2, 3], [10, 20, 30]);
    expect(out.cycles).toEqual([1, 2, 3]);
    expect(out.values).toEqual([10, 20, 30]);
  });
});

describe("clampBaselineRegion", () => {
  const cycles = Array.from({ length: 45 }, (_, i) => i + 1);

  it("never begins before minBeginCycle (default 2)", () => {
    const region = clampBaselineRegion({ beginCycle: 0, endCycle: 9 }, cycles);
    expect(region.beginCycle).toBe(2);
  });

  it("never runs past the last cycle present", () => {
    const region = clampBaselineRegion({ beginCycle: 40, endCycle: 100 }, cycles);
    expect(region.endCycle).toBe(45);
  });

  it("widens a too-narrow region up to the minimum width", () => {
    const region = clampBaselineRegion({ beginCycle: 5, endCycle: 5 }, cycles, { minWidth: 3 });
    expect(region.endCycle - region.beginCycle + 1).toBe(3);
  });

  it("caps the widened region at the last cycle rather than overshooting", () => {
    const region = clampBaselineRegion({ beginCycle: 44, endCycle: 44 }, cycles, { minWidth: 5 });
    expect(region.endCycle).toBe(45);
  });

  it("respects a custom minBeginCycle", () => {
    const region = clampBaselineRegion({ beginCycle: 1, endCycle: 9 }, cycles, { minBeginCycle: 2 });
    expect(region.beginCycle).toBe(2);
  });
});

describe("dataWindowRange", () => {
  it("with the observed defaults (position 1, width 0.99) spans nearly the whole run", () => {
    const range = dataWindowRange(45);
    expect(range.start).toBe(1);
    expect(range.end).toBe(45);
  });

  it("a narrower window sits before the given position", () => {
    const range = dataWindowRange(100, { positionFraction: 0.5, widthFraction: 0.2 });
    expect(range.end).toBe(50);
    expect(range.start).toBe(31);
  });

  it("never returns a start below 1", () => {
    const range = dataWindowRange(10, { positionFraction: 0.1, widthFraction: 0.9 });
    expect(range.start).toBeGreaterThanOrEqual(1);
  });
});

describe("findBaselineByCurvature", () => {
  function sigmoid(cycles: number[], onset: number): number[] {
    return cycles.map((c) => 100 + 5000 / (1 + Math.exp(-(c - onset) * 0.5)));
  }

  it("finds a region ending comfortably before a clean sigmoid's onset", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = sigmoid(cycles, 25);
    const region = findBaselineByCurvature(cycles, values);
    expect(region).not.toBeNull();
    expect(region!.beginCycle).toBe(2);
    expect(region!.endCycle).toBeLessThan(25);
    expect(region!.endCycle - region!.beginCycle + 1).toBeGreaterThanOrEqual(3);
  });

  it("stays out of the rise when amplification is late and the run ends mid-climb", () => {
    // The second difference of a truncated exponential is still climbing at the last cycle, so its
    // peak lands near the end of the run: taking the peak itself as onset would put the baseline
    // several cycles into the rise. See `onsetFootFraction`.
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = cycles.map((c) => 5400 - c * 6 + Math.exp((c - 32) * 0.75) * 20);
    const region = findBaselineByCurvature(cycles, smoothCurve(values))!;
    expect(region).not.toBeNull();
    expect(region.endCycle).toBeLessThan(32);
  });

  it("finds a plausible baseline on the real B3/channel-0 amplification curve", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const smoothed = smoothCurve(curve.mean, { mode: "WeightedMean", width: 5 });
    const region = findBaselineByCurvature(curve.cycles, smoothed);
    expect(region).not.toBeNull();
    expect(region!.beginCycle).toBe(2);
    // the curve is flat through ~cycle 25 and plateaus by ~cycle 40 (see fixture data); the
    // flatness/linearity thresholds are relative to the *whole* curve's span, so the region is
    // allowed to creep partway into the early rise rather than stopping exactly at onset.
    expect(region!.endCycle).toBeGreaterThanOrEqual(3);
    expect(region!.endCycle).toBeLessThan(40);
  });

  it("returns null for a flat curve with no amplification onset", () => {
    const cycles = Array.from({ length: 20 }, (_, i) => i + 1);
    const values = cycles.map(() => 1000);
    expect(findBaselineByCurvature(cycles, values)).toBeNull();
  });

  it("returns null when there are too few cycles to analyse", () => {
    expect(findBaselineByCurvature([1, 2], [10, 20])).toBeNull();
  });
});

describe("findBaselineByRegression", () => {
  it("extends through a flat region and stops where a sigmoid departs from the fitted line", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = cycles.map((c) => 100 + 5000 / (1 + Math.exp(-(c - 25) * 0.5)));
    const region = findBaselineByRegression(cycles, values);
    expect(region).not.toBeNull();
    expect(region!.beginCycle).toBe(2);
    expect(region!.endCycle).toBeLessThan(25);
    expect(region!.endCycle).toBeGreaterThanOrEqual(3);
  });

  it("extends through the entire run for a perfectly flat curve", () => {
    const cycles = Array.from({ length: 10 }, (_, i) => i + 1);
    const values = cycles.map(() => 500);
    const region = findBaselineByRegression(cycles, values);
    expect(region).toEqual({ beginCycle: 2, endCycle: 10 });
  });

  it("degrades gracefully on a noisy, slowly-rising curve", () => {
    const cycles = Array.from({ length: 30 }, (_, i) => i + 1);
    // gentle linear drift with small noise -- no sharp inflection for curvature detection
    const noise = [0, 1, -1, 0.5, -0.5, 1, -1, 0, 0.5, -0.5];
    const values = cycles.map((c, i) => 1000 + c * 2 + noise[i % noise.length]!);
    const region = findBaselineByRegression(cycles, values);
    expect(region).not.toBeNull();
    expect(region!.beginCycle).toBe(2);
  });

  it("returns null when there aren't enough cycles for the initial fit", () => {
    expect(findBaselineByRegression([1, 2], [10, 20], { initialWidth: 3 })).toBeNull();
  });

  it("doesn't truncate a flat, realistically-noisy curve into a too-short region", () => {
    // A too-narrow initial window (e.g. width 3, one degree of freedom) makes the residual
    // std-error estimate unstable enough that a lucky tight initial fit flags the very next
    // noisy-but-flat point as a false departure, truncating the region far too early — this is
    // real point-to-point noise recorded from an actual flat (no-amplification) well.
    const cycles = Array.from({ length: 45 }, (_, i) => i + 1);
    const values = [
      2270.9, 2269.8, 2269.1, 2267.7, 2267.7, 2267.8, 2268.5, 2268.0, 2267.8, 2267.2, 2267.6,
      2267.5, 2268.0, 2267.7, 2267.9, 2267.1, 2267.1, 2266.5, 2266.7, 2266.6, 2266.8, 2266.8,
      2267.1, 2267.1, 2267.2, 2267.0, 2267.0, 2266.3, 2265.3, 2264.8, 2265.3, 2266.2, 2266.8,
      2267.3, 2267.4, 2267.4, 2266.8, 2266.5, 2266.0, 2265.8, 2266.1, 2266.5, 2267.4, 2267.5,
      2268.1,
    ];
    const region = findBaselineByRegression(cycles, values);
    expect(region).toEqual({ beginCycle: 2, endCycle: 45 });
  });
});

describe("autoBaselineRegion", () => {
  it("prefers curvature detection when it finds a confident region", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = cycles.map((c) => 100 + 5000 / (1 + Math.exp(-(c - 25) * 0.5)));
    const region = autoBaselineRegion(cycles, values);
    expect(region).not.toBeNull();
    expect(region!.endCycle).toBeLessThan(25);
  });

  it("falls back to regression when curvature finds nothing", () => {
    const cycles = Array.from({ length: 20 }, (_, i) => i + 1);
    const values = cycles.map(() => 1000); // flat: no second-derivative peak at all
    const region = autoBaselineRegion(cycles, values);
    expect(region).not.toBeNull();
    expect(region!.beginCycle).toBe(2);
  });

  it("produces a plausible region on the real B3/channel-0 curve, well short of the plateau", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const smoothed = smoothCurve(curve.mean, { mode: "WeightedMean", width: 5 });
    const region = autoBaselineRegion(curve.cycles, smoothed);
    expect(region).not.toBeNull();
    expect(region!.beginCycle).toBe(2);
    expect(region!.endCycle).toBeLessThan(40);
  });
});

describe("validateBaselineRegion", () => {
  it("passes a region that's genuinely flat over the curve's whole span", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = cycles.map((c) => 100 + 5000 / (1 + Math.exp(-(c - 25) * 0.5)));
    const region = autoBaselineRegion(cycles, values)!;
    expect(validateBaselineRegion(cycles, values, region)).toBe(true);
  });

  it("rejects a region that's a good local fit but a poor description of the whole curve", () => {
    // Recorded from a real NTC (no-template control) well: a pure decay, steeper for the first
    // ~5 cycles (~-9.7 RFU/cycle) then much shallower for the rest (~-4.7 RFU/cycle) — no
    // amplification anywhere. Starting the region at cycle 2 (the `minBeginCycle` default) drops
    // the steepest point, so the initial fit is shallow enough that regression now extends all the
    // way to the last cycle instead of stopping at the slope change. Either way the region is a
    // poor description of the curve — a line through the whole two-segment decay fits it no better
    // than a line through its first segment — and validateBaselineRegion is what catches that.
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = [
      7423.0, 7408.0, 7399.5, 7387.8, 7384.8, 7384.3, 7374.3, 7372.1, 7368.0, 7360.0, 7360.5,
      7355.8, 7350.2, 7350.7, 7344.7, 7337.0, 7335.1, 7335.1, 7328.0, 7324.7, 7323.7, 7317.8,
      7313.6, 7318.6, 7304.5, 7303.3, 7296.4, 7297.1, 7291.2, 7282.1, 7283.2, 7278.4, 7271.5,
      7268.2, 7262.3, 7254.3, 7247.6, 7247.0, 7239.8, 7240.0,
    ];
    const smoothed = smoothCurve(values);
    const region = autoBaselineRegion(cycles, smoothed)!;
    expect(region).toEqual({ beginCycle: 2, endCycle: 40 });
    expect(validateBaselineRegion(cycles, smoothed, region)).toBe(false);
  });

  it("rejects a too-narrow region even though it trivially fits a line on its own", () => {
    // Recorded from a real NRT (no-reverse-transcriptase) control well in the same run as the
    // NTC above: another pure two-segment decay, no amplification anywhere. Here the curvature
    // detector's onset estimate lands implausibly early (an artifact of the same steep-to-shallow
    // transition), capping the candidate region at just 3 cycles — the enforced minimum. Any
    // 3-point window of a smooth curve fits a line almost exactly by construction, so without
    // extending the check to a wider, more trustworthy window first, this region would pass
    // flatness/linearity despite being just as unreliable as the 5-cycle region above.
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = [
      7925.1, 7916.3, 7908.9, 7892.9, 7885.7, 7877.8, 7858.1, 7852.1, 7835.1, 7830.0, 7824.5,
      7813.5, 7814.3, 7805.0, 7799.6, 7791.2, 7795.4, 7783.5, 7776.4, 7770.4, 7771.5, 7765.2,
      7753.6, 7753.9, 7748.3, 7742.6, 7737.2, 7730.6, 7730.2, 7725.8, 7728.6, 7720.7, 7712.9,
      7713.0, 7705.2, 7698.2, 7700.0, 7699.9, 7690.4, 7683.2,
    ];
    const smoothed = smoothCurve(values);
    const region = autoBaselineRegion(cycles, smoothed)!;
    expect(region).toEqual({ beginCycle: 2, endCycle: 4 });
    expect(validateBaselineRegion(cycles, smoothed, region)).toBe(false);
  });

  it("doesn't extend a region that's already at least minValidationWidth wide", () => {
    // A genuinely narrow-but-trustworthy region (5 cycles, the default minValidationWidth) that's
    // actually flat over the whole span should still pass without being extended further.
    const cycles = Array.from({ length: 20 }, (_, i) => i + 1);
    const values = cycles.map(() => 1000);
    expect(validateBaselineRegion(cycles, values, { beginCycle: 1, endCycle: 5 })).toBe(true);
  });

  it("returns false for a region with fewer than 2 points in range", () => {
    const cycles = [1, 2, 3, 4, 5];
    const values = [10, 20, 30, 40, 50];
    expect(validateBaselineRegion(cycles, values, { beginCycle: 10, endCycle: 12 })).toBe(false);
  });
});

describe("fitLinearBaseline", () => {
  const cycles = [1, 2, 3, 4, 5];

  it("recovers the exact line for noise-free data", () => {
    const values = cycles.map((c) => 2 * c + 3);
    const fit = fitLinearBaseline(cycles, values, { beginCycle: 1, endCycle: 5 });
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.intercept).toBeCloseTo(3, 6);
  });

  it("fits only over the given region, ignoring points outside it", () => {
    const values = [10, 10, 10, 1000, 1000]; // flat, then a jump outside the region
    const fit = fitLinearBaseline(cycles, values, { beginCycle: 1, endCycle: 3 });
    expect(fit.slope).toBeCloseTo(0, 6);
    expect(fit.intercept).toBeCloseTo(10, 6);
  });

  it("returns the zero line when no cycle falls within the region", () => {
    const values = [10, 20, 30, 40, 50];
    const fit = fitLinearBaseline(cycles, values, { beginCycle: 100, endCycle: 200 });
    expect(fit).toEqual({ slope: 0, intercept: 0 });
  });
});

describe("subtractBaseline", () => {
  const cycles = [1, 2, 3, 4, 5];

  it("Raw leaves the curve unchanged", () => {
    const values = [10, 12, 15, 20, 30];
    expect(subtractBaseline(cycles, values, { beginCycle: 1, endCycle: 3 }, "Raw")).toEqual(values);
  });

  it("RawBaseLineSubtracted subtracts the mean of the region from every cycle", () => {
    const values = [10, 12, 20, 30, 40];
    const out = subtractBaseline(cycles, values, { beginCycle: 1, endCycle: 2 }, "RawBaseLineSubtracted");
    // mean of [10, 12] = 11
    expect(out).toEqual([-1, 1, 9, 19, 29]);
  });

  it("LinearBaseLineNormalized removes a sloping baseline, leaving the region ~0", () => {
    // a pure line: y = 2c + 3, no amplification
    const values = cycles.map((c) => 2 * c + 3);
    const out = subtractBaseline(cycles, values, { beginCycle: 1, endCycle: 5 }, "LinearBaseLineNormalized");
    for (const v of out) expect(v).toBeCloseTo(0, 6);
  });

  it("LinearBaseLineNormalized reduces to the constant form when the region has no slope", () => {
    const values = [50, 50, 50, 80, 120];
    const linear = subtractBaseline(cycles, values, { beginCycle: 1, endCycle: 3 }, "LinearBaseLineNormalized");
    const constant = subtractBaseline(cycles, values, { beginCycle: 1, endCycle: 3 }, "RawBaseLineSubtracted");
    expect(linear[0]).toBeCloseTo(constant[0]!, 6);
    expect(linear[3]).toBeCloseTo(constant[3]!, 6);
  });

  it("returns the curve unchanged if the region has no overlapping cycles", () => {
    const values = [10, 20, 30];
    const out = subtractBaseline([1, 2, 3], values, { beginCycle: 100, endCycle: 200 }, "RawBaseLineSubtracted");
    expect(out).toEqual(values);
  });

  it("does not mutate inputs", () => {
    const values = [10, 20, 30, 40, 50];
    subtractBaseline(cycles, values, { beginCycle: 1, endCycle: 3 }, "LinearBaseLineNormalized");
    expect(values).toEqual([10, 20, 30, 40, 50]);
  });

  it("uses fitLinearBaseline's own fit, so subtracting it leaves the region at zero", () => {
    const values = [50, 50, 50, 80, 120];
    const region = { beginCycle: 1, endCycle: 3 };
    const fit = fitLinearBaseline(cycles, values, region);
    const out = subtractBaseline(cycles, values, region, "LinearBaseLineNormalized");
    expect(out[0]).toBeCloseTo(values[0]! - (fit.slope * cycles[0]! + fit.intercept), 6);
  });

  it("brings the real B3/channel-0 baseline region close to zero after linear subtraction", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const region = { beginCycle: 1, endCycle: 20 }; // well within the flat region (amplification starts ~27)
    const corrected = subtractBaseline(curve.cycles, curve.mean, region, "LinearBaseLineNormalized");
    for (let i = 0; i < 20; i++) expect(Math.abs(corrected[i]!)).toBeLessThan(15);
    // the plateau at the end should still show strong signal well above the baseline
    expect(corrected.at(-1)!).toBeGreaterThan(1000);
  });
});
