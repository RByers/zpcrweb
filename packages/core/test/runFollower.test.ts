/**
 * `RunFollower` against the emulator — the decisions a run is made of, in Node.
 *
 * These are the rules the web app's `useRunWatch` held in eleven `useRef` latches across four
 * React effects, where the only witness was an operator driving a real instrument: the
 * step-transition rule (`usb.md` §7.5), the §7.6 finished-and-held acknowledgement, the
 * first-listing rule and its in-progress exception, and which pass attaches the session's USB
 * traffic log.
 *
 * The last of those is the one this suite exists for. `TODO.md`'s "a run's `.zpcr` comes back
 * without its USB traffic log" was a follower decision, and "a run collected after the fact still
 * carries the log the user asked for" is the assertion that pins it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CfxSession,
  RunFollower,
  USB_TRAFFIC_LOG_NAME,
  buildExperimentArchive,
  markExperimentBegun,
  parseRunInfo,
  planRun,
  runFileBaseName,
  unzipArchive,
  writeZpcrwebSettings,
  ZPCRWEB_SETTINGS_VERSION,
  type HeldRun,
  type RunFollowerPorts,
  type ZpcrArchive,
} from "../src/index.js";
import { acceleratedClock, createCfxEmulator } from "../src/emulator.js";
import { RT_S56_SAMPLE_PATH } from "./sample.js";
import { drop, pcrData, waitFor } from "./sessionRig.js";

/** Two cycles, two plate reads — the reference capture's own protocol (`usb.md` §7.2). */
const TWO_CYCLE =
  "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,180;TEMP 95.0,10;TEMP 55.0,30;" +
  "PLATEREAD #h3F;GOTO 2,1;END";
/** No `PLATEREAD`, so no run folder at all (`usb.md` §7.10). */
const THERMAL_ONLY = "METHOD BLOCK;HOTLID 105,30;VOLUME 10;TEMP 37.0,30;END";

/**
 * A previous run sitting in `CurrentRun`, which is what the folder usually holds when you connect
 * (`usb.md` §7.5). Trimmed to the entries the follower actually reasons about — the identity pair,
 * the markers and one read — so a test isn't moving a megabyte of calibration to prove a rule.
 */
function previousRun(options: { finished: boolean } = { finished: true }): ZpcrArchive {
  const buf = readFileSync(RT_S56_SAMPLE_PATH);
  const all = unzipArchive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const keep = [
    "RunInfo.xml",
    "ProtocolName.txt",
    "ProtocolRunDefinition.txt",
    "runlog.xml",
    "begun",
    "Read00001.Plateread",
    ...(options.finished ? ["ended"] : []),
  ];
  const out: ZpcrArchive = {};
  for (const name of keep) if (all[name]) out[name] = all[name];
  return out;
}

/** The app's side of the ports: a file list, and a record of what was handed over. */
function fileStore() {
  const files = new Map<string, ZpcrArchive>();
  const reports = new Map<string, Uint8Array>();
  const activated: string[] = [];
  const passes: { name: string; whole: boolean; entries: string[] }[] = [];
  const ports: RunFollowerPorts = {
    heldRun: (name): HeldRun | null =>
      files.has(name) ? { id: name, files: files.get(name)! } : null,
    openRuns: () => [...files].map(([id, held]) => ({ id, files: held })),
    onRun: async (run, _previousId, activate) => {
      passes.push({ name: run.name, whole: run.whole, entries: Object.keys(run.archive) });
      const existing = run.whole ? {} : (files.get(run.name) ?? {});
      files.set(run.name, { ...existing, ...run.archive });
      if (activate) activated.push(run.name);
      return run.name;
    },
    onReport: async (name, bytes) => {
      reports.set(name, bytes);
      return name;
    },
  };
  return { files, reports, activated, passes, ports };
}

/** The one run in the store, whatever it ended up being called. */
function onlyRun(files: Map<string, ZpcrArchive>): ZpcrArchive {
  expect([...files.keys()]).toHaveLength(1);
  return [...files.values()][0]!;
}

