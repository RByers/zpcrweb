/**
 * The real `CfxDevice`, driven against the emulator — `emulator.md` §10.
 *
 * This is the point of the emulator existing. `startRun`, `cancelRun`, `sendFile`, `runReport`,
 * `clearRunReports` and `deviceInfo` are ~300 lines of `device.ts` that had **no automated
 * coverage at all** and were verified only by an operator driving real hardware; a mistake in
 * them was invisible until a run in the lab went wrong. Everything below goes over the wire —
 * framing, command lines, replies — so a regression here is a regression in the client, not in a
 * fixture.
 *
 * What it does **not** prove is anything about the instrument: the emulator was written from the
 * same `usb.md` the client was, so the two agreeing says only that they read it the same way.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CfxDevice,
  isFinishedRun,
  isPlateReadName,
  isSameRun,
  parseAlf,
  parseRunInfoRaw,
  planRun,
  unzipArchive,
  type CfxStatus,
} from "../src/index.js";
import {
  acceleratedClock,
  createCfxEmulator,
  manualClock,
  recordedRunData,
  realtimeClock,
  AT_TARGET_LAG_MS,
  lidPreheatMs,
  RELEASE_MS,
  START_WINDOW_MS,
  START_WINDOW_PLATE_READ_MS,
  type CfxEmulator,
  type ScaledClock,
} from "../src/emulator.js";
import { MELT_SAMPLE_PATH, RT_S56_SAMPLE_PATH, readSampleBytes } from "./sample.js";

const CURRENT_RUN = "\\Storage Card\\CurrentRun";
const RUN_REPORTS = "\\Storage Card\\PCRunReport";
const REAL_TIME_DATA = "\\Storage Card\\Real-Time Data";

/** The reference capture's own protocol: two cycles, two plate reads (`usb.md` §7.2). */
const TWO_CYCLE =
  "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,180;TEMP 95.0,10;TEMP 55.0,30;" +
  "PLATEREAD #h3F;GOTO 2,1;END";

/** A melt spelled out the long way — a `PLATEREAD` inside a loop with an `INC` on its hold step,
 * which is how every stored protocol in this repo writes one (`protocol.md` §6). */
const MELT =
  "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 65.0,30;TEMP 65.0,5;INC 0.5;" +
  "PLATEREAD #h3F;GOTO 3,4;END";

/** A thermal-only protocol: no `PLATEREAD`, so no run folder at all (`usb.md` §7.10). */
const THERMAL_ONLY = "METHOD BLOCK;HOTLID 105,30;VOLUME 10;TEMP 37.0,30;END";

