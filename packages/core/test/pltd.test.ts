import { basename } from "node:path";
import { describe, it, expect } from "vitest";
import { parsePlatesetup2, parsePltd, parseZpcr, isPltdName } from "../src/index.js";
import { readMultistepBytes, readStandalonePltdBytes, STANDALONE_PLTD_PATH } from "./sample.js";
import { readCfxPassword } from "./secrets.js";

const PW = readCfxPassword();

describe("pltd — container + password handling (no secret needed)", () => {
  const zpcr = parseZpcr(readMultistepBytes());

  it("finds the plate entry and decodes its container", () => {
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    const { name, pltd } = plates[0]!;
    expect(name).toBe("Qualification_Plate_96.pltd");
    expect(pltd.container.compressionMethod).toBe(8);
    expect(pltd.container.encrypted).toBe(true);
    expect(pltd.container.innerName).toMatch(/\.pltd$/);
  });

  it("reports needsPassword (no plate) when no password is supplied", () => {
    const { pltd } = zpcr.plates()[0]!;
    expect(pltd.needsPassword).toBe(true);
    expect(pltd.plate).toBeUndefined();
    expect(pltd.error).toBeUndefined();
  });

  it("reports an error (not needsPassword) on a wrong password", () => {
    const pltd = parsePltd(readStandalonePltdBytes(), { password: "wrong" });
    expect(pltd.container.compressionMethod).toBe(9);
    expect(pltd.needsPassword).toBeUndefined();
    expect(pltd.plate).toBeUndefined();
    expect(pltd.error).toBeDefined();
  });
});

// A `.pltd` opened *on its own* — the app's "load a plate file directly" path, where the whole
// file is the container and there is no surrounding `.zpcr` to supply an archive entry. This is
// what backs the Plates tab for a standalone plate file, so it asserts the whole chain the tab
// needs: the name is recognized as a plate file, the container decodes without a password, and
// (given the password) a complete PlateDefinition comes out.
describe("pltd — standalone file (not inside a .zpcr)", () => {
  const name = basename(STANDALONE_PLTD_PATH);
  const bytes = readStandalonePltdBytes();

  it("recognizes the file name, spaces and all", () => {
    expect(name).toBe("QuickPlate_96 wells_All Channels.pltd");
    expect(isPltdName(name)).toBe(true);
  });

  it("decodes the container of the raw file bytes, and gates on the password", () => {
    const pltd = parsePltd(bytes);
    // The outer file *is* the single-entry ZIP; its inner name differs from the file's own.
    expect(pltd.container.innerName).toBe("QuickPlate_All Channels.pltd");
    expect(pltd.container.encrypted).toBe(true);
    expect(pltd.container.compressionMethod).toBe(9);
    expect(pltd.container.uncompressedSize).toBeGreaterThan(0);
    // Locked, not broken: the viewer shows a password prompt rather than an error.
    expect(pltd.needsPassword).toBe(true);
    expect(pltd.plate).toBeUndefined();
    expect(pltd.error).toBeUndefined();
  });

  it.skipIf(!PW)("decodes a full plate the viewer can render (requires secrets.json)", () => {
    const pltd = parsePltd(bytes, { password: PW });
    expect(pltd.error).toBeUndefined();
    expect(pltd.needsPassword).toBeUndefined();
    const plate = pltd.plate!;
    expect(plate.plateName).toBe("BR Clear");
    expect(plate.rows).toBe(8);
    expect(plate.columns).toBe(12);
    expect(plate.wells).toHaveLength(96);
    // Every dye layer resolves to an optical channel — the viewer colors wells by it.
    expect(plate.fluors.map((f) => f.fluor)).toEqual([
      "FAM",
      "HEX",
      "Texas Red",
      "Cy5",
      "Quasar 705",
    ]);
    expect(plate.fluors.map((f) => f.channel)).toEqual([0, 1, 2, 3, 4]);
    expect(plate.wells.every((w) => w.loaded)).toBe(true);
    expect(plate.wells[0]!.label).toBe("A1");
    expect(plate.wells[95]!.label).toBe("H12");
  });
});

