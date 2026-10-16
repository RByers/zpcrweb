/**
 * A *session* with a CFX96: one connection, kept alive.
 *
 * `CfxDevice` (`device.ts`) speaks the protocol; it knows nothing about staying connected. This
 * adds everything a client needs on top of a device handle and nothing that needs a browser:
 *
 * - **the status poll**, one long-lived timer, and the `busy` gate that keeps it out of the way of
 *   a file transfer;
 * - **reconnect**, with the backoff in {@link RECONNECT_DELAYS_MS} — this used to be the app's job,
 *   and is now the session's;
 * - **the traffic log**, in its two forms: the always-on binary recording that a run's `.zpcr`
 *   carries, and the capped, poll-filtered window a debug console renders;
 * - the accumulated view of the instrument — identity, status, listings, the run report it holds.
 *
 * It is framework-free and browser-free on purpose: the one thing only a browser can do is *find*
 * a device, so that is the single {@link CfxSessionOptions.acquire} callback, and everything else
 * here is driven in `packages/core/test/session.test.ts` against the emulator with no DOM at all.
 *
 * State is published the way `useSyncExternalStore` wants it: {@link CfxSession.subscribe} and a
 * {@link CfxSession.state} snapshot that is a new object only when something actually changed.
 */
import { CFX_DIRECTORIES } from "./commands.js";
import { CFX_CURRENT_RUN_DIR } from "./runPlan.js";
import {
  CfxDevice,
  runNotStartedNote,
  type CfxTrafficEvent,
  type CfxTransferErrorEvent,
} from "./device.js";
import { isFinishedRun } from "./status.js";
import { UsbTrafficRecorder } from "../usbTraffic.js";
import { usbTrafficPreview } from "../usbTraffic.js";
import { parseAlf, type AlfReport } from "../alf.js";
import { runProgressFromNames, type RunProgress } from "../runFolder.js";
import type { CfxCommandName } from "./commands.js";
import type { CfxDirectory, CfxRunStartResult } from "./device.js";
import type { CfxResponse } from "./commands.js";
import type { CfxDeviceInfo, CfxRtStatus, CfxStatus } from "./status.js";
import type { RunPlan } from "./runPlan.js";
import type { UsbDeviceLike } from "./transport.js";

/** How many messages the debug console keeps in view. A 1.5 s poll writes six lines a minute. */
const TRAFFIC_LIMIT = 400;
/** How many lines the session buffers in all — including the poll chatter the display is hiding,
 * so that un-hiding polls recovers a window's worth of them rather than starting empty. At six
 * lines per 1.5 s poll this is around fifteen minutes of an idle instrument. Capped, unlike the
 * recording, because it is kept whether or not anyone asked for a log. */
const BUFFER_LIMIT = 4000;
/** Status poll period. CFX Manager polls about once a second; this is deliberately slower, since
 * nothing here needs sub-second latency and every poll is three lines of console noise. */
const POLL_MS = 1500;
/** The three status queries the poll repeats forever. Suppressing them is what makes the debug
 * console usable for watching anything else — see {@link CfxSession.setHidePolls}. */
const POLL_COMMANDS = /^(STATUS\?|RTSTATUS\?|ERRORLIST A)/;

/**
 * Backoff between reconnect attempts after the connection dropped on its own, in ms; the last
 * value repeats for as long as it takes.
 *
 * It repeats rather than giving up because the case this exists for is a *run in progress*: the
 * instrument goes on cycling whatever the host does, so the only thing a dropped pipe costs is our
 * view of it, and a run is hours long. Retrying forever is cheap and quiet — while the device is
 * unplugged {@link CfxSessionOptions.acquire} simply answers null, so an attempt is one resolved
 * promise and no error — and {@link CfxSession.reconnectNow} short-circuits the wait whenever the
 * caller notices the device come back.
 */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** One decoded message, pre-formatted for display — one kind of line in the debug console. */
export interface TrafficLine {
  kind: "message";
  id: number;
  at: number;
  direction: "out" | "in";
  channel: number;
  unsolicited: boolean;
  /** The payload as text, or `null` when it is binary and must be shown as {@link TrafficLine.hex}. */
  text: string | null;
  hex: string;
  bytes: number;
  /** Part of the status poll — see {@link POLL_COMMANDS}. Classified here, on arrival, rather
   * than by whoever renders the line: a reply carries no copy of its request, so the only place
   * the question is cheap to answer is the point where the lines stream past in wire order. */
  poll: boolean;
}

/** A `transferIn`/`transferOut` failure — the console's other kind of line, interleaved with
 * {@link TrafficLine} in wire order so a retry shows up exactly where it interrupted the
 * conversation. See `CfxTransferErrorEvent`'s doc comment for why this exists: a retry the pump
 * recovered from used to leave no trace anywhere a caller could see. */
