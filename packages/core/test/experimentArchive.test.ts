import { describe, expect, it } from "vitest";
import {
  attachProtocol,
  buildExperimentArchive,
  formatRunDefinitionText,
  markExperimentBegun,
  parseZpcrArchive,
  plateToCsv,
  ProtocolBuilder,
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
    const zpcr = parseZpcrArchive(buildExperimentArchive({}));
    expect(zpcr.protocolText).toBe("");
    expect(zpcr.protocol()).toBeUndefined();
    expect(zpcr.plates()).toEqual([]);
    expect(zpcr.reads).toEqual([]);
  });

  it("is pending: no begun marker, no reads", () => {
    const zpcr = parseZpcrArchive(buildExperimentArchive({}));
    expect(runProgressFromNames(zpcr.archive.entries).begun).toBe(false);
    expect(zpcr.reads.length).toBe(0);
  });

  it("carries a given protocol's text and name", () => {
    const zpcr = parseZpcrArchive(
      buildExperimentArchive({ protocol: { runDefinition: PROTOCOL, name: "Luna noRT" } }),
    );
    expect(zpcr.protocolText).toContain("PLATEREAD #h3F");
    expect(zpcr.protocol()?.name).toBe("Luna noRT");
  });

  it("carries a given plate, renaming a bare .csv upload the same way attachPlateToZpcr does", () => {
    const csv = plateToCsv(plate);
    const zpcr = parseZpcrArchive(
      buildExperimentArchive({
        plate: { name: "MyPlate.csv", bytes: new TextEncoder().encode(csv) },
      }),
    );
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    expect(plates[0]!.name).toBe("MyPlate.plt.csv");
    expect(plates[0]!.pltd.plate?.fluors[0]?.fluor).toBe("FAM");
  });

  it("writes no begun marker, so it reads as never started", () => {
    const zpcr = parseZpcrArchive(
      buildExperimentArchive({ protocol: { runDefinition: PROTOCOL } }),
    );
    expect(zpcr.archive.entries).not.toContain("begun");
    expect(runProgressFromNames(zpcr.archive.entries).begun).toBe(false);
  });

  /**
   * An experiment created from scratch holds *nothing* — that is the state it is for, and claiming
   * otherwise is what the earlier zero-length `ProtocolRunDefinition.txt` did: the archive listed a
   * protocol entry it did not have. Its own settings entry is what keeps it parseable instead
   * (`zpcr.ts`), by presence rather than content.
   */
  it("holds no protocol and no plate when given neither, and still parses", () => {
    const zpcr = parseZpcrArchive(buildExperimentArchive({}));
    expect(zpcr.archive.entries).toEqual(["zpcrweb.json"]);
    expect(zpcr.protocolText).toBe("");
    expect(zpcr.protocol()).toBeUndefined();
    expect(zpcr.plates()).toEqual([]);
    expect(zpcr.reads).toEqual([]);
  });

  it("…and a ZIP with none of the four identifying entries is still refused", () => {
    // The guard `zpcrweb.json` was added to must still reject anything renamed `.zpcr`.
    expect(() => parseZpcrArchive({ "notes.txt": new TextEncoder().encode("hi") })).toThrow(
      /Not a valid \.zpcr archive/,
    );
  });
});

describe("markExperimentBegun — starting a pending experiment in place", () => {
  it("adds the begun marker without touching the rest of the archive", () => {
    const before = buildExperimentArchive({ protocol: { runDefinition: PROTOCOL } });
    const after = parseZpcrArchive(markExperimentBegun(before));
    expect(runProgressFromNames(after.archive.entries).begun).toBe(true);
    expect(after.protocolText).toBe(parseZpcrArchive(before).protocolText);
  });
});

/**
 * The protocol an experiment carries has to come back out **editable**.
 *
 * `Zpcr.protocolText` is the archive entry verbatim — unlike a standalone `.prcl.txt`, whose text the
 * app normalizes through `parseRunDefinitionText` on load — so whatever these writers put in the
 * entry is what `ProtocolBuilder` is handed. Writing the `.prcl.txt` file form here (its
 * `[ProtocolRunDefinition version …]` header included) therefore broke editing for every experiment:
 * the builder refused the header as an unrecognized directive and the Protocol tab reported the
 * protocol as not editable. No instrument-written `ProtocolRunDefinition.txt` carries that header.
 */
describe("an experiment's protocol entry is the form the instrument writes", () => {
  const editable = (text: string) => {
    // Exactly what the app's Protocol tab does with a pending experiment's protocol.
    ProtocolBuilder.fromRunDefinition(text);
    return true;
  };

  it("has no .prcl.txt version header, and is editable", () => {
    const zpcr = parseZpcrArchive(buildExperimentArchive({ protocol: { runDefinition: PROTOCOL } }));
    expect(zpcr.protocolText).not.toContain("[ProtocolRunDefinition");
    expect(zpcr.protocolText.trim()).toBe(PROTOCOL);
    expect(editable(zpcr.protocolText)).toBe(true);
  });

  it("…likewise after attaching a protocol, so an attach doesn't break editing either", () => {
    const bare = buildExperimentArchive({});
    const zpcr = parseZpcrArchive(attachProtocol(bare, { runDefinition: PROTOCOL }));
    expect(zpcr.protocolText).not.toContain("[ProtocolRunDefinition");
    expect(editable(zpcr.protocolText)).toBe(true);
  });

  it("accepts a headered .prcl.txt body as input and strips it, so either form may be passed", () => {
    const asFile = formatRunDefinitionText(PROTOCOL);
    expect(asFile).toContain("[ProtocolRunDefinition");
    const zpcr = parseZpcrArchive(buildExperimentArchive({ protocol: { runDefinition: asFile } }));
    expect(zpcr.protocolText.trim()).toBe(PROTOCOL);
    expect(editable(zpcr.protocolText)).toBe(true);
  });

  it("survives the edit → write → re-read cycle the editor drives, unchanged", () => {
    // The editor hands back `builder.toRunDefinition()`; writing that must not re-wrap it, or the
    // second mount would fail where the first succeeded.
    const zpcr = parseZpcrArchive(buildExperimentArchive({ protocol: { runDefinition: PROTOCOL } }));
    const edited = ProtocolBuilder.fromRunDefinition(zpcr.protocolText).toRunDefinition();
    const again = parseZpcrArchive(attachProtocol(buildExperimentArchive({}), { runDefinition: edited }));
    expect(again.protocolText).not.toContain("[ProtocolRunDefinition");
    expect(editable(again.protocolText)).toBe(true);
    // And a further round trip is a fixed point rather than drifting.
    expect(
      ProtocolBuilder.fromRunDefinition(again.protocolText).toRunDefinition(),
    ).toBe(edited);
  });
});
