/**
 * The archive-level API: every function that writes a `.zpcr` takes a {@link ZpcrArchive} and
 * returns a new one, and zipping is a separate step nobody but the caller takes.
 *
 * Three things have to hold for that to be safe, and this file checks each:
 *
 * 1. **The two entry points agree.** An archive parsed directly says exactly what it says after a
 *    round trip through a real ZIP — otherwise "hold it open" and "write it to disk" would be two
 *    different runs.
 * 2. **Writers don't mutate.** They return a new archive; the one passed in is untouched, since
 *    callers hold archives across edits (the app holds one for every run in progress).
 * 3. **Writers compose.** Two edits in a row cost no ZIP at all — the reason the byte-level
 *    wrappers were removed rather than kept alongside.
 */
import { describe, expect, it } from "vitest";
import {
  attachPlate,
  attachProtocol,
  buildExperimentArchive,
  markExperimentBegun,
  parseZpcr,
  parseZpcrArchive,
  runProgressFromNames,
  unzipArchive,
  writeZpcrwebSettings,
  zipArchive,
  zpcrFromRunFiles,
  RUN_BEGUN_MARKER,
  ZPCRWEB_SETTINGS_NAME,
  type ZpcrArchive,
} from "../src/index.js";
import { readSampleArchive, readSampleBytes } from "./sample.js";

const PROTOCOL = "METHOD CALC;HOTLID 105,30;TEMP 95.0,60;PLATEREAD #h3F;GOTO 2,3;END;";

/** Entry names + bytes, as a comparable value — two archives are the same archive when these
 * match, whatever order the entries were written in. */
function entriesOf(archive: ZpcrArchive): [string, string][] {
  return Object.entries(archive)
    .map(([name, bytes]): [string, string] => [name, Buffer.from(bytes).toString("base64")])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe("parseZpcrArchive", () => {
  it("decodes an archive exactly as parseZpcr decodes the same archive's bytes", () => {
    const fromBytes = parseZpcr(readSampleBytes());
    const fromArchive = parseZpcrArchive(readSampleArchive());

    expect(fromArchive.archive.entries.sort()).toEqual(fromBytes.archive.entries.sort());
    expect(fromArchive.metadata).toEqual(fromBytes.metadata);
    expect(fromArchive.reads.length).toBe(fromBytes.reads.length);
    expect(fromArchive.protocolText).toBe(fromBytes.protocolText);
    expect(fromArchive.reads[0]?.wells).toEqual(fromBytes.reads[0]?.wells);
  });

  it("survives a round trip through a real ZIP — an edit reads the same held open or written out", () => {
    const edited = attachProtocol(readSampleArchive(), { runDefinition: PROTOCOL, name: "Held" });
    const written = unzipArchive(zipArchive(edited));

    expect(entriesOf(written)).toEqual(entriesOf(edited));
    expect(parseZpcr(zipArchive(edited)).protocolText).toBe(parseZpcrArchive(edited).protocolText);
  });
});

describe("archive writers", () => {
  it("attachPlate replaces the plate entry and leaves the rest alone", () => {
    const before = readSampleArchive();
    const plate = { name: "Open Plate.plt.csv", bytes: new TextEncoder().encode("# plateName: x\n") };
    const after = attachPlate(before, plate);

    expect(Object.keys(after)).toContain("Open Plate.plt.csv");
    expect(after["RunInfo.xml"]).toBe(before["RunInfo.xml"]); // by reference: copied, not rebuilt
  });

  it("writeZpcrwebSettings adds the entry the run's own settings live in", () => {
    const after = writeZpcrwebSettings(readSampleArchive(), {
      version: 1,
      experimentName: "Open run",
    });
    expect(parseZpcrArchive(after).archive.text(ZPCRWEB_SETTINGS_NAME)).toContain("Open run");
  });

  it("markExperimentBegun adds the marker that ends the pending state", () => {
    const after = markExperimentBegun(buildExperimentArchive({}));
    expect(Object.keys(after)).toContain(RUN_BEGUN_MARKER);
    expect(runProgressFromNames(Object.keys(after)).begun).toBe(true);
  });

  it("leave the archive they were given untouched — each returns a new one", () => {
    const archive = readSampleArchive();
    const before = entriesOf(archive);
    attachProtocol(archive, { runDefinition: PROTOCOL });
    attachPlate(archive, { name: "p.plt.csv", bytes: new Uint8Array([1]) });
    writeZpcrwebSettings(archive, { version: 1 });
    markExperimentBegun(archive);
    expect(entriesOf(archive)).toEqual(before);
  });

  it("compose — a whole experiment is built, named and started with one zip at the end", () => {
    // What the app's "new experiment → name it → start it" does, and what the removed byte-level
    // wrappers would have made cost three zips and two unzips.
    const started = markExperimentBegun(
      writeZpcrwebSettings(
        buildExperimentArchive({ protocol: { runDefinition: PROTOCOL, name: "Chained" } }),
        { version: 1, experimentName: "Chained" },
      ),
    );
    const zpcr = parseZpcr(zipArchive(started));

    expect(zpcr.protocolText).toContain("PLATEREAD");
    expect(runProgressFromNames(zpcr.archive.entries).begun).toBe(true);
    expect(zpcr.archive.text(ZPCRWEB_SETTINGS_NAME)).toContain("Chained");
  });
});

describe("zpcrFromRunFiles", () => {
  it("hands a run directory back as the archive it already is, with the name it should carry", () => {
    const files = readSampleArchive();
    const run = zpcrFromRunFiles(files);

    expect(run.name).toBe("20260720_211747_CT019138_Luna_noRT.zpcr");
    expect(run.archive).toBe(files); // the same archive, not a copy and not a repack
    expect(parseZpcrArchive(run.archive).reads.length).toBe(parseZpcr(readSampleBytes()).reads.length);
  });

  it("refuses a folder with no RunInfo.xml, rather than yielding an unopenable archive", () => {
    const { "RunInfo.xml": _dropped, ...rest } = readSampleArchive();
    expect(() => zpcrFromRunFiles(rest)).toThrow(/RunInfo\.xml/);
  });
});
