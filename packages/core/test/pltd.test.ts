import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parsePlatesetup2, parsePltd, parseZpcr } from "../src/index.js";
import { readMultistepBytes } from "./sample.js";
import { readCfxPassword } from "./secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): Uint8Array {
  const buf = readFileSync(resolve(here, "fixtures", name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function fixtureText(name: string): string {
  return readFileSync(resolve(here, "fixtures", name), "utf-8");
}
function sampleText(name: string): string {
  return readFileSync(resolve(here, "../../../samples", name), "utf-8");
}

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
    const pltd = parsePltd(fixture("quickplate_allchannels.pltd"), { password: "wrong" });
    expect(pltd.container.compressionMethod).toBe(9);
    expect(pltd.needsPassword).toBeUndefined();
    expect(pltd.plate).toBeUndefined();
    expect(pltd.error).toBeDefined();
  });
});

// The decoded plate structure is exercised against the plaintext XML extracted from each
// sample (committed in samples/ and test/fixtures/) — no decryption, no secret needed. Only
// the pipeline test below (decrypt → inflate) needs the real password.
describe("pltd — decoded plate structure (plaintext samples, no secret needed)", () => {
  it("decodes the method-8 plate (Qualification_Plate_96.pltd)", () => {
    const plate = parsePlatesetup2(sampleText("Qualification_Plate_96.pltd.xml"));
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

  it("decodes the method-9 (DEFLATE64) multi-dye fixture (quickplate_allchannels.pltd)", () => {
    const plate = parsePlatesetup2(fixtureText("quickplate_allchannels.pltd.xml"));
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

describe.skipIf(!PW)("pltd — decryption pipeline (requires secrets.json)", () => {
  it("decrypts the method-8 entry to the same plaintext committed in samples/", () => {
    const pltd = parseZpcr(readMultistepBytes()).plates(PW)[0]!.pltd;
    expect(pltd.xml).toBe(sampleText("Qualification_Plate_96.pltd.xml"));
  });

  it("decrypts the method-9 (DEFLATE64) entry to the same plaintext committed fixture", () => {
    const pltd = parsePltd(fixture("quickplate_allchannels.pltd"), { password: PW });
    expect(pltd.xml).toBe(fixtureText("quickplate_allchannels.pltd.xml"));
  });
});
