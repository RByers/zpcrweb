import { describe, it, expect } from "vitest";
import {
  parseZpcr,
  baselineCorrectCurve,
  computeCq,
  computeCqTable,
} from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("baselineCorrectCurve", () => {
  // A clean sigmoid: flat ~100 well before onset, plateauing ~5100 by the end.
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
    const result = baselineCorrectCurve(cycles, values, "Raw", 200);
    expect(result.correctedValues).toEqual(values);
    // Endpoint (~5100) minus the mean of the flat baseline region (~100).
    expect(result.deltaRfu).toBeGreaterThan(4800);
  });

  it("exposes the fitted linear baseline (slope, intercept) for display", () => {
    const result = baselineCorrectCurve(cycles, values, "LinearBaseLineNormalized", 200);
    // Loose bounds: this checks the fit is exposed and plausible (well below the curve's ~5100
    // plateau), not the region's exact boundary — `baseline.test.ts` covers that.
    expect(result.baselineFit.intercept).toBeGreaterThan(-100);
    expect(result.baselineFit.intercept).toBeLessThan(500);
    expect(Math.abs(result.baselineFit.slope)).toBeLessThan(50);
  });

  it("keeps the baseline out of the rise once a threshold is available", () => {
    // With no threshold the region is the whole run (there is no Cq to stop before); given one,
    // it stops two cycles short of the Cq that threshold implies.
    const wholeRun = baselineCorrectCurve(cycles, values, "LinearBaseLineNormalized");
    expect(wholeRun.baselineRegion.endCycle).toBe(40);

    const refined = baselineCorrectCurve(cycles, values, "LinearBaseLineNormalized", 200);
    expect(refined.baselineRegion.endCycle).toBeLessThan(22);
    expect(refined.amplified).toBe(true);
    // The baseline now describes the pre-amplification part rather than the whole sigmoid, so the
    // line it fits is far flatter than one dragged across the rise.
    expect(refined.baselineFit.slope).toBeLessThan(wholeRun.baselineFit.slope / 10);
  });

  // Recorded from a real NTC (no-template control) well: a pure two-segment decay (steep for the
  // first ~5 cycles, much shallower after) with no amplification anywhere. The old onset detector
  // locked onto cycles 1–5 as "the baseline" and extrapolated that steep line across all 40,
  // fabricating a ~200 RFU rise out of slope-estimation error — which then needed a validity gate
  // to suppress. Baselining the whole run removes the failure instead of catching it.
  const ntcCycles = Array.from({ length: 40 }, (_, i) => i + 1);
  const ntcValues = [
    7423.0, 7408.0, 7399.5, 7387.8, 7384.8, 7384.3, 7374.3, 7372.1, 7368.0, 7360.0, 7360.5, 7355.8,
    7350.2, 7350.7, 7344.7, 7337.0, 7335.1, 7335.1, 7328.0, 7324.7, 7323.7, 7317.8, 7313.6, 7318.6,
    7304.5, 7303.3, 7296.4, 7297.1, 7291.2, 7282.1, 7283.2, 7278.4, 7271.5, 7268.2, 7262.3, 7254.3,
    7247.6, 7247.0, 7239.8, 7240.0,
  ];

  it("manufactures no rise on a two-segment-decay NTC well", () => {
    const result = baselineCorrectCurve(ntcCycles, ntcValues, "LinearBaseLineNormalized");
    expect(result.baselineRegion).toEqual({ beginCycle: 3, endCycle: 40 });
    expect(result.amplified).toBe(false);
    // What is left is the decay's own gentle bow about the fitted line — tens of RFU on a curve
    // sitting at 7400, not the ~200 RFU rise the old early-region fit extrapolated into existence.
    expect(Math.max(...result.correctedValues.map(Math.abs))).toBeLessThan(25);
    // And with a threshold in hand it stays that way: no Cq, because nothing crosses.
    const withThreshold = baselineCorrectCurve(ntcCycles, ntcValues, "LinearBaseLineNormalized", 30);
    expect(computeCq(ntcCycles, withThreshold.correctedValues, 30)).toBeNull();
  });

  // Recorded from well E9 of `20230829_135443_CT019138_SINGLE_STEP_.zpcr` — an NRT control that
  // really does amplify, but late (from ~cycle 32) and still climbing when the run ends at 40, on
  // a baseline that drifts *down* ~6.5 RFU/cycle. The old curvature detector read onset at cycle
  // ~37 and ran the baseline to 35 — five cycles into the rise, fitted at +0.87 RFU/cycle, the
  // wrong sign — after which the corrected curve started above the threshold and the well silently
  // reported no Cq at all.
  const lateCycles = Array.from({ length: 40 }, (_, i) => i + 1);
  const lateValues = [
    5403, 5411, 5407, 5388, 5382, 5381, 5365, 5349, 5339, 5328, 5314, 5314, 5307, 5301, 5299, 5285,
    5286, 5284, 5271, 5266, 5264, 5262, 5248, 5250, 5245, 5236, 5231, 5227, 5235, 5241, 5262, 5317,
    5418, 5606, 5986, 6703, 8002, 10149, 13116, 15985,
  ];

  it("keeps the baseline out of a late, run-truncated amplification", () => {
    const whole = baselineCorrectCurve(lateCycles, lateValues, "LinearBaseLineNormalized");
    const threshold = 20 * whole.noise;
    const result = baselineCorrectCurve(lateCycles, lateValues, "LinearBaseLineNormalized", threshold);
    expect(result.baselineRegion.endCycle).toBeLessThan(32);
    // The fitted baseline follows the curve's real downward drift instead of being dragged up.
    expect(result.baselineFit.slope).toBeLessThan(0);
    // The early cycles stay well under the threshold, and a Cq comes back inside the visible rise.
    expect(Math.max(...result.correctedValues.slice(0, 5))).toBeLessThan(threshold);
    const cq = computeCq(lateCycles, result.correctedValues, threshold);
    expect(cq).not.toBeNull();
    expect(cq!).toBeGreaterThan(28);
    expect(cq!).toBeLessThan(36);
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
    expect(table.get("0,0,FAM")!.thresholdSource).toBe("group");
    expect(auto.get("0,0,FAM")!.thresholdSource).toBe("auto");
    expect(table.get("0,0,FAM")!.cq).toBeGreaterThan(auto.get("0,0,FAM")!.cq!);
  });

  it("lets a per-curve override outrank its group's, for that curve only", () => {
    const curves = [curve("0,0,FAM", "GeneA", amp(25)), curve("0,1,FAM", "GeneA", amp(25))];
    const table = computeCqTable(curves, {
      thresholdOverrides: new Map([["GeneA", 500]]),
      curveThresholdOverrides: new Map([["0,0,FAM", 4000]]),
    });
    expect(table.get("0,0,FAM")!.threshold).toBe(4000);
    expect(table.get("0,0,FAM")!.thresholdSource).toBe("curve");
    // The group's own threshold is still reported, so a UI can show what the group is on even
    // when every one of its curves overrode it.
    expect(table.get("0,0,FAM")!.groupThreshold).toBe(500);
    // Its plate-mate is untouched — a per-curve override moves one curve, never the group.
    expect(table.get("0,1,FAM")!.threshold).toBe(500);
    expect(table.get("0,1,FAM")!.thresholdSource).toBe("group");
    expect(table.get("0,0,FAM")!.cq).toBeGreaterThan(table.get("0,1,FAM")!.cq!);
  });

  it("keeps an overridden curve in its group's noise cohort", () => {
    // The override changes what this curve's Cq is measured against, not what its baseline noise
    // is — so the auto threshold its plate-mates get must be exactly the same either way.
    const curves = [curve("0,0,FAM", "G", amp(25)), curve("0,1,FAM", "G", flat())];
    const withOverride = computeCqTable(curves, {
      curveThresholdOverrides: new Map([["0,0,FAM", 4000]]),
    });
    const without = computeCqTable(curves);
    expect(withOverride.get("0,1,FAM")!.threshold).toBeCloseTo(
      without.get("0,1,FAM")!.threshold,
      6,
    );
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
