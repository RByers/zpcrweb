/**
 * `CfxSession` against the emulator — the session layer, with no browser anywhere.
 *
 * This is everything the web app's `useCfxDevice` used to do in React and so could only be
 * checked by driving Chrome at a real instrument: the status poll and the busy gate that
 * serialises it against a file transfer, the reconnect backoff, and the traffic window's rule that
 * a hidden poll must not cause a render.
 */
import { describe, expect, it } from "vitest";
import { CfxSession, formatUsbTrafficBytes, planRun, type UsbDeviceLike } from "../src/index.js";
import { acceleratedClock, createCfxEmulator } from "../src/emulator.js";
import { drop, pcrData, sessionOn, waitFor } from "./sessionRig.js";

/** The reference capture's own protocol: two cycles, two plate reads (`usb.md` §7.2). */
const TWO_CYCLE =
  "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,180;TEMP 95.0,10;TEMP 55.0,30;" +
  "PLATEREAD #h3F;GOTO 2,1;END";

describe("a session brings a connection up and keeps it", () => {
  it("publishes what the instrument says, through the acquire port", async () => {
    const session = sessionOn(createCfxEmulator({ clock: acceleratedClock() }));
    await session.connect();
    expect(session.state.connection).toBe("connected");
    expect(session.state.info?.serial).toBe("CT019138");
    expect(session.state.status?.stepText).toBe("IDLE");
    // Read unasked, once per connection: an instrument holding no report is a real answer.
    await waitFor("the last-run report read", () => session.state.busy === null);
    expect(session.state.lastReport).toBeNull();
    await session.dispose();
  });

  it("answers a declined picker with no error and no connection", async () => {
    const session = new CfxSession({ acquire: async () => null });
    await session.connect();
    expect(session.state.connection).toBe("disconnected");
    expect(session.state.error).toBeNull();
    await session.dispose();
  });

  it("polls a run all the way to its finish, with no timer in the run itself", async () => {
    // The accelerated clock makes the *poll* the passage of time: one `STATUS?` advances the run
    // to the end of the step it is on, so the run's progress is a pure function of how many polls
    // have happened and nothing here waits on a duration.
    const emulator = createCfxEmulator({ data: pcrData(), clock: acceleratedClock() });
    const session = sessionOn(emulator);
    await session.connect();
    await session.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    await waitFor("the run to start", () => session.state.status?.running === true);
    await waitFor("the run to finish", () => session.state.status?.phase === "finished");
    expect(session.state.status?.runName).toBe("DEMO");
    await session.dispose();
  });
});

describe("the instrument's clock is set from the host's", () => {
  it("sends SetDateTime once per connection, with this machine's offset", async () => {
    const emulator = createCfxEmulator({ clock: acceleratedClock() });
    const session = sessionOn(emulator);
    await session.connect();
    await waitFor("the last-run report read", () => session.state.busy === null);
    expect(emulator.instrument.clockSettings).toHaveLength(1);
    expect(emulator.instrument.clockSettings[0]).toMatch(
      /^\d{2}\/\d{2}\/\d{4},\d{2}:\d{2}:\d{2},(AM|PM),[+-]\d{2}:\d{2}$/,
    );
    await session.dispose();
  });

  it("leaves the clock alone while a run is on the block", async () => {
    // A reconnect mid-run is the case: the `.alf` report's per-step timestamps come off the clock
    // being set, and a jump would put a step's measured duration off by the correction.
    const emulator = createCfxEmulator({ data: pcrData(), clock: acceleratedClock() });
    const session = new CfxSession({
      pollMs: 2,
      reconnectDelaysMs: [1],
      acquire: async () => emulator,
    });
    await session.connect();
    await waitFor("the last-run report read", () => session.state.busy === null);
    expect(emulator.instrument.clockSettings).toHaveLength(1);
    await session.startRun(planRun({ runDefinition: TWO_CYCLE, name: "demo" }));
    await waitFor("the run to start", () => session.state.status?.running === true);

    emulator.opened = true;
    drop(emulator);
    await waitFor("the drop to be noticed", () => session.state.connection === "reconnecting");
    emulator.opened = true;
    await waitFor("the reconnect", () => session.state.connection === "connected", 10_000);
    expect(session.state.status?.running).toBe(true);
    expect(emulator.instrument.clockSettings).toHaveLength(1);
    await session.dispose();
  });
});

