import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeMeltAnalysis,
  computeMeltAnalysisFor,
  buildMeltRows,
  hasMeltSignal,
  meltCsv,
  meltDerivative,
  meltPeak,
  meltCurvesFromFluor,
  meltSegmentFor,
  meltSegments,
  parseBiomeme,
  parseZpcr,
  savitzkyGolay5,
  stepTemperatures,
  computeRunAnalysis,
  CALIBRATION_TEMP_QUANTUM_C,
} from "../src/index.js";
import { readMeltBytes, readSampleBytes } from "./sample.js";
import { readCfxPassword } from "./secrets.js";

const PW = readCfxPassword();

const here = dirname(fileURLToPath(import.meta.url));
function readBmrun(name: string): Uint8Array {
  const buf = readFileSync(resolve(here, `../../../samples/${name}`));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("melt detection (melt.md §2)", () => {
  const zpcr = parseZpcr(readMeltBytes());

  it("finds exactly the one step whose reads sweep temperature", () => {
    // The run has two plate-read steps; only the second is a melt.
    expect(zpcr.steps().map((s) => s.step)).toEqual([3, 5]);
    const segments = meltSegments(zpcr);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.step).toBe(5);
  });

  it("reads the ramp off the reads themselves", () => {
    const segment = meltSegments(zpcr)[0]!;
    expect(segment.pointCount).toBe(61);
    expect(segment.startTempC).toBeCloseTo(65, 5);
    expect(segment.endTempC).toBeCloseTo(95, 5);
    expect(segment.incrementC).toBeCloseTo(0.5, 5);
    // SAMPLETEMP is preferred over BLOCKTEMP: it is the temperature the melt was programmed in
    // and lands on an exact uniform grid (§3).
    expect(segment.source).toBe("SAMPLETEMP");
    expect(segment.temperaturesC).toHaveLength(61);
  });

  it("does not mistake the amplification step for one", () => {
    // Step 3 holds 60 °C for all 40 of its reads — measured span 0.01 °C, against the melt's
    // 29.88 °C. This is the whole detection rule, and the margin it has.
    expect(meltSegmentFor(zpcr, 3)).toBeUndefined();
    const held = zpcr.reads.filter((r) => r.step === 3).map((r) => r.blockTempC as number);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThan(0.1);
  });

  it("needs no protocol, no `.prcl` and no password", () => {
    // The melt is spelled the long way (`protocol.md` §6), so there is no MELT directive to read,
    // and this run's `.prcl` is encrypted. Detection uses neither.
    expect(zpcr.protocolText).not.toMatch(/\bMELT\b/);
    expect(zpcr.protocols().every((p) => p.prcl.needsPassword)).toBe(true);
    expect(meltSegments(zpcr)).toHaveLength(1);
  });

  it("reports no melt for an ordinary amplification run", () => {
    expect(meltSegments(parseZpcr(readSampleBytes()))).toEqual([]);
  });
});

