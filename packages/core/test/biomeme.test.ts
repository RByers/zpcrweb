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

  it("carries the file's own Cq, shifted off the file's 0-indexing and with the 0 sentinel nulled", () => {
    const curves = zpcr.curves();
    // Well "4" (device wellNumber 3, sampleId 4) is the sample's TexRedX-positive well. The file
    // states 23.2375; the file counts cycles from zero, so the 1-indexed Cq is one more than that
    // (`biomeme.md` §2.1).
    const amplified = curves.find((c) => c.wellLabel === "4" && c.fileAnalysis!.cq != null);
    expect(amplified).toBeDefined();
    expect(amplified!.fileAnalysis!.cq).toBeCloseTo(24.2375, 3);

    const flat = curves.find((c) => c.wellLabel === "1" && c.channel === amplified!.channel);
    expect(flat!.fileAnalysis!.cq).toBeNull();
  });

  it("pins the 0-indexing of the file's Cq against the file's own threshold crossing", () => {
    // The evidence behind the `+1` (`biomeme.md` §2.1), re-derived rather than asserted: where
    // the file's own `baselineData` crosses the file's own `threshold` *is* the file's `cq`, when
    // that crossing is read as a 0-based array index. Two fields of one record, no library
    // algorithm involved. Guards against the correction being dropped or double-applied.
    const run = JSON.parse(new TextDecoder().decode(readBiomemeBytes())) as {
      targets: { cq: number; threshold: number; baselineData: number[] }[];
    };
    const amplified = run.targets.filter((t) => t.cq > 0);
    expect(amplified).toHaveLength(19);
    const parsedCqs = zpcr
      .curves()
      .map((c) => c.fileAnalysis!.cq)
      .filter((cq): cq is number => cq != null)
      .sort((a, b) => a - b);

    const crossings: number[] = [];
    for (const t of amplified) {
      const b = t.baselineData;
      // The *last* upward crossing: three targets start above threshold as their baseline decays
      // through it, so a first-crossing scan would stop at index 0 for those (§2.1).
      let i = -1;
      for (let k = 1; k < b.length; k++) if (b[k - 1]! < t.threshold && b[k]! >= t.threshold) i = k;
      expect(i).toBeGreaterThan(0);
      const frac = (t.threshold - b[i - 1]!) / (b[i]! - b[i - 1]!);
      const zeroIndexed = i - 1 + frac;
      expect(zeroIndexed).toBeCloseTo(t.cq, 2); // the file's own number, 0-indexed
      crossings.push(zeroIndexed + 1); // ...and 1-indexed is what parseBiomeme must report
    }
    crossings.sort((a, b) => a - b);
    for (const [i, cq] of parsedCqs.entries()) expect(cq).toBeCloseTo(crossings[i]!, 2);
  });

  it("measures agreement with the file's own Cq using this library's own algorithm", () => {
    // Not exact agreement, and not expected to be: the device sets a per-*curve* threshold with
    // no stated derivation (`details.baselineType: "lobf"` is all it names), while
    // `computeCqTable` resolves one threshold per *fluorophore* from the group's noise
    // (`threshold.md` §5.2) — a deliberately different, coarser rule. This is a bound on that
    // known divergence, not a reproduction target the way `cfxExport.test.ts` is for CFX: see
    // `biomeme.md` §3 for the measured numbers this bakes in (19/27 agree on amplified-or-not,
    // median 4.0 cycles apart where both report one). Both sides are 1-indexed here: the file's
    // Cq has already been shifted off its 0-indexing by `parseBiomeme` (§2.1), so this compares
    // like with like rather than folding a constant one-cycle offset into the spread.
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
    expect(diffs[Math.floor(diffs.length / 2)]).toBeLessThan(6); // median 4.0 measured
    expect(diffs.at(-1)).toBeLessThan(20); // max 14.5 measured
  });
});