function archiveAt(path: string) {
  const buf = readFileSync(path);
  return unzipArchive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

let pcrArchive: ReturnType<typeof archiveAt> | null = null;
function pcrData() {
  pcrArchive ??= archiveAt(RT_S56_SAMPLE_PATH);
  return recordedRunData(pcrArchive);
}

let meltArchive: ReturnType<typeof archiveAt> | null = null;
function meltData() {
  meltArchive ??= archiveAt(MELT_SAMPLE_PATH);
  return recordedRunData(meltArchive);
}

interface Rig {
  emulator: CfxEmulator;
  device: CfxDevice;
  close: () => Promise<void>;
}

async function connect(options: Parameters<typeof createCfxEmulator>[0] = {}): Promise<Rig> {
  const emulator = createCfxEmulator({ clock: acceleratedClock(), ...options });
  const device = new CfxDevice(emulator);
  await device.open();
  return { emulator, device, close: () => device.close() };
}

/**
 * Poll until `done`, the way a client does — and, with the accelerated clock, the polling *is*
 * the passage of time: one `STATUS?` advances the run to the end of the step it is on. So this
 * waits on state rather than on a duration, and there is no timer anywhere in the run.
 */
async function pollUntil(
  device: CfxDevice,
  done: (s: CfxStatus) => boolean,
  limit = 400,
): Promise<CfxStatus> {
  let status = await device.status();
  for (let i = 0; i < limit && !done(status); i++) status = await device.status();
  if (!done(status)) throw new Error(`gave up after ${limit} polls; last step ${status.stepText}`);
  return status;
}

/** Move a manual clock to `offsetMs` past the run's first step starting — wherever its start
 * window and its preheat (which depends on how warm the lid was) put that. */
function advanceIntoRun(
  emulator: CfxEmulator,
  clock: ReturnType<typeof manualClock>,
  offsetMs: number,
): void {
  const run = emulator.instrument.currentRun!;
  clock.advance(run.protocolStartsAtMs + offsetMs - clock.now());
}

describe("the emulator answers the identification block", () => {
  it("identifies itself, and deviceInfo gathers every static query", async () => {
    const { device, emulator, close } = await connect();
    expect(await device.identify()).toMatchObject({
      manufacturer: "BIO-RAD LABORATORIES",
      model: "C1000",
      serial: "CT019138",
      firmware: "2.0.231.0",
    });
    const info = await device.deviceInfo();
    expect(info).toMatchObject({
      serial: "CT019138",
      baseSerial: "CT019138",
      alphaSerial: "RN050773",
      alphaId: "4",
      // `BLOCKDESC?` comes back quoted and `deviceInfo` unquotes it.
      blockDescription: "96FX",
      blockCount: 1,
      cpld: "B",
      superLockdown: "OFF",
      errorCount: 0,
    });
    expect(info.freeSpaceBytes).toBeGreaterThan(0);
    expect(info.totalRamBytes).toBeGreaterThan(0);
    // Every one of them went out as its own command line — `deviceInfo` is fifteen round trips,
    // not one composite query.
    expect(emulator.sent).toContain("FrontEndSoftware?");
    expect(emulator.sent).toContain("GETTOTALRAM");
    await close();
  });

  it("takes an overridden identity", async () => {
    const { device, close } = await connect({ identity: { serial: "CT000001" } });
    expect((await device.identify()).serial).toBe("CT000001");
    await close();
  });

  it("reports an idle status that parses as idle", async () => {
    const { device, close } = await connect();
    const status = await device.status();
    expect(status.running).toBe(false);
    expect(status.phase).toBe("idle");
    expect(status.runName).toBe("");
    expect(status.stepText).toBe("IDLE");
    expect(status.lid).toBe("CLOSED");
    // Twenty fields, as `usb.md` §3.2 defines the record — nineteen plus the trailing code.
    expect(status.fields).toHaveLength(19);
    const rt = await device.rtStatus();
    expect(rt.shuttleTempC).toBeCloseTo(18.31, 2);
    expect(rt.faults).toEqual([]);
    expect(await device.errorList()).toEqual([]);
    await close();
  });

  /**
   * A second client on the same instrument — the app's disconnect → reconnect, and the case a
   * Node test never reached because it opens one client and ends.
   *
   * The first client's read pump is parked in `transferIn` when it closes. Until the transport
   * rejected those parked reads the way WebUSB does, the reply to the *second* client's first
   * command went to the dead pump, and every command after it timed out — an emulator that
   * worked perfectly until something unplugged it.
   */
  it("answers a client that connects after another has closed", async () => {
    const emulator = createCfxEmulator({ clock: acceleratedClock() });
    const first = new CfxDevice(emulator);
    await first.open();
    expect((await first.status()).phase).toBe("idle");
    await first.close();

    const second = new CfxDevice(emulator);
    await second.open();
    expect((await second.status()).phase).toBe("idle");
    await second.close();
  });
});

describe("the filesystem, quirks included", () => {
  it("replays the preceding GETFILESLEN's buffer, whatever path LISTALLFILES is given", async () => {
    const { device, emulator, close } = await connect({
      initialRunFolder: { "a.txt": new Uint8Array(1), "b.txt": new Uint8Array(2) },
    });
    // The pair must stay adjacent, which is what `CfxDevice.listFiles` holds the channel for:
    // two interleaved listings would each report the other's directory.
    const [current, reports] = await Promise.all([
      device.listFiles(CURRENT_RUN),
      device.listFiles(RUN_REPORTS),
    ]);
    expect(current.names).toEqual(["a.txt", "b.txt"]);
    expect(current.status).toBe("ok");
    // An empty directory answers with `07 00 09 00` and no listing is attempted at all.
    expect(reports.status).toBe("empty");
    expect(reports.names).toEqual([]);
    expect(emulator.sent).toEqual([
      `GETFILESLEN ${CURRENT_RUN}`,
      `LISTALLFILES ${CURRENT_RUN}`,
      `GETFILESLEN ${RUN_REPORTS}`,
    ]);
    await close();
  });

  it("answers a missing directory, and `\\Storage Card` itself, with their status codes", async () => {
    const { device, close } = await connect();
    expect(await device.listFiles("\\Nonexistent")).toMatchObject({
      status: "missing",
      listed: false,
    });
    // Listings cover files only, so the volume root — which holds nothing but its two
    // subdirectories — reports itself empty rather than naming them (`usb.md` §5).
    expect(await device.listFiles("\\Storage Card")).toMatchObject({ status: "empty" });
    await close();
  });

  it("downloads a completed run from Real-Time Data, though it spans several messages", async () => {
    // ~400 KB: the instrument sends it as six full 65,530-byte messages and a remainder, the
    // shape the `usb-basic` capture's `.zpcr` download has (`usb.md` §5).
    const zpcr = readSampleBytes();
    const path = `${REAL_TIME_DATA}\\20260720_FirstQualification.zpcr`;
    const { device, close } = await connect({ initialFiles: { [path]: zpcr } });
    expect((await device.listFiles(REAL_TIME_DATA)).names).toEqual([
      "20260720_FirstQualification.zpcr",
    ]);
    expect(Array.from(await device.getFile(path))).toEqual(Array.from(zpcr));
    // Every part went to the one GETFILE: had any leaked, it would answer this instead.
    expect((await device.status()).phase).toBe("idle");
    await close();
  });

  it("refuses to seed a file into a directory the instrument doesn't have", () => {
    expect(() =>
      createCfxEmulator({ initialFiles: { "\\Storage Card\\Nowhere\\x.zpcr": new Uint8Array(1) } }),
    ).toThrow(/no directory/);
  });

  it("round-trips a file through sendFile's five-command upload cycle", async () => {
    const { device, emulator, close } = await connect();
    // An even length, so the checksum's byte order is actually exercised (`usb.md` §9.2).
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37 + 13) % 256);
    const path = `${CURRENT_RUN}\\probe.bin`;
    const result = await device.sendFile(path, bytes);
    expect(result.verified).toBe(true);
    expect(result.crcStored).toBe(result.crcSent);
    expect(result.storedPath).toMatch(/^\\Storage Card\\CurrentRun\\[0-9a-f-]+$/);
    expect(result.bytes).toBe(1000);
    expect(emulator.sent.filter((c) => !c.startsWith("CRCSENDFILE"))).toEqual([
      `DELFILE ${path}`,
      `COMPUTEFILECRC "${path}"`,
      `GETFILESLEN ${CURRENT_RUN}`,
      `LISTALLFILES ${CURRENT_RUN}`,
      `GETFILECRC "${result.storedPath}"`,
    ]);
    // And the bytes really landed: the same file comes back down.
    expect(Array.from(await device.getFile(path))).toEqual(Array.from(bytes));
    await close();
  });
});

