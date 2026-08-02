import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cfxFileCrc,
  checkRunPlan,
  formatCfxFileCrc,
  parsePltd,
  parseRunDefinition,
  planRun,
  runProgressFromNames,
  type PlateDefinition,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sample = (name: string) => readFileSync(resolve(here, "../../../samples", name));

describe("cfxFileCrc (usb.md §7.4)", () => {
  /**
   * The reference measurement. `QuickPlate_96 wells_All Channels.pltd` is committed here and is
   * byte-identical to the file the `usb-run` capture uploaded, for which CFX Manager announced
   * `05672` and the instrument echoed `5672` back through `GETFILECRC` — so this pins the
   * algorithm against both ends of a real exchange, not just against itself.
   */
  it("matches the checksum the capture sent for the sample .pltd", () => {
    expect(cfxFileCrc(sample("QuickPlate_96 wells_All Channels.pltd"))).toBe(5672);
  });

  it("zero-pads to five digits for the wire, as the capture does", () => {
    expect(formatCfxFileCrc(5672)).toBe("05672");
    expect(formatCfxFileCrc(24700)).toBe("24700");
  });

  it("is empty-safe and stays inside 16 bits", () => {
    expect(cfxFileCrc(new Uint8Array())).toBe(0);
    const big = new Uint8Array(5000).map((_, i) => (i * 37) & 0xff);
    expect(cfxFileCrc(big)).toBeGreaterThanOrEqual(0);
    expect(cfxFileCrc(big)).toBeLessThanOrEqual(0xffff);
  });

  /**
   * The byte order, pinned to hardware (`usb.md` §9.2).
   *
   * Every file the captures upload is odd-length, and on an odd length this algorithm is
   * indistinguishable from the degenerate CRC-16 with `x^16 + 1` — the two swap halves only on
   * even lengths. These five even-length payloads were uploaded to a real C1000 (CT019138) and
   * the checksums below are what `GETFILECRC` answered, so they are the measurement that rules
   * the shift-register reading out. The capture's own files cannot: they pass either way.
   */
  it("matches what real hardware returned for even-length files", () => {
    const probe = (n: number) =>
      new Uint8Array(n).map((_, i) => (i * 37 + n * 101 + 13) & 0xff);
    expect(cfxFileCrc(probe(2))).toBe(55292);
    expect(cfxFileCrc(probe(4))).toBe(19158);
    expect(cfxFileCrc(probe(16))).toBe(208);
    expect(cfxFileCrc(probe(100))).toBe(19126);
    expect(cfxFileCrc(probe(1000))).toBe(36936);
  });

  /**
   * The same probes under the retired hypothesis, so a regression that silently flips the halves
   * back fails here with a name that says what happened rather than just a changed number.
   */
  it("is not the shift-register CRC-16 the command names suggest", () => {
    const shiftRegister = (bytes: Uint8Array) => {
      let crc = 0;
      for (const b of bytes) {
        crc ^= b;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) | 0x8000 : crc >>> 1;
      }
      return crc & 0xffff;
    };
    const even = new Uint8Array(100).map((_, i) => (i * 37 + 100 * 101 + 13) & 0xff);
    expect(shiftRegister(even)).toBe(46666);
    expect(cfxFileCrc(even)).not.toBe(shiftRegister(even));
  });
});

/** A plate using exactly the given 1-based channels, and nothing else the checks read. */
function plateUsing(channels: (number | undefined)[]): PlateDefinition {
  return {
    plateName: "BR Clear",
    rows: 8,
    columns: 12,
    dyeCount: channels.length,
    scanMode: "AllChannelsScan",
    plateType: "BR Clear",
    standardUnits: "copy number",
    fluors: channels.map((c, i) => ({
      fluor: `Dye${i + 1}`,
      ...(c === undefined ? {} : { channel: c - 1 }),
    })),
    targets: [],
    samples: [],
    wells: [],
    meta: {},
  };
}

const ALL_CHANNELS = "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,60;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,44;END;";
const FAST_SCAN = "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,60;TEMP 60.0,30;PLATEREAD #h81;GOTO 2,44;END;";

describe("checkRunPlan — PLATEREAD against the plate", () => {
  it("passes a six-channel mask reading a plate that uses channel 1 only, with a note", () => {
    const checks = checkRunPlan(parseRunDefinition(ALL_CHANNELS), plateUsing([1]));
    expect(checks.some((c) => c.severity === "error")).toBe(false);
    expect(checks.map((c) => c.code)).toContain("channels-idle");
  });

  it("says nothing about idle channels when the plate uses a subset with no tested mask", () => {
    // Channels 1–3 have no narrower mask this project has exercised, so all 6 is what to send.
    const checks = checkRunPlan(parseRunDefinition(ALL_CHANNELS), plateUsing([1, 2, 3]));
    expect(checks).toEqual([]);
  });

  it("errors when the mask omits a channel the plate uses", () => {
    // #h81 reads channel 1 only; this plate also carries dyes on 2 and 4.
    const checks = checkRunPlan(parseRunDefinition(FAST_SCAN), plateUsing([1, 2, 4]));
    const bad = checks.find((c) => c.code === "channels-unread");
    expect(bad?.severity).toBe("error");
    expect(bad?.message).toMatch(/channels 2, 4/);
  });

  it("is clean when the mask covers exactly the plate's channels", () => {
    const checks = checkRunPlan(parseRunDefinition(FAST_SCAN), plateUsing([1]));
    expect(checks).toEqual([]);
  });

  it("errors on a protocol that never reads the plate", () => {
    const noRead = "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,60;GOTO 1,10;END;";
    const checks = checkRunPlan(parseRunDefinition(noRead), plateUsing([1]));
    expect(checks.find((c) => c.code === "no-plate-read")?.severity).toBe("error");
  });

  it("warns, but does not block, when a fluor's channel is unknown", () => {
    const checks = checkRunPlan(parseRunDefinition(ALL_CHANNELS), plateUsing([1, undefined]));
    expect(checks.find((c) => c.code === "channels-unknown")?.severity).toBe("warning");
    expect(checks.some((c) => c.severity === "error")).toBe(false);
  });

  it("accepts the real sample plate against the mask its own run used", () => {
    const plate = parsePltd(sample("QuickPlate_96 wells_All Channels.pltd")).plate;
    // The committed .pltd is encrypted; without a password there is no plate to check, and the
    // point of this case is only that a real all-channels plate doesn't trip the channel rules.
    if (!plate) return;
    const checks = checkRunPlan(parseRunDefinition(ALL_CHANNELS), plate);
    expect(checks.some((c) => c.code === "channels-unread")).toBe(false);
  });
});

