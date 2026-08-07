import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  expectedPlateReads,
  parseZpcr,
  parseZpcrArchive,
  runCompleteness,
  zpcrFromRunFiles,
} from "../src/index.js";
import { unzipArchive } from "../src/archive.js";
import {
  readSampleBytes,
  readMultistepBytes,
  readGradientBytes,
} from "./sample.js";

/**
 * Counting a protocol's plate reads, and using that count to recognise a run that stopped short.
 *
 * The whole reason this exists: an aborted run is *not* marked as aborted anywhere in its own
 * files (`usb.md` §7.8, `alf.md` §6), so the read count is the only evidence. That makes a false
 * positive here an accusation against an honest run, which is why the strongest test below is the
 * one that runs every committed sample through and demands an exact match.
 */
const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../../../samples");

describe("expectedPlateReads", () => {
  it("counts a simple cycling loop", () => {
    // Two passes over steps 2–3: TEMP, TEMP, PLATEREAD, GOTO 2,1.
    expect(expectedPlateReads("METHOD CALC;TEMP 95.0,5;TEMP 60.0,5;PLATEREAD #h3F;GOTO 2,1;END")).toBe(2);
  });

  it("counts a qPCR run followed by a melt, resetting the inner loop's counter", () => {
    // The `20230829` sample's own protocol: 40 cycling reads, then a 61-rung melt.
    const melt =
      "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,180;TEMP 95.0,10;TEMP 55.0,30;" +
      "PLATEREAD #h3F;GOTO 3,39;TEMP 65.0,31;TEMP 65.0,5;INC 0.5;RATE 0.5;PLATEREAD #h3F;GOTO 8,60;END";
    expect(expectedPlateReads(melt)).toBe(101);
  });

  it("declines to guess rather than risk accusing an honest run", () => {
    // No PLATEREAD: a thermal-only protocol can't be short.
    expect(expectedPlateReads("METHOD CALC;TEMP 95.0,60;END")).toBeNull();
    // The compact MELT form stands for a whole melt curve whose read count this project has
    // never seen an instance of (`protocol.md` §3.2 marks it *stated*).
    expect(expectedPlateReads("METHOD CALC;MELT 65,95,0.5,5,#h3F;END")).toBeNull();
    // A GOTO pointing off the end of the step list.
    expect(expectedPlateReads("METHOD CALC;PLATEREAD #h3F;GOTO 9,1;END")).toBeNull();
  });

  it("terminates on a self-referential GOTO instead of hanging", () => {
    // `GOTO 2,3` is step 2 jumping to itself: it must exhaust its repeats and move on.
    expect(expectedPlateReads("METHOD CALC;PLATEREAD #h3F;GOTO 2,3;END")).toBe(1);
  });
});

describe("runCompleteness", () => {
  /**
   * The load-bearing assertion. Every committed `.zpcr` is a run that finished, so any mismatch
   * here is the simulation being wrong about a real protocol — not a real incomplete run.
   */
  it("matches the read count exactly on every committed sample", () => {
    const archives = [
      "20190516_122922_CT019138_SHORT_QUALIF.zpcr",
      "20230829_135443_CT019138_SINGLE_STEP_.zpcr",
      "20260720_FirstQualification.zpcr",
      "20260725_GRADIENTTEST.zpcr",
      "20260726_S183-S185_RVP.zpcr",
    ];
    for (const name of archives) {
      const zpcr = parseZpcr(new Uint8Array(readFileSync(resolve(samples, name))));
      const c = runCompleteness(zpcr);
      expect(`${name}: expected ${c.expected}`).toBe(`${name}: expected ${c.actual}`);
      expect(c.incomplete).toBe(false);
    }
  });

  it("reads a complete run as complete", () => {
    for (const bytes of [readSampleBytes(), readMultistepBytes(), readGradientBytes()]) {
      expect(runCompleteness(parseZpcr(bytes)).incomplete).toBe(false);
    }
  });

  it("flags a run whose reads stop short of its protocol", () => {
    // The sample's own files, minus its last two plate reads and with `ended` in place: exactly
    // the shape a cancelled run's archive has.
    const zpcr = parseZpcr(readGradientBytes());
    const short = withoutLastReads(readGradientBytes(), 2);
    const c = runCompleteness(short);
    expect(c.expected).toBe(runCompleteness(zpcr).expected);
    expect(c.actual).toBe(c.expected! - 2);
    expect(c.incomplete).toBe(true);
  });

  it("does not call a run still in progress incomplete", () => {
    // Same truncation, but `ended` removed — this run hasn't stopped short, it hasn't stopped.
    const short = withoutLastReads(readGradientBytes(), 2, { dropEnded: true });
    expect(runCompleteness(short).incomplete).toBe(false);
  });
});

/**
 * A run that never reads the plate — an incubation, a reverse-transcription hold, the block used
 * as a heated surface. Its protocol carries no `PLATEREAD`, so the instrument writes no
 * `.Plateread` files at all, and the archive is a finished run with no fluorescence in it.
 *
 * Built from a committed sample's own archive rather than from scratch, so everything that isn't
 * the plate reads — `RunInfo.xml`, the markers, the calibration set — is exactly what the
 * instrument writes.
 */
describe("a run with no plate reads at all", () => {
  const noReadRun = () => {
    const files = unzipArchive(readGradientBytes());
    for (const name of Object.keys(files)) {
      if (/\.Plateread$/i.test(name)) delete files[name];
    }
    files["ProtocolRunDefinition.txt"] = new TextEncoder().encode(
      "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 50.0,600;TEMP 95.0,120;END;\n",
    );
    return parseZpcrArchive(files);
  };

  it("parses as a run, with nothing to say about curves", () => {
    const zpcr = noReadRun();
    expect(zpcr.reads).toEqual([]);
    expect(zpcr.steps()).toEqual([]);
    // Everything that isn't a reading still decodes — this is a run to look at, not a broken file.
    expect(zpcr.protocolText).toContain("TEMP 50.0,600");
    expect(zpcr.calibrations().length).toBeGreaterThan(0);
    expect(zpcr.runReports().length).toBeGreaterThan(0);
  });

  it("is not accused of stopping short", () => {
    // `expectedPlateReads` declines to answer for a protocol with no PLATEREAD, which is what
    // keeps a run that was never going to read anything from reading as a cancelled one.
    const c = runCompleteness(noReadRun());
    expect(c).toMatchObject({ expected: null, actual: 0, incomplete: false });
  });
});

/** Rebuild a sample's archive with its last `n` plate reads (and optionally `ended`) removed. */
function withoutLastReads(
  bytes: Uint8Array,
  n: number,
  options: { dropEnded?: boolean } = {},
): ReturnType<typeof parseZpcr> {
  const files = unzipArchive(bytes);
  const reads = Object.keys(files)
    .filter((k) => /\.Plateread$/i.test(k))
    .sort();
  for (const name of reads.slice(reads.length - n)) delete files[name];
  if (options.dropEnded) delete files["ended"];
  return parseZpcrArchive(zpcrFromRunFiles(files).archive);
}