describe("the busy gate", () => {
  it("stands the poll down for the whole of an operation, and lets it back afterwards", async () => {
    const emulator = createCfxEmulator({ clock: acceleratedClock() });
    const session = sessionOn(emulator, { pollMs: 1 });
    await session.connect();
    await waitFor("the first poll", () => emulator.sent.filter((c) => c === "STATUS?").length > 2);

    const during = await session.run("Holding the channel", async () => {
      const before = emulator.sent.filter((c) => c === "STATUS?").length;
      // Longer than several poll periods: the gate is what keeps them from queueing up behind a
      // `GETFILE` of a plate read and replaying all at once.
      await new Promise((r) => setTimeout(r, 40));
      return emulator.sent.filter((c) => c === "STATUS?").length - before;
    });
    expect(during).toBe(0);
    expect(session.state.busy).toBeNull();

    const after = emulator.sent.filter((c) => c === "STATUS?").length;
    await waitFor("polling to resume", () => emulator.sent.filter((c) => c === "STATUS?").length > after);
    await session.dispose();
  });

  it("reports a failed operation rather than throwing it at the caller", async () => {
    const session = sessionOn(createCfxEmulator({ clock: acceleratedClock() }));
    await session.connect();
    const got = await session.run("Failing", async () => {
      throw new Error("no such thing");
    });
    expect(got).toBeUndefined();
    expect(session.state.error).toBe("no such thing");
    await session.dispose();
  });
});

describe("reconnect is the session's job", () => {
  it("comes back on its own after the pipe dies, on the same recorder", async () => {
    const first = createCfxEmulator({ clock: acceleratedClock() });
    const second = createCfxEmulator({ clock: acceleratedClock() });
    let handed = 0;
    const reasons: string[] = [];
    const session = new CfxSession({
      pollMs: 2,
      // The backoff is the real one's shape — it repeats its last value forever — just short
      // enough that a test isn't waiting out a real outage.
      reconnectDelaysMs: [1, 2],
      acquire: async (reason): Promise<UsbDeviceLike | null> => {
        reasons.push(reason);
        // Two attempts find nothing, exactly as an unplugged device does, before it comes back.
        if (reason === "reconnect" && handed++ < 2) return null;
        return handed === 0 ? first : second;
      },
    });
    await session.connect();
    expect(session.state.connection).toBe("connected");
    const linesBefore = session.state.traffic.length;

    drop(first);
    await waitFor("the drop to be noticed", () => session.state.connection === "reconnecting");
    await waitFor("the reconnect", () => session.state.connection === "connected", 10_000);
    expect(reasons.filter((r) => r === "reconnect").length).toBeGreaterThanOrEqual(3);
    expect(session.state.info?.serial).toBe("CT019138");
    // One session, one recording: the console is the one place a disconnect's cause is visible
    // after the fact, so nothing about it wipes the traffic that led up to it.
    expect(session.state.traffic.length).toBeGreaterThan(linesBefore);
    await session.dispose();
  });

  it("identifies the instrument correctly past a poll the last connection never read", async () => {
    // Disconnect with a `STATUS?` answered but unread: the emulator keeps it queued the way the
    // instrument's pipe does, so the next connection's first read is that status line. Before
    // `*IDN?` turned such a reply away, `info.model` here was the status line's `BLOCK` field.
    const emulator = createCfxEmulator({ clock: acceleratedClock() });
    const session = sessionOn(emulator);
    await session.connect();
    await session.disconnect();
    emulator.push(
      new TextEncoder().encode(
        '18.40;23.8;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;18.40;CLOSED;0;0000\r\n',
      ),
    );
    await session.connect();
    expect(session.state.info).toMatchObject({ manufacturer: "BIO-RAD LABORATORIES", model: "C1000" });
    expect(session.state.info?.frontEndSoftware ?? "").not.toMatch(/;/);
    // The stale line is still in the record — as traffic nobody asked for, not as an answer.
    const staleLine = session.state.traffic.find(
      (l) => l.kind === "message" && l.direction === "in" && /18\.40;23\.8/.test(l.text ?? ""),
    );
    expect(staleLine).toMatchObject({ unsolicited: true });
    await session.dispose();
  });

  it("does not reconnect after a disconnect that was asked for", async () => {
    const emulator = createCfxEmulator({ clock: acceleratedClock() });
    let acquires = 0;
    const session = new CfxSession({
      pollMs: 2,
      reconnectDelaysMs: [1],
      acquire: async () => {
        acquires++;
        return emulator;
      },
    });
    await session.connect();
    await session.disconnect();
    expect(session.state.connection).toBe("disconnected");
    await new Promise((r) => setTimeout(r, 20)); // negative assertion: nothing should happen
    expect(acquires).toBe(1);
    expect(session.state.status).toBeNull();
    await session.dispose();
  });
});