describe("planRun", () => {
  const plan = () =>
    planRun({ runDefinition: ALL_CHANNELS, plate: plateUsing([1]), name: "My Run/2" });

  it("types the protocol one directive per command line, after PROTOCOL", () => {
    expect(plan().commands).toEqual([
      "PROTOCOL 'PCRUN'",
      "METHOD CALC",
      "HOTLID 105,30",
      "VOLUME 25",
      "TEMP 95.0,60",
      "TEMP 60.0,30",
      "PLATEREAD #h3F",
      "GOTO 2,44",
      "END",
    ]);
  });

  it("builds the RemoteRun line with the run's name and method", () => {
    expect(plan().remoteRun).toBe(
      'RemoteRun "A","True","False","My Run_2","admin","","True","CALC"',
    );
  });

  it("uploads the protocol and plate as this project's own plaintext formats", () => {
    const uploads = plan().uploads;
    expect(new TextDecoder().decode(uploads[0]!.bytes)).toContain("PLATEREAD #h3F;");
    expect(new TextDecoder().decode(uploads[1]!.bytes)).toContain("# zpcrweb plate definition");
  });

  /**
   * Protocols, plates and experiments are three namespaces: the first two are reused across runs
   * and arrive with names of their own, so the deposited copies keep them and only `RemoteRun`
   * carries the run's name.
   */
  it("names the uploads after the protocol and the plate, never after the run", () => {
    const uploads = planRun({
      runDefinition: ALL_CHANNELS,
      plate: plateUsing([1]),
      name: "My Run/2",
      protocolName: "Luna noRT",
      plateName: "S183-S185 RVP.pltd",
    }).uploads;
    expect(uploads.map((u) => u.name)).toEqual(["Luna noRT.prcl.txt", "S183-S185 RVP.plt.csv"]);
    expect(uploads[0]!.path).toBe("\\Storage Card\\CurrentRun\\Luna noRT.prcl.txt");
  });

  it("falls back to the plate's own identity, then to generic names", () => {
    const identified = planRun({
      runDefinition: ALL_CHANNELS,
      plate: { ...plateUsing([1]), identityKey: "Qualification_Plate_96.pltd" },
      name: "My Run/2",
    }).uploads;
    expect(identified.map((u) => u.name)).toEqual([
      "protocol.prcl.txt",
      "Qualification_Plate_96.plt.csv",
    ]);

    const anonymous = plan().uploads;
    expect(anonymous.map((u) => u.name)).toEqual(["protocol.prcl.txt", "plate.plt.csv"]);
  });

  it("sanitizes an upload name the way it sanitizes the run's", () => {
    const uploads = planRun({
      runDefinition: ALL_CHANNELS,
      plate: plateUsing([1]),
      protocolName: 'RVP "fast";v2/3',
      plateName: "  ",
    }).uploads;
    // `";` is one run of operand-syntax characters, so it collapses to a single `_`.
    expect(uploads.map((u) => u.name)).toEqual(["RVP _fast_v2_3.prcl.txt", "plate.plt.csv"]);
  });

  it("refuses to be startable when a check is an error", () => {
    const bad = planRun({ runDefinition: FAST_SCAN, plate: plateUsing([1, 3]), name: "x" });
    expect(bad.startable).toBe(false);
  });

  it("falls back to a usable name when given none", () => {
    const anon = planRun({ runDefinition: ALL_CHANNELS, plate: plateUsing([1]) });
    expect(anon.name).toBe("zpcrweb");
  });
});

describe("runProgressFromNames — the begun/ended markers", () => {
  it("reads a run still going", () => {
    const p = runProgressFromNames(["RunInfo.xml", "begun", "Read00001.Plateread"]);
    expect(p).toMatchObject({ begun: true, ended: false, inProgress: true, plateReads: 1 });
  });

  it("reads a finished run", () => {
    const p = runProgressFromNames(["RunInfo.xml", "begun", "ended", "Read00001.Plateread"]);
    expect(p.inProgress).toBe(false);
  });

  it("reports every committed sample as finished, since all of them are", () => {
    // Guards the flag against the obvious failure mode: an ordinary opened file must never light
    // up as in-progress.
    const names = ["RunInfo.xml", "begun", "ended", "lastplatereadstatus"];
    expect(runProgressFromNames(names).inProgress).toBe(false);
  });
});
