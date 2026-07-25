import { describe, it, expect } from "vitest";
import {
  parseZpcr,
  smoothCurve,
  autoBaselineRegion,
  subtractBaseline,
  baselineNoise,
  autoThreshold,
  resolveThreshold,
  isAmplified,
  findThresholdCrossing,
  findInflectionCq,
  computeCq,
} from "../src/index.js";
import { readSampleBytes } from "./sample.js";

function sigmoid(cycles: number[], onset: number, amplitude = 5000): number[] {
  return cycles.map((c) => 100 + amplitude / (1 + Math.exp(-(c - onset) * 0.5)));
}

describe("baselineNoise", () => {
  it("is zero for a perfectly flat region", () => {
    const cycles = [1, 2, 3, 4, 5];
    const values = [10, 10, 10, 10, 10];
    expect(baselineNoise(cycles, values, { beginCycle: 1, endCycle: 5 })).toBe(0);
  });

  it("reflects the spread of noisy residuals about their mean", () => {
    const cycles = [1, 2, 3, 4];
    const values = [-1, 1, -1, 1];
    expect(baselineNoise(cycles, values, { beginCycle: 1, endCycle: 4 })).toBeCloseTo(1, 6);
  });

  it("returns 0 when no cycle falls within the region", () => {
    const cycles = [1, 2, 3];
    const values = [10, 20, 30];
    expect(baselineNoise(cycles, values, { beginCycle: 100, endCycle: 200 })).toBe(0);
  });

  it("computes a small residual noise on the real B3/channel-0 baseline region", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const region = { beginCycle: 1, endCycle: 20 };
    const corrected = subtractBaseline(curve.cycles, curve.mean, region, "LinearBaseLineNormalized");
    const noise = baselineNoise(curve.cycles, corrected, region);
    expect(noise).toBeGreaterThan(0);
    expect(noise).toBeLessThan(15);
  });
});

describe("autoThreshold", () => {
  it("is multiplier x the median of the noise estimates", () => {
    expect(autoThreshold([1, 2, 3], { multiplier: 3 })).toBeCloseTo(6, 6);
  });

  it("uses the default multiplier of 3.2", () => {
    expect(autoThreshold([10])).toBeCloseTo(32, 6);
  });

  it("floors the result at minThreshold", () => {
    expect(autoThreshold([0, 0, 0], { multiplier: 3.2, minThreshold: 5 })).toBe(5);
  });

  it("returns minThreshold (default 0) when given no estimates", () => {
    expect(autoThreshold([])).toBe(0);
    expect(autoThreshold([], { minThreshold: 7 })).toBe(7);
  });
});

describe("resolveThreshold", () => {
  it("uses the manual override when given, skipping auto entirely", () => {
    expect(resolveThreshold([1000, 2000, 3000], { overrideValue: 38.7 })).toBe(38.7);
  });

  it("falls back to autoThreshold when no override is given", () => {
    expect(resolveThreshold([1, 2, 3], { auto: { multiplier: 3 } })).toBeCloseTo(6, 6);
  });
});

describe("isAmplified", () => {
  it("is true when the total rise is well above the noise multiple", () => {
    expect(isAmplified([0, 0, 5000], 10, { minRiseMultiplier: 10 })).toBe(true);
  });

  it("is false for a flat well whose rise is just noise", () => {
    expect(isAmplified([0, 5, -3, 2], 10, { minRiseMultiplier: 10 })).toBe(false);
  });

  it("is false for an empty curve", () => {
    expect(isAmplified([], 10)).toBe(false);
  });

  it("uses the default multiplier of 10", () => {
    expect(isAmplified([0, 50], 10)).toBe(false); // rise 50 < 10*10
    expect(isAmplified([0, 150], 10)).toBe(true); // rise 150 >= 10*10
  });
});

