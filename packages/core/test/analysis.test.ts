import { describe, it, expect } from "vitest";
import {
  parseZpcr,
  subtractSeries,
  baselineCorrectCurve,
  computeCq,
  computeCqTable,
} from "../src/index.js";
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

  it("reports baselineValid true and the real rise as amplified for a clean sigmoid", () => {
    const result = baselineCorrectCurve(cycles, values, "LinearBaseLineNormalized");
    expect(result.baselineValid).toBe(true);
    expect(result.amplified).toBe(true);
  });

  // Recorded from a real NTC (no-template control) well: a pure two-segment decay (steep for the
  // first ~5 cycles, much shallower after) with no amplification anywhere. Auto-detection locks
  // onto cycles 1-5 as "the baseline" (findBaselineByRegression's local fit-and-extend stops
  // right where the decay's slope changes), and extrapolating that steep 5-cycle line across all
  // 40 cycles fabricates a ~200 RFU "rise" out of pure slope-estimation error — exactly the false
  // positive `validateBaselineRegion`'s §7 gate exists to catch.
  const ntcCycles = Array.from({ length: 40 }, (_, i) => i + 1);
  const ntcValues = [
    7423.0, 7408.0, 7399.5, 7387.8, 7384.8, 7384.3, 7374.3, 7372.1, 7368.0, 7360.0, 7360.5, 7355.8,
    7350.2, 7350.7, 7344.7, 7337.0, 7335.1, 7335.1, 7328.0, 7324.7, 7323.7, 7317.8, 7313.6, 7318.6,
    7304.5, 7303.3, 7296.4, 7297.1, 7291.2, 7282.1, 7283.2, 7278.4, 7271.5, 7268.2, 7262.3, 7254.3,
    7247.6, 7247.0, 7239.8, 7240.0,
  ];

  it("flags an invalid baseline on a two-segment-decay NTC well instead of a spurious rise", () => {
    const result = baselineCorrectCurve(ntcCycles, ntcValues, "LinearBaseLineNormalized");
    expect(result.baselineValid).toBe(false);
    // Without the gate this would otherwise read as amplified (the mis-fit baseline extrapolates
    // to a ~200 RFU manufactured rise, well past any reasonable noise-based threshold).
    expect(result.amplified).toBe(false);
  });

  // Recorded from a real NRT (no-reverse-transcriptase) control well in the same run as the NTC
  // above: another pure two-segment decay with no amplification, but here auto-detection settles
  // on a region only 3 cycles wide (the enforced minimum) — narrow enough that it would pass the
  // flatness/linearity check trivially without `validateBaselineRegion`'s minimum-width extension.
  const nrtCycles = Array.from({ length: 40 }, (_, i) => i + 1);
  const nrtValues = [
    7925.1, 7916.3, 7908.9, 7892.9, 7885.7, 7877.8, 7858.1, 7852.1, 7835.1, 7830.0, 7824.5, 7813.5,
    7814.3, 7805.0, 7799.6, 7791.2, 7795.4, 7783.5, 7776.4, 7770.4, 7771.5, 7765.2, 7753.6, 7753.9,
    7748.3, 7742.6, 7737.2, 7730.6, 7730.2, 7725.8, 7728.6, 7720.7, 7712.9, 7713.0, 7705.2, 7698.2,
    7700.0, 7699.9, 7690.4, 7683.2,
  ];

  it("flags an invalid baseline on a too-narrow-region NRT well instead of a spurious rise", () => {
    const result = baselineCorrectCurve(nrtCycles, nrtValues, "LinearBaseLineNormalized");
    expect(result.baselineValid).toBe(false);
    expect(result.amplified).toBe(false);
  });

  // Recorded from well E9 of `20230829_135443_CT019138_SINGLE_STEP_.zpcr` — an NRT control that
  // really does amplify, but late (from ~cycle 32) and still climbing when the run ends at 40, on
  // a baseline that drifts *down* ~6.5 RFU/cycle. Curvature's second-derivative peak lands at
  // cycle ~37 on a curve shaped like this, so onset used to be read there and the baseline ran to
  // cycle 35 — five cycles into the rise, fitted at +0.87 RFU/cycle, the wrong sign.
  const lateCycles = Array.from({ length: 40 }, (_, i) => i + 1);
  const lateValues = [
    5403, 5411, 5407, 5388, 5382, 5381, 5365, 5349, 5339, 5328, 5314, 5314, 5307, 5301, 5299, 5285,
    5286, 5284, 5271, 5266, 5264, 5262, 5248, 5250, 5245, 5236, 5231, 5227, 5235, 5241, 5262, 5317,
    5418, 5606, 5986, 6703, 8002, 10149, 13116, 15985,
  ];

  it("keeps the baseline out of a late, run-truncated amplification", () => {
    const result = baselineCorrectCurve(lateCycles, lateValues, "LinearBaseLineNormalized");
    expect(result.baselineValid).toBe(true);
    expect(result.baselineRegion.endCycle).toBeLessThan(32);
    // The fitted baseline follows the curve's real downward drift instead of being dragged up by
    // the rise — the sign error that pushed the corrected curve's first cycles above threshold.
    expect(result.baselineFit.slope).toBeLessThan(0);
    expect(result.correctedValues[0]!).toBeLessThan(result.noise);
  });

  it("gives that well a Cq even in a group of otherwise flat wells", () => {
    // Its threshold group is the untargeted NTC/NRT catch-all, whose median noise — and so whose
    // auto threshold — is set by the flat wells. The well used to drop out of the results entirely.
    const flatish = (level: number) => lateCycles.map((c) => level - c * 0.5 + Math.sin(c) * 2);
    const table = computeCqTable([
      { key: "4,8,SYBR", group: "(none)", cycles: lateCycles, values: lateValues },
      ...[5200, 5300, 5400, 5500].map((level, i) => ({
        key: `1,${i},SYBR`,
        group: "(none)",
        cycles: lateCycles,
        values: flatish(level),
      })),
    ]);
    const e9 = table.get("4,8,SYBR")!;
    expect(e9.amplified).toBe(true);
    expect(e9.cq).not.toBeNull();
    // Somewhere in the rise, not cycle 1-2 (baseline noise crossing a low threshold).
    expect(e9.cq!).toBeGreaterThan(20);
    // The flat plate-mates still get none.
    for (let i = 0; i < 4; i++) expect(table.get(`1,${i},SYBR`)!.cq).toBeNull();
  });

  it("suppresses Cq via computeCq's baselineValid option for that same well", () => {
    const result = baselineCorrectCurve(ntcCycles, ntcValues, "LinearBaseLineNormalized");
    const cq = computeCq(ntcCycles, result.correctedValues, {
      algorithm: "Threshold",
      threshold: 30,
      noise: result.noise,
      baselineValid: result.baselineValid,
    });
    expect(cq).toBeNull();
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

describe("computeCqTable", () => {
  const cycles = Array.from({ length: 40 }, (_, i) => i + 1);
  /** A sigmoid amplifying at `onset`, on a flat ~100 RFU baseline. */
  const amp = (onset: number) => cycles.map((c) => 100 + 5000 / (1 + Math.exp(-(c - onset) * 0.5)));
  /** A flat, faintly wobbling well — an NTC that never takes off. */
  const flat = (level = 100) => cycles.map((c) => level + Math.sin(c) * 2);

  const curve = (key: string, group: string, values: number[], rest = {}) => ({
    key,
    group,
    cycles,
    values,
    ...rest,
  });

  it("returns exactly one entry per key, and drops duplicate keys", () => {
    const table = computeCqTable([
      curve("0,0,FAM", "GeneA", amp(25)),
      curve("0,1,FAM", "GeneA", amp(28)),
      curve("0,0,FAM", "GeneA", amp(10)), // duplicate key: ignored
    ]);
    expect(table.size).toBe(2);
    // The first entry won: its Cq reflects the onset-25 curve, not the onset-10 one — compared
    // against what the onset-25 curve scores on its own rather than an absolute cycle, since the
    // auto threshold (and so the Cq) depends on the whole group.
    const alone = computeCqTable([curve("0,0,FAM", "GeneA", amp(25)), curve("0,1,FAM", "GeneA", amp(28))]);
    expect(table.get("0,0,FAM")!.cq).toBe(alone.get("0,0,FAM")!.cq);
  });

  it("shares one threshold across a group and gives each curve its own Cq", () => {
    const table = computeCqTable([
      curve("0,0,FAM", "GeneA", amp(20)),
      curve("0,1,FAM", "GeneA", amp(30)),
    ]);
    const a = table.get("0,0,FAM")!;
    const b = table.get("0,1,FAM")!;
    expect(a.threshold).toBe(b.threshold);
    expect(a.cq).toBeLessThan(b.cq!);
  });

  it("is unaffected by which curves a view happens to display — the whole point", () => {
    // Same well, once alongside a quiet plate-mate and once alongside a noisy one. Because the
    // table is always built over the whole plate, callers can't produce these two answers for the
    // same well by filtering; this test pins that the *inputs* are what differ, so a view that
    // re-derived from a subset would drift.
    const quiet = computeCqTable([curve("0,0,FAM", "G", amp(25)), curve("0,1,FAM", "G", flat())]);
    const noisy = computeCqTable([
      curve("0,0,FAM", "G", amp(25)),
      curve("0,1,FAM", "G", cycles.map((c) => 100 + Math.sin(c * 3) * 400)),
    ]);
    expect(quiet.get("0,0,FAM")!.threshold).not.toBeCloseTo(noisy.get("0,0,FAM")!.threshold, 1);
  });

  it("gives untargeted wells (NTC/NRT) real entries in the catch-all group", () => {
    const table = computeCqTable([
      curve("0,0,FAM", "GeneA", amp(22)),
      curve("0,1,FAM", "GeneA", amp(24)),
      // Two dyes in one untargeted well: distinct curves, distinct keys, one shared group.
      curve("7,11,FAM", "(none)", amp(31)),
      curve("7,11,HEX", "(none)", flat()),
    ]);
    expect(table.size).toBe(4);
    expect(table.get("7,11,FAM")!.group).toBe("(none)");
    expect(table.get("7,11,FAM")!.cq).not.toBeNull();
    // The flat one is legitimately Cq-less — unamplified, not merely ungrouped.
    expect(table.get("7,11,HEX")!.cq).toBeNull();
    expect(table.get("7,11,HEX")!.amplified).toBe(false);
  });

  it("honours a per-group threshold override", () => {
    const overrides = new Map([["GeneA", 4000]]);
    const table = computeCqTable([curve("0,0,FAM", "GeneA", amp(25))], {
      thresholdOverrides: overrides,
    });
    const auto = computeCqTable([curve("0,0,FAM", "GeneA", amp(25))]);
    expect(table.get("0,0,FAM")!.threshold).toBe(4000);
    expect(table.get("0,0,FAM")!.cq).toBeGreaterThan(auto.get("0,0,FAM")!.cq!);
  });

  it("keeps opted-out curves out of the noise cohort but still gives them a Cq", () => {
    const noisyUnloaded = cycles.map((c) => 100 + Math.sin(c * 3) * 400);
    const withOptOut = computeCqTable([
      curve("0,0,FAM", "G", amp(25)),
      curve("0,1,FAM", "G", flat()),
      curve("7,0,FAM", "G", noisyUnloaded, { contributesToThreshold: false }),
    ]);
    const withoutIt = computeCqTable([
      curve("0,0,FAM", "G", amp(25)),
      curve("0,1,FAM", "G", flat()),
    ]);
    expect(withOptOut.get("0,0,FAM")!.threshold).toBeCloseTo(
      withoutIt.get("0,0,FAM")!.threshold,
      6,
    );
    expect(withOptOut.has("7,0,FAM")).toBe(true);
  });

  it("falls back to every curve when a whole group opts out of the cohort", () => {
    const table = computeCqTable([
      curve("0,0,FAM", "G", amp(25), { contributesToThreshold: false }),
      curve("0,1,FAM", "G", amp(27), { contributesToThreshold: false }),
    ]);
    expect(table.get("0,0,FAM")!.threshold).toBeGreaterThan(0);
  });
});