describe("a run, start to collected", () => {
  it("authors every directive, starts on RemoteRun, and deposits afterwards", async () => {
    const { device, emulator, close } = await connect({ data: pcrData() });
    const plan = planRun({ runDefinition: TWO_CYCLE, name: "demo", protocolName: "twocycle" });
    expect(plan.startable).toBe(true);
    const result = await device.startRun(plan);
    expect(result.uploadErrors).toEqual([]);
    expect(result.uploads.every((u) => u.verified)).toBe(true);

    const sent = emulator.sent;
    // §7.1 first: the previous report is cleared so the new one is the directory's only entry.
    expect(sent[0]).toBe(`GETFILESLEN ${RUN_REPORTS}`);
    // §7.2: the protocol typed in, one command per directive, in order.
    const author = sent.slice(sent.indexOf("PROTOCOL 'PCRUN'"));
    expect(author.slice(0, 10)).toEqual([
      "PROTOCOL 'PCRUN'",
      "METHOD CALC",
      "HOTLID 105,30",
      "VOLUME 25",
      "TEMP 95.0,180",
      "TEMP 95.0,10",
      "TEMP 55.0,30",
      "PLATEREAD #h3F",
      "GOTO 2,1",
      "END",
    ]);
    // §7.3, then the no-op §7.3 sends as ordinary setup — and the deposit only after both.
    expect(author[10]).toBe('RemoteRun "A","True","False","demo","admin","","True","CALC"');
    expect(author[11]).toBe("ADDCYCLES 0");
    expect(author.slice(12).some((c) => c.startsWith("CRCSENDFILE"))).toBe(true);
    await close();
  });

  /**
   * Measured (`usb.md` §7.4, "The folder is cleared as the run starts"): the firmware empties the
   * previous run out of `CurrentRun` in the seconds after `RemoteRun`, and a file written then can
   * go with it — which is how a deposited `.prcl.txt` came to be missing from nearly every run.
   * The emulator clears as the run appears, the latest the real clear ends, so a deposit made
   * inside the start window is lost here and one made after it survives.
   */
  it("loses a deposit made inside the start window, and keeps one made after", async () => {
    const clock = manualClock();
    const { device, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));

    const early = CURRENT_RUN + "\\early.txt";
    expect((await device.sendFile(early, new TextEncoder().encode("early"))).verified).toBe(true);
    clock.advance(START_WINDOW_PLATE_READ_MS);
    expect((await device.listFiles(CURRENT_RUN)).names).not.toContain("early.txt");

    const deposited = CURRENT_RUN + "\\zpcrweb.json";
    const mine = new TextEncoder().encode('{"experimentName":"mine"}');
    expect((await device.sendFile(deposited, mine)).verified).toBe(true);
    // Past the lid preheat, so the run writes its own files on top.
    clock.advance(600_000);
    const listed = await device.listFiles(CURRENT_RUN);
    expect(listed.names).toContain("zpcrweb.json");
    expect(listed.names).toContain("begun");
    expect(Array.from(await device.getFile(deposited))).toEqual(Array.from(mine));
    await close();
  });

  /** CFX Manager's order (`usb.md` §7.4): no `CRCSENDFILE` until `STATUS?` shows the run. */
  it("waits for the run to appear before depositing, and every file survives", async () => {
    const { device, emulator, close } = await connect({ data: pcrData() });
    const plan = planRun({
      runDefinition: TWO_CYCLE,
      name: "demo",
      protocolName: "twocycle",
    });
    const result = await device.startRun(plan);
    expect(result.uploadErrors).toEqual([]);
    expect(result.uploads).toHaveLength(plan.uploads.length);

    const sent = emulator.sent;
    const firstUpload = sent.findIndex((c) => c.startsWith("CRCSENDFILE"));
    expect(sent.slice(sent.indexOf("ADDCYCLES 0"), firstUpload)).toContain("STATUS?");
    const listed = (await device.listFiles(CURRENT_RUN)).names;
    for (const u of plan.uploads) expect(listed).toContain(u.name);
    await close();
  });

  it("holds the empty idle through the start window, then runs", async () => {
    const clock = manualClock();
    const { device, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    // Measured: `RemoteRun` is accepted and for ~10.7 s — a run with plate reads — `STATUS?` still
    // reports the empty idle, so an armed run and a genuinely idle instrument are the same reply
    // (`usb.md` §7.3, §7.8 step 0).
    clock.advance(START_WINDOW_PLATE_READ_MS - 1_000);
    expect(await device.status()).toMatchObject({ running: false, runName: "", stepText: "IDLE" });
    clock.advance(2_000);
    const started = await device.status();
    expect(started.running).toBe(true);
    expect(started.runName).toBe("DEMO");
    // And the lid heats first, with the run's own clocks still at zero (`usb.md` §7.3).
    expect(started.flags.lidPreheating).toBe(true);
    expect(started.elapsedS).toBe(0);
    expect(started.blockTempC).toBeCloseTo(18.4, 1);
    await close();
  });

  it("materialises each plate read as its step ends, and the last only on acknowledgement", async () => {
    // With the accelerated clock only `STATUS?` moves time, so the listing straight after the
    // `CANCEL` below sits at the very moment of the acknowledgement — the measured 0.3 s case.
    const { device, close } = await connect({ data: pcrData() });
    await device.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));

    // Watch for the first read's step to end, exactly as `useRunWatch` does.
    await pollUntil(device, (s) => s.stepText.startsWith("PLATEREAD"));
    expect((await device.listFiles(CURRENT_RUN)).names.filter(isPlateReadName)).toEqual([]);
    await pollUntil(device, (s) => !s.stepText.startsWith("PLATEREAD") || !s.running);
    expect((await device.listFiles(CURRENT_RUN)).names.filter(isPlateReadName)).toEqual([
      "Read00001.Plateread",
    ]);

    const finished = await pollUntil(device, (s) => isFinishedRun(s));
    // §7.6: finished, and still held — `IDLE`, counters zero, the name still attached.
    expect(finished.stepText).toBe("IDLE");
    expect(finished.cycle).toBe(0);
    expect(finished.runName).toBe("DEMO");
    expect(finished.flags.raw).toBe(32);
    expect(finished.phase).toBe("finished");

    const before = await device.listFiles(CURRENT_RUN);
    expect(before.names).not.toContain("ended");
    // §7.7: the last read is not there yet — the acknowledgement is what releases it.
    expect(before.names.filter(isPlateReadName)).toEqual(["Read00001.Plateread"]);
    await device.acknowledgeRun();
    // §7.6, measured: the final read is there at once, but the run is still named and neither
    // `ended` nor the report has been written — collecting now files a run in progress for ever.
    const acknowledged = await device.listFiles(CURRENT_RUN);
    expect(acknowledged.names.filter(isPlateReadName)).toEqual([
      "Read00001.Plateread",
      "Read00002.Plateread",
    ]);
    expect(acknowledged.names).not.toContain("ended");
    expect((await device.listFiles(RUN_REPORTS)).status).toBe("empty");

    // Released a moment later: the name is gone, the instrument is back to the empty idle, and
    // `ended` and the report have appeared.
    const released = await pollUntil(device, (s) => s.runName === "");
    expect(released).toMatchObject({ runName: "", stepText: "IDLE" });
    expect((await device.listFiles(CURRENT_RUN)).names).toContain("ended");
    expect((await device.listFiles(RUN_REPORTS)).names).toHaveLength(1);

    // And what came back is a real plate read, with this run's cycle in its header.
    const read = await device.getFile(`${CURRENT_RUN}\\Read00002.Plateread`);
    expect(read.length).toBeGreaterThan(20_000);
    await close();
  });

  it("collects a report whose step log is the run that actually executed", async () => {
    const { device, close } = await connect({ data: pcrData() });
    await device.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    await pollUntil(device, (s) => isFinishedRun(s));
    await device.releaseRun();

    const report = await device.runReport();
    expect(report).not.toBeNull();
    expect(report!.name).toMatch(/^\d{8}_\d{6}_CT019138_DEMO\.alf$/);
    const alf = parseAlf(report!.bytes);
    expect(alf.problems).toEqual([]);
    expect(alf.header.runName).toBe("DEMO");
    expect(alf.header.user).toBe("admin");
    expect(alf.plateReadCount).toBe(2);
    // The instrument supplies the lid and volume settings it is holding, even when the host
    // never sent them — measured on the thermal-only run (`usb.md` §7.10).
    expect(alf.runDefinition).toContain("HOTLID 105,30");
    expect(alf.completionPhrase).toBe("Protocol completed.");
    // Seven executed steps: three of cycle 1 plus the read, then cycle 2's three.
    expect(alf.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3, 4, 2, 3, 4]);
    expect(alf.steps.map((s) => s.repeat)).toEqual([1, 1, 1, 1, 2, 2, 2]);
    await close();
  });

  /**
   * A host identifies a run by its `RunInfo.xml` (`isSameRun`). Carried verbatim from the
   * recording, every emulated run had the same one, so the app's run follower took a second run
   * for the first and merged its reads into the first run's file (`emulator.md` §7).
   */
  it("gives every run its own RunInfo.xml, keeping the recording's instrument fields", async () => {
    const { device, emulator, close } = await connect({ data: pcrData() });
    const runInfoOf = async (name: string) => {
      await device.startRun(planRun({ runDefinition: TWO_CYCLE, name }));
      await pollUntil(device, (s) => isFinishedRun(s));
      await device.releaseRun();
      const bytes = emulator.instrument.fs.read(`${CURRENT_RUN}\\RunInfo.xml`)!;
      return { bytes, raw: parseRunInfoRaw(new TextDecoder().decode(bytes)) };
    };
    const first = await runInfoOf("first");
    const second = await runInfoOf("second");

    expect(isSameRun({ "RunInfo.xml": first.bytes }, { "RunInfo.xml": second.bytes })).toBe(false);
    expect(first.raw.Identifier).toMatch(/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);
    expect(first.raw.Identifier).not.toBe(second.raw.Identifier);
    expect(second.raw.DataFile).toMatch(/^\d{8}_\d{6}_CT019138_second\.zpcr$/);
    expect(second.raw.RunDefinition).toContain("PLATEREAD #h3F;GOTO 2,1");
    expect(new Date(second.raw.RunStartTime!).getTime()).toBeGreaterThan(
      new Date(first.raw.RunStartTime!).getTime(),
    );
    // Everything that describes the instrument rather than the run is the recording's, untouched.
    const recorded = parseRunInfoRaw(new TextDecoder().decode(pcrArchive!["RunInfo.xml"]));
    const own = new Set(["Identifier", "RunStartTime", "DataFile", "RunDefinition"]);
    for (const [key, value] of Object.entries(recorded)) {
      if (!own.has(key)) expect([key, second.raw[key]]).toEqual([key, value]);
    }
    expect(Object.keys(second.raw)).toEqual(Object.keys(recorded));
    await close();
  });

  it("empties the run-report directory at the start, so the new report is the only entry", async () => {
    const { device, emulator, close } = await connect({ data: pcrData() });
    emulator.instrument.fs.write(`${RUN_REPORTS}\\20260101_000000_CT019138_OLD.alf`, new Uint8Array(1));
    expect(await device.clearRunReports()).toEqual(["20260101_000000_CT019138_OLD.alf"]);
    expect((await device.listFiles(RUN_REPORTS)).status).toBe("empty");
    await close();
  });
});

