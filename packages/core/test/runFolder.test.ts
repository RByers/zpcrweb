import { describe, it, expect } from "vitest";
import { zpcrFromRunFiles, zpcrNameFromRunFiles, parseZpcr } from "../src/index.js";
import { unzipArchive } from "../src/archive.js";
import { readSampleBytes } from "./sample.js";

/**
 * The premise the assembler rests on: a `.zpcr` is nothing but a ZIP of a run directory's files.
 * Unzipping a real sample and zipping it straight back is the closest thing to a live instrument
 * this suite can have — the entries are exactly what `CurrentRun` holds.
 */
describe("zpcrFromRunFiles", () => {
  const runFiles = unzipArchive(readSampleBytes());

  it("round-trips a sample's own files back into a parseable .zpcr", () => {
    const { bytes } = zpcrFromRunFiles(runFiles);
    const rebuilt = parseZpcr(bytes);
    const original = parseZpcr(readSampleBytes());

    expect(rebuilt.archive.entries.sort()).toEqual(original.archive.entries.sort());
    expect(rebuilt.reads.length).toBe(original.reads.length);
    expect(rebuilt.metadata.identifier).toBe(original.metadata.identifier);
    // Byte-for-byte on the payload that matters, not just a successful parse.
    for (const name of original.archive.entries) {
      expect(Array.from(rebuilt.archive.bytes(name))).toEqual(Array.from(original.archive.bytes(name)));
    }
  });

  it("names the archive after RunInfo.xml's DataFile", () => {
    expect(zpcrFromRunFiles(runFiles).name).toBe("20260720_211747_CT019138_Luna_noRT.zpcr");
  });

  it("falls back when DataFile is absent, empty, or a full path", () => {
    const enc = new TextEncoder();
    const runInfo = (dataFile: string) =>
      enc.encode(
        `<RunInfo><KeyValuePairs><Key>DataFile</Key><Value>${dataFile}</Value></KeyValuePairs></RunInfo>`,
      );
    expect(zpcrNameFromRunFiles({ "RunInfo.xml": runInfo("") })).toBe("CurrentRun.zpcr");
    expect(zpcrNameFromRunFiles({})).toBe("CurrentRun.zpcr");
    expect(zpcrNameFromRunFiles({ "RunInfo.xml": runInfo("\\Storage Card\\CurrentRun\\r.zpcr") })).toBe(
      "r.zpcr",
    );
    // A name the instrument wrote without the extension still lands as a `.zpcr`, since that is
    // what the app's own file-kind check keys on.
    expect(zpcrNameFromRunFiles({ "RunInfo.xml": runInfo("plainname") })).toBe("plainname.zpcr");
  });

  it("refuses a set of files with no RunInfo.xml", () => {
    const { "RunInfo.xml": _drop, ...rest } = runFiles;
    expect(() => zpcrFromRunFiles(rest)).toThrow(/RunInfo\.xml/);
  });
});
