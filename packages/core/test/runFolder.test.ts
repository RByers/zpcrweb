import { describe, it, expect } from "vitest";
import {
  zipArchive,
  zpcrFromRunFiles,
  zpcrNameFromRunFiles,
  runFilesToFetch,
  runIdentityFileNames,
  isSameRun,
  parseZpcr,
} from "../src/index.js";
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
    // Through a real ZIP: the archive it hands back is what a caller writes to disk with
    // `zipArchive`, and that file has to be the run the folder held.
    const rebuilt = parseZpcr(zipArchive(zpcrFromRunFiles(runFiles).archive));
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

    it("keeps the path of a file the caller names by one, and its own extension", () => {
      // The app names a file opened out of a granted folder by its path within that folder, so a
      // run started from one has to stay *that* file — its snapshots update it rather than landing
      // beside it under a bare name.
      expect(
        zpcrNameFromRunFiles(started("S183-S185 RVP"), {
          experimentName: "S183-S185 RVP",
          fileName: "Lab runs/2026-08/20260802-S183-S185_RVP.zpcr",
        }),
      ).toBe("Lab runs/2026-08/20260802-S183-S185_RVP.zpcr");
      expect(
        zpcrNameFromRunFiles(started("S183-S185 RVP"), {
          experimentName: "S183-S185 RVP",
          fileName: "Lab runs/2026-08/20260802-S183-S185_RVP",
        }),
      ).toBe("Lab runs/2026-08/20260802-S183-S185_RVP.zpcr");
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

/**
 * What a caller following a live run downloads, and what it doesn't — the rules that let the run's
 * own file be the only record of what has already been fetched (`useRunWatch`).
 */
describe("what a run's archive still needs from the folder", () => {
  const runFiles = unzipArchive(readSampleBytes());
  const names = Object.keys(runFiles);
  const plateName = names.find((n) => /\.(pltd|plt\.csv)$/i.test(n))!;
  const readName = names.find((n) => /\.Plateread$/i.test(n))!;

  it("fetches everything when nothing is held", () => {
    expect(runFilesToFetch(null, names)).toEqual(names);
    expect(runFilesToFetch(undefined, names)).toEqual(names);
  });

  it("fetches only what the archive is missing", () => {
    const { [readName]: _missing, ...held } = runFiles;
    expect(runFilesToFetch(held, names)).toEqual([readName]);
    expect(runFilesToFetch(runFiles, names)).toEqual([]);
  });

  it("re-reads the files the instrument rewrites, when asked", () => {
    const rewritten = new Set(["runlog.xml", "lastplatereadstatus"]);
    const wanted = runFilesToFetch(runFiles, names, rewritten);
    expect(wanted.map((n) => n.toLowerCase()).sort()).toEqual([...rewritten].sort());
  });

  it("leaves a replaced plate alone — it does not re-fetch the folder's copy", () => {
    // What the app's archive looks like after the user swaps the plate of a run in progress: the
    // folder's own plate is gone from it, replaced by one under a name the folder has never
    // heard of.
    const { [plateName]: _replaced, ...rest } = runFiles;
    const swapped = { ...rest, "corrected.plt.csv": new Uint8Array([1, 2, 3]) };
    expect(runFilesToFetch(swapped, names)).toEqual([]);
    // Still true on the end-of-run pass, which is where the whole run used to be re-read.
    expect(runFilesToFetch(swapped, names, new Set(["runlog.xml"]))).toEqual(["runlog.xml"]);
  });

  it("does fetch the plate for an archive that has none", () => {
    const { [plateName]: _none, ...plateless } = runFiles;
    expect(runFilesToFetch(plateless, names)).toEqual([plateName]);
  });
});

describe("is the folder still holding the run we have?", () => {
  const runFiles = unzipArchive(readSampleBytes());

  it("matches an archive of the same run", () => {
    expect(isSameRun(runFiles, runFiles)).toBe(true);
    expect(isSameRun({ ...runFiles }, { ...runFiles })).toBe(true);
  });

  it("refuses a different run, and anything with no RunInfo.xml to compare", () => {
    const other = { ...runFiles, "RunInfo.xml": new TextEncoder().encode("<RunInfo/>") };
    expect(isSameRun(other, runFiles)).toBe(false);
    const { "RunInfo.xml": _drop, ...rest } = runFiles;
    expect(isSameRun(rest, runFiles)).toBe(false);
    expect(isSameRun(runFiles, rest)).toBe(false);
    expect(isSameRun(null, runFiles)).toBe(false);
  });

  it("names the two files that answer the question", () => {
    expect(runIdentityFileNames(Object.keys(runFiles))).toEqual(["RunInfo.xml"]);
    expect(runIdentityFileNames(["zpcrweb.json", "Read00001.Plateread", "RunInfo.xml"])).toEqual([
      "zpcrweb.json",
      "RunInfo.xml",
    ]);
  });
});