export interface TransferErrorLine {
  kind: "error";
  id: number;
  at: number;
  direction: "out" | "in";
  message: string;
  attempt: number;
  fatal: boolean;
  /** Always false. A transfer error has no request/reply relationship to filter by, and it is
   * exactly the kind of thing "hide polling" shouldn't hide. */
  poll: false;
}

export type ConsoleLine = TrafficLine | TransferErrorLine;

/** The result of an action button, kept so the view can report what the instrument answered —
 * including a rejection, which for an `unverified` command is the expected outcome. */
export interface ActionResult {
  label: string;
  command: string;
  ok: boolean;
  code: string;
  raw: string;
  at: number;
}

/**
 * The `.alf` the instrument is currently holding in `\Storage Card\PCRunReport` — the last run it
 * ran, whoever started it and whatever it produced (see {@link CfxSession.refreshLastReport}).
 *
 * Kept as bytes as well as a decode: the bytes are what "Open report" hands to the file bar, so
 * the file the user ends up with is the instrument's, byte for byte, rather than a re-rendering of
 * our parse of it. `report` is null when those bytes don't decode as a report, which leaves the
 * panel able to say a report is there without claiming to have read it.
 */
export interface LastRunReport {
  name: string;
  bytes: Uint8Array;
  report: AlfReport | null;
}

/** Everything a view renders, as one immutable snapshot — see {@link CfxSession.state}. */
export interface CfxSessionState {
  connection: ConnectionState;
  error: string | null;
  info: CfxDeviceInfo | null;
  status: CfxStatus | null;
  rtStatus: CfxRtStatus | null;
  /** The display window — capped, and without poll chatter while {@link hidePolls} is set. */
  traffic: ConsoleLine[];
  /** True once anything at all has been recorded, so a download button knows it has something. */
  hasTraffic: boolean;
  saveLog: boolean;
  hidePolls: boolean;
  polling: boolean;
  directories: Record<string, CfxDirectory>;
  busy: string | null;
  lastAction: ActionResult | null;
  lastReport: LastRunReport | null;
  /** The last listing of `CurrentRun`, derived from {@link directories} rather than stored twice. */
  runFolder: CfxDirectory | null;
  /** What that listing says about the run's progress — derived, never stored. */
  runProgress: RunProgress | null;
}

type SessionFields = Omit<CfxSessionState, "traffic" | "runFolder" | "runProgress">;

export interface CfxSessionOptions {
  /**
   * Hand back a device to connect to, or null when there is none — which is not an error: on a
   * `"connect"` it means the user declined the picker, and on a `"reconnect"` it means the cable
   * is still out and we should wait and look again.
   *
   * The one thing in here that a browser does differently from a test, and the reason it is a
   * callback rather than a class to implement.
   */
  acquire: (reason: "connect" | "reconnect") => Promise<UsbDeviceLike | null>;
  pollMs?: number;
  reconnectDelaysMs?: readonly number[];
  /** Whether a finished run's `.zpcr` starts out carrying the recorded log — see
   * {@link CfxSession.setSaveLog}. Passed in because *remembering* the answer across page loads is
   * the caller's business, and forgetting it mid-run is how a log goes missing. */
  saveLog?: boolean;
  hidePolls?: boolean;
}

export class CfxSession {
  readonly #acquire: CfxSessionOptions["acquire"];
  readonly #pollMs: number;
  readonly #reconnectDelays: readonly number[];
  readonly #listeners = new Set<() => void>();

  #device: CfxDevice | null = null;
  /** True while the caller wants to be connected — set by {@link connect}, cleared by
   * {@link disconnect} and by a connect that failed. This is the whole difference between "the
   * pipe died, get it back" and "the user pressed Disconnect", both of which reach `onClose`. */
  #wantConnected = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many attempts the current outage has cost, indexing {@link CfxSessionOptions.reconnectDelaysMs}. */
  #reconnectAttempt = 0;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  // The session's complete record, as binary items (`usb-traffic.md`) rather than console lines:
  // it is unbounded in time, so it is stored in the form that costs ~16 bytes per message instead
  // of the ~85-byte line one renders to. Unaffected by `clearTraffic`, which resets the view only.
  // This is what a download button writes and what a run's `.zpcr` carries — both want the
  // complete record, not the display window.
  readonly #recorder = new UsbTrafficRecorder();
  // Whether the last outbound *message* was a poll query, which is how an inbound reply is
  // classified: it carries no copy of the request it answers.
  #lastOutWasPoll = false;
  #trafficId = 0;
  /**
   * Every console line, polls included, capped at {@link BUFFER_LIMIT}; {@link #displayed} is the
   * filtered, display-capped view of it, rebuilt lazily.
   *
   * One buffer rather than two. Hiding polls is done **here, on arrival**, and that placement is
   * the whole point of the flag: filtering at render time still pushed every poll line into the
   * published state, so a 1.5 s poll re-rendered the console and re-ran its follow-scroll six
   * times a minute for lines that were then thrown away. A hidden poll now notifies nobody, while
   * the recorder still takes it, so the downloaded log and the copy in a run's `.zpcr` are
   * complete either way — and because the lines are still *here*, un-hiding recovers them without
   * a second list to keep in step.
   */
  #lines: ConsoleLine[] = [];
  #displayed: ConsoleLine[] | null = null;
  /** How many of {@link #lines} pass the current filter, so an eviction knows whether it changed
   * what is on screen. */
  #visible = 0;