/** Stand a session and a follower up, wired exactly as the React shell wires them: one `observe`
 * per published status. */
function rig(
  options: Parameters<typeof createCfxEmulator>[0] = {},
  naming?: RunFollowerPorts["naming"],
) {
  return rigOn(createCfxEmulator({ clock: acceleratedClock(), ...options }), { naming });
}

/** {@link rig} on an emulator the caller already has — one that outlives a page, or a cable. */
function rigOn(
  emulator: ReturnType<typeof createCfxEmulator>,
  options: { naming?: RunFollowerPorts["naming"]; reconnectDelaysMs?: number[] } = {},
) {
  const session = new CfxSession({
    acquire: async () => emulator,
    pollMs: 2,
    reconnectDelaysMs: options.reconnectDelaysMs,
  });
  const store = fileStore();
  const follower = new RunFollower(session, { ...store.ports, naming: options.naming });
  session.subscribe(() => follower.observe(session.state.status, session.state.connection));
  return { emulator, session, follower, ...store, close: () => session.dispose() };
}

describe("a run watched from its start", () => {
  it("grows the file a read at a time, and completes it at the finish", { timeout: 30_000 }, async () => {
    const r = rig({ data: pcrData() });
    r.session.setSaveLog(true);
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);
    // Nothing was pulled: the folder is empty, so there is no run to have.
    expect(r.passes).toEqual([]);

    await r.session.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    await waitFor("the run to start", () => r.session.state.status?.running === true);
    // The false→true edge is what says this run *started* here rather than being found going.
    expect(r.follower.memory.watchedRuns.has("DEMO")).toBe(true);

    await waitFor("the first read to be collected", () => r.passes.length > 0, 20_000);
    // The first pass is the whole folder — there was nothing of ours to lay it over.
    expect(r.passes[0]!.whole).toBe(true);
    expect(r.passes[0]!.entries).toContain("Read00001.Plateread");
    expect(r.activated).toHaveLength(1); // a run that began here is what the user is looking at

    await waitFor("the run to be filed as finished", () => r.follower.state.finished !== null, 20_000);
    const run = onlyRun(r.files);
    // §7.6: the acknowledgement is what made the last read, `ended` and the report appear.
    expect(Object.keys(run)).toContain("ended");
    expect(Object.keys(run).filter((n) => n.endsWith(".Plateread"))).toHaveLength(2);
    // And the one entry that is ours rather than the instrument's.
    expect(run[USB_TRAFFIC_LOG_NAME]).toBeInstanceOf(Uint8Array);
    // The last pass re-read the files that go stale as a run goes, and only the last one — which
    // is also the proof that the finish, not a step-transition edge, collected the last read. An
    // edge that got there first would have taken `ended` and read 2 as an ordinary cycle, and this
    // pass would have found the listing unchanged and called the folder somebody else's.
    expect(r.follower.memory.staleAtFinish).toBe(false);
    expect(r.passes.at(-1)!.entries).toContain("runlog.xml");
    expect(r.passes[0]!.whole).toBe(true);
    expect(r.passes.at(-1)!.whole).toBe(false);
    await r.close();
  });
});

/**
 * A pending experiment exactly as the app's Start leaves it: protocol, name and the `begun` marker
 * (`useZpcrStore.ts`'s `beginExperiment`), and nothing of the instrument's yet.
 */
function startedExperiment(experimentName: string): ZpcrArchive {
  return markExperimentBegun(
    writeZpcrwebSettings(
      buildExperimentArchive({ protocol: { runDefinition: TWO_CYCLE, name: "TwoCycle" } }),
      { version: ZPCRWEB_SETTINGS_VERSION, experimentName },
    ),
  );
}

