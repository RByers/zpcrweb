/**
 * The map-level half of every archive operation (`archive.ts`'s pairing): working on a `.zpcr`
 * that is already unzipped must produce exactly what working on its bytes does.
 *
 * That equivalence is the whole contract the app's exploded storage rests on — a run kept open
 * while it is being written to, zipped only on download (`apps/web/src/state/fileContent.ts`) —
 * so each case here does the same edit both ways and compares what comes back out.
 */
import { describe, expect, it } from "vitest";
import {
  attachPlateToFiles,
  attachPlateToZpcr,
  attachProtocolToFiles,
  attachProtocolToZpcr,
  buildExperimentArchive,
  buildExperimentFiles,
  markExperimentBegun,
  markFilesBegun,
  parseZpcr,
  parseZpcrFiles,
  runArchiveFromRunFiles,
  runProgressFromNames,
  unzipArchive,
  writeZpcrwebSettings,
  writeZpcrwebSettingsToFiles,
  zipArchive,
  zpcrFromRunFiles,
  RUN_BEGUN_MARKER,
  ZPCRWEB_SETTINGS_NAME,
  type ArchiveFiles,
} from "../src/index.js";
import { readSampleBytes } from "./sample.js";

const PROTOCOL = "METHOD CALC;HOTLID 105,30;TEMP 95.0,60;PLATEREAD #h3F;GOTO 2,3;END;";

/** Entry names + bytes, as a comparable value — two archives are the same archive when these
 * match, whatever order the entries were written in. */
function entriesOf(files: ArchiveFiles): [string, string][] {
  return Object.entries(files)
    .map(([name, bytes]): [string, string] => [name, Buffer.from(bytes).toString("base64")])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe("parseZpcrFiles", () => {
  it("decodes an already-unzipped archive exactly as parseZpcr decodes its bytes", () => {
    const bytes = readSampleBytes();
    const fromBytes = parseZpcr(bytes);
    const fromFiles = parseZpcrFiles(unzipArchive(bytes));

    expect(fromFiles.archive.entries.sort()).toEqual(fromBytes.archive.entries.sort());
    expect(fromFiles.metadata).toEqual(fromBytes.metadata);
    expect(fromFiles.reads.length).toBe(fromBytes.reads.length);
    expect(fromFiles.protocolText).toBe(fromBytes.protocolText);
    expect(fromFiles.reads[0]?.wells).toEqual(fromBytes.reads[0]?.wells);
  });
});

describe("archive writers, open vs. zipped", () => {
  const bytes = readSampleBytes();
  const files = unzipArchive(bytes);

  it("attachProtocolToFiles matches attachProtocolToZpcr", () => {
    const open = attachProtocolToFiles(files, { runDefinition: PROTOCOL, name: "Open" });
    const zipped = unzipArchive(attachProtocolToZpcr(bytes, { runDefinition: PROTOCOL, name: "Open" }));
    expect(entriesOf(open)).toEqual(entriesOf(zipped));
    expect(parseZpcrFiles(open).protocolText).toBe(parseZpcr(zipArchive(open)).protocolText);
  });

  it("attachPlateToFiles matches attachPlateToZpcr", () => {
    const plate = { name: "Open Plate.plt.csv", bytes: new TextEncoder().encode("# plateName: x\n") };
    const open = attachPlateToFiles(files, plate);
    const zipped = unzipArchive(attachPlateToZpcr(bytes, plate));
    expect(entriesOf(open)).toEqual(entriesOf(zipped));
  });

  it("writeZpcrwebSettingsToFiles matches writeZpcrwebSettings", () => {
    const settings = { version: 1, experimentName: "Open run" };
    const open = writeZpcrwebSettingsToFiles(files, settings);
    const zipped = unzipArchive(writeZpcrwebSettings(bytes, settings));
    expect(entriesOf(open)).toEqual(entriesOf(zipped));
    expect(parseZpcrFiles(open).archive.text(ZPCRWEB_SETTINGS_NAME)).toContain("Open run");
  });

  it("markFilesBegun matches markExperimentBegun", () => {
    const open = markFilesBegun(files);
    expect(entriesOf(open)).toEqual(entriesOf(unzipArchive(markExperimentBegun(bytes))));
    expect(Object.keys(open)).toContain(RUN_BEGUN_MARKER);
  });

  it("buildExperimentFiles matches buildExperimentArchive", () => {
    const parts = { protocol: { runDefinition: PROTOCOL, name: "P" } };
    expect(entriesOf(buildExperimentFiles(parts))).toEqual(
      entriesOf(unzipArchive(buildExperimentArchive(parts))),
    );
    // A fresh experiment has not begun and has not ended — the state the app keeps open.
    const progress = runProgressFromNames(Object.keys(buildExperimentFiles(parts)));
    expect(progress.begun).toBe(false);
    expect(progress.ended).toBe(false);
  });

  it("leaves the source archive untouched — every writer returns a new map", () => {
    const before = entriesOf(files);
    attachProtocolToFiles(files, { runDefinition: PROTOCOL });
    attachPlateToFiles(files, { name: "p.plt.csv", bytes: new Uint8Array([1]) });
    writeZpcrwebSettingsToFiles(files, { version: 1 });
    markFilesBegun(files);
    expect(entriesOf(files)).toEqual(before);
  });
});

describe("runArchiveFromRunFiles", () => {
  const files = unzipArchive(readSampleBytes());

  it("names a run exactly as zpcrFromRunFiles does, and hands back its files unzipped", () => {
    const open = runArchiveFromRunFiles(files);
    expect(open.name).toBe(zpcrFromRunFiles(files).name);
    expect(entriesOf(open.files)).toEqual(entriesOf(files));
    // The point of it: what it returns parses as the run, with nothing decompressed on the way.
    expect(parseZpcrFiles(open.files).reads.length).toBe(parseZpcr(readSampleBytes()).reads.length);
  });

  it("refuses a folder with no RunInfo.xml, like zpcrFromRunFiles", () => {
    const { "RunInfo.xml": _dropped, ...rest } = files;
    expect(() => runArchiveFromRunFiles(rest)).toThrow(/RunInfo\.xml/);
  });
});