describe("the derivative and the peak (melt.md §4–§5)", () => {
  /** A falling sigmoid centred on `mid`: the shape a melting product makes. */
  function sigmoid(temperaturesC: number[], mid: number, steepness = 1): number[] {
    return temperaturesC.map((t) => 1000 / (1 + Math.exp((t - mid) * steepness)));
  }
  const axis = Array.from({ length: 61 }, (_, i) => 65 + i * 0.5);

  it("recovers a synthetic curve's inflection as its Tm", () => {
    const values = sigmoid(axis, 80);
    const peak = meltPeak(axis, meltDerivative(axis, values));
    expect(peak).not.toBeNull();
    expect(peak!.tmC).toBeCloseTo(80, 1);
  });

  it("reports the peak in per-°C units, whatever the grid spacing", () => {
    // Same curve sampled twice as finely: a *rate* must not change with the sampling.
    const fine = Array.from({ length: 121 }, (_, i) => 65 + i * 0.25);
    const coarse = meltPeak(axis, meltDerivative(axis, sigmoid(axis, 80)))!;
    const dense = meltPeak(fine, meltDerivative(fine, sigmoid(fine, 80)))!;
    expect(dense.tmC).toBeCloseTo(coarse.tmC, 1);
    expect(dense.height / coarse.height).toBeGreaterThan(0.8);
    expect(dense.height / coarse.height).toBeLessThan(1.25);
  });

  it("puts the Tm on a sampled temperature, never between two", () => {
    // The peak of this one sits between grid points; the reported Tm is still the nearer rung,
    // because the sampled temperature is the answer and nothing is interpolated (`melt.md` §5).
    const peak = meltPeak(axis, meltDerivative(axis, sigmoid(axis, 80.3)))!;
    expect(axis).toContain(peak.tmC);
    expect(Math.abs(peak.tmC - 80.3)).toBeLessThanOrEqual(0.25);
  });

  it("reports the Tm rounded to 0.1 °C", () => {
    // The value itself is cut to 0.1 °C, with no floating-point tail for a `toFixed` to hide.
    for (const mid of [80, 80.3, 82.37, 85.55555]) {
      const peak = meltPeak(axis, meltDerivative(axis, sigmoid(axis, mid)))!;
      expect(peak.tmC).toBe(Math.round(peak.tmC * 10) / 10);
      expect(String(peak.tmC)).toMatch(/^\d+(\.\d)?$/);
    }
  });

  it("never places a Tm outside the ramp", () => {
    // Free once the Tm is a sampled temperature, and worth keeping: the parabolic refinement this
    // replaced put melting temperatures at 38 °C on a ramp starting at 65 (`melt.md` §B.2).
    for (const values of [axis.map(() => 500), axis.map((t) => t), axis.map((t) => -t)]) {
      const peak = meltPeak(axis, meltDerivative(axis, values));
      if (!peak) continue;
      expect(peak.tmC).toBeGreaterThanOrEqual(65);
      expect(peak.tmC).toBeLessThanOrEqual(95);
    }
  });

  it("finds no peak on a curve that only rises", () => {
    expect(meltPeak(axis, meltDerivative(axis, axis.map((t) => t * 10)))).toBeNull();
  });

  it("smooths without moving a peak", () => {
    const values = sigmoid(axis, 80);
    const smoothed = savitzkyGolay5(values);
    expect(smoothed).toHaveLength(values.length);
    // A quadratic filter preserves a peak's height, unlike a moving average which flattens it.
    expect(Math.max(...smoothed)).toBeCloseTo(Math.max(...values), 0);
  });

  it("calls a Tm only for a curve whose fluorescence actually moved", () => {
    expect(hasMeltSignal(sigmoid(axis, 80).map((v) => v + 9000))).toBe(true);
    // A flat well wobbling by a few RFU on a level of thousands: every curve has a highest point,
    // and this one's is noise.
    expect(hasMeltSignal(axis.map((_, i) => 9000 + (i % 3)))).toBe(false);
  });
});

