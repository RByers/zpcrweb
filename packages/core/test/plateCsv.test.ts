import { describe, it, expect } from "vitest";
import {
  isPlateCsvName,
  parseZpcr,
  parsePlateCsv,
  plateToCsv,
  type PlateDefinition,
} from "../src/index.js";
import { readMultistepBytes, readSampleBytes } from "./sample.js";
import { readCfxPassword } from "./secrets.js";

const PW = readCfxPassword();

/**
 * The dye→channel lookup `zpcr.plates()` builds from an archive's `.Dcal` set, for the two dyes
 * {@link syntheticPlate} uses. Round-trip tests have to pass it: the CSV labels its fluor columns
 * by dye alone, so the channel comes back from calibration or not at all — there is deliberately
 * no positional fallback to paper over its absence.
 */
const SYNTHETIC_CHANNELS = (fluor: string) => ({ FAM: 0, HEX: 1 })[fluor];

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
    const back = parsePlateCsv(csv, { channelForFluor: SYNTHETIC_CHANNELS });
    expect(back).toEqual(plate);
  });

  it("marks a well with no fluor cell filled in as unloaded", () => {
    const plate = syntheticPlate();
    const back = parsePlateCsv(plateToCsv(plate), { channelForFluor: SYNTHETIC_CHANNELS });
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
    expect(parsePlateCsv(plateToCsv(plate), { channelForFluor: SYNTHETIC_CHANNELS })).toEqual(plate);
  });

  it("writes wells column-major (A1, B1, C1, …), the order a plate is filled", () => {
    const labels = plateToCsv(syntheticPlate())
      .split("\r\n")
      .filter((l) => /^[A-H]\d/.test(l))
      .map((l) => l.split(",")[0]);
    expect(labels).toEqual([
      "A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1",
      "A2", "B2", "C2", "D2", "E2", "F2", "G2", "H2",
    ]);
  });

  it("reads a row-major file back identically, so order is presentation only", () => {
    const plate = syntheticPlate();
    const lines = plateToCsv(plate).split("\r\n").filter(Boolean);
    const wellRows = lines.filter((l) => /^[A-H]\d/.test(l));
    const rowMajor = [
      ...lines.filter((l) => !/^[A-H]\d/.test(l)),
      ...[...wellRows].sort(),
    ].join("\r\n") + "\r\n";
    expect(parsePlateCsv(rowMajor, { channelForFluor: SYNTHETIC_CHANNELS })).toEqual(plate);
  });

  it("writes fluor columns in ascending channel order, whatever order the plate declares", () => {
    const plate = syntheticPlate();
    plate.fluors = [...plate.fluors].reverse(); // HEX (Ch2) declared before FAM (Ch1)
    for (const w of plate.wells) w.fluors = [...w.fluors].reverse();
    const lines = plateToCsv(plate).split("\r\n");
    expect(lines.find((l) => l.startsWith("Well,"))).toBe(
      "Well,SampleType,Sample,Replicate,Quantity,FAM,HEX",
    );
    // …so each well's cells read low channel → high: FAM's target first, then HEX's bare marker.
    expect(lines.find((l) => l.startsWith("A1,"))!.endsWith(",GeneA,+")).toBe(true);
    const back = parsePlateCsv(plateToCsv(plate), { channelForFluor: SYNTHETIC_CHANNELS });
    expect(back.fluors).toEqual([
      { fluor: "FAM", channel: 0 },
      { fluor: "HEX", channel: 1 },
    ]);
    expect(back.wells[0]!.fluors).toEqual([
      { fluor: "FAM", channel: 0, target: "GeneA" },
      { fluor: "HEX", channel: 1 },
    ]);
  });

  it("re-sorts a file whose fluor columns are in another order, unknown channels last", () => {
    const text =
      ["# vessel: BR White 8x12", "Well,SampleType,Sample,HEX,Mystery,FAM", "A1,unknown,S1,+,+,GeneA"].join(
        "\r\n",
      ) + "\r\n";
    const back = parsePlateCsv(text, { channelForFluor: SYNTHETIC_CHANNELS });
    expect(back.fluors).toEqual([
      { fluor: "FAM", channel: 0 },
      { fluor: "HEX", channel: 1 },
      { fluor: "Mystery", channel: undefined },
    ]);
    expect(back.wells[0]!.fluors.map((f) => f.fluor)).toEqual(["FAM", "HEX", "Mystery"]);
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
    expect(parsePlateCsv(plateToCsv(blank), { channelForFluor: SYNTHETIC_CHANNELS })).toEqual(blank);
  });

  it("resolves channels from calibration, not from the column order", () => {
    const csv = [
      "# vessel: BR Clear 1x1",
      "Well,SampleType,Sample,FAM,Tex 615,Cy5",
      "A1,unknown,,GeneA,GeneB,GeneC",
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
    // A dye the lookup doesn't know keeps its column (it's still a real fluor on the plate) but
    // gets NO channel — never the column's position, which would read as a real channel.
    expect(parsePlateCsv(csv, { channelForFluor: () => undefined }).fluors).toEqual([
      { fluor: "FAM", channel: undefined },
      { fluor: "Tex 615", channel: undefined },
      { fluor: "Cy5", channel: undefined },
    ]);
  });

  it("wires the calibration lookup up for a real archive's .plt.csv entry", () => {
    // The end-to-end version of the test above: the sample's plate CSV labels its columns
    // FAM,Tex 615,Cy5 in that order, but Cy5 is read on channel 3, not the 2 its position
    // implies — so a `plates()` that forgot to pass `channelForFluor` would still look
    // plausible while shifting every dye past the first onto the wrong channel.
    const zpcr = parseZpcr(readSampleBytes());
    const plate = zpcr.plates().find((e) => isPlateCsvName(e.name))!.pltd.plate!;
    expect(plate.fluors).toEqual([
      { fluor: "FAM", channel: 0 },
      { fluor: "Tex 615", channel: 2 },
      { fluor: "Cy5", channel: 3 },
    ]);
  });

  it("honours an explicit Ch<n> suffix over the calibration lookup", () => {
    const csv = [
      "# vessel: BR Clear 1x1",
      "Well,SampleType,Sample,FAM Ch1,Tex 615 Ch3,Cy5 Ch4",
      "A1,unknown,,GeneA,GeneB,GeneC",
    ].join("\r\n");
    expect(parsePlateCsv(csv, { channelForFluor: () => 5 }).fluors).toEqual([
      { fluor: "FAM", channel: 0 },
      { fluor: "Tex 615", channel: 2 },
      { fluor: "Cy5", channel: 3 },
    ]);
  });

  it("leaves the channel unknown with neither a suffix nor a calibration lookup", () => {
    // Column order is not a channel. Deriving one from it (this used to) produces a plausible
    // wrong answer — the dye is coloured and grouped as a neighbouring channel — where undefined
    // produces a visible "Ch?".
    const csv = [
      "Well,SampleType,Sample,FAM,HEX",
      "A1,unknown,,GeneA,GeneB",
    ].join("\r\n");
    const { fluors, wells } = parsePlateCsv(csv);
    expect(fluors).toEqual([
      { fluor: "FAM", channel: undefined },
      { fluor: "HEX", channel: undefined },
    ]);
    // …and the per-well copies agree; nothing downstream re-derives one.
    expect(wells[0]!.fluors.map((f) => f.channel)).toEqual([undefined, undefined]);
  });

  it("treats wells left out of the table as empty", () => {
    const csv = [
      "# vessel: BR Clear 8x12",
      "Well,SampleType,Sample,FAM Ch1",
      "B2,unknown,S1,GeneA",
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

  it("writes the vessel and the plate extent on one `# vessel:` line", () => {
    const csv = plateToCsv(syntheticPlate());
    expect(csv).toContain("# vessel: BR White 8x12\r\n");
    expect(csv).not.toMatch(/# (plateName|rows|columns):/);
  });

  it("sizes the plate from the vessel line's extent, past the last labelled well", () => {
    const csv = [
      "# vessel: BR White 8x12",
      "Well,SampleType,Sample,FAM",
      "A1,unknown,,GeneA",
    ].join("\r\n");
    const plate = parsePlateCsv(csv);
    expect(plate.plateName).toBe("BR White");
    expect([plate.rows, plate.columns]).toEqual([8, 12]);
    expect(plate.wells).toHaveLength(96);
    // Without the extent it falls back to the well labels — a 1x1 plate here.
    const noExtent = parsePlateCsv(csv.replace(" 8x12", ""));
    expect([noExtent.rows, noExtent.columns, noExtent.plateName]).toEqual([1, 1, "BR White"]);
  });

  it("omits Replicate/Quantity when no well fills them in, and reads a file without them", () => {
    const plate = syntheticPlate();
    const bare = {
      ...plate,
      wells: plate.wells.map((w) => ({ ...w, replicate: undefined, quantity: undefined })),
    };
    const csv = plateToCsv(bare);
    expect(csv.split("\r\n").find((l) => l.startsWith("Well,"))).toBe(
      "Well,SampleType,Sample,FAM,HEX",
    );
    expect(parsePlateCsv(csv, { channelForFluor: SYNTHETIC_CHANNELS })).toEqual(bare);
  });

  it("writes only the one of Replicate/Quantity that is used", () => {
    const plate = syntheticPlate();
    const replicateOnly = {
      ...plate,
      wells: plate.wells.map((w) => ({ ...w, quantity: undefined })),
    };
    const csv = plateToCsv(replicateOnly);
    expect(csv.split("\r\n").find((l) => l.startsWith("Well,"))).toBe(
      "Well,SampleType,Sample,Replicate,FAM,HEX",
    );
    expect(parsePlateCsv(csv, { channelForFluor: SYNTHETIC_CHANNELS })).toEqual(replicateOnly);
  });

  it("writes the raw code for an `other` well, and round-trips it without inventing wcOther", () => {
    const plate = syntheticPlate();
    plate.wells[0]!.sampleType = "other";
    plate.wells[0]!.sampleTypeRaw = "wcSomethingNew";
    const csv = plateToCsv(plate);
    expect(csv).not.toMatch(/wcOther/);
    expect(csv.split("\r\n").find((l) => l.startsWith("A1,"))).toMatch(/^A1,wcSomethingNew,/);
    expect(parsePlateCsv(csv, { channelForFluor: SYNTHETIC_CHANNELS })).toEqual(plate);
  });

  it("accepts a raw wc* code in the SampleType cell and normalizes it", () => {
    const csv = [
      "# vessel: BR Clear 1x3",
      "Well,SampleType,Sample,FAM Ch1",
      "A1,wcNTC,,GeneA",
      "A2,ntc,,GeneA",
      "A3,wcFirst,,",
    ].join("\r\n");
    const wells = parsePlateCsv(csv).wells;
    // A hand-written CFX code reads the same as the normalized name, and the enum filler that
    // `.pltd` uses for an unset well reads as empty rather than `other`.
    expect(wells[0]!).toMatchObject({ sampleType: "ntc", sampleTypeRaw: "wcNTC" });
    expect(wells[1]!).toMatchObject({ sampleType: "ntc", sampleTypeRaw: "wcNTC" });
    expect(wells[2]!).toMatchObject({ sampleType: "empty", sampleTypeRaw: "wcEmpty", loaded: false });
  });

  it("omits plateType/scanMode/standardUnits when empty, and parses a file without them", () => {
    const plate = { ...syntheticPlate(), plateType: "", scanMode: "", standardUnits: "" };
    const csv = plateToCsv(plate);
    expect(csv).not.toMatch(/# (plateType|scanMode|standardUnits):/);
    expect(parsePlateCsv(csv, { channelForFluor: SYNTHETIC_CHANNELS })).toEqual(plate);
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

describe("Zpcr.channelForDye — giving an outside plate CSV its channels", () => {
  // The mapping `plates()` uses internally for an in-archive `.plt.csv`, published so a caller
  // can pair a run with a plate CSV that isn't in the archive (the app's Instrument view stages
  // exactly that). Read from the run's own `.Dcal` set, so it is a fact about this instrument.
  const zpcr = parseZpcr(readSampleBytes());

  it("resolves a calibrated dye to its primary channel, case- and space-insensitively", () => {
    const channels = zpcr.calibrations().map((e) => [e.dcal.dye, e.dcal.primaryChannel] as const);
    const [dye, channel] = channels.find(([d]) => d)!;
    expect(zpcr.channelForDye(dye!)).toBe(channel);
    expect(zpcr.channelForDye(dye!.toLowerCase())).toBe(channel);
    expect(zpcr.channelForDye(`  ${dye}  `)).toBe(channel);
  });

  it("leaves a dye the run doesn't calibrate unknown, rather than guessing one", () => {
    expect(zpcr.channelForDye("NotADye")).toBeUndefined();
  });

  it("gives a standalone plate CSV the same channels as parsing it inside the archive", () => {
    // The CSV records dye names only, so parsed bare every channel is unknown; parsed against
    // the run it matches what the same bytes yield as an archive entry.
    // This sample's plate *is* a `.plt.csv` archive entry, which never needs a password — so
    // this runs with or without secrets.json, and asserting rather than skipping keeps it from
    // passing silently if that ever changes.
    const plate = zpcr.plates(PW)[0]?.pltd.plate;
    if (!plate) throw new Error("expected the sample's own .plt.csv entry to decode");
    const csv = plateToCsv(plate);
    const bare = parsePlateCsv(csv, { sourceName: "x.plt.csv" });
    const mapped = parsePlateCsv(csv, {
      sourceName: "x.plt.csv",
      channelForFluor: (f) => zpcr.channelForDye(f),
    });
    expect(bare.fluors.every((f) => f.channel === undefined)).toBe(true);
    expect(mapped.fluors.map((f) => f.channel)).toEqual(plate.fluors.map((f) => f.channel));
    expect(mapped.fluors.some((f) => f.channel !== undefined)).toBe(true);
  });
});
