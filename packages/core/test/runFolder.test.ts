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

  /**
   * A run this app started deposits its own `zpcrweb.json` (`usb/runPlan.ts`), which is both the
   * archive's statement of what the run is called and the evidence that the file name typed in
   * the Instrument view describes *this* run.
   */
  describe("a run this app started", () => {
    const enc = new TextEncoder();
    const started = (experimentName: string) => ({
      ...runFiles,
      "zpcrweb.json": enc.encode(JSON.stringify({ version: 1, experimentName })),
    });

    it("takes the file name the user chose, when it is still that run's name", () => {
      expect(
        zpcrNameFromRunFiles(started("S183-S185 RVP"), {
          experimentName: "S183-S185 RVP",
          fileName: "20260802-S183-S185_RVP",
        }),
      ).toBe("20260802-S183-S185_RVP.zpcr");
    });

    it("derives the name from the deposited one when nothing is staged, or a different run is", () => {
      // The date is the run's own start (`Tue, 21 Jul 2026 05:18:16 GMT`, so the 20th or the 21st
      // depending on where this test runs), not today's — the same run re-pulled tomorrow keeps
      // its name.
      const derived = zpcrNameFromRunFiles(started("S183-S185 RVP"));
      expect(derived).toMatch(/^2026072[01]-S183-S185_RVP\.zpcr$/);
      expect(
        zpcrNameFromRunFiles(started("S183-S185 RVP"), {
          experimentName: "Something else",
          fileName: "something-else",
        }),
      ).toBe(derived);
    });

    it("leaves a run it did not start named by the instrument", () => {
      expect(
        zpcrNameFromRunFiles(runFiles, { experimentName: "mine", fileName: "mine" }),
      ).toBe("20260720_211747_CT019138_Luna_noRT.zpcr");
    });
  });

  it("refuses a set of files with no RunInfo.xml", () => {
    const { "RunInfo.xml": _drop, ...rest } = runFiles;
    expect(() => zpcrFromRunFiles(rest)).toThrow(/RunInfo\.xml/);
  });
});