describe("melt analysis of the committed CFX run", () => {
  const zpcr = parseZpcr(readMeltBytes());
  const analysis = computeMeltAnalysis(zpcr, meltSegments(zpcr)[0]!);

  it("derives the derivative itself, there being none in the file", () => {
    expect(analysis.derivativeSource).toBe("computed");
    expect(analysis.curves).toHaveLength(576); // 6 channels × 8 rows × 12 cols
    for (const curve of analysis.curves) {
      expect(curve.rfu).toHaveLength(61);
      expect(curve.derivative).toHaveLength(61);
      expect(curve.temperaturesC).toHaveLength(61);
    }
  });

  it("gives every replicate of one product the same Tm", () => {
    // 27 replicate curves of one product. Their peaks all fall on the same 0.5 °C rung, so with
    // no interpolation they agree exactly — the 0.12 °C of scatter `melt.md` Appendix A measures
    // is entirely below the grid.
    const tms = analysis.curves
      .filter((c) => c.channel === 0 && (c.peakHeight ?? 0) > 3000)
      .map((c) => c.tmC as number)
      .sort((a, b) => a - b);
    expect(tms).toHaveLength(27);
    expect(new Set(tms)).toEqual(new Set([85.5]));
  });

  it("calls nothing at all on the channels that carry no signal", () => {
    for (const channel of [3, 4]) {
      const called = analysis.curves.filter((c) => c.channel === channel && c.tmC != null);
      expect(called).toEqual([]);
    }
  });

  it("keeps every Tm inside the ramp it was measured on", () => {
    for (const curve of analysis.curves) {
      if (curve.tmC == null) continue;
      expect(curve.tmC).toBeGreaterThanOrEqual(65);
      expect(curve.tmC).toBeLessThanOrEqual(95);
    }
  });

  it("tabulates and exports what it found", () => {
    const rows = buildMeltRows(analysis, (c) => c.channel === 0);
    expect(rows).toHaveLength(96);
    expect(rows.every((r) => r.channel === 0)).toBe(true);
    // Channel space names no fluor and no target, so both columns come out empty.
    expect(rows.every((r) => r.dye === undefined && r.target === undefined)).toBe(true);
    const csv = meltCsv(rows);
    expect(csv.split("\r\n")[0]).toBe("well,channel,fluor,target,tm,peakHeight");
    expect(csv).toMatch(/A1,Ch1,,,/);
  });

  it("answers nothing for a step that isn't a melt", () => {
    expect(computeMeltAnalysisFor(zpcr, 3)).toBeUndefined();
    expect(computeMeltAnalysisFor(zpcr, 5)).toBeDefined();
  });
});

describe("melt analysis of a Biomeme melt export (biomeme.md §5)", () => {
  const melt = parseBiomeme(readBmrun("biomeme-2025-10-15-melt.bmrun"));

  it("detects the melt from the axis the file states, having no reads at all", () => {
    expect(melt.reads).toEqual([]);
    const segments = meltSegments(melt);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.source).toBe("file");
    expect(segments[0]!.pointCount).toBe(71);
    expect(segments[0]!.startTempC).toBe(60);
    expect(segments[0]!.endTempC).toBe(95);
    expect(segments[0]!.incrementC).toBeCloseTo(0.5, 5);
  });

  it("uses the derivative the device already computed", () => {
    const analysis = computeMeltAnalysis(melt, meltSegments(melt)[0]!);
    expect(analysis.derivativeSource).toBe("file");
    // The file states −ΔF per 0.5 °C step; what a `MeltCurve` carries is per °C.
    const stated = melt.curves()[0]!.meltDerivativePerC as number[];
    expect(stated).toHaveLength(71);
    expect(analysis.curves[0]!.derivative).toBe(stated);
  });

  it("agrees with the device's own called peak on every unambiguous well", () => {
    const analysis = computeMeltAnalysis(melt, meltSegments(melt)[0]!);
    const raw = JSON.parse(new TextDecoder().decode(readBmrun("biomeme-2025-10-15-melt.bmrun")));
    const called = analysis.curves.filter((c) => c.tmC != null);
    // Only the wells carrying real product clear the signal gate; the device calls a peak for
    // every well including flat ones, which is why this compares the ones it agrees about.
    expect(called.length).toBeGreaterThanOrEqual(4);
    for (const curve of called) {
      const index = analysis.curves.indexOf(curve);
      const filePeak = raw.targets[index]?.peak as number;
      // Exactly, not approximately: both are now a point of the file's own 0.5 °C grid.
      expect(curve.tmC).toBe(filePeak);
    }
  });

  it("builds no amplification analysis for a run that has none", () => {
    // `cq`, `threshold` and the background range are all zero on a melt run — a `fileAnalysis`
    // made of those is a degenerate one-point baseline, which is what this used to produce.
    expect(melt.curves().every((c) => c.fileAnalysis === undefined)).toBe(true);
  });

  it("leaves an ordinary Biomeme run alone", () => {
    const ordinary = parseBiomeme(readBmrun("biomeme-2024-01-17.bmrun"));
    expect(meltSegments(ordinary)).toEqual([]);
    expect(ordinary.curves().every((c) => c.temperaturesC === undefined)).toBe(true);
    expect(ordinary.curves()[0]!.fileAnalysis).toBeDefined();
  });
});