describe("a run started from a file", () => {
  /**
   * Start a run the way `App.tsx`'s `startExperiment` does — pin the names, adopt the file — and
   * run it to the finish. The file is deliberately *not* named `<today>-<name>`: a file renamed by
   * hand, one restamping skipped (a disk-backed file), or a second run of the day's `-2` all look
   * like this, and none of them may make the run's results land anywhere but here.
   */
  async function runFrom(fileId: string, experimentName: string, pin: boolean) {
    const plan = planRun({ runDefinition: TWO_CYCLE, name: experimentName });
    const r = rig(
      { data: pcrData() },
      pin ? () => ({ experimentName: plan.name, fileName: fileId.replace(/\.zpcr$/i, "") }) : undefined,
    );
    r.files.set(fileId, startedExperiment(experimentName));
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);
    // Adopted before the send, as `App.tsx`'s `startExperiment` does.
    r.follower.adopt(fileId, pin ? plan.experimentName : undefined);
    await r.session.startRun(plan);
    await waitFor("the run to be filed as finished", () => r.follower.state.finished !== null, 20_000);
    return r;
  }

  for (const [label, fileId, name] of [
    ["a name the file name can carry verbatim", "My_Experiment.zpcr", "My_Experiment"],
    ["a name with a space in it", "My Experiment.zpcr", "My Experiment"],
    ["an older date on the file", "20260920-Mock_Run.zpcr", "Mock Run"],
    ["the day's second run of a name", "20261014-Mock_Run-2.zpcr", "Mock Run"],
  ] as const) {
    it(`keeps every read in that file — ${label}`, { timeout: 30_000 }, async () => {
      const r = await runFrom(fileId, name, true);
      expect([...r.files.keys()]).toEqual([fileId]);
      const run = r.files.get(fileId)!;
      expect(Object.keys(run).filter((n) => n.endsWith(".Plateread"))).toHaveLength(2);
      expect(Object.keys(run)).toContain("ended");
      await r.close();
    });
  }

  it("keeps it there with the pinned names gone, as after a reload", { timeout: 30_000 }, async () => {
    const r = await runFrom("My Experiment.zpcr", "My Experiment", false);
    expect([...r.files.keys()]).toEqual(["My Experiment.zpcr"]);
    await r.close();
  });

  it("follows its file through a rename mid-run", { timeout: 30_000 }, async () => {
    const plan = planRun({ runDefinition: TWO_CYCLE, name: "My Experiment" });
    const r = rig({ data: pcrData() }, () => ({
      experimentName: plan.experimentName,
      fileName: "My Experiment",
    }));
    r.files.set("My Experiment.zpcr", startedExperiment("My Experiment"));
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);
    r.follower.adopt("My Experiment.zpcr", plan.experimentName);
    await r.session.startRun(plan);
    await waitFor("the first read to be collected", () => r.passes.length > 0, 20_000);
    // Renamed by hand, as Overview's Filename row does: a new id, and the pinned name now stale.
    r.files.set("Renamed.zpcr", r.files.get("My Experiment.zpcr")!);
    r.files.delete("My Experiment.zpcr");
    await waitFor("the run to be filed as finished", () => r.follower.state.finished !== null, 20_000);
    expect([...r.files.keys()]).toEqual(["Renamed.zpcr"]);
    const run = r.files.get("Renamed.zpcr")!;
    expect(Object.keys(run).filter((n) => n.endsWith(".Plateread"))).toHaveLength(2);
    expect(Object.keys(run)).toContain("ended");
    await r.close();
  });

  it("never lays a run over an earlier run's file that has the derived name", { timeout: 30_000 }, async () => {
    const plan = planRun({ runDefinition: TWO_CYCLE, name: "Mock Run" });
    // The name the run would derive for itself (`zpcrNameFromRunFiles`'s second rung): the date
    // the emulator's `RunInfo.xml` carries, which is the recording's, not today's.
    const runInfo = pcrData().supportFiles()["RunInfo.xml"]!;
    const started = parseRunInfo(new TextDecoder().decode(runInfo)).runStartDate!;
    const earlier = `${runFileBaseName("Mock Run", started)}.zpcr`;
    const mine = earlier.replace(/\.zpcr$/, "-2.zpcr");
    const r = rig({ data: pcrData() }, () => ({ experimentName: plan.name, fileName: mine.replace(/\.zpcr$/i, "") }));
    // A different run's file: its `RunInfo.xml` is not this run's, as a real earlier run's never is.
    const earlierRun = previousRun();
    earlierRun["RunInfo.xml"] = new Uint8Array([...earlierRun["RunInfo.xml"]!, 0x20]);
    r.files.set(earlier, earlierRun);
    r.files.set(mine, startedExperiment("Mock Run"));
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);
    r.follower.adopt(mine, plan.experimentName);
    await r.session.startRun(plan);
    await waitFor("the run to be filed as finished", () => r.follower.state.finished !== null, 20_000);
    expect([...r.files.keys()].sort()).toEqual([earlier, mine].sort());
    // Untouched: the same archive object, not the new run laid over it. (`toBe` on the archive
    // itself would diff a megabyte of calibration on failure.)
    expect(r.files.get(earlier) === earlierRun).toBe(true);
    expect(Object.keys(r.files.get(mine)!)).toContain("ended");
    await r.close();
  });
});

