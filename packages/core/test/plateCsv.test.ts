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

  it("marks a well with an empty Fluors cell as unloaded", () => {
    const plate = syntheticPlate();
    const back = parsePlateCsv(plateToCsv(plate));
    expect(back.wells[2]!.loaded).toBe(false);
    expect(back.wells[0]!.loaded).toBe(true);
  });

  it("rejects a well referencing an undeclared fluor", () => {
    const csv = [
      "# fluors: FAM:0",
      "# rows: 1",
      "# columns: 1",
      "Well,SampleType,Sample,Replicate,Quantity,Fluors",
      "A1,unknown,,,,HEX",
    ].join("\r\n");
    expect(() => parsePlateCsv(csv)).toThrow(/unknown fluor/);
  });

  it.skipIf(!PW)("round-trips a real decoded plate from a sample .zpcr", () => {
    const zpcr = parseZpcr(readMultistepBytes());
    const { pltd } = zpcr.plates(PW)[0]!;
    const plate = pltd.plate!;
    const back = parsePlateCsv(plateToCsv(plate));
    // The CSV format intentionally drops the raw `.pltd` header metadata (`meta`, per-fluor
    // `fluorId`) — it's a plain plate-editing format, not a lossless `.pltd` mirror.
    expect(back).toEqual({
      ...plate,
      fluors: plate.fluors.map(({ fluor, channel }) => ({ fluor, channel })),
      meta: {},
    });
  });
});