describe("the traffic window", () => {
  it("records a hidden poll without publishing it, and un-hiding brings it back", async () => {
    const emulator = createCfxEmulator({ clock: acceleratedClock() });
    const session = sessionOn(emulator, { pollMs: 1 });
    await session.connect();
    await waitFor("the first poll", () => emulator.sent.filter((c) => c === "STATUS?").length > 3);
    await waitFor("the connect burst to settle", () => session.state.busy === null);

    // Hidden polls are the *only* traffic an idle instrument produces, so the published window has
    // to come back **the same array** poll after poll: a console subscribed to it then re-renders
    // not at all, which is what hiding at capture time buys over filtering at render time.
    const before = session.state.traffic;
    const shown = before.length;
    await waitFor("several more polls", () => emulator.sent.filter((c) => c === "STATUS?").length > 10);
    expect(session.state.traffic).toBe(before);

    session.setHidePolls(false);
    expect(session.state.traffic.some((l) => l.kind === "message" && l.text === "STATUS?")).toBe(true);
    // And turning it back on drops them again, so the display is a pure function of the flag.
    session.setHidePolls(true);
    expect(session.state.traffic.length).toBe(shown);
    await session.dispose();
  });

  it("attaches a log to a run only when asked, and never an empty one", async () => {
    const session = sessionOn(createCfxEmulator({ clock: acceleratedClock() }));
    expect(session.trafficLogForRun()).toBeNull(); // nothing recorded yet, and the switch is off
    session.setSaveLog(true);
    expect(session.trafficLogForRun()).toBeNull(); // asked for, but there is nothing to give
    await session.connect();
    expect(session.trafficLogForRun()!.length).toBeGreaterThan(8);
    expect(formatUsbTrafficBytes(session.trafficLogBytes())).toContain("STATUS?");
    session.setSaveLog(false);
    expect(session.trafficLogForRun()).toBeNull();
    // The download is the recording itself, switch or no switch: the switch decides what a run's
    // file keeps, not what a download button can write.
    expect(session.trafficLogBytes().length).toBeGreaterThan(8);
    await session.dispose();
  });

  it("clears the view without touching the recording", async () => {
    const session = sessionOn(createCfxEmulator({ clock: acceleratedClock() }));
    session.setSaveLog(true);
    await session.connect();
    session.setHidePolls(false);
    expect(session.state.traffic.length).toBeGreaterThan(0);
    const recorded = session.trafficLogForRun()!.length;
    session.clearTraffic();
    expect(session.state.traffic).toEqual([]);
    expect(session.trafficLogForRun()!.length).toBe(recorded);
    await session.dispose();
  });
});

describe("the run folder is derived, not stored twice", () => {
  it("reads back out of the directory map the listing landed in", async () => {
    const emulator = createCfxEmulator({
      clock: acceleratedClock(),
      initialRunFolder: { begun: new Uint8Array(0), "Read00001.Plateread": new Uint8Array(4) },
    });
    const session = sessionOn(emulator);
    await session.connect();
    expect(session.state.runFolder).toBeNull();
    await session.refreshRunFolder();
    expect(session.state.runFolder?.names).toContain("begun");
    expect(session.state.directories["\\Storage Card\\CurrentRun"]).toBe(session.state.runFolder);
    expect(session.state.runProgress).toMatchObject({ plateReads: 1, inProgress: true });
    await session.dispose();
  });
});