describe("a run that was already going", () => {
  it("is pulled on the first listing rather than waited out, and is not activated", async () => {
    const r = rig({ initialRunFolder: previousRun({ finished: false }) });
    await r.session.connect();
    await waitFor("the in-progress folder to be pulled", () => r.passes.length > 0);
    // The *first* listing pulled it — no edge has fired, and nothing waited a cycle out.
    expect(r.passes).toHaveLength(1);
    expect(r.passes[0]!.whole).toBe(true);
    expect(r.passes[0]!.entries).toContain("Read00001.Plateread");
    // Found, not started: nothing about this run says the user caused it just now, so the
    // selection is left alone.
    expect(r.activated).toEqual([]);
    expect(r.follower.state.available).toBeNull();
    await r.close();
  });

  it("offers a finished run in the folder instead of taking it", async () => {
    const r = rig({ initialRunFolder: previousRun() });
    await r.session.connect();
    await waitFor("the offer", () => r.follower.state.available !== null);
    expect(r.follower.state.available).toMatchObject({ plateReads: 1, inProgress: false });
    expect(r.follower.state.note).toMatch(/Watching for changes/);
    // A surprise 400 KB transfer and an unrequested file is not what connecting asks for.
    expect(r.passes).toEqual([]);
    expect(r.files.size).toBe(0);
    await r.close();
  });

  /**
   * `TODO.md`'s missing-traffic-log bug, as an assertion.
   *
   * The Download button used to reach `check(true)` — forced, but not a *final* assembly, and
   * `finalAssembly` was the only thing that attached the log. So a run collected after the fact
   * could not carry one however the switch was set. There is no way to spell that combination
   * now: `download` is one of four named reasons, and it is a completing pass like `final`.
   */
  it("carries the traffic log into a run collected after the fact", async () => {
    const r = rig({ initialRunFolder: previousRun() });
    r.session.setSaveLog(true);
    await r.session.connect();
    await waitFor("the offer", () => r.follower.state.available !== null);

    await r.follower.downloadAvailable();
    const run = onlyRun(r.files);
    expect(run[USB_TRAFFIC_LOG_NAME]).toBeInstanceOf(Uint8Array);
    expect(Object.keys(run)).toContain("ended");
    // Asked for, so it is what the user wants to be looking at when it lands.
    expect(r.activated).toHaveLength(1);
    // And the offer is retired by the pass that answered it.
    expect(r.follower.state.available).toBeNull();
    await r.close();
  });

  it("attaches no log to that download when the switch is off", async () => {
    const r = rig({ initialRunFolder: previousRun() });
    await r.session.connect();
    await waitFor("the offer", () => r.follower.state.available !== null);
    await r.follower.downloadAvailable();
    expect(Object.keys(onlyRun(r.files))).not.toContain(USB_TRAFFIC_LOG_NAME);
    await r.close();
  });
});