describe("a melt in dye space (calibration.md §2.1)", () => {
  // The plate is encrypted, so the password reaches it through `computeRunAnalysis` below rather
  // than through the parse — which is exactly why the channel-space melt needs neither.
  const zpcr = parseZpcr(readMeltBytes());
  const segment = meltSegments(zpcr)[0]!;

  it("reads a block temperature for every read of the ramp", () => {
    const ramp = stepTemperatures(zpcr, segment.step);
    expect(ramp).toHaveLength(61);
    expect(ramp[0]).toBeCloseTo(64.98, 1);
    expect(ramp.at(-1)).toBeCloseTo(94.86, 1);
    // The amplification step holds one temperature — measured span 0.01 °C across its 40 reads,
    // which is what keeps it on the single-matrix path.
    const hold = stepTemperatures(zpcr, 3);
    expect(hold).toHaveLength(40);
    expect(Math.max(...hold) - Math.min(...hold)).toBeLessThan(CALIBRATION_TEMP_QUANTUM_C);
  });

  it.skipIf(!PW)("separates each read against its own block temperature", () => {
    expect(computeRunAnalysis(zpcr, {}, 3, PW).perReadCalibration).toBe(false);
    const run = computeRunAnalysis(zpcr, {}, segment.step, PW);
    expect(run.perReadCalibration).toBe(true);
    expect(run.readTemperaturesC).toHaveLength(61);
  });

  it.skipIf(!PW)("gives the same melting temperatures the raw channel does", () => {
    const run = computeRunAnalysis(zpcr, {}, segment.step, PW);
    const dye = meltCurvesFromFluor(segment, run.allFluorCurves, run.available);
    // This run carries one dye (SYBR) on one channel, so the separation is close to a rescaling
    // and the Tm it yields should be the raw channel's. What it is *not* is a different answer: a
    // matrix sampled at the wrong temperature would tilt the curve and drag the peak with it.
    expect(dye.curves).toHaveLength(96);
    expect(dye.curves.every((c) => c.dye === "SYBR")).toBe(true);
    const channelTm = new Map(
      computeMeltAnalysis(zpcr, segment)
        .curves.filter((c) => c.channel === 0)
        .map((c) => [c.wellLabel, c.tmC]),
    );
    // Only the curves with a peak worth calling. The four wells that disagree on this run all
    // have peaks of 10–13 RFU/°C — flat curves that squeaked past `hasMeltSignal`, whose three
    // tallest derivative points sit within 1% of each other, so the tilt the temperature
    // correction removes is enough to reorder them. The 54 curves carrying real product peak at
    // 100–5900 RFU/°C and every one of them lands on the same rung in both spaces.
    const real = dye.curves.filter((c) => (c.peakHeight ?? 0) > 100);
    expect(real.length).toBe(54);
    for (const c of real) {
      expect(c.tmC).toBe(channelTm.get(c.wellLabel));
    }
  });

  it.skipIf(!PW)("tabulates dye-space rows with their target", () => {
    const run = computeRunAnalysis(zpcr, {}, segment.step, PW);
    const dye = meltCurvesFromFluor(segment, run.allFluorCurves, run.available);
    const rows = buildMeltRows(dye, () => true, { targetOf: () => "N gene" });
    expect(rows).toHaveLength(96);
    expect(rows.every((r) => r.dye === "SYBR" && r.target === "N gene")).toBe(true);
    expect(meltCsv(rows)).toMatch(/A1,Ch1,SYBR,N gene,/);
  });
});
