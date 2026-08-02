import { describe, expect, it } from "vitest";
import {
  parseZpcr,
  parseZpcrwebSettings,
  planRun,
  zpcrSeedArchive,
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

const seed = (name = "First Qualification", fileBaseName?: string) =>
  zpcrSeedArchive({
    experimentName: name,
    fileBaseName,
    runDefinition: PROTOCOL,
    protocolName: "Luna noRT",
    plan: planRun({
      runDefinition: PROTOCOL,
      plate,
      name,
      protocolName: "Luna noRT",
      plateName: "S183-S185 RVP.pltd",
    }),
    startedAt: new Date(2026, 7, 2, 9, 30),
  });

describe("zpcrSeedArchive — the file a run gets the moment it starts", () => {
  it("holds the protocol, the plate, the name and the begun marker, and nothing else", () => {
    expect(parseZpcr(seed().bytes).archive.entries.sort()).toEqual(
      [
        "ProtocolName.txt",
        "ProtocolRunDefinition.txt",
        "S183-S185 RVP.plt.csv",
        "begun",
        "zpcrweb.json",
      ].sort(),
    );
  });

  /** The seed is what the run folder will hold, so its entries are the plan's own upload bytes —
   * a `.plt.csv` re-derived here could differ from the one actually deposited. */
  it("copies the plate and the name deposit verbatim from the plan", () => {
    const plan = planRun({
      runDefinition: PROTOCOL,
      plate,
      name: "First Qualification",
      plateName: "S183-S185 RVP.pltd",
    });
    const zpcr = parseZpcr(seed().bytes);
    for (const upload of plan.uploads) {
      if (/\.prcl\.txt$/i.test(upload.name)) continue;
      expect(Array.from(zpcr.archive.bytes(upload.name))).toEqual(Array.from(upload.bytes));
    }
  });

  it("parses as a run with no metadata and no reads, rather than failing", () => {
    const zpcr = parseZpcr(seed().bytes);
    expect(zpcr.reads).toEqual([]);
    expect(zpcr.metadata.identifier).toBe("");
    expect(zpcr.protocolText).toContain("PLATEREAD #h3F");
    expect(zpcr.protocol()?.name).toBe("Luna noRT");
    expect(zpcr.plates()[0]?.pltd.plate?.fluors[0]?.fluor).toBe("FAM");
  });

  it("reads as in progress: begun, not ended", () => {
    const zpcr = parseZpcr(seed().bytes);
    expect(zpcr.archive.entries).toContain("begun");
    expect(zpcr.archive.entries).not.toContain("ended");
  });

  it("carries the experiment name, and is named the way the run watcher will name it", () => {
    expect(parseZpcrwebSettings(parseZpcr(seed().bytes))?.experimentName).toBe(
      "First Qualification",
    );
    expect(seed().name).toBe("20260802-First_Qualification.zpcr");
    expect(seed("First Qualification", "my-run").name).toBe("my-run.zpcr");
  });

  it("refuses to seed an unnamed run", () => {
    expect(() => seed("   ")).toThrow(/experiment name/i);
  });
});
