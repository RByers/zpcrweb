import { describe, it, expect } from "vitest";
import {
  attachPlate,
  attachProtocol,
  parseZpcrArchive,
  plateToCsv,
  type PlateDefinition,
} from "../src/index.js";
import { readMultistepArchive, readSampleArchive } from "./sample.js";
import { readCfxPassword } from "./secrets.js";

const PW = readCfxPassword();

function syntheticPlate(name: string): PlateDefinition {
  const wells = Array.from({ length: 8 * 12 }, (_, index) => ({
    index,
    row: Math.floor(index / 12),
    col: index % 12,
    label: `${String.fromCharCode(65 + Math.floor(index / 12))}${(index % 12) + 1}`,
    loaded: false,
    fluors: [],
    sampleType: "empty" as const,
    sampleTypeRaw: "wcEmpty",
  }));
  return {
    plateName: name,
    rows: 8,
    columns: 12,
    dyeCount: 0,
    scanMode: "AllChannelsScan",
    plateType: "Plate96",
    standardUnits: "",
    fluors: [],
    targets: [],
    samples: [],
    wells,
    meta: {},
  };
}

describe("attachPlate", () => {
  it("adds a .plt.csv entry to an archive, renaming a bare .csv upload", () => {
    const original = readSampleArchive();
    const csv = plateToCsv(syntheticPlate("Attached Plate"));
    const augmented = attachPlate(original, {
      name: "MyPlate.csv",
      bytes: new TextEncoder().encode(csv),
    });

    const zpcr = parseZpcrArchive(augmented);
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    expect(plates[0]!.name).toBe("MyPlate.plt.csv");
    expect(plates[0]!.pltd.plate?.plateName).toBe("Attached Plate");
    expect(plates[0]!.pltd.error).toBeUndefined();
  });

  it("replaces (not adds to) an existing .pltd entry", () => {
    const original = readMultistepArchive();
    expect(parseZpcrArchive(original).plates()).toHaveLength(1); // sanity: starts with one real .pltd

    const csv = plateToCsv(syntheticPlate("Replacement"));
    const augmented = attachPlate(original, {
      name: "Replacement.plt.csv",
      bytes: new TextEncoder().encode(csv),
    });

    const plates = parseZpcrArchive(augmented).plates();
    expect(plates).toHaveLength(1);
    expect(plates[0]!.name).toBe("Replacement.plt.csv");
    expect(plates[0]!.pltd.plate?.plateName).toBe("Replacement");
  });

  it("preserves the rest of the archive untouched (reads, RunInfo)", () => {
    const original = readMultistepArchive();
    const before = parseZpcrArchive(original);
    const csv = plateToCsv(syntheticPlate("X"));
    const augmented = attachPlate(original, {
      name: "X.plt.csv",
      bytes: new TextEncoder().encode(csv),
    });
    const after = parseZpcrArchive(augmented);
    expect(after.reads).toHaveLength(before.reads.length);
    expect(after.metadata.dataFile).toBe(before.metadata.dataFile);
  });

  it.skipIf(!PW)("attaching a real .pltd's raw bytes stays a real, password-gated .pltd", () => {
    const source = parseZpcrArchive(readMultistepArchive());
    const originalEntry = source.plates(PW)[0]!;
    const pltdBytes = source.archive.bytes(originalEntry.name);

    const target = attachPlate(readSampleArchive(), {
      name: "Qualification_Plate_96.pltd",
      bytes: pltdBytes,
    });
    const zpcr = parseZpcrArchive(target);
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    expect(plates[0]!.pltd.needsPassword).toBe(true);
    expect(zpcr.plates(PW)[0]!.pltd.plate?.plateName).toBe(originalEntry.pltd.plate?.plateName);
  });

  it("rejects an unrecognized plate file name", () => {
    expect(() =>
      attachPlate(readSampleArchive(), { name: "notes.txt", bytes: new Uint8Array() }),
    ).toThrow(/not a \.pltd or \.csv/);
  });
});

const PROTOCOL = "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,60;PLATEREAD #h3F;GOTO 2,10;END;";

describe("attachProtocol", () => {
  it("replaces the run's protocol text and name, leaving the rest of the archive alone", () => {
    const original = readMultistepArchive();
    const before = parseZpcrArchive(original);
    const augmented = attachProtocol(original, {
      runDefinition: PROTOCOL,
      name: "Fast test",
    });
    const after = parseZpcrArchive(augmented);
    expect(after.protocolText).toContain("PLATEREAD #h3F");
    expect(after.protocol()?.name).toBe("Fast test");
    expect(after.reads).toHaveLength(before.reads.length);
    expect(after.metadata.dataFile).toBe(before.metadata.dataFile);
  });

  it("writes no ProtocolName.txt for an unnamed protocol", () => {
    const augmented = attachProtocol(readSampleArchive(), { runDefinition: PROTOCOL });
    const zpcr = parseZpcrArchive(augmented);
    expect(zpcr.protocol()?.name).toBeFalsy();
  });

  it("attaches into an archive with no protocol at all yet", () => {
    // Mirrors a pending experiment's bare archive (`experimentArchive.ts`): a zero-length
    // ProtocolRunDefinition.txt exists purely so the ZIP parses as a .zpcr.
    const bare = { "ProtocolRunDefinition.txt": new Uint8Array(0) };
    const zpcr = parseZpcrArchive(attachProtocol(bare, { runDefinition: PROTOCOL }));
    expect(zpcr.protocolText).toContain("PLATEREAD #h3F");
  });
});
