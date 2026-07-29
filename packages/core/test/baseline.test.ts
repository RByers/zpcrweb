import { describe, it, expect } from "vitest";
import {
  BASELINE_BEGIN_CYCLE,
  baselineRegion,
  endPointRfu,
  fitLinearBaseline,
  parseZpcr,
  smoothPlateauTail,
  subtractBaseline,
} from "../src/index.js";
import { readSampleBytes } from "./sample.js";

const cycles45 = Array.from({ length: 45 }, (_, i) => i + 1);

describe("baselineRegion", () => {
  it("takes the whole run for a well with no Cq", () => {
    expect(baselineRegion(cycles45, null)).toEqual({ beginCycle: 3, endCycle: 45 });
  });

  it("stops two cycles before an amplifying well's Cq", () => {
    // The rule recovered from CFX's own baselines: round(Cq) − 2.
    expect(baselineRegion(cycles45, 23.0733).endCycle).toBe(21);
    expect(baselineRegion(cycles45, 21.8747).endCycle).toBe(20);
    expect(baselineRegion(cycles45, 38.1442).endCycle).toBe(36);
  });

  it("never starts before the settling cycles are over", () => {
    expect(baselineRegion(cycles45, null).beginCycle).toBe(BASELINE_BEGIN_CYCLE);
    expect(baselineRegion(cycles45, 30).beginCycle).toBe(BASELINE_BEGIN_CYCLE);
  });

  it("keeps a minimum width when the Cq is implausibly early", () => {
    const region = baselineRegion(cycles45, 4);
    expect(region.endCycle).toBeGreaterThan(region.beginCycle);
    expect(region.endCycle - region.beginCycle + 1).toBeGreaterThanOrEqual(5);
  });

  it("never runs past the last cycle of a short run", () => {
    const short = [1, 2, 3, 4];
    const region = baselineRegion(short, null);
    expect(region.endCycle).toBe(4);
    expect(region.beginCycle).toBeLessThanOrEqual(region.endCycle);
  });

  it("gives a real, decaying no-amplification well the whole run rather than an early slice", () => {
    // Recorded from a real NTC well: a pure decay, steeper over the first ~5 cycles then much
    // shallower, with no amplification anywhere. The old onset-detection path fitted the first
    // segment and extrapolated it across the run, manufacturing a spurious rise; the measured rule
    // baselines the whole trace, which is what CFX does with a well like this.
    const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
    const values = [
      7423.0, 7408.0, 7399.5, 7387.8, 7384.8, 7384.3, 7374.3, 7372.1, 7368.0, 7360.0, 7360.5,
      7355.8, 7350.2, 7350.7, 7344.7, 7337.0, 7335.1, 7335.1, 7328.0, 7324.7, 7323.7, 7317.8,
      7313.6, 7318.6, 7304.5, 7303.3, 7296.4, 7297.1, 7291.2, 7282.1, 7283.2, 7278.4, 7271.5,
      7268.2, 7262.3, 7254.3, 7247.6, 7247.0, 7239.8, 7240.0,
    ];
    const region = baselineRegion(cycles, null);
    expect(region).toEqual({ beginCycle: 3, endCycle: 40 });
    const corrected = subtractBaseline(cycles, values, region, "LinearBaseLineNormalized");
    // No spurious rise: what is left is the decay's own gentle bow about the fitted line, tens of
    // RFU on a curve sitting at 7400 — not the ~200 RFU the old early-region fit extrapolated.
    expect(Math.max(...corrected.map(Math.abs))).toBeLessThan(25);
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
    const values = [10, 10, 10, 1000, 1000];
    const fit = fitLinearBaseline(cycles, values, { beginCycle: 1, endCycle: 3 });
    expect(fit.slope).toBeCloseTo(0, 6);
    expect(fit.intercept).toBeCloseTo(10, 6);
  });

  it("returns the zero line when no cycle falls within the region", () => {
    const fit = fitLinearBaseline(cycles, [10, 20, 30, 40, 50], { beginCycle: 100, endCycle: 200 });
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
    const out = subtractBaseline(cycles, [10, 12, 20, 30, 40], { beginCycle: 1, endCycle: 2 }, "RawBaseLineSubtracted");
    expect(out).toEqual([-1, 1, 9, 19, 29]);
  });

  it("LinearBaseLineNormalized removes a sloping baseline, leaving the region ~0", () => {
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
    expect(subtractBaseline([1, 2, 3], values, { beginCycle: 100, endCycle: 200 }, "RawBaseLineSubtracted")).toEqual(values);
  });

  it("does not mutate inputs", () => {
    const values = [10, 20, 30, 40, 50];
    subtractBaseline(cycles, values, { beginCycle: 1, endCycle: 3 }, "LinearBaseLineNormalized");
    expect(values).toEqual([10, 20, 30, 40, 50]);
  });

  it("brings the real B3/channel-0 baseline region close to zero after linear subtraction", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const region = { beginCycle: 3, endCycle: 20 }; // amplification starts ~27
    const corrected = subtractBaseline(curve.cycles, curve.mean, region, "LinearBaseLineNormalized");
    for (let i = 2; i < 20; i++) expect(Math.abs(corrected[i]!)).toBeLessThan(15);
    expect(corrected.at(-1)!).toBeGreaterThan(1000);
  });
});

describe("smoothPlateauTail", () => {
  it("averages the plateau in threes, from floor(cq)+3 to the second-to-last cycle", () => {
    const values = Array.from({ length: 12 }, (_, i) => (i === 8 ? 100 : 0));
    const out = smoothPlateauTail(values, 4.9); // start cycle = 7, i.e. index 6
    expect(out.slice(0, 6)).toEqual(values.slice(0, 6));
    expect(out[7]).toBeCloseTo(100 / 3, 9); // index 7 sees the spike at 8
    expect(out[8]).toBeCloseTo(100 / 3, 9);
    expect(out[11]).toBe(values[11]); // the last cycle is left alone
  });

  it("reads from the unfiltered curve rather than applying in place", () => {
    // With an in-place pass each output would feed the next; a plain FIR pass keeps them
    // independent, which is what reproduces CFX's curve.
    const values = [0, 0, 0, 0, 0, 0, 9, 9, 9, 0];
    const out = smoothPlateauTail(values, 1);
    expect(out[7]).toBeCloseTo(9, 9);
    expect(out[8]).toBeCloseTo(6, 9);
  });

  it("leaves a curve with no Cq completely alone", () => {
    const values = [1, 5, 2, 8, 3, 9, 4];
    expect(smoothPlateauTail(values, null)).toEqual(values);
  });
});

describe("endPointRfu", () => {
  it("is the mean of the last five cycles, not the last value", () => {
    const values = [0, 0, 0, 0, 0, 10, 20, 30, 40, 50];
    expect(endPointRfu(values)).toBeCloseTo(30, 9);
  });

  it("copes with a curve shorter than the window", () => {
    expect(endPointRfu([2, 4])).toBeCloseTo(3, 9);
    expect(endPointRfu([])).toBe(0);
  });
});