describe("pausing, skipping and stopping", () => {
  it("pauses and resumes, with the run's clock frozen in between", async () => {
    const clock = manualClock();
    const { device, emulator, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    advanceIntoRun(emulator, clock, 40_000);
    const before = await device.status();
    expect(before.running).toBe(true);

    await device.pauseRun();
    const paused = await device.status();
    // `usb.md` §7.9: bit 1 of the register is the indicator to trust, and field 13 sits beside
    // it. `isPaused` takes either, which is what this must satisfy.
    expect(paused.flags.paused).toBe(true);
    expect(paused.elapsedS).toBe(before.elapsedS);
    expect(before.elapsedS).not.toBeNull();

    clock.advance(30_000);
    expect((await device.status()).elapsedS).toBe(before.elapsedS);

    await device.resumeRun();
    clock.advance(5_000);
    const resumed = await device.status();
    expect(resumed.flags.paused).toBe(false);
    // The pause cost the run nothing: five seconds after resuming, five seconds have elapsed.
    expect(resumed.elapsedS).toBeCloseTo(before.elapsedS! + 5, 1);
    await close();
  });

  it("PROCEED skips to the next step rather than starting or resuming anything", async () => {
    const clock = manualClock();
    const { device, emulator, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    advanceIntoRun(emulator, clock, 40_000);
    // Step 1 is a 3-minute hold the run is 40 s into (its ramp included) — it cannot have run out.
    const before = await device.status();
    expect(before.stepText).toBe("TEMP 95.0,180");
    await device.runAction("skipStep");
    const after = await device.status();
    expect(after.stepText).toBe("TEMP 95.0,10");
    // Measured (`usb-run`): the skip re-plans what remains but does not jump the elapsed clock —
    // the instrument read 37.77 s on the step after a skipped 180 s hold, not 180.
    expect(after.elapsedS).toBeCloseTo(before.elapsedS!, 1);
    expect(after.remainingS!).toBeLessThan(before.remainingS! - 100);
    await close();
  });

  it("a CANCEL during the lid preheat aborts the run, and STATUS? says so at once", async () => {
    const clock = manualClock();
    const { device, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    clock.advance(START_WINDOW_PLATE_READ_MS + 30_000);
    expect((await device.status()).flags.lidPreheating).toBe(true);
    const result = await device.cancelRun({ pollMs: 1, timeoutMs: 5_000 });
    expect(result.stopped).toBe(true);
    expect(result.timedOut).toBe(false);
    // Still inside what would have been the preheat: the run must not go on reporting itself
    // preheating after it answered the abort (register 104), or the client's cancel times out.
    clock.advance(60_000);
    const status = await device.status();
    expect(status.flags.raw).toBe(160);
    expect(status.flags.lidPreheating).toBe(false);
    expect(isFinishedRun(status)).toBe(true);
    await close();
  });

  it("the lid takes its time: OPENING, then OPEN, then CLOSING, then CLOSED", async () => {
    const clock = manualClock();
    const { device, close } = await connect({ clock });
    await device.runAction("lidOpen");
    expect((await device.status()).lid).toBe("OPENING");
    clock.advance(17_000);
    expect((await device.status()).lid).toBe("OPENING");
    clock.advance(1_000);
    expect((await device.status()).lid).toBe("OPEN");
    await device.runAction("lidClose");
    expect((await device.status()).lid).toBe("CLOSING");
    clock.advance(9_000);
    expect((await device.status()).lid).toBe("CLOSED");
    await close();
  });

  it("…and with the accelerated clock a poll carries the lid to where it is going", async () => {
    const { device, close } = await connect();
    await device.runAction("lidOpen");
    await pollUntil(device, (s) => s.lid === "OPEN", 3);
    await close();
  });

  it("cancelRun stops a running protocol and leaves it in the finished state", async () => {
    const { device, close } = await connect({ data: pcrData() });
    await device.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    await pollUntil(device, (s) => s.running && !s.flags.lidPreheating);

    const result = await device.cancelRun({ pollMs: 1, timeoutMs: 5_000 });
    expect(result.startedFrom).toBe("running");
    expect(result.stopped).toBe(true);
    // Bit 7 on top of the finished state — the one signal that says "the run I stopped" rather
    // than "the run that finished while I was deciding" (`usb.md` §3.2, §7.8).
    expect(result.sawCancelledFlag).toBe(true);
    expect(result.status.flags.raw).toBe(160);
    expect(result.errors).toEqual([]);
    expect(result.timedOut).toBe(false);
    // It stops at §7.6's finished state and hands the acknowledgement to the end-of-run path —
    // having two owners of that is how a run loses its last read.
    expect(isFinishedRun(result.status)).toBe(true);

    await device.releaseRun();
    const names = (await device.listFiles(CURRENT_RUN)).names;
    expect(names).toContain("ended");
    // A cancelled run is simply a run with fewer reads than its protocol implies — that count is
    // the only durable evidence the run was cut short (`usb.md` §7.8 step 6).
    expect(names.filter(isPlateReadName).length).toBeLessThan(2);
    await close();
  });

  it("does not cancel into a plate read: it waits for the step to end first", async () => {
    // The manual clock, because this is the one case that needs the run to sit *inside* a step
    // while the host decides: the optics are mid-scan and that cycle's file does not exist yet
    // (`usb.md` §7.8 step 1). `cancelRun`'s own `onStatus` is what moves time on here, which is
    // also the callback a caller uses to keep its display live while the channel is held.
    const clock = manualClock();
    const { device, emulator, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    // Five seconds into the first plate read, wherever the ramps put it.
    const firstRead = emulator.instrument.currentRun!.schedule.steps.find((s) => s.readIndex === 1)!;
    advanceIntoRun(emulator, clock, firstRead.startMs + 5_000);
    expect((await device.status()).stepText).toBe("PLATEREAD #h3F");

    const result = await device.cancelRun({
      pollMs: 1,
      readWaitMs: 5_000,
      timeoutMs: 10_000,
      onStatus: () => clock.advance(3_000),
    });
    expect(result.waitedForRead).toBe(true);
    expect(result.stopped).toBe(true);
    await device.acknowledgeRun();
    // The read in flight became a file rather than being thrown away.
    expect((await device.listFiles(CURRENT_RUN)).names).toContain("Read00001.Plateread");
    await close();
  });

  it("survives the start window, where a bare CANCEL is answered 0000 and ignored", async () => {
    const clock = manualClock();
    const { device, emulator, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));

    // A fire-and-forget button: accepted, and the run starts anyway. This is the bug.
    expect((await device.acknowledgeRun()).ok).toBe(true);
    clock.advance(START_WINDOW_PLATE_READ_MS + 500);
    expect((await device.status()).running).toBe(true);
    await close();
    expect(emulator.sent.filter((c) => c === "CANCEL")).toHaveLength(1);
  });

  it("cancelRun with expectStart waits the run out and then stops it for real", async () => {
    // A real clock this time, scaled hard: `cancelRun`'s own loop sleeps in wall time, so the
    // start window has to pass in wall time too for the watch-and-retry path to be exercised.
    const clock = realtimeClock(200);
    const { device, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    const result = await device.cancelRun({
      expectStart: true,
      pollMs: 5,
      startWindowMs: 2_000,
      timeoutMs: 10_000,
    });
    expect(result.startedFrom).toBe("idle");
    expect(result.stopped).toBe(true);
    // More than one CANCEL: the first fell in the window and did nothing.
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.status.runName).toBe("DEMO");
    await close();
  });
});

describe("the other two kinds of run", () => {
  it("runs a melt, whose reads climb in temperature", async () => {
    const { device, close } = await connect({ data: meltData() });
    const plan = planRun({ runDefinition: MELT, name: "melt" });
    expect(plan.startable).toBe(true);
    await device.startRun(plan);
    await pollUntil(device, (s) => isFinishedRun(s));
    await device.releaseRun();

    const names = (await device.listFiles(CURRENT_RUN)).names.filter(isPlateReadName);
    // `GOTO 3,4` — five passes over the 65 °C step and its read.
    expect(names).toHaveLength(5);
    const report = await device.runReport();
    const alf = parseAlf(report!.bytes);
    // `INC 0.5` walks the setpoint up half a degree a pass, which is what makes it a melt.
    expect(alf.steps.filter((s) => s.stepNumber === 3).map((s) => s.setpointText)).toEqual([
      "65.0",
      "65.5",
      "66.0",
      "66.5",
      "67.0",
    ]);
    await close();
  });

  it("a thermal-only run writes no run folder at all, only its report", async () => {
    const previous = { "Read00001.Plateread": new Uint8Array(10), begun: new Uint8Array(0) };
    const { device, close } = await connect({ initialRunFolder: previous });
    const plan = planRun({ runDefinition: THERMAL_ONLY, name: "agblk" });
    expect(plan.producesRunFile).toBe(false);
    // And therefore nothing to deposit: the files would land in the *previous* run's folder.
    expect(plan.uploads).toEqual([]);
    await device.startRun(plan);
    await pollUntil(device, (s) => isFinishedRun(s));
    await device.releaseRun();

    // Not one entry appeared or disappeared, from before the run to after the acknowledgement
    // (`usb.md` §7.10, measured on a CFX96).
    expect((await device.listFiles(CURRENT_RUN)).names.sort()).toEqual([
      "Read00001.Plateread",
      "begun",
    ]);
    const report = await device.runReport();
    expect(report!.name).toMatch(/_AGBLK\.alf$/);
    const alf = parseAlf(report!.bytes);
    expect(alf.plateReadCount).toBe(0);
    expect(alf.runDefinition).toBe("METHOD BLOCK;HOTLID 105,30;VOLUME 10;TEMP 37.0,30;END");
    await close();
  });
});

/**
 * What the first recorded qPCR session (`samples/20261014-S187_S188_S189_cold_check.zpcr`, a
 * 45-cycle run) measured, alongside the `usb-run` capture and the heat-block session — `usb.md`
 * §3.2, §7.3, §7.6. `emulatorFidelity.test.ts` replays the session itself; these pin each rule.
 */
describe("timings and fields measured from a recorded qPCR run", () => {
  const THREE_CYCLE = TWO_CYCLE.replace("GOTO 2,1", "GOTO 2,2");

  it("reports a loop's total in field 2 only once its GOTO has run", async () => {
    const { device, close } = await connect({ data: pcrData() });
    await device.startRun(planRun({ runDefinition: THREE_CYCLE, name: "demo" }));
    const seen: string[] = [];
    await pollUntil(device, (s) => {
      const pair = `${s.cycleCount}/${s.cycle}`;
      if (s.running && seen.at(-1) !== pair) seen.push(pair);
      return isFinishedRun(s);
    });
    // `1;1` through the first pass, `45;23` in a `GOTO 2,44` loop's 23rd — here, three passes.
    expect(seen).toEqual(["1/1", "3/2", "3/3"]);
    await close();
  });

  it("ramps for as long as the distance needs, and not at all for the same setpoint", async () => {
    const clock = manualClock();
    const { device, emulator, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    const steps = emulator.instrument.currentRun!.schedule.steps;
    // Up from ambient at 3.1 °C/s, 95 → 95 not at all, 95 → 55 at 2.35 °C/s.
    expect(steps[0]!.rampMs / 1000).toBeCloseTo((95 - 18.4) / 3.1, 1);
    expect(steps[1]!.rampMs).toBe(0);
    expect(steps[2]!.rampMs / 1000).toBeCloseTo(40 / 2.35, 1);

    // Field 9 reads the hold, like field 12 — zero through the ramp (`usb.md` §3.2).
    advanceIntoRun(emulator, clock, steps[2]!.startMs + 5_000);
    const ramping = await device.status();
    expect(ramping.flags.atTarget).toBe(false);
    expect(ramping.rampElapsedS).toBeCloseTo(5, 1);
    expect(ramping.stepElapsedS).toBe(0);
    advanceIntoRun(emulator, clock, steps[2]!.startMs + steps[2]!.rampMs + 7_000);
    const holding = await device.status();
    expect(holding.flags.atTarget).toBe(true);
    expect(holding.stepElapsedS).toBeCloseTo(7, 1);
    expect(holding.stepElapsedS).toBe(holding.holdElapsedS);
    await close();
  });

  it("carries the last step's at-target bit into a new setpoint for a moment", async () => {
    const clock = manualClock();
    const { device, emulator, close } = await connect({ data: pcrData(), clock });
    await device.beginRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    const toAnneal = emulator.instrument.currentRun!.schedule.steps[2]!;
    advanceIntoRun(emulator, clock, toAnneal.startMs + 100);
    const first = await device.status();
    expect(first.stepText).toBe("TEMP 55.0,30");
    expect(first.flags.atTarget).toBe(true);
    clock.advance(AT_TARGET_LAG_MS);
    expect((await device.status()).flags.atTarget).toBe(false);
    await close();
  });

  it("appears sooner for a run with no plate reads, whose folder it leaves alone", async () => {
    const clock = manualClock();
    const { device, close } = await connect({ clock });
    await device.beginRun(planRun({ runDefinition: THERMAL_ONLY, name: "agblk" }));
    clock.advance(START_WINDOW_MS - 500);
    expect((await device.status()).runName).toBe("");
    clock.advance(1_000);
    expect((await device.status()).runName).toBe("AGBLK");
    expect(START_WINDOW_PLATE_READ_MS).toBeGreaterThan(START_WINDOW_MS + 4_000);
    await close();
  });

  it("preheats the lid for as long as it takes to come within 10 °C of its setpoint", () => {
    // The three runs measured, lid start → preheat (`usb.md` §7.3). One rate for all three is
    // within 6 s of each: their own rates spread 0.444–0.469 °C/s.
    for (const [lidC, measuredS] of [
      [37.7, 124.5],
      [19.6, 169.3],
      [22.5, 154.2],
    ] as const) {
      expect(Math.abs(lidPreheatMs(lidC, 105) / 1000 - measuredS)).toBeLessThan(6);
    }
    expect(lidPreheatMs(100, 105)).toBe(0);
    expect(lidPreheatMs(18.4, 105, false)).toBe(0);
  });

  it("leaves the block and lid to cool after a run, and a warm lid skips the next preheat", async () => {
    const clock = manualClock();
    const { device, emulator, close } = await connect({ clock });
    await device.beginRun(planRun({ runDefinition: THERMAL_ONLY, name: "first" }));
    const run = emulator.instrument.currentRun!;
    advanceIntoRun(emulator, clock, run.schedule.endMs + 1_000);
    const finished = await device.status();
    expect(isFinishedRun(finished)).toBe(true);
    // Still at the run's last setpoint a second after it ended, not at ambient — 94.42 °C beside a
    // 95 °C hold, measured.
    expect(finished.blockTempC!).toBeGreaterThan(36);
    expect(finished.lidTempC!).toBeGreaterThan(100);
    await device.acknowledgeRun();
    clock.advance(RELEASE_MS);
    const idle = await device.status();
    expect(idle.runName).toBe("");
    expect(idle.blockTempC!).toBeGreaterThan(30);
    expect(idle.sampleTempC).toBe(idle.blockTempC);

    // Straight into another run: the lid is still hot, so there is no preheat to sit through.
    await device.beginRun(planRun({ runDefinition: THERMAL_ONLY, name: "second" }));
    clock.advance(START_WINDOW_MS + 1_000);
    const second = await device.status();
    expect(second.runName).toBe("SECOND");
    expect(second.flags.lidPreheating).toBe(false);
    await close();
  });

  it("writes ProtocolRunDefinition.txt CRLF-terminated, as the instrument does", async () => {
    const { device, emulator, close } = await connect({ data: pcrData() });
    await device.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    const text = new TextDecoder().decode(
      emulator.instrument.fs.read(`${CURRENT_RUN}\\ProtocolRunDefinition.txt`)!,
    );
    expect(text).toBe(
      "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,180;TEMP 95.0,10;TEMP 55.0,30;" +
        "PLATEREAD #h3F;GOTO 2,1;END\r\n",
    );
    await close();
  });

  it("releaseRun waits out the acknowledgement, so the folder it leaves is complete", async () => {
    const { device, close } = await connect({ data: pcrData() });
    await device.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    await pollUntil(device, (s) => isFinishedRun(s));
    const result = await device.releaseRun({ pollMs: 1 });
    expect(result.released).toBe(true);
    expect(result.status.runName).toBe("");
    const names = (await device.listFiles(CURRENT_RUN)).names;
    expect(names).toContain("ended");
    expect(names.filter((n) => n.endsWith(".alf"))).toHaveLength(1);
    await close();
  });
});

describe("the clock never jumps", () => {
  const readings = (clock: ScaledClock, wall: { t: number }, plan: [number, number][]) => {
    const out: number[] = [];
    for (const [speed, advanceMs] of plan) {
      const before = clock.now();
      clock.setSpeed(speed);
      const after = clock.now();
      // The change itself moves the clock not at all — the whole of the rebasing rule.
      expect(after).toBe(before);
      wall.t += advanceMs;
      out.push(clock.now());
    }
    return out;
  };

  it("is monotonically non-decreasing across speed changes up and down", () => {
    const wall = { t: 1_000 };
    const clock = realtimeClock(1, () => wall.t);
    wall.t += 1_000;
    expect(clock.now()).toBe(1_000);
    const seen = readings(clock, wall, [
      [60, 1_000],
      [1, 1_000],
      [600, 1_000],
      [0.5, 1_000],
      [1, 1_000],
    ]);
    // 1 000 + 60 000, then +1 000, +600 000, +500, +1 000 — and never once backwards.
    expect(seen).toEqual([61_000, 62_000, 662_000, 662_500, 663_500]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it("advances only when asked, in the accelerated clock", async () => {
    const clock = acceleratedClock();
    expect(clock.now()).toBe(0);
    // No timer exists: waiting does nothing at all.
    await new Promise((r) => setTimeout(r, 20));
    expect(clock.now()).toBe(0);
    clock.poll(5_000);
    expect(clock.now()).toBe(5_000);
    // And it never goes backwards, whatever it is told.
    clock.poll(1_000);
    expect(clock.now()).toBe(5_000);
  });

  it("refuses to run backwards on the manual clock", () => {
    const clock = manualClock();
    clock.advance(10);
    expect(() => clock.advance(-1)).toThrow(/never goes backwards/);
    expect(clock.now()).toBe(10);
  });
});

describe("@zpcrweb/core/emulator is a subpath of its own", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as {
    exports: Record<string, { import: string }>;
  };

  it("is declared in package.json and built as its own tsup entry", () => {
    expect(pkg.exports["./emulator"]?.import).toBe("./dist/emulator.js");
    const tsup = readFileSync(resolve(here, "../tsup.config.ts"), "utf8");
    expect(tsup).toContain('"src/emulator.ts"');
    // The entry exists and re-exports the module the app will lazily import.
    expect(readFileSync(resolve(here, "../src/emulator.ts"), "utf8")).toContain(
      'export * from "./usb/emulator/index.js"',
    );
  });

  // `npm test` runs against `src`, so there need not be a `dist` — but when there is one, the
  // path the export map points at has to be a module that really loads and really carries the
  // entry point. Skipped rather than failed without a build, since building is not this suite's
  // job and a red test for "you have not run tsup" would be noise.
  const built = resolve(here, "..", pkg.exports["./emulator"]!.import);
  it.skipIf(!existsSync(built))("loads from the path its export map names", async () => {
    const module = (await import(pathToFileURL(built).href)) as typeof import("../src/emulator.js");
    expect(typeof module.createCfxEmulator).toBe("function");
    expect(module.createCfxEmulator().vendorId).toBe(0x0614);
  });
});

describe("the schedule counts passes the way the walk does", () => {
  it("a one-step loop body still advances the repeat, so INC applies on every pass", async () => {
    const { scheduleRun } = await import("../src/emulator.js");
    const { parseRunDefinition } = await import("../src/index.js");
    // `GOTO 1,3` straight back to the step before it: the walk lands on the same step number
    // four times in a row, which is a backwards jump of zero and was not counted as one.
    const schedule = scheduleRun(parseRunDefinition("METHOD CALC;TEMP 65.0,5;INC 0.5;GOTO 1,3;END"));
    expect(schedule.steps.map((s) => s.repeat)).toEqual([1, 2, 3, 4]);
    expect(schedule.steps.map((s) => s.targetC)).toEqual([65, 65.5, 66, 66.5]);
  });
});
