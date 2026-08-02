import { describe, it, expect } from "vitest";
import { isAlfName, parseAlf, parseRunDefinition, parseZpcr } from "../src/index.js";
import { readGradientBytes, readMultistepBytes, readSampleBytes } from "./sample.js";

/** The whole 3-cycle gradient report from `alf.md` §3, verbatim (CRLF included). */
const EXAMPLE = [
  "GRADIENTTEST*admin*RN050773*A*CFX96*Jul 25, 2026*12:48:11*12:56:53*00:08:42*105.0*25.0**CT019138*CT019138*",
  "METHOD CALC*HOTLID 105,30*VOLUME 25*TEMP 95.0,60*GRAD 55.0,65.0,30*TEMP 55.0,30*PLATEREAD #h3F*GOTO 2,2*END",
  " No errors reported. *0:*False*False*False*False*None*False*",
  "-1*1*1*.00*95.0*60*07/25/2026 12:48:20*False*0*",
  "-1*1*2*.14*55;65*30*07/25/2026 12:52:20*False*0*",
  "-1*1*3*.10*55.0*30*07/25/2026 12:53:07*False*0*",
  "-1*1*4*.02*Plate Read*0*07/25/2026 12:53:46*False*0*",
  "-1*2*2*.88*55;65*30*07/25/2026 12:54:00*False*0*",
  "-1*2*3*.91*55.0*30*07/25/2026 12:54:35*False*0*",
  "-1*2*4*.05*Plate Read*0*07/25/2026 12:55:11*False*0*",
  "-1*3*2*.65*55;65*30*07/25/2026 12:55:24*False*0*",
  "-1*3*3*1.84*55.0*30*07/25/2026 12:56:01*False*0*",
  "-1*3*4*.04*Plate Read*0*07/25/2026 12:56:37*False*0*",
  "-1*0*0*.00*0*0*07/25/2026 12:56:53 Protocol completed.*False*0*",
  "",
].join("\r\n");

