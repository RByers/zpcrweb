import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parsePcrd, parseZpcr } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// Same fixture the .md docs cross-validate against: the CFX Manager saved-experiment document
// for the run also committed as samples/20260720.zpcr.
const PCRD_PATH = resolve(here, "../../../samples/20260720_Luna_noRT.pcrd");
const ZPCR_PATH = resolve(here, "../../../samples/20260720.zpcr");

function readBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// The decryption password is NOT committed to this repo — same fixed password as .pltd/.prcl
// (see pltd.md §2, pcrd.md §2). Supply it via the environment to run the decode assertions
// locally (`CFX_PLTD_PASSWORD=… npm test`); container-level assertions run without it.
const PW = process.env.CFX_PLTD_PASSWORD;

describe("pcrd — container + password handling (no secret needed)", () => {
  it("decodes the container and reports needsPassword without a password", () => {
    const pcrd = parsePcrd(readBytes(PCRD_PATH));
    expect(pcrd.container.encrypted).toBe(true);
    expect(pcrd.container.innerName).toMatch(/\.pcrd$/);
    expect(pcrd.needsPassword).toBe(true);
    expect(pcrd.zpcr).toBeUndefined();
    expect(pcrd.error).toBeUndefined();
  });

  it("reports an error (not needsPassword) on a wrong password", () => {
    const pcrd = parsePcrd(readBytes(PCRD_PATH), { password: "wrong" });
    expect(pcrd.needsPassword).toBeUndefined();
    expect(pcrd.zpcr).toBeUndefined();
    expect(pcrd.error).toBeDefined();
  });
});

describe.skipIf(!PW)("pcrd — decode (requires CFX_PLTD_PASSWORD)", () => {
  it("decodes into the same Zpcr shape as the matching .zpcr, cross-validated field for field", () => {
    const pcrd = parsePcrd(readBytes(PCRD_PATH), { password: PW });
    expect(pcrd.error).toBeUndefined();
    const zpcr = pcrd.zpcr!;
    const reference = parseZpcr(readBytes(ZPCR_PATH));

    expect(zpcr.metadata.identifier).toBe(reference.metadata.identifier);
    expect(zpcr.metadata.baseSerialNumber).toBe(reference.metadata.baseSerialNumber);
    expect(zpcr.reads).toHaveLength(reference.reads.length);
    expect(zpcr.reads.length).toBe(45);

    // Every WELLDATA/DARKDATA value across all 45 reads matches the binary .Plateread files
    // bit-for-bit (see pcrd.md §3.1).
    for (let i = 0; i < zpcr.reads.length; i++) {
      const a = zpcr.reads[i]!;
      const b = reference.reads[i]!;
      expect(a.cycle).toBe(b.cycle);
      expect(a.step).toBe(b.step);
      expect(a.channelMask).toBe(b.channelMask);
      expect(a.blockTempC).toBeCloseTo(b.blockTempC!, 2);
      for (let w = 0; w < a.wells.length; w++) {
        expect(a.wells[w]!.mean).toBeCloseTo(b.wells[w]!.mean, 2);
        expect(a.wells[w]!.min).toBeCloseTo(b.wells[w]!.min, 2);
        expect(a.wells[w]!.max).toBeCloseTo(b.wells[w]!.max, 2);
      }
      for (let d = 0; d < a.dark.length; d++) {
        expect(a.dark[d]!.mean).toBeCloseTo(b.dark[d]!.mean, 2);
      }
    }
  });

  it("pivots into curves/darkCurves/temperatureCurves like a .zpcr", () => {
    const zpcr = parsePcrd(readBytes(PCRD_PATH), { password: PW }).zpcr!;
    const curves = zpcr.curves();
    expect(curves.length).toBeGreaterThan(0);
    expect(curves[0]!.cycles).toHaveLength(45);
    expect(zpcr.darkCurves()).toHaveLength(6);
    expect(zpcr.channels().length).toBeGreaterThan(0);
    expect(zpcr.steps().length).toBeGreaterThan(0);
  });

  it("decodes the embedded plate setup via plates()", () => {
    const zpcr = parsePcrd(readBytes(PCRD_PATH), { password: PW }).zpcr!;
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    const plate = plates[0]!.pltd.plate!;
    expect(plate.plateName).toBe("BR Clear");
    expect(plate.rows).toBe(8);
    expect(plate.columns).toBe(12);
    expect(plate.fluors.map((f) => f.fluor)).toEqual(["FAM", "Texas Red", "Cy5"]);
  });

  it("exposes the real protocol text via protocolText and reports an empty archive", () => {
    const zpcr = parsePcrd(readBytes(PCRD_PATH), { password: PW }).zpcr!;
    expect(zpcr.protocolText).toContain("METHOD CALC");
    expect(zpcr.archive.entries).toEqual([]);
  });

  it("exposes not-yet-decoded subtrees verbatim in the full raw document (Pcrd.xml)", () => {
    const pcrd = parsePcrd(readBytes(PCRD_PATH), { password: PW });
    expect(pcrd.xml).toContain("<experimentalData2");
    expect(pcrd.xml).toContain("dataAnalysisParameters");
  });

  it("decodes calibrations() from calibrationCollection, matching the .zpcr's real .Dcal files", () => {
    const zpcr = parsePcrd(readBytes(PCRD_PATH), { password: PW }).zpcr!;
    const reference = parseZpcr(readBytes(ZPCR_PATH));

    const entries = zpcr.calibrations();
    const refEntries = reference.calibrations();
    // 14 dyes x {BR Clear, BR White}, same library the .zpcr carries as 28 real .Dcal files.
    expect(entries).toHaveLength(28);
    expect(refEntries).toHaveLength(28);

    const byKey = (list: typeof entries) =>
      new Map(list.map((e) => [`${e.dcal.dye}|${e.dcal.plate}`, e.dcal]));
    const fromPcrd = byKey(entries);
    const fromZpcr = byKey(refEntries);
    expect([...fromPcrd.keys()].sort()).toEqual([...fromZpcr.keys()].sort());

    for (const [key, a] of fromPcrd) {
      const b = fromZpcr.get(key)!;
      expect(a.primaryChannel).toBe(b.primaryChannel);
      expect(a.channelCount).toBe(b.channelCount);
      expect(a.wellCount).toBe(b.wellCount);
      expect(a.factory).toBe(b.factory);
      expect(a.notes).toBe(b.notes);

      expect(a.blocks).toHaveLength(b.blocks.length);
      for (const blockA of a.blocks) {
        const blockB = b.blocks.find(
          (x) => x.kind === blockA.kind && x.temperatureC === blockA.temperatureC,
        )!;
        expect(blockB).toBeDefined();
        expect(blockA.channelCount).toBe(blockB.channelCount);
        expect(blockA.wellCount).toBe(blockB.wellCount);
        for (let i = 0; i < blockA.values.length; i++) {
          expect(blockA.values[i]!).toBeCloseTo(blockB.values[i]!, 2);
        }
      }
    }
  });

  it("recovers the calibration timestamp/operator the .pcrd's copy carries (unlike this run's .zpcr .Dcal snapshot)", () => {
    const zpcr = parsePcrd(readBytes(PCRD_PATH), { password: PW }).zpcr!;
    const fam = zpcr
      .calibrations()
      .find((e) => e.dcal.dye === "FAM" && e.dcal.plate === "BR Clear")!.dcal;
    expect(fam.security.date?.getUTCFullYear()).toBe(2026);
    expect(fam.security.username).toBe("Bio-Rad Service");
    expect(fam.security.app).toBe("BioRadCFXManager");
  });
});
