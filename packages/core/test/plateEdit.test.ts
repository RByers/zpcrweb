import { describe, it, expect } from "vitest";
import {
  applyWellPatches,
  clearPatch,
  editWells,
  parsePlateCsv,
  plateToCsv,
  setPlateFluors,
  wellPatch,
  type PlateDefinition,
} from "../src/index.js";

/** A 2×3 plate with two dyes, one loaded well (A1) — small enough to assert on whole. */
function plate(): PlateDefinition {
  return parsePlateCsv(
    [
      "# zpcrweb plate definition",
      "# vessel: BR Clear 2x3",
      "Well,SampleType,Sample,FAM,HEX",
      "A1,unknown,S1,GeneA,+",
      "",
    ].join("\r\n"),
    { sourceName: "test.plt.csv" },
  );
}

/** Every edit's output has to survive a save/reload, since that is what the app does with it. */
function roundTrip(p: PlateDefinition): PlateDefinition {
  return parsePlateCsv(plateToCsv(p), { sourceName: "test.plt.csv" });
}

describe("editWells", () => {
  it("changes only the fields the patch names", () => {
    const next = editWells(plate(), [0], { sample: "S2" });
    expect(next.wells[0]!.sample).toBe("S2");
    // The targets the patch said nothing about are untouched — the whole point of an absent
    // field, and what lets a column's sample be set without disturbing its assay.
    expect(next.wells[0]!.fluors).toEqual([{ fluor: "FAM", target: "GeneA" }, { fluor: "HEX" }]);
    expect(next.wells[0]!.sampleType).toBe("unknown");
  });

  it("applies one patch across a whole selection", () => {
    const next = editWells(plate(), [1, 2, 3], { sampleType: "ntc", fluors: { FAM: "GeneA" } });
    for (const i of [1, 2, 3]) {
      expect(next.wells[i]!.sampleType).toBe("ntc");
      expect(next.wells[i]!.sampleTypeRaw).toBe("wcNTC");
      expect(next.wells[i]!.fluors).toEqual([{ fluor: "FAM", target: "GeneA" }]);
      // A well carrying a fluor is loaded, which is the rule the CSV round-trip enforces.
      expect(next.wells[i]!.loaded).toBe(true);
    }
    expect(next.wells[4]!.loaded).toBe(false);
    expect(next.targets).toEqual(["GeneA"]);
  });

  it("empties a well whose last fluor is removed", () => {
    const next = editWells(plate(), [0], { fluors: { FAM: null, HEX: null } });
    expect(next.wells[0]!.loaded).toBe(false);
    expect(next.targets).toEqual([]);
    expect(roundTrip(next).wells[0]!.loaded).toBe(false);
  });

  it("adds a dye the plate didn't declare when a patch brings one", () => {
    const next = editWells(plate(), [1], { fluors: { "Tex 615": "RP" } });
    expect(next.fluors.map((f) => f.fluor).sort()).toEqual(["FAM", "HEX", "Tex 615"]);
    expect(next.dyeCount).toBe(3);
    expect(roundTrip(next).wells[1]!.fluors).toEqual([{ fluor: "Tex 615", target: "RP" }]);
  });

  it("rebuilds the plate's sample and target lists from the wells", () => {
    const next = editWells(plate(), [0], { sample: "S9", fluors: { FAM: "GeneB" } });
    expect(next.samples).toEqual(["S9"]);
    expect(next.targets).toEqual(["GeneB"]);
  });

  it("clears a well completely", () => {
    const p = plate();
    const next = editWells(p, [0], clearPatch(p));
    expect(next.wells[0]!.loaded).toBe(false);
    expect(next.wells[0]!.sample).toBeUndefined();
    expect(next.wells[0]!.sampleType).toBe("empty");
    // The dye stays on the plate — clearing wells isn't the same as dropping a channel.
    expect(next.fluors).toHaveLength(2);
  });

  it("keeps an unrecognized sample type's raw code when the type isn't what changed", () => {
    const p = parsePlateCsv(
      ["# vessel: BR Clear 1x2", "Well,SampleType,Sample,FAM", "A1,wcMystery,S1,GeneA", ""].join(
        "\r\n",
      ),
    );
    expect(p.wells[0]!.sampleType).toBe("other");
    const next = editWells(p, [0], { sample: "S2" });
    expect(next.wells[0]!.sampleTypeRaw).toBe("wcMystery");
  });
});

describe("wellPatch / applyWellPatches", () => {
  it("copies a well onto another one exactly", () => {
    const p = plate();
    const next = applyWellPatches(p, new Map([[4, wellPatch(p.wells[0]!)]]));
    const { index, row, col, label, ...copied } = next.wells[4]!;
    const { index: i0, row: r0, col: c0, label: l0, ...source } = next.wells[0]!;
    expect(copied).toEqual(source);
    expect(label).toBe("B2");
  });

  it("applies a different patch per well, as a multi-well paste does", () => {
    const next = applyWellPatches(
      plate(),
      new Map([
        [1, { sample: "S2" }],
        [2, { sample: "S3" }],
      ]),
    );
    expect(next.wells.map((w) => w.sample)).toEqual(["S1", "S2", "S3", undefined, undefined, undefined]);
  });
});

describe("setPlateFluors", () => {
  it("drops a dye from the plate and from every well", () => {
    const next = setPlateFluors(plate(), ["FAM"]);
    expect(next.fluors).toEqual([{ fluor: "FAM", channel: undefined }]);
    expect(next.wells[0]!.fluors).toEqual([{ fluor: "FAM", target: "GeneA" }]);
    expect(next.dyeCount).toBe(1);
  });

  it("adds a dye no well carries yet, and the format keeps it", () => {
    const next = setPlateFluors(plate(), ["FAM", "HEX", "Cy5"]);
    expect(next.dyeCount).toBe(3);
    expect(roundTrip(next).fluors.map((f) => f.fluor).sort()).toEqual(["Cy5", "FAM", "HEX"]);
  });

  it("ignores blank and duplicate names", () => {
    expect(setPlateFluors(plate(), ["FAM", " ", "FAM", ""]).fluors.map((f) => f.fluor)).toEqual([
      "FAM",
    ]);
  });

  it("empties a well whose only dye is dropped", () => {
    const next = setPlateFluors(plate(), []);
    expect(next.wells[0]!.loaded).toBe(false);
    expect(next.wells[0]!.fluors).toEqual([]);
  });
});

describe("the vessel either-or", () => {
  it("pushes the plate's vessel down when one well gets its own", () => {
    const next = editWells(plate(), [0], { vessel: "BR White" });
    expect(next.plateName).toBe("");
    expect(next.wells.map((w) => w.vessel)).toEqual([
      "BR White",
      "BR Clear",
      "BR Clear",
      "BR Clear",
      "BR Clear",
      "BR Clear",
    ]);
    // …which is the one thing `parsePlateCsv` rejects if it is also stated on the header line.
    expect(roundTrip(next).wells[0]!.vessel).toBe("BR White");
  });

  it("hoists back to the plate when every well agrees again", () => {
    const mixed = editWells(plate(), [0], { vessel: "BR White" });
    const back = editWells(mixed, [0], { vessel: "BR Clear" });
    expect(back.plateName).toBe("BR Clear");
    expect(back.wells.every((w) => w.vessel === undefined)).toBe(true);
    expect(plateToCsv(back)).toBe(plateToCsv(plate()));
  });
});