describe("a run that writes no run folder", () => {
  it("collects its report when it was known in advance to be thermal-only", { timeout: 30_000 }, async () => {
    const r = rig({ initialRunFolder: previousRun() });
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);

    r.follower.expectReportOnly();
    await r.session.startRun(planRun({ runDefinition: THERMAL_ONLY, name: "agblk" }));
    await waitFor("the run to start", () => r.session.state.status?.running === true);
    await waitFor("the report to be collected", () => r.reports.size === 1, 20_000);
    expect([...r.reports.keys()][0]).toMatch(/_AGBLK\.alf$/);
    // The previous run's folder is still sitting there, and was not mistaken for this run's.
    expect(r.files.size).toBe(0);
    expect(r.follower.state.finished?.name).toBe("AGBLK");
    await r.close();
  });

  it("catches one started at the touchscreen through the unchanged listing", { timeout: 30_000 }, async () => {
    // Nothing armed `expectReportOnly`, so the end-of-run pass lists — and finds the *previous*
    // run's complete folder, unchanged. That is how a 45-cycle qPCR run once came back as the
    // archive of a reverse-transcription incubation.
    const r = rig({ initialRunFolder: previousRun() });
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);
    await r.session.startRun(planRun({ runDefinition: THERMAL_ONLY, name: "agblk" }));
    await waitFor("the report to be collected", () => r.reports.size === 1, 20_000);
    expect(r.follower.memory.staleAtFinish).toBe(true);
    expect(r.files.size).toBe(0);
    await r.close();
  });
});

describe("what the follower believes is readable", () => {
  it("resets what belongs to a connection on a disconnect, and keeps what belongs to the session", async () => {
    const r = rig({ initialRunFolder: previousRun({ finished: false }) });
    await r.session.connect();
    await waitFor("the first listing", () => r.follower.memory.lastNames !== null);
    r.follower.memory.watchedRuns.add("SOMERUN");

    await r.session.disconnect();
    r.follower.observe(null, "disconnected");
    expect(r.follower.memory.lastNames).toBeNull();
    expect(r.follower.memory.identified).toBe(false);
    expect(r.follower.state.available).toBeNull();
    // A run that finishes while the cable is out must still be acknowledged when it comes back,
    // so what this session saw cycling is a page fact, not a connection fact.
    expect(r.follower.memory.watchedRuns.has("SOMERUN")).toBe(true);
    await r.close();
  });
});

/**
 * `runningFile` is what the Instrument view keys "this selected file is the run on the block" on,
 * so the property under test is the strict one: it names a file while that file's run is cycling,
 * and never otherwise.
 */