describe("parseAlf — the documented example (alf.md §3)", () => {
  const report = parseAlf(EXAMPLE);

  it("parses the 15-field header (§4)", () => {
    expect(report.header).toMatchObject({
      protocolName: "GRADIENTTEST",
      runName: "GRADIENTTEST",
      user: "admin",
      blockSerial: "RN050773",
      blockLetter: "A",
      blockType: "CFX96",
      dateBegan: "Jul 25, 2026",
      timeBegan: "12:48:11",
      timeEnd: "12:56:53",
      totalElapsed: "00:08:42",
      totalElapsedSeconds: 8 * 60 + 42,
      lidTemperatureC: 105,
      sampleVolumeUl: 25,
      sampleId: "",
      cyclerName: "CT019138",
      baseSerial: "CT019138",
      lidPressure: "",
    });
    // The header's own timestamp, read on the local clock (the file states no zone).
    expect(report.header.startedAt?.getHours()).toBe(12);
    expect(report.header.startedAt?.getMinutes()).toBe(48);
    expect(report.header.startedAt?.getFullYear()).toBe(2026);
  });

  it("re-delimits line 2 into the `;` form parseRunDefinition reads (§5)", () => {
    expect(report.runDefinition).toBe(
      "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,60;GRAD 55.0,65.0,30;TEMP 55.0,30;PLATEREAD #h3F;GOTO 2,2;END",
    );
    const program = parseRunDefinition(report.runDefinition);
    expect(program.unknownVerbs).toEqual([]);
    // The step numbers the log's field 3 uses are exactly these (protocol.md §4).
    expect(program.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses the error summary, spaces and all (§6)", () => {
    expect(report.errors).toEqual({
      text: " No errors reported. ",
      rawErrors: "0:",
      powerFailed: false,
      userAborted: false,
      errorOccurred: false,
      emulationUsed: false,
      emulationMode: "None",
      criticalError: false,
      clean: true,
    });
  });

  it("decodes each step line's fields (§7)", () => {
    expect(report.steps).toHaveLength(10);
    expect(report.steps[0]).toMatchObject({
      repeat: 1,
      stepNumber: 1,
      rampTimeField: 0,
      setpoint: { kind: "temperature", tempC: 95 },
      holdSeconds: 60,
      timestampText: "07/25/2026 12:48:20",
      paused: false,
      pausedSeconds: 0,
      sentinel: false,
    });
    // A gradient's `low;high`, and an optical step's literal `Plate Read`.
    expect(report.steps[1]!.setpoint).toEqual({ kind: "gradient", lowC: 55, highC: 65 });
    expect(report.steps[3]!.setpoint).toEqual({ kind: "plateRead" });
    expect(report.steps[3]!.holdSeconds).toBe(0);
  });

  it("times a step by the next line's timestamp, not by its hold (§7.4)", () => {
    // 12:48:20 → 12:52:20 for a nominally 60 s hold: the difference is ramp + settle + hold.
    expect(report.steps[0]!.elapsedSeconds).toBe(240);
    expect(report.steps[0]!.holdSeconds).toBe(60);
    // The last plate read is timed against the sentinel, which stamps the end of the run.
    expect(report.steps.at(-1)!.elapsedSeconds).toBe(16);
  });

  it("numbers plate reads 1:1 with the archive's reads (§7.5)", () => {
    expect(report.steps.filter((s) => s.readIndex !== undefined).map((s) => s.readIndex)).toEqual([
      1, 2, 3,
    ]);
    expect(report.plateReadCount).toBe(3);
  });

  it("splits the sentinel's phrase off its timestamp (§7.3)", () => {
    expect(report.sentinel).toMatchObject({
      repeat: 0,
      stepNumber: 0,
      timestampText: "07/25/2026 12:56:53",
      sentinel: true,
    });
    expect(report.completionPhrase).toBe("Protocol completed.");
    // The sentinel is not a step, and the header's end time is where it lands.
    expect(report.steps.every((s) => !s.sentinel)).toBe(true);
    expect(report.sentinel!.timestampText.endsWith(report.header.timeEnd)).toBe(true);
  });

  it("has nothing to complain about", () => {
    expect(report.problems).toEqual([]);
  });
});

describe("parseAlf — the committed samples", () => {
  it("finds one report per .zpcr and decodes it", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const reports = zpcr.runReports();
    expect(reports).toHaveLength(1);
    expect(isAlfName(reports[0]!.name)).toBe(true);
    const alf = reports[0]!.alf;
    expect(alf.problems).toEqual([]);
    expect(alf.header.baseSerial).toBe(zpcr.metadata.baseSerialNumber);
    expect(alf.header.blockSerial).toBe(zpcr.metadata.raw["AlphaSerialNumber"]);
    expect(alf.errors.clean).toBe(true);
    expect(alf.completionPhrase).toBe("Protocol completed.");
  });

  it("logs exactly as many plate reads as the archive holds (§7.5)", () => {
    for (const bytes of [readSampleBytes(), readMultistepBytes(), readGradientBytes()]) {
      const zpcr = parseZpcr(bytes);
      const alf = zpcr.runReports()[0]!.alf;
      expect(alf.plateReadCount).toBe(zpcr.reads.length);
    }
  });

  it("carries the same protocol the archive's own copy does (§5)", () => {
    for (const bytes of [readSampleBytes(), readMultistepBytes(), readGradientBytes()]) {
      const zpcr = parseZpcr(bytes);
      const alf = zpcr.runReports()[0]!.alf;
      const fromArchive = parseRunDefinition(zpcr.protocolText).directives.map((d) => d.text);
      expect(parseRunDefinition(alf.runDefinition).directives.map((d) => d.text)).toEqual(
        fromArchive,
      );
    }
  });

  it("never logs a GOTO, and skips its number (§7.1)", () => {
    const zpcr = parseZpcr(readGradientBytes());
    const alf = zpcr.runReports()[0]!.alf;
    const gotos = new Set(
      parseRunDefinition(alf.runDefinition)
        .directives.filter((d) => d.verb === "GOTO")
        .map((d) => d.stepNumber),
    );
    expect(gotos.size).toBeGreaterThan(0);
    expect(alf.steps.some((s) => gotos.has(s.stepNumber))).toBe(false);
  });

  it("starts a new stage where the repeat index goes backwards (§7.2)", () => {
    // The multi-step sample cycles, then melts — two loop blocks, so two stages.
    const alf = parseZpcr(readMultistepBytes()).runReports()[0]!.alf;
    const stages = [...new Set(alf.steps.map((s) => s.stage))];
    expect(stages).toEqual([1, 2]);
    // Every stage restarts the repeat count at 1 and the step numbers only move forward.
    for (const stage of stages) {
      const inStage = alf.steps.filter((s) => s.stage === stage);
      expect(inStage[0]!.repeat).toBe(1);
    }
    const firstOfStage2 = alf.steps.find((s) => s.stage === 2)!;
    const lastOfStage1 = alf.steps.filter((s) => s.stage === 1).at(-1)!;
    expect(firstOfStage2.stepNumber).toBeGreaterThan(lastOfStage1.stepNumber);
  });

  it("reads a plate-read line ~12 s before the .Plateread file's own GMT stamp (§7.4)", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const alf = zpcr.runReports()[0]!.alf;
    const first = alf.steps.find((s) => s.readIndex === 1)!;
    // Both clocks as seconds-of-day; the file's is GMT, the report's is instrument-local, so
    // only the sub-minute part is comparable — which is exactly the lead being measured.
    const fileStamp = new Date(zpcr.reads[0]!.timestamp);
    const lead =
      ((fileStamp.getUTCSeconds() - first.startedAt!.getSeconds() + 60) % 60) +
      60 * ((fileStamp.getUTCMinutes() - first.startedAt!.getMinutes() + 60) % 60);
    expect(lead).toBeGreaterThan(5);
    expect(lead).toBeLessThan(30);
  });
});

describe("parseAlf — malformed input", () => {
  it("reports a short line rather than throwing", () => {
    const report = parseAlf("A*B*\r\nMETHOD CALC*END\r\n No errors. *0:*False*\r\n-1*1*1*\r\n");
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.header.protocolName).toBe("A");
    expect(report.steps).toHaveLength(1);
    expect(report.sentinel).toBeNull();
  });

  it("takes the basename of a touchscreen-started run's protocol path (§4)", () => {
    const report = parseAlf("\\Storage Card\\Recent\\Luna_noRT**RN050773*A*CFX96*");
    expect(report.header.protocolName).toBe("\\Storage Card\\Recent\\Luna_noRT");
    expect(report.header.runName).toBe("Luna_noRT");
    expect(report.header.user).toBe("");
  });

  it("treats anything but the literal True as false (§6)", () => {
    const report = parseAlf("N*\r\nEND\r\n err *3:5:*true*TRUE*True*x**False*\r\n");
    expect(report.errors.powerFailed).toBe(false);
    expect(report.errors.userAborted).toBe(false);
    expect(report.errors.errorOccurred).toBe(true);
    expect(report.errors.clean).toBe(false);
  });
});
