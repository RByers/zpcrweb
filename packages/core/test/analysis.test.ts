import { describe, it, expect } from "vitest";
import { parseZpcr, subtractSeries, baselineCorrectCurve } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("subtractSeries", () => {
  it("subtracts element-wise", () => {
    expect(subtractSeries([10, 20, 30], [1, 2, 3])).toEqual([9, 18, 27]);
  });

  it("treats missing baseline entries as 0 and matches the length of a", () => {
    expect(subtractSeries([10, 20, 30], [1, 2])).toEqual([9, 18, 30]);
  });

  it("does not mutate inputs", () => {
    const a = [5, 6];
    const b = [1, 1];
    subtractSeries(a, b);
    expect(a).toEqual([5, 6]);
    expect(b).toEqual([1, 1]);
  });
});

describe("baselineCorrectCurve", () => {
  // A clean sigmoid (flat ~100 well before onset, plateauing ~5100 by the end) — the same shape
  // `baseline.test.ts`'s curvature-detection tests use, so auto-detection's region choice here is
  // already covered by those tests. Baseline region selection is always automatic now (no manual
  // override).
  const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
  const values = cycles.map((c) => 100 + 5000 / (1 + Math.exp(-(c - 25) * 0.5)));

  it("reports noise much smaller than the curve's overall rise", () => {
    const result = baselineCorrectCurve(cycles, values, "RawBaseLineSubtracted");
    expect(result.noise).toBeLessThan(200);
  });

  it("flags a real rise as amplified with a large positive ΔRFU", () => {
    const result = baselineCorrectCurve(cycles, values, "RawBaseLineSubtracted");
    expect(result.amplified).toBe(true);
    expect(result.deltaRfu).toBeGreaterThan(1000);
  });

  it("does not flag a flat, noisy curve as amplified", () => {
    const flat = cycles.map((_, i) => (i % 2 === 0 ? 99 : 101));
    const result = baselineCorrectCurve(cycles, flat, "RawBaseLineSubtracted");
    expect(result.amplified).toBe(false);
  });

  it("computes a large positive ΔRFU from raw values (no subtraction) in Raw mode", () => {
    const result = baselineCorrectCurve(cycles, values, "Raw");
    expect(result.correctedValues).toEqual(values);
    // Endpoint (~5100) minus the mean of the flat baseline region (~100).
    expect(result.deltaRfu).toBeGreaterThan(4800);
  });

  it("reports baselineRfu as the mean raw value over the baseline region, unaffected by mode", () => {
    const raw = baselineCorrectCurve(cycles, values, "Raw");
    const subtracted = baselineCorrectCurve(cycles, values, "RawBaseLineSubtracted");
    expect(raw.baselineRfu).toBeCloseTo(subtracted.baselineRfu, 6);
    expect(raw.baselineRfu).toBeLessThan(300);
  });

  it("exposes the fitted linear baseline (slope, intercept) for display", () => {
    const result = baselineCorrectCurve(cycles, values, "LinearBaseLineNormalized");
    // Loose bounds: the exact region auto-detection settles on is covered by
    // `baseline.test.ts`'s curvature/regression tests — this just checks the fit is exposed and
    // plausible (well below the curve's ~5100 plateau), not the algorithm's exact boundary.
    expect(result.baselineFit.intercept).toBeGreaterThan(-100);
    expect(result.baselineFit.intercept).toBeLessThan(500);
    expect(Math.abs(result.baselineFit.slope)).toBeLessThan(50);
  });
});

describe("darkCurves", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("returns one curve per channel, aligned with cycles", () => {
    const dark = zpcr.darkCurves();
    expect(dark).toHaveLength(6);
    for (const d of dark) {
      expect(d.cycles).toHaveLength(45);
      expect(d.mean).toHaveLength(45);
    }
  });

  it("carries the sane DARKDATA background values", () => {
    const dark = zpcr.darkCurves();
    // channel 0 dark mean at cycle 1 ≈ 2125 (see plateread DARKDATA fix)
    expect(dark[0]!.mean[0]).toBeCloseTo(2125.2, 0);
    for (const d of dark) {
      expect(d.min[0]!).toBeLessThanOrEqual(d.mean[0]!);
      expect(d.max[0]!).toBeGreaterThanOrEqual(d.mean[0]!);
    }
  });
});