describe("which open file is the run on the block", () => {
  it("is the file Start was pressed on, until the run's final assembly lands", { timeout: 30_000 }, async () => {
    const plan = planRun({ runDefinition: TWO_CYCLE, name: "My Experiment" });
    const r = rig({ data: pcrData() });
    r.files.set("My Experiment.zpcr", startedExperiment("My Experiment"));
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);
    expect(r.follower.state.runningFile).toBeNull();

    r.follower.adopt("My Experiment.zpcr", plan.experimentName);
    // Before `STATUS?` admits the run: the click is what makes it the running file.
    expect(r.follower.state.runningFile).toBe("My Experiment.zpcr");
    await r.session.startRun(plan);
    await waitFor("the run to start", () => r.session.state.status?.running === true);
    expect(r.follower.state.runningFile).toBe("My Experiment.zpcr");
    await waitFor("the first read to be collected", () => r.passes.length > 0, 20_000);
    expect(r.follower.state.runningFile).toBe("My Experiment.zpcr");

    await waitFor("the run to be filed as finished", () => r.follower.state.finished !== null, 20_000);
    expect(r.follower.state.runningFile).toBeNull();
    // `fileName` is a different fact: the last file written, which outlives the run.
    expect(r.follower.state.fileName).toBe("My Experiment.zpcr");
    await r.close();
  });

  it("is found again by a page that connects to a run already cycling", { timeout: 30_000 }, async () => {
    const plan = planRun({ runDefinition: TWO_CYCLE, name: "My Experiment" });
    const emulator = createCfxEmulator({ clock: acceleratedClock(), data: pcrData() });
    // The page that started the run, gone once the run has cycled once — a reload, in effect.
    const before = rigOn(emulator);
    before.files.set("My Experiment.zpcr", startedExperiment("My Experiment"));
    await before.session.connect();
    await waitFor("the baseline listing", () => before.follower.memory.lastNames !== null);
    before.follower.adopt("My Experiment.zpcr", plan.experimentName);
    await before.session.startRun(plan);
    await waitFor("the first read to be collected", () => before.passes.length > 0, 20_000);
    await before.close();

    // The new page has the started experiment open, and no memory of starting it.
    const r = rigOn(emulator);
    r.files.set("My Experiment.zpcr", startedExperiment("My Experiment"));
    expect(r.follower.state.runningFile).toBeNull();
    await r.session.connect();
    await waitFor("the in-progress folder to be pulled", () => r.passes.length > 0, 20_000);
    expect(r.session.state.status?.running).toBe(true);
    expect([...r.files.keys()]).toEqual(["My Experiment.zpcr"]);
    expect(r.follower.state.runningFile).toBe("My Experiment.zpcr");
    await r.close();
  });

  it("survives a disconnect mid-run", { timeout: 30_000 }, async () => {
    const plan = planRun({ runDefinition: TWO_CYCLE, name: "My Experiment" });
    const emulator = createCfxEmulator({ clock: acceleratedClock(), data: pcrData() });
    const r = rigOn(emulator, { reconnectDelaysMs: [1] });
    r.files.set("My Experiment.zpcr", startedExperiment("My Experiment"));
    await r.session.connect();
    await waitFor("the baseline listing", () => r.follower.memory.lastNames !== null);
    r.follower.adopt("My Experiment.zpcr", plan.experimentName);
    await r.session.startRun(plan);
    await waitFor("the first read to be collected", () => r.passes.length > 0, 20_000);
    expect(r.follower.state.runningFile).toBe("My Experiment.zpcr");

    drop(emulator);
    await waitFor("the drop to be noticed", () => r.session.state.connection === "reconnecting");
    // The run goes on without the cable, so its file is still the running one.
    expect(r.follower.state.runningFile).toBe("My Experiment.zpcr");
    await waitFor("the reconnect", () => r.session.state.connection === "connected", 10_000);
    await waitFor("the reconnected baseline", () => r.follower.memory.lastNames !== null, 10_000);
    expect(r.follower.state.runningFile).toBe("My Experiment.zpcr");

    await waitFor("the run to be filed as finished", () => r.follower.state.finished !== null, 20_000);
    expect(r.follower.state.runningFile).toBeNull();
    expect([...r.files.keys()]).toEqual(["My Experiment.zpcr"]);
    await r.close();
  });

  it("is nothing when the instrument is idle, holding a finished run", async () => {
    const r = rig({ initialRunFolder: previousRun() });
    await r.session.connect();
    await waitFor("the offer", () => r.follower.state.available !== null);
    expect(r.follower.state.runningFile).toBeNull();
    await r.close();
  });

  it("is nothing for an in-progress folder whose run is not on the block", async () => {
    // The folder says begun-not-ended but `STATUS?` says idle: pulled, as the first-listing rule
    // says, but not claimed as running.
    const r = rig({ initialRunFolder: previousRun({ finished: false }) });
    await r.session.connect();
    await waitFor("the in-progress folder to be pulled", () => r.passes.length > 0);
    expect(r.follower.state.fileName).not.toBeNull();
    expect(r.follower.state.runningFile).toBeNull();
    await r.close();
  });
});