describe("findThresholdCrossing", () => {
  it("log-interpolates a fractional Cq between the bracketing cycles", () => {
    // corrected[c] = 2^c, so threshold 6 sits between c=2 (4) and c=3 (8) at c = log2(6) ~= 2.585
    const cycles = [1, 2, 3, 4];
    const values = cycles.map((c) => 2 ** c);
    const cq = findThresholdCrossing(cycles, values, 6);
    expect(cq).toBeCloseTo(Math.log2(6), 6);
  });

  it("finds the crossing on a clean sigmoid, ahead of the curve's true midpoint", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = sigmoid(cycles, 25);
    const threshold = 200; // low, close to the ~100 baseline -- crosses well before c=25
    const cq = findThresholdCrossing(cycles, values, threshold);
    expect(cq).not.toBeNull();
    expect(cq!).toBeGreaterThan(10);
    expect(cq!).toBeLessThan(25);
  });

  it("falls back to linear interpolation when a bracketing value is <= 0", () => {
    const cycles = [1, 2, 3];
    const values = [-5, 15, 30]; // crosses threshold 10 between c=1 (-5) and c=2 (15)
    const cq = findThresholdCrossing(cycles, values, 10);
    // linear: -5 + frac*(15-(-5)) = 10 => frac = 15/20 = 0.75 => cycle 1 + 0.75 = 1.75
    expect(cq).toBeCloseTo(1.75, 6);
  });

  it("returns null when the curve starts at or above threshold", () => {
    const cycles = [1, 2, 3];
    const values = [50, 60, 70];
    expect(findThresholdCrossing(cycles, values, 10)).toBeNull();
  });

  it("returns null when the curve never crosses", () => {
    const cycles = [1, 2, 3];
    const values = [1, 2, 3];
    expect(findThresholdCrossing(cycles, values, 1000)).toBeNull();
  });

  it("returns null when the trace ends below threshold and requireEndsAboveThreshold is on (default)", () => {
    const cycles = [1, 2, 3, 4];
    const values = [0, 50, 5, 2]; // crosses at c=2 then falls back below threshold
    expect(findThresholdCrossing(cycles, values, 10)).toBeNull();
  });

  it("reports the crossing when requireEndsAboveThreshold is turned off", () => {
    const cycles = [1, 2, 3, 4];
    const values = [0, 50, 5, 2];
    expect(findThresholdCrossing(cycles, values, 10, { requireEndsAboveThreshold: false })).not.toBeNull();
  });

  it("returns null for an empty curve", () => {
    expect(findThresholdCrossing([], [], 10)).toBeNull();
  });

  it("finds a plausible crossing on the real B3/channel-0 curve", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const smoothed = smoothCurve(curve.mean, { mode: "WeightedMean", width: 5 });
    const region = autoBaselineRegion(curve.cycles, smoothed)!;
    const corrected = subtractBaseline(curve.cycles, smoothed, region, "LinearBaseLineNormalized");
    const noise = baselineNoise(curve.cycles, corrected, region);
    const threshold = autoThreshold([noise]);
    const cq = findThresholdCrossing(curve.cycles, corrected, threshold);
    expect(cq).not.toBeNull();
    expect(cq!).toBeGreaterThan(region.beginCycle);
    expect(cq!).toBeLessThan(40);
  });
});

describe("findInflectionCq", () => {
  it("finds the cycle nearest the sigmoid's true inflection point", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = sigmoid(cycles, 25);
    const cq = findInflectionCq(cycles, values);
    expect(cq).not.toBeNull();
    expect(cq!).toBeGreaterThanOrEqual(22);
    expect(cq!).toBeLessThan(28);
  });

  it("returns null for a flat curve with no dominant peak", () => {
    const cycles = Array.from({ length: 20 }, (_, i) => i + 1);
    const values = cycles.map(() => 1000);
    expect(findInflectionCq(cycles, values)).toBeNull();
  });

  it("returns null when there are too few points", () => {
    expect(findInflectionCq([1, 2], [10, 20])).toBeNull();
  });
});

describe("computeCq", () => {
  it("computes a threshold-crossing Cq by default", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = sigmoid(cycles, 25);
    const cq = computeCq(cycles, values, { threshold: 200 });
    expect(cq).not.toBeNull();
    expect(cq!).toBeGreaterThan(10);
    expect(cq!).toBeLessThan(25);
  });

  it("throws if the Threshold algorithm is used without a threshold", () => {
    expect(() => computeCq([1, 2, 3], [1, 2, 3])).toThrow();
  });

  it("uses curve-shape inflection under the NoThreshold algorithm", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = sigmoid(cycles, 25);
    const cq = computeCq(cycles, values, { algorithm: "NoThreshold" });
    expect(cq).not.toBeNull();
    expect(cq!).toBeGreaterThanOrEqual(22);
    expect(cq!).toBeLessThan(28);
  });

  it("squelches an unamplified well when noise is given, for both algorithms", () => {
    const cycles = [1, 2, 3, 4, 5];
    const values = [0, 5, -3, 2, 1]; // flat, noise-only
    expect(computeCq(cycles, values, { threshold: 10, noise: 10 })).toBeNull();
    expect(computeCq(cycles, values, { algorithm: "NoThreshold", noise: 10 })).toBeNull();
  });

  it("does not squelch an amplified well", () => {
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = sigmoid(cycles, 25);
    expect(computeCq(cycles, values, { threshold: 200, noise: 5 })).not.toBeNull();
  });

  it("produces a plausible Cq on the real B3/channel-0 curve end to end", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const smoothed = smoothCurve(curve.mean, { mode: "WeightedMean", width: 5 });
    const region = autoBaselineRegion(curve.cycles, smoothed)!;
    const corrected = subtractBaseline(curve.cycles, smoothed, region, "LinearBaseLineNormalized");
    const noise = baselineNoise(curve.cycles, corrected, region);
    const threshold = autoThreshold([noise]);
    const cq = computeCq(curve.cycles, corrected, { threshold, noise });
    expect(cq).not.toBeNull();
    expect(cq!).toBeGreaterThan(region.beginCycle);
    expect(cq!).toBeLessThan(40);
  });
});