  #snapshot: CfxSessionState | null = null;
  /** The stored half of {@link CfxSessionState}; the rest of it is derived in {@link state}. */
  #state: SessionFields = {
    connection: "disconnected" as ConnectionState,
    error: null as string | null,
    info: null as CfxDeviceInfo | null,
    status: null as CfxStatus | null,
    rtStatus: null as CfxRtStatus | null,
    hasTraffic: false,
    saveLog: false,
    hidePolls: true,
    polling: true,
    directories: {} as Record<string, CfxDirectory>,
    busy: null as string | null,
    lastAction: null as ActionResult | null,
    lastReport: null as LastRunReport | null,
  };

  constructor(options: CfxSessionOptions) {
    this.#acquire = options.acquire;
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#reconnectDelays = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.#state.saveLog = options.saveLog ?? false;
    this.#state.hidePolls = options.hidePolls ?? true;
  }

  // --- publishing ------------------------------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** The current snapshot. Identity-stable until something changes, which is what
   * `useSyncExternalStore` requires of it. */
  get state(): CfxSessionState {
    if (!this.#snapshot) {
      const runFolder = this.#state.directories[CFX_CURRENT_RUN_DIR] ?? null;
      this.#snapshot = {
        ...this.#state,
        traffic: this.#display(),
        runFolder,
        // Derived rather than stored: `runFolder` used to be a second copy of this listing, kept
        // in step by hand.
        runProgress: runFolder?.listed ? runProgressFromNames(runFolder.names) : null,
      };
    }
    return this.#snapshot;
  }

  #changed(): void {
    this.#snapshot = null;
    for (const fn of this.#listeners) fn();
  }

  #set(patch: Partial<SessionFields>): void {
    let any = false;
    for (const [k, v] of Object.entries(patch)) {
      if ((this.#state as Record<string, unknown>)[k] !== v) {
        (this.#state as Record<string, unknown>)[k] = v;
        any = true;
      }
    }
    if (any) this.#changed();
  }

  // --- the traffic window ----------------------------------------------------------------------

  #shown(line: ConsoleLine): boolean {
    return !(this.#state.hidePolls && line.poll);
  }

  #display(): ConsoleLine[] {
    if (!this.#displayed) {
      const shown = this.#lines.filter((l) => this.#shown(l));
      this.#displayed = shown.length > TRAFFIC_LIMIT ? shown.slice(shown.length - TRAFFIC_LIMIT) : shown;
    }
    return this.#displayed;
  }

  #push(line: ConsoleLine): void {
    this.#lines.push(line);
    // Nothing below changes what is on screen unless this says so — a hidden poll arrives, is
    // recorded, and notifies nobody.
    let dirty = this.#shown(line);
    if (dirty) this.#visible++;
    if (this.#lines.length > BUFFER_LIMIT) {
      const dropped = this.#lines.shift()!;
      if (this.#shown(dropped)) {
        this.#visible--;
        // Only an eviction from inside the display window actually changes the screen.
        if (this.#visible < TRAFFIC_LIMIT) dirty = true;
      }
    }
    if (!this.#state.hasTraffic) {
      this.#state.hasTraffic = true;
      dirty = true;
    }
    if (!dirty) return;
    this.#displayed = null;
    this.#changed();
  }

  /** Classify one arriving message against the poll vocabulary, and remember the answer for the
   * reply that follows it. Outbound messages only update the memo — a transfer error goes past
   * without disturbing which request is still outstanding. */
  #classifyPoll(direction: "out" | "in", text: string | null): boolean {
    if (direction === "in") return this.#lastOutWasPoll;
    this.#lastOutWasPoll = text !== null && POLL_COMMANDS.test(text);
    return this.#lastOutWasPoll;
  }

  #onTraffic = (e: CfxTrafficEvent): void => {
    // What the console *shows*: the trimmed decode and the hex, both cut to one line for a long
    // response (`usbTrafficPreview`, shared with the text rendering so the two agree). A `GETFILE`
    // reply is a whole file, and putting it in a console line verbatim swamped the panel and
    // parked megabytes of unreadable hex in state; the recorder below still takes every byte, so
    // nothing is lost but the display of it.
    const shown = usbTrafficPreview(e);
    const poll = this.#classifyPoll(e.direction, shown.text);
    // The recorder takes the event as the device reported it — `e.text` and the whole payload, not
    // the previewed pair above: what it stores is every byte, plus "did the device offer a decode
    // at all", and both the trimming and the elision are display choices re-applied at format time.
    this.#recorder.message({
      at: e.at,
      direction: e.direction,
      channel: e.channel,
      payload: e.payload,
      text: e.text,
      unsolicited: e.unsolicited,
      poll,
    });
    this.#push({
      kind: "message",
      id: this.#trafficId++,
      at: e.at,
      direction: e.direction,
      channel: e.channel,
      unsolicited: e.unsolicited,
      text: shown.text,
      hex: shown.hex,
      bytes: e.payload.length,
      poll,
    });
  };

  #onTransferError = (e: CfxTransferErrorEvent): void => {
    this.#recorder.error(e);
    this.#push({
      kind: "error",
      id: this.#trafficId++,
      at: e.at,
      direction: e.direction,
      message: e.message,
      attempt: e.attempt,
      fatal: e.fatal,
      poll: false,
    });
  };

  /** Clear the console. The *view* only: a running recording keeps every line it has taken, since
   * clearing the screen to watch the next exchange is not a request to throw away the transcript
   * being kept for the run's `.zpcr`. */
  clearTraffic(): void {
    this.#lines = [];
    this.#visible = 0;
    this.#displayed = null;
    this.#changed();
  }

  /**
   * Turn poll suppression on or off.
   *
   * Rebuilding the display in both directions rather than only when un-hiding keeps the result a
   * pure function of the flag — turning it on drops the polls already on screen, which is what
   * "hide polling" is asked for in the first place.
   */
  setHidePolls(hide: boolean): void {
    if (this.#state.hidePolls === hide) return;
    this.#state.hidePolls = hide;
    this.#visible = this.#lines.reduce((n, l) => n + (this.#shown(l) ? 1 : 0), 0);
    this.#displayed = null;
    this.#changed();
  }

  /**
   * Choose whether a finished run's `.zpcr` carries the recorded log.
   *
   * Recording itself is not a choice — it always happens, so a download button always has a
   * complete session behind it and a problem noticed after the fact is still recoverable. What
   * this decides is the copy that *persists*: the entry attached to the run's file, which outlives
   * the session and takes up disk wherever that file goes.
   *
   * Read at the moment the log is attached rather than while recording, so switching it on
   * part-way through a run still saves the whole run — including everything that happened before
   * the switch was touched. Switching it off before the run ends leaves the file without the entry
   * entirely; nothing is half-saved.
   */
  setSaveLog(on: boolean): void {
    this.#set({ saveLog: on });
  }

  /**
   * The log to attach to a run's `.zpcr`, or null for "attach nothing" — the one place both
   * conditions are decided, so the run follower doesn't have to know either of them.
   *
   * Null when {@link setSaveLog} is off, and null for an empty recording: a session that saw no
   * traffic (the run was watched but the instrument was driven by someone else, say) is worth no
   * entry rather than an 8-byte header nobody can learn anything from.
   */
  trafficLogForRun(): Uint8Array | null {
    return this.#state.saveLog && !this.#recorder.isEmpty ? this.#recorder.bytes() : null;
  }

  /**
   * The whole session's log as stored — the `usb-traffic.bin` records, every byte of every
   * message — for a download button. Always available, since recording is unconditional, and
   * independent of the "save log" switch, which decides only what a run's `.zpcr` keeps.
   *
   * Bytes rather than text on purpose: the text rendering previews a long response rather than
   * spelling it out (`usbTrafficPreview`), so a downloaded text log could never answer "was this
   * transfer corrupt?" — the question a traffic log exists for. The text is what the Raw files
   * view shows for the file once it is loaded back.
   */
  trafficLogBytes(): Uint8Array {
    return this.#recorder.bytes();
  }

  // --- connecting ------------------------------------------------------------------------------

  setPolling(on: boolean): void {
    this.#set({ polling: on });
  }

  #teardown(next: ConnectionState = "disconnected"): void {
    this.#device = null;
    // No request is outstanding across a disconnect, so the next reply must not be classified by
    // whatever the last session happened to have sent.
    this.#lastOutWasPoll = false;
    this.#set({
      connection: next,
      info: null,
      status: null,
      rtStatus: null,
      directories: {},
      busy: null,
      // Read from the instrument at connect and true only of the instrument that was on the other
      // end: a different unit — or the same one after someone ran something at its touchscreen —
      // must not be described by the last one's report.
      lastReport: null,
    });
  }

  /**
   * Open a device handle and bring the session up on it. Shared by {@link connect} and the
   * reconnect loop, so a recovered connection is the same connection in every respect — same
   * traffic recorder, same poll, same identity refresh — rather than a second path that drifts
   * from this one.
   */
  async #openDevice(chosen: UsbDeviceLike): Promise<void> {
    // Set when this handle is abandoned below, before it is closed. Closing fires `onClose`, and
    // without this the cleanup of a *failed* attempt would report the session as disconnected —
    // racing, and usually winning against, the "reconnecting" the caller sets straight after.
    let abandoned = false;
    const device = new CfxDevice(chosen, {
      onTraffic: this.#onTraffic,
      onTransferError: this.#onTransferError,
      onClose: (err) => {
        if (abandoned) return;
        if (err) {
          // The library already logs the retries and the final failure; this adds the one thing it
          // can't know — what the session is about to do about it — so a console shows cause and
          // effect together rather than an isolated stack trace.
          console.error("[CfxSession] device closed unexpectedly:", err);
          this.#set({ error: err.message });
        }
        // An error close while the caller still wants a connection is the reconnect case. An
        // ordinary one is `disconnect()`, which has already cleared the flag.
        if (err && this.#wantConnected) {
          this.#teardown("reconnecting");
          this.#scheduleReconnect();
        } else {
          this.#teardown();
        }
      },
    });
    await device.open();
    this.#device = device;
    try {
      this.#set({ connection: "connected" });
      this.#set({ info: await device.deviceInfo() });
      this.#set({ status: await device.status() });
      try {
        this.#set({ rtStatus: await device.rtStatus() });
      } catch {
        /* the poll will catch up */
      }
      // Set the instrument's clock and zone offset from this machine's, as CFX Manager does on
      // every connection (`usb.md` §3). Left alone the instrument assumes Pacific, and every
      // `RunStartTime` it then writes is hours in the future (`alf.md` §4.1). Only when idle: the
      // `.alf` report's per-step timestamps come off this same clock, and a jump mid-run would
      // put a step's duration (next line minus this one, `alf.md` §7.4) off by the correction.
      // Best effort — a refusal costs nothing the connection needs.
      if (this.state.status?.phase === "idle") {
        try {
          await device.setClock();
        } catch (e) {
          console.warn("[CfxSession] SetDateTime was not accepted:", e);
        }
      }
    } catch (e) {
      // A handle that opened but failed partway through identification is no good to anyone.
      // Closing it here — rather than leaving it to whoever called — is what keeps a failed
      // reconnect attempt from stranding a claimed interface the next attempt then can't take.
      abandoned = true;
      this.#device = null;
      await device.close().catch(() => undefined);
      throw e;
    }
    this.#startPolling();
    // Read the report the instrument is holding once per connection — see `refreshLastReport`. A
    // reconnect mid-run runs it afresh, which is right: the directory may have changed while the
    // pipe was down.
    void this.refreshLastReport();
  }

  async connect(): Promise<void> {
    this.#closed = false;
    this.#set({ error: null });
    this.cancelReconnect();
    this.#wantConnected = true;
    this.#set({ connection: "connecting" });
    try {
      const chosen = await this.#acquire("connect");
      if (!chosen) {
        // Declined, or nothing there. Not an error worth shouting.
        this.#wantConnected = false;
        this.#set({ connection: "disconnected" });
        return;
      }
      await this.#openDevice(chosen);
    } catch (e) {
      console.error("[CfxSession] connect() failed:", e);
      this.#set({ error: e instanceof Error ? e.message : String(e) });
      this.#wantConnected = false;
      this.#device = null;
      this.#set({ connection: "disconnected" });
    }
  }

  async disconnect(): Promise<void> {
    // Clear the intent first: the `close()` below fires `onClose`, and this is what tells that
    // handler the drop was asked for rather than something to undo.
    this.#wantConnected = false;
    this.cancelReconnect();
    this.#stopPolling();
    const d = this.#device;
    // No device but a live intent is the reconnecting state — Disconnect must still end it.
    if (!d) {
      this.#teardown();
      return;
    }
    await d.close();
    this.#teardown();
  }

  /** Close the interface and stand the session down. A pending reconnect goes with it: one
   * firing after the owner has gone would re-claim an interface nobody is watching any more.
   * `connect()` brings a disposed session back — React's StrictMode runs an effect's cleanup
   * once on mount, against a session held in a ref that outlives it, so a dispose that was
   * final would leave the one session the page has unable to reconnect on its own. */
  async dispose(): Promise<void> {
    this.#closed = true;
    this.#wantConnected = false;
    this.cancelReconnect();
    this.#stopPolling();
    const d = this.#device;
    this.#device = null;
    await d?.close().catch(() => undefined);
  }

  /** Drop any pending reconnect and reset the backoff, so the next outage starts at the short
   * delay again rather than wherever the last one left off. */
  cancelReconnect(): void {
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#reconnectAttempt = 0;
  }

  #scheduleReconnect(): void {
    if (this.#closed || !this.#wantConnected || this.#reconnectTimer !== null) return;
    const i = Math.min(this.#reconnectAttempt, this.#reconnectDelays.length - 1);
    this.#reconnectAttempt++;
    this.#reconnectTimer = setTimeout(() => void this.reconnectNow(), this.#reconnectDelays[i]);
  }

  /**
   * One reconnect attempt, scheduled after the pipe died on its own — and callable directly, which
   * is what turns "wait out the rest of the backoff" into "reconnect the moment the cable is
   * back" when the caller has an event saying so (`navigator.usb`'s `connect`).
   *
   * {@link CfxSessionOptions.acquire} is asked with `"reconnect"`, which must never put a picker
   * up: one needs a user gesture and would throw here. What makes an automatic reconnect possible
   * at all is that permission persists — a device already granted comes back with no prompt.
   */
  async reconnectNow(): Promise<void> {
    this.#reconnectTimer = null;
    if (this.#closed || !this.#wantConnected || this.#device) return;
    try {
      const chosen = await this.#acquire("reconnect");
      if (!chosen) {
        // Still unplugged, or not yet re-enumerated. Not an error — wait and look again.
        this.#scheduleReconnect();
        return;
      }
      await this.#openDevice(chosen);
      this.#reconnectAttempt = 0;
      this.#set({ error: null });
      console.info("[CfxSession] reconnected");
    } catch (e) {
      // Expected while the instrument is still coming back — say so quietly and try again.
      console.warn("[CfxSession] reconnect attempt failed:", e);
      this.#teardown("reconnecting");
      this.#scheduleReconnect();
    }
  }

  // --- the poll --------------------------------------------------------------------------------

  /**
   * One long-lived timer for the life of the connection, reading {@link CfxSessionState.busy} and
   * {@link CfxSessionState.polling} as fields.
   *
   * The app's version restarted its interval on every change to either, so a burst of listings
   * could defer a poll indefinitely and the interval's phase was never stable. A tick that simply
   * declines to run is both simpler and more reliable — and declining is the point: a `GETFILE` of
   * a plate read would otherwise queue several polls behind it and replay them all at once.
   */
  #startPolling(): void {
    this.#stopPolling();
    this.#pollTimer = setInterval(() => void this.#tick(), this.#pollMs);
  }

  #stopPolling(): void {
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  async #tick(): Promise<void> {
    const d = this.#device;
    if (!d || !this.#state.polling || this.#state.busy) return;
    try {
      this.#set({ status: await d.status() });
    } catch (e) {
      // A transient failure is not worth tearing the connection down over — the read pump already
      // retries and, if it can't recover, fires `onClose` on its own — but log it so a string of
      // these leading up to a disconnect shows up in the same console as the cause.
      console.warn("[CfxSession] status poll failed:", e);
    }
    if (this.#device !== d || this.#state.busy) return;
    try {
      this.#set({ rtStatus: await d.rtStatus() });
    } catch (e) {
      console.warn("[CfxSession] rtStatus poll failed:", e);
    }
  }

  /**
   * Re-read `STATUS?` now, because something just changed what it will say.
   *
   * Every operation that actuates the instrument ends here — starting or stopping a run, pausing
   * one, moving the lid, acknowledging a finished run. Waiting a poll period for the answer looks
   * like a failure to the person who pressed the button, and a failure to read it is nothing to
   * report: the poll will catch up.
   */
  async refreshStatusNow(): Promise<void> {
    const d = this.#device;
    if (!d) return;
    try {
      this.#set({ status: await d.status() });
    } catch {
      /* the poll will catch up */
    }
  }

  // --- operations ------------------------------------------------------------------------------

  /**
   * Run `fn` with the busy flag set, so the poll and the buttons stand back. Undefined when there
   * is no device, or when the operation failed — in which case {@link CfxSessionState.error}
   * carries the reason.
   */
  async run<T>(what: string, fn: (d: CfxDevice) => Promise<T>): Promise<T | undefined> {
    const d = this.#device;
    if (!d) return undefined;
    this.#set({ busy: what, error: null });
    try {
      return await fn(d);
    } catch (e) {
      console.error(`[CfxSession] ${what} failed:`, e);
      this.#set({ error: e instanceof Error ? e.message : String(e) });
      return undefined;
    } finally {
      this.#set({ busy: null });
    }
  }

  /** Re-label the operation in flight — for a long sequence that counts its way through. */
  progress(what: string): void {
    if (this.#state.busy !== null) this.#set({ busy: what });
  }

  async refreshDirectory(path: string): Promise<void> {
    const dir = await this.run(`Listing ${path}`, (d) => d.listFiles(path));
    if (dir) this.#set({ directories: { ...this.#state.directories, [path]: dir } });
  }

  async refreshAll(): Promise<void> {
    for (const d of CFX_DIRECTORIES) await this.refreshDirectory(d.path);
  }

  async fetchFile(dir: string, name: string): Promise<Uint8Array | undefined> {
    return this.run(`Fetching ${name}`, (d) => d.getFile(`${dir}\\${name}`));
  }

  /**
   * Pull every named file out of one directory, as `name → bytes`. Sequential by necessity: the
   * command channel carries one request at a time (see `CfxDevice.sequence`), and a `CurrentRun`
   * is ~40 files, so the busy label counts them off rather than sitting on one opaque message.
   *
   * A file that fails is dropped rather than failing the whole set: the caller (assembling a
   * `.zpcr`) validates what it got, and one unreadable marker file shouldn't cost a run its
   * plate reads.
   */
  async fetchDirectoryFiles(
    path: string,
    names: readonly string[],
  ): Promise<Record<string, Uint8Array> | undefined> {
    return this.run(`Fetching ${names.length} files`, async (d) => {
      const files: Record<string, Uint8Array> = {};
      for (const [i, name] of names.entries()) {
        this.progress(`Fetching ${name} (${i + 1}/${names.length})`);
        try {
          files[name] = await d.getFile(`${path}\\${name}`);
        } catch {
          /* keep going; the caller reports what's missing */
        }
      }
      return files;
    });
  }

  /**
   * Re-list `\Storage Card\CurrentRun` and report what it holds — how the app notices a new plate
   * read. The listing lands in {@link CfxSessionState.directories} like any other, and
   * {@link CfxSessionState.runFolder} and `runProgress` are derived from it there.
   */
  async refreshRunFolder(): Promise<CfxDirectory | undefined> {
    const dir = await this.run("Checking the run", (d) => d.listFiles(CFX_CURRENT_RUN_DIR));
    if (dir) this.#set({ directories: { ...this.#state.directories, [CFX_CURRENT_RUN_DIR]: dir } });
    return dir;
  }

  /**
   * Start the staged run: pre-flight, author the protocol, `RemoteRun`, deposit the files
   * (`usb.md` §7).
   *
   * Everything about *what* is sent was decided by `planRun` before this is called. This adds a
   * progress label while the sequence runs and a re-read of `STATUS?` afterwards, since a run that
   * has just started changes what a rail shows and waiting a poll period for it looks like a
   * failure.
   *
   * Note that the block does *not* start heating immediately — §7.3 measures ~3 minutes of lid
   * heating first, during which nothing appears to happen.
   */
  async startRun(plan: RunPlan): Promise<CfxRunStartResult | undefined> {
    // Whatever the last action-button command reported (e.g. a stale "CANCEL → accepted") is about
    // to be answered by a new run's own status — starting one is exactly the moment that readout
    // stops being relevant, so it shouldn't linger through it.
    //
    // The first thing a start does is empty `PCRunReport` (`usb.md` §7.1), so the report shown as
    // "the last run" is about to stop existing. Drop it here rather than leaving a panel
    // describing a file that has been deleted; the run being started writes the next one, and
    // `refreshLastReport` picks that up when it finishes.
    this.#set({ lastAction: null, lastReport: null });
    const progress = (what: string) => this.progress(what);
    // `CfxDevice.startRun`'s three phases, taken separately so the device isn't held while the
    // run comes up: the wait is ~12 s, and it is the start window, where Stop has to work (it is
    // disabled while `busy`, and `cancelRun`'s `expectStart` exists for exactly this stretch).
    const begun = await this.run("Starting run", async (d) => {
      await d.beginRun(plan, progress);
      return true;
    });
    if (!begun) return undefined;
    let result: CfxRunStartResult = { uploads: [], uploadErrors: [] };
    const device = this.#device;
    if (device && plan.uploads.length > 0) {
      // Not inside `run`: `STATUS?` is one command, so this interleaves safely with the poll and
      // with a Stop. It publishes what it reads, the way `cancelRun`'s `onStatus` does.
      let started: CfxStatus | null = null;
      try {
        started = await device.awaitRunStart({ onStatus: (s) => this.#set({ status: s }) });
      } catch (e) {
        console.error("[CfxSession] waiting for the run to start failed:", e);
      }
      result = started
        ? ((await this.run("Copying the run's files", (d) => d.depositRunFiles(plan, progress))) ??
          result)
        : { uploads: [], uploadErrors: [runNotStartedNote(plan)] };
    }
    await this.refreshStatusNow();
    return result;
  }

  /**
   * Stop the run in progress — `usb.md` §7.8, driven by `CfxDevice.cancelRun`.
   *
   * `expectStart` says a run has been asked for that `STATUS?` will not admit to for a few seconds
   * yet, which is exactly the window where a plain `CANCEL` is accepted and ignored. `onStatus`
   * keeps the published status live through the operation: `run` stands the poll down for the
   * duration, and a cancel can legitimately take a while (a plate read in flight is allowed to
   * finish), so a rail would otherwise freeze on a stale reading through the one operation the
   * user is most anxious to watch.
   *
   * Deliberately stops at §7.6's finished state rather than driving all the way to the empty-name
   * idle: the acknowledgement is what makes the last read, `ended` and the `.alf` appear, and the
   * run follower already owns that so the partial run still gets collected and filed.
   */
  async cancelRun(options: { expectStart?: boolean; force?: boolean } = {}) {
    return this.run("Stopping the run", (d) =>
      d.cancelRun({
        expectStart: options.expectStart || this.#state.status?.running === true,
        force: options.force,
        onStatus: (s) => this.#set({ status: s }),
      }),
    );
  }

  /** `PAUSE`/`RESUME` — suspend or continue the running protocol (`usb.md` §7.9). */
  async setRunPaused(paused: boolean): Promise<CfxResponse | undefined> {
    const res = await this.run(paused ? "Pausing the run" : "Resuming the run", (d) =>
      paused ? d.pauseRun() : d.resumeRun(),
    );
    // The pause bit is the whole feedback this has; don't make the user wait a poll for it.
    if (res) await this.refreshStatusNow();
    return res;
  }

  /**
   * `CANCEL` a run the instrument has finished but is still holding (`usb.md` §7.6).
   *
   * Guarded on the status this is *only* correct for ({@link isFinishedRun}): a completed protocol
   * leaves `STATUS?` reporting `IDLE` with the run's name still attached, and acknowledging that
   * releases the instrument and makes the final plate read, the `ended` marker and the `.alf`
   * report appear. The same command sent to a run still cycling would abort it, which is why the
   * check is here rather than trusted to the caller.
   */
  async acknowledgeFinishedRun(): Promise<boolean> {
    const current = this.#state.status;
    if (!current || !isFinishedRun(current)) return false;
    const res = await this.run("Acknowledging the finished run", (d) => d.acknowledgeRun());
    if (res) await this.refreshStatusNow();
    return res !== undefined;
  }

  async runAction(name: CfxCommandName, spec: { label: string; command: string }) {
    const res = await this.run(spec.label, (d) => d.runAction(name));
    if (res) {
      this.#set({
        lastAction: { label: spec.label, command: spec.command, ok: res.ok, code: res.code, raw: res.raw, at: Date.now() },
      });
      // An action that moves the lid changes what STATUS? reports; don't wait for the poll.
      await this.refreshStatusNow();
    }
    return res;
  }

  /**
   * Read whatever `\Storage Card\PCRunReport` is holding into {@link CfxSessionState.lastReport}.
   *
   * **Called automatically once per connection**, which is what makes a view able to say what this
   * machine last did the moment it is plugged in. The report is there for *every* run — a qPCR one
   * and a thermal-only one alike (`usb.md` §5.2) — so unlike `CurrentRun`, which exists only for
   * runs with a `PLATEREAD`, this one directory answers "what ran here last?" whatever was run. It
   * survives until something deletes it, and the thing that deletes it is a new run's pre-flight
   * (`CfxDevice.clearRunReports`, §7.1), so what is sitting there on connect is the previous run's
   * and nobody has seen it in this app before.
   *
   * Cheap enough to do unasked: the file is 386 bytes to ~14 KB (`alf.md` §1), and this is a
   * listing plus one `GETFILE`.
   *
   * Also called after a run finishes, where it picks up the report that run just wrote — so the
   * panel describes the run that has actually just happened rather than the one before it.
   */
  async refreshLastReport(): Promise<LastRunReport | null> {
    const got = await this.run("Reading the last run report", (d) => d.runReport());
    // `undefined` is a failed read, which `run` has already reported; leave the last answer
    // standing rather than claiming the instrument has no report. `null` is the instrument
    // genuinely holding none, which is a real answer and replaces whatever was there.
    if (got === undefined) return null;
    if (got === null) {
      this.#set({ lastReport: null });
      return null;
    }
    let report: AlfReport | null = null;
    try {
      report = parseAlf(got.bytes);
    } catch (e) {
      // A report we can't decode is still a report the instrument is holding, and its bytes are
      // still worth offering — so keep it, undecoded, rather than dropping the fact of it.
      console.warn("[CfxSession] the instrument's run report did not decode:", e);
    }
    const held: LastRunReport = { name: got.name, bytes: got.bytes, report };
    this.#set({ lastReport: held });
    return held;
  }

  /**
   * Collect the `.alf` report the run that just finished wrote — the whole output of a thermal-only
   * run, which builds no run folder at all (see `RunPlan.producesRunFile`), so this is what the
   * follower fetches in place of a `.zpcr`.
   *
   * The same read as {@link refreshLastReport}, and deliberately *is* it rather than a second call
   * to `runReport`: there is one report directory, so anything fetched out of it is by definition
   * the instrument's current last report, and having the two share a read means the last-run panel
   * is right after this without a duplicate transfer. Returns null when the directory holds no
   * report, or when the read fails — a report that doesn't arrive is worth nothing more than a note
   * in the rail, since by then the run itself is over and nothing about it can be lost by this
   * failing.
   */
  async fetchRunReport(): Promise<{ name: string; bytes: Uint8Array } | null> {
    const held = await this.refreshLastReport();
    return held ? { name: held.name, bytes: held.bytes } : null;
  }
}