// The decoded plate structure is exercised against real samples, which means decrypting them
// first: the plaintext XML is no longer committed beside them, so these need the password. What
// `parsePlatesetup2` does with the shapes a real sample doesn't have is covered by the synthetic
// fixtures below, which need no secret.
describe.skipIf(!PW)("pltd — decoded plate structure (real samples, requires secrets.json)", () => {
  it("decodes the method-8 plate (Qualification_Plate_96.pltd)", () => {
    const plate = parseZpcr(readMultistepBytes()).plates(PW)[0]!.pltd.plate!;
    expect(plate.plateName).toBe("BR White");
    expect(plate.rows).toBe(8);
    expect(plate.columns).toBe(12);
    expect(plate.fluors).toEqual([{ fluor: "SYBR", channel: 0, fluorId: expect.any(String) }]);
    expect(plate.wells).toHaveLength(96);
    const a1 = plate.wells[0]!;
    expect(a1.label).toBe("A1");
    expect(a1.loaded).toBe(true);
    expect(a1.sampleType).toBe("unknown");
    expect(a1.sampleTypeRaw).toBe("wcSample");
    expect(a1.fluors).toEqual([{ fluor: "SYBR", channel: 0, target: undefined }]);
  });

  it("decodes the method-9 (DEFLATE64) multi-dye sample (QuickPlate_96 wells_All Channels.pltd)", () => {
    const plate = parsePltd(readStandalonePltdBytes(), { password: PW }).plate!;
    expect(plate.plateName).toBe("BR Clear");
    expect(plate.scanMode).toBe("AllChannelsScan");
    expect(plate.dyeCount).toBe(5);
    expect(plate.fluors.map((f) => f.fluor)).toEqual([
      "FAM",
      "HEX",
      "Texas Red",
      "Cy5",
      "Quasar 705",
    ]);
    expect(plate.fluors.map((f) => f.channel)).toEqual([0, 1, 2, 3, 4]);
    expect(plate.wells).toHaveLength(96);
    expect(plate.wells[0]!.fluors.map((f) => f.fluor)).toEqual([
      "FAM",
      "HEX",
      "Texas Red",
      "Cy5",
      "Quasar 705",
    ]);
  });
});

describe("pltd — wellSampleType normalization", () => {
  function platesetup2(codes: string[]): string {
    const wells = codes
      .map(
        (code, i) =>
          `<wellSample replicateNumber="-1" sampleQuantity="NaN" wellSampleType="${code}" ` +
          `plateIndex="${i}" wellLoadedFluor="${code === "wcFirst" || code === "wcLast" ? "False" : "True"}" ` +
          `geneName="" conditionName="" />`,
      )
      .join("");
    return (
      `<platesetup2 plateName="T" rows="1" columns="${codes.length}" dyes="1">` +
      `<dyeLayer><fluor fluorName="FAM" channelPosition="0"/>${wells}</dyeLayer></platesetup2>`
    );
  }

  it("maps the enum bounds wcFirst/wcLast to empty, not other", () => {
    const plate = parsePlatesetup2(platesetup2(["wcFirst", "wcLast"]));
    expect(plate.wells.map((w) => w.sampleType)).toEqual(["empty", "empty"]);
    // The raw code is still preserved, so the filler stays visible in the well detail.
    expect(plate.wells.map((w) => w.sampleTypeRaw)).toEqual(["wcFirst", "wcLast"]);
    expect(plate.wells.every((w) => !w.loaded)).toBe(true);
  });

  it("still falls back to other for a genuinely unrecognized code", () => {
    const plate = parsePlatesetup2(platesetup2(["wcSomethingNew"]));
    expect(plate.wells[0]!.sampleType).toBe("other");
    expect(plate.wells[0]!.sampleTypeRaw).toBe("wcSomethingNew");
  });

  it("normalizes the real sample-type codes", () => {
    const codes = ["wcSample", "wcStandard", "wcNTC", "wcNRT", "wcPostiveControl", "wcNegativeControl"];
    expect(parsePlatesetup2(platesetup2(codes)).wells.map((w) => w.sampleType)).toEqual([
      "unknown",
      "standard",
      "ntc",
      "nrt",
      "positiveControl",
      "negativeControl",
    ]);
  });
});

// Decrypt → inflate has to yield a *whole* document, not a prefix: a truncated inflate still
// parses into a plausible-looking plate (the wells come first), so the tail is what catches it.
describe.skipIf(!PW)("pltd — decryption pipeline (requires secrets.json)", () => {
  it("decrypts the method-8 entry to a complete platesetup2 document", () => {
    const pltd = parseZpcr(readMultistepBytes()).plates(PW)[0]!.pltd;
    expect(pltd.error).toBeUndefined();
    expect(pltd.xml).toMatch(/^<\?xml /);
    expect(pltd.xml!.trimEnd()).toMatch(/<\/platesetup2>$/);
  });

  it("decrypts the method-9 (DEFLATE64) entry to a complete platesetup2 document", () => {
    const pltd = parsePltd(readStandalonePltdBytes(), { password: PW });
    expect(pltd.error).toBeUndefined();
    expect(pltd.xml).toMatch(/^<\?xml /);
    expect(pltd.xml!.trimEnd()).toMatch(/<\/platesetup2>$/);
  });
});
