import { describe, it, expect } from "vitest";
import { parseZpcr, parsePlateCsv, plateToCsv, type PlateDefinition } from "../src/index.js";
import { readMultistepBytes } from "./sample.js";
import { readCfxPassword } from "./secrets.js";

const PW = readCfxPassword();

function syntheticPlate(): PlateDefinition {
  const samples: string[] = [];
  const wells = Array.from({ length: 8 * 12 }, (_, index) => {
    const row = Math.floor(index / 12);
    const col = index % 12;
    const loaded = col < 2;
    const sample = loaded ? `Sample, "quoted" ${row}-${col}` : undefined;
    if (sample) samples.push(sample);
    return {
      index,
      row,
      col,
      label: `${String.fromCharCode(65 + row)}${col + 1}`,
      loaded,
      fluors: loaded
        ? [
            { fluor: "FAM", channel: 0, target: "GeneA" },
            { fluor: "HEX", channel: 1 },
          ]
        : [],
      sampleType: loaded ? ("unknown" as const) : ("empty" as const),
      sampleTypeRaw: loaded ? "wcSample" : "wcEmpty",
      sample,
      replicate: loaded ? 1 : undefined,
      quantity: loaded ? 1000 : undefined,
    };
  });
  return {
    plateName: "BR White",
    rows: 8,
    columns: 12,
    dyeCount: 2,
    scanMode: "AllChannelsScan",
    plateType: "Plate96",
    standardUnits: "copy number",
    fluors: [
      { fluor: "FAM", channel: 0 },
      { fluor: "HEX", channel: 1 },
    ],
    targets: ["GeneA"],
    samples,
    wells,
    meta: {},
  };
}

