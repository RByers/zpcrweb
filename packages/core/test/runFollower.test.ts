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
  RunFollower,
  USB_TRAFFIC_LOG_NAME,
  planRun,
  unzipArchive,
  type HeldRun,
  type RunFollowerPorts,
  type ZpcrArchive,
} from "../src/index.js";
import { acceleratedClock, createCfxEmulator } from "../src/emulator.js";
import { RT_S56_SAMPLE_PATH } from "./sample.js";
import { pcrData, sessionOn, waitFor } from "./sessionRig.js";

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
function rig(options: Parameters<typeof createCfxEmulator>[0] = {}) {
  const emulator = createCfxEmulator({ clock: acceleratedClock(), ...options });
  const session = sessionOn(emulator, { pollMs: 2 });
  const store = fileStore();
  const follower = new RunFollower(session, store.ports);
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
