import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYSIS_BASELINE_MODE, computeCqTable, isBiomemeJson, parseBiomeme } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIOMEME_PATH = resolve(here, "../../../samples/biomeme-2024-01-17.json");

function readBiomemeBytes(): Uint8Array {
  const buf = readFileSync(BIOMEME_PATH);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("isBiomemeJson", () => {
  it("recognizes a Biomeme run export", () => {
    expect(isBiomemeJson(readBiomemeBytes())).toBe(true);
  });

  it("rejects arbitrary JSON", () => {
    expect(isBiomemeJson(new TextEncoder().encode(JSON.stringify({ a: 1 })))).toBe(false);
  });
});

describe("parseBiomeme", () => {
  const zpcr = parseBiomeme(readBiomemeBytes());

  it("reports dye-space curves, one per (well, fluorophore)", () => {
    expect(zpcr.dyeSpace).toBe(true);
    const curves = zpcr.curves();
    expect(curves).toHaveLength(27); // 9 wells x 3 fluors, from the sample
    for (const c of curves) {
      expect(c.cycles).toHaveLength(45);
      expect(c.mean).toHaveLength(45);
      expect(c.fileAnalysis).toBeDefined();
    }
  });

  it("synthesizes a single-row, 9-position plate with sample names and fluor layers", () => {
    const plate = zpcr.plates()[0]?.pltd.plate;
    expect(plate).toBeDefined();
    expect(plate!.rows).toBe(1);
    expect(plate!.columns).toBe(9);
    expect(plate!.fluors.map((f) => f.fluor).sort()).toEqual(["ATTO-647N", "FAM", "TexRedX"]);
    expect(plate!.wells.every((w) => w.loaded)).toBe(true);
    expect(plate!.wells[0]!.sample).toBe("1");
  });

  it("labels a single-row plate's wells by position alone, with no row letter", () => {
    const curves = zpcr.curves();
    expect(curves.every((c) => /^\d+$/.test(c.wellLabel))).toBe(true);
    expect(new Set(curves.map((c) => c.wellLabel))).toEqual(
      new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"]),
    );
  });

  it("assigns channels from emission color: green/amber/red -> Ch1/Ch3/Ch4 (FAM/TexRedX/ATTO-647N)", () => {
    const plate = zpcr.plates()[0]!.pltd.plate!;
    const channelOf = new Map(plate.fluors.map((f) => [f.fluor, f.channel]));
    expect(channelOf.get("FAM")).toBe(0);
    expect(channelOf.get("TexRedX")).toBe(2);
    expect(channelOf.get("ATTO-647N")).toBe(3);
  });

  it("carries the file's own Cq, normalizing the 0 sentinel to null", () => {
    const curves = zpcr.curves();
    // Well "4" (device wellNumber 3, sampleId 4) is the sample's TexRedX-positive well.
    const amplified = curves.find((c) => c.wellLabel === "4" && c.fileAnalysis!.cq != null);
    expect(amplified).toBeDefined();
    expect(amplified!.fileAnalysis!.cq).toBeCloseTo(23.2375, 3);

    const flat = curves.find((c) => c.wellLabel === "1" && c.channel === amplified!.channel);
    expect(flat!.fileAnalysis!.cq).toBeNull();
  });

  it("measures agreement with the file's own Cq using this library's own algorithm", () => {
    // Not exact agreement, and not expected to be: the device sets a per-*curve* threshold with
    // no stated derivation (`details.baselineType: "lobf"` is all it names), while
    // `computeCqTable` resolves one threshold per *fluorophore* from the group's noise
    // (`threshold.md` §5.2) — a deliberately different, coarser rule. This is a bound on that
    // known divergence, not a reproduction target the way `cfxExport.test.ts` is for CFX: see
    // `biomeme.md` §3 for the measured numbers this bakes in (19/27 agree on amplified-or-not,
    // median 4.1 cycles apart where both report one).
    const curves = zpcr.curves();
    const inputs = curves.map((c) => ({
      key: `${c.row},${c.col},${c.channel}`,
      group: String(c.channel),
      cycles: c.cycles,
      values: c.mean,
    }));
    const table = computeCqTable(inputs, { baselineMode: ANALYSIS_BASELINE_MODE });

    let agreeCall = 0;
    const diffs: number[] = [];
    for (const c of curves) {
      const fileCq = c.fileAnalysis!.cq;
      const computed = table.get(`${c.row},${c.col},${c.channel}`)?.cq ?? null;
      if ((fileCq == null) === (computed == null)) agreeCall++;
      if (fileCq != null && computed != null) diffs.push(Math.abs(fileCq - computed));
    }
    diffs.sort((a, b) => a - b);
    expect(agreeCall).toBeGreaterThanOrEqual(18); // 19/27 measured
    expect(diffs.length).toBeGreaterThanOrEqual(14); // 15 measured
    expect(diffs[Math.floor(diffs.length / 2)]).toBeLessThan(6); // median 4.1 measured
    expect(diffs.at(-1)).toBeLessThan(20); // max 15.5 measured
  });
});