describe("plate CSV round-trip", () => {
  it("round-trips a synthetic plate exactly, including escaped delimiters", () => {
    const plate = syntheticPlate();
    const csv = plateToCsv(plate);
    const back = parsePlateCsv(csv);
    expect(back).toEqual(plate);
  });

  it("marks a well with no fluor cell filled in as unloaded", () => {
    const plate = syntheticPlate();
    const back = parsePlateCsv(plateToCsv(plate));
    expect(back.wells[2]!.loaded).toBe(false);
    expect(back.wells[0]!.loaded).toBe(true);
  });

  it("writes one column per fluor, holding just the target", () => {
    const lines = plateToCsv(syntheticPlate()).split("\r\n");
    expect(lines.some((l) => l.startsWith("# fluors:"))).toBe(false);
    const header = lines.find((l) => l.startsWith("Well,"))!;
    expect(header).toBe("Well,SampleType,Sample,Replicate,Quantity,FAM,HEX");
    // A1 is loaded: FAM has a target, HEX doesn't.
    expect(lines.find((l) => l.startsWith("A1,"))!.endsWith(",GeneA,+")).toBe(true);
  });

  it("leaves blank wells out of the table entirely", () => {
    const plate = syntheticPlate(); // only columns 1-2 of each row are loaded
    const lines = plateToCsv(plate).split("\r\n").filter(Boolean);
    expect(lines.some((l) => l.startsWith("A3,"))).toBe(false);
    expect(lines.filter((l) => /^[A-H]\d/.test(l))).toHaveLength(16);
    // …and they come back as empty wells, so the plate is unchanged.
    expect(parsePlateCsv(plateToCsv(plate))).toEqual(plate);
  });

  it("writes and re-reads a plate with no non-blank wells", () => {
    const plate = syntheticPlate();
    const blank = {
      ...plate,
      targets: [],
      samples: [],
      wells: plate.wells.map((w) => ({
        ...w,
        loaded: false,
        fluors: [],
        sampleType: "empty" as const,
        sampleTypeRaw: "wcEmpty",
        sample: undefined,
        replicate: undefined,
        quantity: undefined,
      })),
    };
    expect(parsePlateCsv(plateToCsv(blank))).toEqual(blank);
  });

  it("resolves channels from calibration, not from the column order", () => {
    const csv = [
      "# rows: 1",
      "# columns: 1",
      "Well,SampleType,Sample,Replicate,Quantity,FAM,Tex 615,Cy5",
      "A1,unknown,,,,GeneA,GeneB,GeneC",
    ].join("\r\n");
    // What `zpcr.plates()` passes in, from the archive's `.Dcal` primaryChannel fields.
    const channels = new Map([["fam", 0], ["tex 615", 2], ["cy5", 3]]);
    const plate = parsePlateCsv(csv, {
      channelForFluor: (f) => channels.get(f.toLowerCase()),
    });
    expect(plate.fluors).toEqual([
      { fluor: "FAM", channel: 0 },
      { fluor: "Tex 615", channel: 2 },
      { fluor: "Cy5", channel: 3 },
    ]);
    // An unknown dye still gets a column position rather than being dropped.
    expect(parsePlateCsv(csv, { channelForFluor: () => undefined }).fluors.map((f) => f.channel))
      .toEqual([0, 1, 2]);
  });

  it("honours an explicit Ch<n> suffix over the calibration lookup", () => {
    const csv = [
      "# rows: 1",
      "# columns: 1",
      "Well,SampleType,Sample,Replicate,Quantity,FAM Ch1,Tex 615 Ch3,Cy5 Ch4",
      "A1,unknown,,,,GeneA,GeneB,GeneC",
    ].join("\r\n");
    expect(parsePlateCsv(csv, { channelForFluor: () => 5 }).fluors).toEqual([
      { fluor: "FAM", channel: 0 },
      { fluor: "Tex 615", channel: 2 },
      { fluor: "Cy5", channel: 3 },
    ]);
  });

  it("falls back to column order with neither a suffix nor a calibration lookup", () => {
    const csv = [
      "Well,SampleType,Sample,Replicate,Quantity,FAM,HEX",
      "A1,unknown,,,,GeneA,GeneB",
    ].join("\r\n");
    expect(parsePlateCsv(csv).fluors).toEqual([
      { fluor: "FAM", channel: 0 },
      { fluor: "HEX", channel: 1 },
    ]);
  });

  it("treats wells left out of the table as empty", () => {
    const csv = [
      "# rows: 8",
      "# columns: 12",
      "Well,SampleType,Sample,Replicate,Quantity,FAM Ch1",
      "B2,unknown,S1,,,GeneA",
    ].join("\r\n");
    const plate = parsePlateCsv(csv);
    expect(plate.wells).toHaveLength(96);
    const listed = plate.wells[1 * 12 + 1]!;
    expect(listed).toMatchObject({ label: "B2", loaded: true, sample: "S1" });
    for (const w of plate.wells) {
      if (w.label === "B2") continue;
      expect(w).toMatchObject({ loaded: false, fluors: [], sampleType: "empty" });
    }
  });

  it("omits plateType/scanMode/standardUnits when empty, and parses a file without them", () => {
    const plate = { ...syntheticPlate(), plateType: "", scanMode: "", standardUnits: "" };
    const csv = plateToCsv(plate);
    expect(csv).not.toMatch(/# (plateType|scanMode|standardUnits):/);
    expect(parsePlateCsv(csv)).toEqual(plate);
  });

  it("ignores trailing commas a spreadsheet adds to the header lines", () => {
    const csv = plateToCsv(syntheticPlate())
      .split("\r\n")
      .map((l) => (l.startsWith("#") ? `${l},,,,,,` : l))
      .join("\r\n");
    expect(parsePlateCsv(csv)).toEqual(parsePlateCsv(plateToCsv(syntheticPlate())));
  });

  it("takes identityKey from the source name, and writes no identityKey line", () => {
    const csv = plateToCsv({ ...syntheticPlate(), identityKey: "Ignored.plt" });
    expect(csv).not.toMatch(/# identityKey:/);
    expect(parsePlateCsv(csv, { sourceName: "runs/S183-S185-RVP.plt.csv" }).identityKey).toBe(
      "S183-S185-RVP",
    );
    expect(parsePlateCsv(csv, { sourceName: "MyPlate.csv" }).identityKey).toBe("MyPlate");
    expect(parsePlateCsv(csv).identityKey).toBeUndefined();
  });

  it.skipIf(!PW)("round-trips a real decoded plate from a sample .zpcr", () => {
    const zpcr = parseZpcr(readMultistepBytes());
    const { pltd } = zpcr.plates(PW)[0]!;
    const plate = pltd.plate!;
    // identityKey comes from the file name and the channels from the archive's `.Dcal` set —
    // neither is in the text. This is what `zpcr.plates()` does for a `.plt.csv` entry.
    const channels = new Map(
      zpcr.calibrations().map(({ dcal }) => [dcal.dye.toLowerCase(), dcal.primaryChannel]),
    );
    const back = parsePlateCsv(plateToCsv(plate), {
      sourceName: `${plate.identityKey}.csv`,
      channelForFluor: (f) => channels.get(f.toLowerCase()),
    });
    // The CSV format intentionally drops the raw `.pltd` header metadata (`meta`, per-fluor
    // `fluorId`) — it's a plain plate-editing format, not a lossless `.pltd` mirror.
    expect(back).toEqual({
      ...plate,
      fluors: plate.fluors.map(({ fluor, channel }) => ({ fluor, channel })),
      meta: {},
    });
  });
});
