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
  meltSegmentFor,
  meltSegments,
  parseBiomeme,
  parseZpcr,
  savitzkyGolay5,
} from "../src/index.js";
import { readMeltBytes, readSampleBytes } from "./sample.js";

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

  it("puts the Tm between grid points rather than on them", () => {
    // The peak of this one sits off the 0.5 °C grid; the parabolic refinement is what finds it.
    const peak = meltPeak(axis, meltDerivative(axis, sigmoid(axis, 80.3)))!;
    expect(peak.tmC).toBeCloseTo(80.3, 1);
    expect(peak.tmC % 0.5).not.toBe(0);
  });

  it("never places a Tm outside the ramp", () => {
    // A parabola fitted through a near-flat trio solves to a vertex far outside the data; before
    // the vertex was clamped this put melting temperatures at 38 °C on a ramp starting at 65.
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

  it("puts the strongest curves' Tm within 0.12 °C of each other", () => {
    // 27 replicate curves of one product. The spread is the measurement `melt.md` Appendix A
    // quotes, and the reason a Tm is worth reporting to two decimals at all.
    const tms = analysis.curves
      .filter((c) => c.channel === 0 && (c.peakHeight ?? 0) > 3000)
      .map((c) => c.tmC as number)
      .sort((a, b) => a - b);
    expect(tms).toHaveLength(27);
    expect(tms[tms.length - 1]! - tms[0]!).toBeLessThan(0.13);
    expect(tms[tms.length >> 1]!).toBeCloseTo(85.6, 1);
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
    const rows = buildMeltRows(analysis, (_r, _c, channel) => channel === 0);
    expect(rows).toHaveLength(96);
    expect(rows.every((r) => r.channel === 0)).toBe(true);
    const csv = meltCsv(rows);
    expect(csv.split("\r\n")[0]).toBe("well,channel,tm,peakHeight");
    expect(csv).toMatch(/A1,Ch1,/);
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
      expect(Math.abs((curve.tmC as number) - filePeak)).toBeLessThan(0.5);
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
