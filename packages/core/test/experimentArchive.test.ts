import { describe, expect, it } from "vitest";
import {
  buildExperimentArchive,
  markExperimentBegun,
  parseZpcr,
  plateToCsv,
  runProgressFromNames,
  type PlateDefinition,
} from "../src/index.js";

const PROTOCOL =
  "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,60;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,44;END;";

const plate: PlateDefinition = {
  plateName: "BR Clear",
  rows: 8,
  columns: 12,
  dyeCount: 1,
  scanMode: "AllChannelsScan",
  plateType: "BR Clear",
  standardUnits: "copy number",
  fluors: [{ fluor: "FAM", channel: 0 }],
  targets: [],
  samples: [],
  wells: [],
  meta: {},
};

describe("buildExperimentArchive — a bare .zpcr for a pending experiment", () => {
  it("with neither part still parses as a run with no protocol and no plate", () => {
    const zpcr = parseZpcr(buildExperimentArchive({}));
    expect(zpcr.protocolText).toBe("");
    expect(zpcr.protocol()).toBeUndefined();
    expect(zpcr.plates()).toEqual([]);
    expect(zpcr.reads).toEqual([]);
  });

  it("is pending: no begun marker, no reads", () => {
    const zpcr = parseZpcr(buildExperimentArchive({}));
    expect(runProgressFromNames(zpcr.archive.entries).begun).toBe(false);
    expect(zpcr.reads.length).toBe(0);
  });

  it("carries a given protocol's text and name", () => {
    const zpcr = parseZpcr(
      buildExperimentArchive({ protocol: { runDefinition: PROTOCOL, name: "Luna noRT" } }),
    );
    expect(zpcr.protocolText).toContain("PLATEREAD #h3F");
    expect(zpcr.protocol()?.name).toBe("Luna noRT");
  });

  it("carries a given plate, renaming a bare .csv upload the same way attachPlateToZpcr does", () => {
    const csv = plateToCsv(plate);
    const zpcr = parseZpcr(
      buildExperimentArchive({
        plate: { name: "MyPlate.csv", bytes: new TextEncoder().encode(csv) },
      }),
    );
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    expect(plates[0]!.name).toBe("MyPlate.plt.csv");
    expect(plates[0]!.pltd.plate?.fluors[0]?.fluor).toBe("FAM");
  });

  it("writes no begun marker and no zpcrweb.json, unlike a started run", () => {
    const zpcr = parseZpcr(
      buildExperimentArchive({ protocol: { runDefinition: PROTOCOL } }),
    );
    expect(zpcr.archive.entries).not.toContain("begun");
    expect(zpcr.archive.entries).not.toContain("zpcrweb.json");
  });
});

describe("markExperimentBegun — starting a pending experiment in place", () => {
  it("adds the begun marker without touching the rest of the archive", () => {
    const before = buildExperimentArchive({ protocol: { runDefinition: PROTOCOL } });
    const after = parseZpcr(markExperimentBegun(before));
    expect(runProgressFromNames(after.archive.entries).begun).toBe(true);
    expect(after.protocolText).toBe(parseZpcr(before).protocolText);
  });
});
