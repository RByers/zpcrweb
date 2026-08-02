/**
 * {@link CfxDevice} — a client for a CFX96 / C1000 Touch over its own USB protocol (`usb.md`).
 *
 * Environment-free: it talks to a {@link UsbDeviceLike}, which a browser `USBDevice` and
 * node-usb's WebUSB device both satisfy without an adapter (see `transport.ts`). Nothing in this
 * file, or anything it imports, references `navigator`, `window` or `node:*`.
 *
 * ## Two design points worth knowing before changing anything here
 *
 * **1. Reading is a pump, not a per-command read.** The naive shape — write a command, then
 * `transferIn` until the reply is complete — looks right and is wrong, because the IN endpoint is
 * shared by channels the host never asked for. Channel 2 carries 274 unsolicited messages across
 * the two reference captures (`usb.md` §2), so a per-command reader eventually returns a channel-2
 * payload as if it were the answer to a channel-1 query, and every subsequent reply is off by one.
 * Instead one background loop owns the endpoint, reassembles the byte stream (`FrameReassembler`),
 * and routes each complete message by channel. Channel-1 messages answer queued commands in order;
 * everything else is surfaced as traffic and otherwise ignored. This is also what lets a debug
 * view show *all* traffic rather than only what a command asked for.
 *
 * **2. Commands are serialized, and some must be serialized in groups.** The protocol has no
 * request ids — a reply is matched to a request purely by arrival order — so exactly one command
 * may be outstanding at a time. Two callers polling at once would otherwise each receive the
 * other's answer.
 *
 * Beyond that, some operations are *stateful pairs* that a second caller must not be able to
 * interleave with. `LISTALLFILES` is the sharp case: it returns whatever listing the preceding
 * `GETFILESLEN` buffered and **ignores its own path argument** (measured — see
 * {@link CfxDevice.listFiles}), so `GETFILESLEN A` / `GETFILESLEN B` / `LISTALLFILES A` answers
 * for B. `sequence` therefore holds the channel across several commands, and every multi-command
 * operation here runs inside one.
 *
 * **3. Command lines are built here and nowhere else.** Every public method on this class is a
 * *named operation* — `status()`, `listFiles(dir)`, `runAction("lidOpen")` — and the machinery
 * that turns one into a command line (`send`/`command`/`tryCommand`/`sequence`) is private. There
 * is deliberately no "send this string" escape hatch: the command channel drives an instrument
 * that heats a block and moves a lid, one where a typo is indistinguishable from an intended
 * command and the vocabulary is reverse-engineered rather than specified (`usb.md` §3), so an
 * arbitrary line is a hazard with no matching benefit. Adding a capability means adding a method
 * here — or, for an action with no return value, an entry in {@link CFX_COMMANDS} — which is also
 * where its reply gets parsed into something typed and its provenance recorded.
 *
 * The one thing a caller still supplies verbatim is a *path*, which the filesystem operations
 * interpolate into a command line. {@link assertCommandArgument} keeps that from becoming the
 * escape hatch by the back door: a path carrying a CR or LF would otherwise frame a second,
 * caller-chosen command line after the first.
 */
import {
  FrameReassembler,
  REQUEST_HEADER,
  encodeFrame,
  type CfxMessage,
} from "./frame.js";
import {
  CFX_COMMANDS,
  CfxCommandError,
  assertCommandArgument,
  encodeCommand,
  parseResponse,
  type CfxCommandName,
  type CfxResponse,
} from "./commands.js";
import {
  parseIdentity,
  parseRtStatus,
  parseStatus,
  type CfxDeviceInfo,
  type CfxIdentity,
  type CfxRtStatus,
  type CfxStatus,
} from "./status.js";
import { cfxFileCrc, formatCfxFileCrc } from "./crc.js";
import { CFX_RUN_REPORT_DIR, type RunPlan } from "./runPlan.js";
import {
  CFX_CONFIGURATION,
  CFX_ENDPOINT_IN,
  CFX_ENDPOINT_OUT,
  CFX_INTERFACE,
  CFX_READ_CHUNK,
  transferBytes,
  type UsbDeviceLike,
  type UsbInTransferResultLike,
} from "./transport.js";

/** The ASCII command channel (`usb.md` §3). */
const CHANNEL_ASCII = 1;

/**
 * How many consecutive `transferIn` failures the read pump tolerates before giving up.
 *
 * A single "A transfer error has occurred" is usually one glitched USB transaction — Chrome
 * throws it for a stalled or babbling endpoint, not only for a genuine unplug — and the endpoint
 * is usually readable again on the very next call. Killing the whole connection (and with it every
 * in-flight command and the UI's `connected` state) on the first one is a worse trade than a short
 * retry, so only a *run* of failures, or the device itself reporting it's no longer open, is
 * treated as fatal.
 */
const READ_ERROR_RETRY_LIMIT = 4;
/** Pause between retries, so a still-settling endpoint isn't hammered immediately. */
const READ_ERROR_RETRY_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One decoded message crossing the wire, as handed to {@link CfxDeviceOptions.onTraffic}. */
export interface CfxTrafficEvent {
  direction: "out" | "in";
  channel: number;
  /** Payload bytes exactly as framed. */
  payload: Uint8Array;
  /** The payload decoded as latin1 when it is text, else `null` — a binary channel-0/2 message,
   * a `passThrough` reply, or file content. Lets a debug view render text as text and bytes as
   * hex without re-deciding the question. */
  text: string | null;
  /** True for a channel-1 message the host never asked for, and for every channel-0/2 message. */
  unsolicited: boolean;
  at: number;
}

/**
 * A `transferIn`/`transferOut` failure, handed to {@link CfxDeviceOptions.onTransferError} —
 * whether or not the read pump goes on to recover it. Without this, a `transferIn` the retry loop
 * swallowed left no trace anywhere a caller could see: only a `console.error` and, if the retries
 * ran out, the unrelated {@link CfxDeviceOptions.onClose}. This is what lets a debug view show a
 * retried-but-recovered glitch as what it was, in place among the traffic it interrupted, rather
 * than nothing at all.
 */
export interface CfxTransferErrorEvent {
  at: number;
  direction: "out" | "in";
  message: string;
  /** 1-based count of consecutive failures so far, including this one. Always 1 for `"out"`:
   * {@link CfxDevice.exchangeBytes}'s `transferOut` is never retried. */
  attempt: number;
  /** True when this failure ends something — the read pump giving up after
   * {@link READ_ERROR_RETRY_LIMIT} tries or losing the device, or (always, for `"out"`) the one
   * command this write belonged to. Never by itself a reason the *connection* tears down; that is
   * still exactly what {@link CfxDeviceOptions.onClose} reports. */
  fatal: boolean;
}

export interface CfxDeviceOptions {
  /** Called for every logical message in both directions, in wire order. */
  onTraffic?: (event: CfxTrafficEvent) => void;
  /** Called for every `transferIn`/`transferOut` failure, retried or not — see
   * {@link CfxTransferErrorEvent}. */
  onTransferError?: (event: CfxTransferErrorEvent) => void;
  /** Called when the read pump stops — a disconnect, or an ordinary {@link CfxDevice.close}. */
  onClose?: (error: Error | null) => void;
  /** Per-command timeout. A `GETFILE` of a large plate read is still comfortably inside this. */
  timeoutMs?: number;
}

/**
 * What `GETFILESLEN` said about a path (`usb.md` §5). An ASCII length means the directory can be
 * listed; the two binary payloads are the instrument's way of saying it won't produce one.
 */
export type CfxListingStatus =
  /** A length came back, so `LISTALLFILES` was run and `names` is that directory's contents. */
  | "ok"
  /** The directory exists but holds no files (only subdirectories, or nothing at all). */
  | "empty"
  /** No such directory — a misspelling, or a path that names a file rather than a directory. */
  | "missing"
  /** A binary payload this library doesn't recognize. Treated like `missing`: nothing is listed. */
  | "unknown";

/** One directory listing: the names, plus the byte length `GETFILESLEN` reported for them. */
export interface CfxDirectory {
  path: string;
  names: string[];
  /** `null` when the instrument answered with a binary payload instead of a number — see
   * {@link CfxDevice.listFiles}. */
  listingBytes: number | null;
  /**
   * What the instrument said. `empty` is a real answer about *this* path and `names` is correctly
   * empty; `missing`/`unknown` mean nothing was learned.
   */
  status: CfxListingStatus;
  /**
   * True when `names` describes this directory — `ok` or `empty`.
   *
   * False means `GETFILESLEN` gave no length and no other reading of its reply, so `LISTALLFILES`
   * was never sent. Not a soft failure to paper over: because `LISTALLFILES` replays the last
   * successfully buffered listing — one that survives even a disconnect and reconnect — issuing
   * it anyway returns *another directory's contents* under this path's name.
   */
  listed: boolean;
}

/**
 * The two binary `GETFILESLEN` replies, keyed by their four payload bytes (measured live; see
 * `usb.md` §5). Both are `passThrough` messages (§2) rather than the usual `<value>;<code>` text.
 */
const LISTING_STATUS_CODES = new Map<string, CfxListingStatus>([
  ["7,0,9,0", "empty"],
  ["4,0,9,0", "missing"],
]);

/** What one {@link CfxDevice.sendFile} upload did, including both sides' checksums. */
export interface CfxUploadResult {
  /** The friendly path the file was sent to. */
  path: string;
  /** The GUID path the device actually stored it under, or null if it named none. */
  storedPath: string | null;
  bytes: number;
  /** The checksum this client computed and announced (`crc.ts`). */
  crcSent: number;
  /** The checksum the device computed over what it stored, or null if it reported none. */
  crcStored: number | null;
  /** True when the two agree — the only evidence that the bytes landed intact. */
  verified: boolean;
}

/** What one {@link CfxDevice.startRun} did. The run is going by the time this resolves. */
export interface CfxRunStartResult {
  /** One entry per file successfully sent in the §7.4 deposit phase. */
  uploads: CfxUploadResult[];
  /**
   * Anything that went wrong *after* the run started — a file that didn't copy, or a checksum
   * that came back under the other convention. Never a reason to consider the run failed: it is
   * running. Surfaced so a UI can say the archive may be missing its plate map.
   */
  uploadErrors: string[];
}

const ENCODER = new TextEncoder();

/** Throw on a non-success code, else pass the response through. */
function checked(command: string, res: CfxResponse): CfxResponse {
  if (!res.ok) throw new CfxCommandError(command, res);
  return res;
}

interface Pending {
  command: string;
  resolve: (res: CfxMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const TEXT_DECODER = new TextDecoder("latin1");

/** Whether a payload is plausibly the ASCII the command channel normally carries. Used only to
 * decide how to *present* a message; nothing branches on it. */
function asText(payload: Uint8Array): string | null {
  for (const b of payload) {
    if (b !== 0x09 && b !== 0x0a && b !== 0x0d && (b < 0x20 || b > 0x7e)) return null;
  }
  return TEXT_DECODER.decode(payload);
}

export class CfxDevice {
  private readonly opts: CfxDeviceOptions;
  private readonly inbound = new FrameReassembler();
  private readonly queue: Pending[] = [];
  /** Serializes `command` calls — see design point 2 in the module comment. */
  private chain: Promise<unknown> = Promise.resolve();
  private pump: Promise<void> | null = null;
  private closing = false;
  private closed = false;

  constructor(
    readonly usb: UsbDeviceLike,
    options: CfxDeviceOptions = {},
  ) {
    this.opts = options;
  }

  get isOpen(): boolean {
    return this.pump !== null && !this.closed;
  }

  /** Open, configure and claim the vendor-specific interface, then start the read pump. */
  async open(): Promise<void> {
    if (this.pump) return;
    if (!this.usb.opened) await this.usb.open();
    // A freshly-enumerated device may have no configuration selected yet; one that has been
    // opened before already does, and re-selecting it resets endpoint state for no reason.
    if (this.usb.configuration == null) await this.usb.selectConfiguration(CFX_CONFIGURATION);
    await this.usb.claimInterface(CFX_INTERFACE);
    this.closed = false;
    this.closing = false;
    this.inbound.reset();
    this.pump = this.readLoop();
  }

  /** Stop the pump, release the interface and close the device. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.closed = true;
    // Whatever is in flight will never be answered now.
    this.failAll(new Error("device closed"));
    try {
      await this.usb.releaseInterface(CFX_INTERFACE);
    } catch {
      /* already gone — a physical unplug takes the interface with it */
    }
    try {
      await this.usb.close();
    } catch {
      /* as above */
    }
    this.pump = null;
  }

  // ---- the read pump ----------------------------------------------------

  private async readLoop(): Promise<void> {
    let error: Error | null = null;
    let consecutiveErrors = 0;
    readLoop: while (!this.closing) {
      let result: UsbInTransferResultLike;
      try {
        result = await this.usb.transferIn(CFX_ENDPOINT_IN, CFX_READ_CHUNK);
      } catch (e) {
        // A close() in progress rejects the in-flight transfer; that isn't a failure.
        if (this.closing) break readLoop;
        const err = e instanceof Error ? e : new Error(String(e));
        consecutiveErrors++;
        // `usb.opened` flips to false the moment Chrome notices a real unplug; a transient
        // stall on an otherwise-live device leaves it true, which is what distinguishes "try
        // again" from "the device is gone" here.
        const fatal = consecutiveErrors >= READ_ERROR_RETRY_LIMIT || !this.usb.opened;
        console.error(
          `[CfxDevice] transferIn failed (attempt ${consecutiveErrors}/${READ_ERROR_RETRY_LIMIT}` +
            `, endpoint ${CFX_ENDPOINT_IN}, opened=${this.usb.opened}, ` +
            `${this.queue.length} command(s) pending)${fatal ? " — giving up" : " — retrying"}:`,
          err,
        );
        this.opts.onTransferError?.({
          at: Date.now(),
          direction: "in",
          message: err.message,
          attempt: consecutiveErrors,
          fatal,
        });
        if (fatal) {
          error = err;
          break readLoop;
        }
        await delay(READ_ERROR_RETRY_DELAY_MS);
        continue readLoop;
      }
      consecutiveErrors = 0;
      const chunk = transferBytes(result);
      if (chunk.length === 0) continue readLoop;
      for (const msg of this.inbound.push(chunk)) this.dispatch(msg);
    }
    this.pump = null;
    if (error) {
      console.error(
        `[CfxDevice] read pump stopped; failing ${this.queue.length} pending command(s)`,
        error,
      );
      this.failAll(error);
    }
    this.opts.onClose?.(error);
  }

  private dispatch(msg: CfxMessage): void {
    const waiting = msg.channel === CHANNEL_ASCII ? this.queue.shift() : undefined;
    this.emit("in", msg, !waiting);
    if (!waiting) return; // channel 0/2, or a channel-1 message nobody asked for
    if (waiting.timer) clearTimeout(waiting.timer);
    waiting.resolve(msg);
  }

  private emit(direction: "out" | "in", msg: CfxMessage, unsolicited: boolean): void {
    if (!this.opts.onTraffic) return;
    this.opts.onTraffic({
      direction,
      channel: msg.channel,
      payload: msg.payload,
      // A `passThrough` reply is raw by declaration, so don't even try to read it as text.
      text: msg.passThrough ? null : asText(msg.payload),
      unsolicited,
      at: Date.now(),
    });
  }

  private failAll(err: Error): void {
    while (this.queue.length) {
      const p = this.queue.shift()!;
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  // ---- sending ----------------------------------------------------------

  /** Take the command channel for the duration of `fn`, so nothing else can interleave. */
  private hold<T>(fn: () => Promise<T>): Promise<T> {
    // `.then(fn, fn)` so a failed predecessor doesn't wedge the channel.
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Write one command and await its reply. Assumes the caller holds the channel. */
  private async exchange(command: string, timeoutMs?: number): Promise<CfxMessage> {
    return this.exchangeBytes(command, encodeCommand(command), timeoutMs);
  }

  /**
   * As {@link exchange}, but with the payload supplied whole.
   *
   * Exists for `CRCSENDFILE`, the one command whose payload is not all-ASCII: a file's raw bytes
   * follow the command text in the *same* message, and — measured byte-exactly from the capture,
   * where the announced length is the prefix plus the file and not two more — with **no `\r\n`
   * terminator**, unlike every text command. `command` here is the label the timeout message and
   * the pending queue use, not something that gets encoded.
   */
  private async exchangeBytes(
    command: string,
    payload: Uint8Array,
    timeoutMs?: number,
  ): Promise<CfxMessage> {
    if (this.closed) throw new Error("device is closed");
    const header = { ...REQUEST_HEADER, channel: CHANNEL_ASCII };
    const frame = encodeFrame(header, payload);
    let pending!: Pending;
    const reply = new Promise<CfxMessage>((resolve, reject) => {
      pending = { command, resolve, reject, timer: null };
      const ms = timeoutMs ?? this.opts.timeoutMs ?? 10_000;
      pending.timer = setTimeout(() => {
        // Drop it from the queue, or every later reply would be matched to the wrong request.
        const i = this.queue.indexOf(pending);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(`timed out after ${ms}ms waiting for a reply to ${command}`));
      }, ms);
      this.queue.push(pending);
    });
    this.emit("out", { ...header, payload, passThrough: false } as CfxMessage, false);
    try {
      await this.usb.transferOut(CFX_ENDPOINT_OUT, frame);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Drop the pending reply: nothing will ever answer a write that never went out, and leaving
      // it queued would mismatch the *next* command's reply against this one. `command` calls are
      // serialized (design point 2), so `pending` is still the queue's own last entry here.
      const i = this.queue.indexOf(pending);
      if (i >= 0) {
        if (pending.timer) clearTimeout(pending.timer);
        this.queue.splice(i, 1);
      }
      this.opts.onTransferError?.({ at: Date.now(), direction: "out", message: err.message, attempt: 1, fatal: true });
      throw err;
    }
    return reply;
  }

  /**
   * Run several commands with exclusive use of the command channel.
   *
   * Needed wherever one command's answer depends on the one before it — see design point 2. `fn`
   * receives the same three primitives the public API is built from; it must use those rather
   * than calling back into {@link send}/{@link command}, which would wait for a channel `fn`
   * itself is holding and deadlock.
   */
  private async sequence<T>(
    fn: (ops: {
      send: (command: string, timeoutMs?: number) => Promise<CfxMessage>;
      command: (command: string, timeoutMs?: number) => Promise<CfxResponse>;
      tryCommand: (command: string, timeoutMs?: number) => Promise<CfxResponse>;
      sendBytes: (label: string, payload: Uint8Array, timeoutMs?: number) => Promise<CfxMessage>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.hold(() =>
      fn({
        send: (c, t) => this.exchange(c, t),
        command: async (c, t) => checked(c, parseResponse((await this.exchange(c, t)).payload)),
        tryCommand: async (c, t) => parseResponse((await this.exchange(c, t)).payload),
        sendBytes: (l, p, t) => this.exchangeBytes(l, p, t),
      }),
    );
  }

  /**
   * Send one command line and resolve with the reply message, unparsed.
   *
   * Most callers want {@link command}, which parses the reply. This is for the replies that are
   * *not* `value;code` text — `GETFILE`'s file bytes, and any `passThrough` response — where
   * parsing would corrupt the payload.
   *
   * Private, along with {@link command} and {@link tryCommand}: see design point 3. The command
   * lines these take are literals in this file, not caller input.
   */
  private async send(command: string, timeoutMs?: number): Promise<CfxMessage> {
    return this.hold(() => this.exchange(command, timeoutMs));
  }

  /** Send a command and parse its reply. Throws {@link CfxCommandError} on a non-`0000` code. */
  private async command(command: string, timeoutMs?: number): Promise<CfxResponse> {
    return checked(command, parseResponse((await this.send(command, timeoutMs)).payload));
  }

  /** As {@link command}, but returns the failing response instead of throwing — for the queries
   * gathered best-effort at connect time, and for an action command whose rejection is a result
   * to report rather than a failure. */
  private async tryCommand(command: string, timeoutMs?: number): Promise<CfxResponse> {
    return parseResponse((await this.send(command, timeoutMs)).payload);
  }

  // ---- typed operations -------------------------------------------------

  async identify(): Promise<CfxIdentity> {
    return parseIdentity(await this.command("*IDN?"));
  }

  async status(): Promise<CfxStatus> {
    return parseStatus(await this.command("STATUS?"));
  }

  async rtStatus(): Promise<CfxRtStatus> {
    return parseRtStatus(await this.command("RTSTATUS?"));
  }

  /** `ERRORLIST A` — the error *contents*, empty when there is nothing to report. */
  async errorList(): Promise<string[]> {
    const res = await this.command("ERRORLIST A");
    const v = (res.value ?? "").trim();
    return v === "" ? [] : v.split(",");
  }

  /**
   * The static identification block (`usb.md` §3), gathered once at connect.
   *
   * Every query past `*IDN?` is best-effort: an unrecognised command on some other Bio-Rad model
   * should leave that one field undefined, not fail the connection.
   */
  async deviceInfo(): Promise<CfxDeviceInfo> {
    const info: CfxDeviceInfo = await this.identify();
    const opt = async (cmd: string): Promise<string | undefined> => {
      try {
        const res = await this.tryCommand(cmd);
        return res.ok ? res.value ?? undefined : undefined;
      } catch {
        return undefined;
      }
    };
    const numeric = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    info.frontEndSoftware = await opt("FrontEndSoftware?");
    info.baseSerial = await opt("BASESN?");
    info.alphaSerial = await opt("ALPHASN?");
    info.alphaId = await opt("ALPHAID?");
    // Comes back quoted — `"96FX"`.
    info.blockDescription = (await opt("BLOCKDESC?"))?.replace(/^"|"$/g, "");
    info.blockCount = numeric(await opt("BLOCKCOUNT?"));
    info.cpld = await opt("CPLD?");
    info.volumeUl = numeric(await opt("VOLUME?"));
    info.freeSpaceBytes = numeric(await opt("GETFREESPACE"));
    info.totalRamBytes = numeric(await opt("GETTOTALRAM"));
    info.lidForce = await opt("LIDFORCE?");
    info.lidVersion = await opt("LIDVERSION?");
    info.lidBVersion = await opt("LIDBVERSION?");
    info.superLockdown = await opt("SUPERLOCKDOWNMODE?");
    info.errorCount = numeric(await opt("ERRORS?"));
    return info;
  }

  // ---- filesystem -------------------------------------------------------

  /**
   * List a directory: `GETFILESLEN <dir>` immediately followed by `LISTALLFILES <dir>`.
   *
   * **The pair is one operation, not a convenience.** `LISTALLFILES` returns the listing the
   * preceding `GETFILESLEN` computed and ignores the path it is given itself — measured against a
   * live instrument, where `GETFILESLEN \Storage Card\CurrentRun` followed by
   * `LISTALLFILES \Storage Card\PCRunReport` returns CurrentRun's 42 entries, and `LISTALLFILES`
   * with no `GETFILESLEN` before it returns a stale buffer. `usb.md` §5 read the pairing as the
   * host double-checking itself; it is actually load-bearing, which is why this runs inside a
   * {@link sequence} rather than as two independent calls.
   *
   * Names are comma-separated, which is all the protocol offers: a name containing a comma would
   * be indistinguishable from two names, and nothing escapes one. No observed name has one (they
   * run to `QuickPlate_96 wells_All Channels.pltd` — spaces, no commas), so this splits on the
   * separator and accepts the limit rather than pretending to a robustness it can't have.
   *
   * Lists **files only**: a directory containing nothing but subdirectories comes back `empty`,
   * which is why `\Storage Card` — which holds only `CurrentRun` and `PCRunReport` — has no
   * listing of its own.
   *
   * When `GETFILESLEN` answers with a binary payload instead of a length ({@link CfxListingStatus}),
   * `LISTALLFILES` is **not** sent: with nothing newly buffered it would hand back whichever
   * directory was listed last (measured — the reply to `LISTALLFILES \Storage Card` is still the
   * previous `CurrentRun` listing, in full).
   */
  async listFiles(dir: string): Promise<CfxDirectory> {
    assertCommandArgument("directory", dir);
    return this.sequence(async ({ send, command }) => {
      const lenMsg = await send(`GETFILESLEN ${dir}`);
      let listingBytes: number | null = null;
      if (lenMsg.passThrough) {
        const status =
          LISTING_STATUS_CODES.get(Array.from(lenMsg.payload).join(",")) ?? "unknown";
        return { path: dir, names: [], listingBytes: null, status, listed: status === "empty" };
      }
      const res = parseResponse(lenMsg.payload);
      if (!res.ok) throw new CfxCommandError(`GETFILESLEN ${dir}`, res);
      const n = Number(res.value);
      listingBytes = Number.isFinite(n) ? n : null;
      if (listingBytes === null) {
        return { path: dir, names: [], listingBytes: null, status: "unknown", listed: false };
      }
      const res2 = await command(`LISTALLFILES ${dir}`);
      const v = (res2.value ?? "").trim();
      const names = v === "" ? [] : v.split(",").filter((n) => n !== "");
      return { path: dir, names, listingBytes, status: "ok", listed: true };
    });
  }

  /** `GETFILESIZE <path>` — the file's size in bytes. */
  async fileSize(path: string): Promise<number> {
    assertCommandArgument("path", path);
    const res = await this.command(`GETFILESIZE ${path}`);
    const n = Number(res.value);
    if (!Number.isFinite(n)) throw new Error(`GETFILESIZE ${path}: unparseable size ${res.raw}`);
    return n;
  }

  /**
   * `GETFILE <path>` — the file's bytes, preceded by the `GETFILESIZE` that sizes the transfer.
   *
   * The reply is the file itself, with no `;0000` appended: this is the one response that must
   * not go through {@link parseResponse}, which would take the last semicolon in a binary file as
   * a field separator. The announced size is used to verify the transfer arrived whole.
   *
   * Runs as one {@link sequence} for the same reason {@link listFiles} does — `GETFILESLEN`
   * demonstrably primes `LISTALLFILES`, so the size/fetch pair is treated as equally stateful
   * rather than assumed independent.
   */
  async getFile(path: string, timeoutMs = 60_000): Promise<Uint8Array> {
    assertCommandArgument("path", path);
    return this.sequence(async ({ send, command }) => {
      const sizeRes = await command(`GETFILESIZE ${path}`);
      const expected = Number(sizeRes.value);
      if (!Number.isFinite(expected)) {
        throw new Error(`GETFILESIZE ${path}: unparseable size ${sizeRes.raw}`);
      }
      // The run's `begun`/`ended` markers are zero-content by design (runFolder.ts), and a
      // `GETFILE` sent for one has been observed to go unanswered until the reply timer below
      // finally rejects it — costing up to `timeoutMs` per marker. Nothing to fetch, so don't ask.
      if (expected === 0) return new Uint8Array(0);
      const msg = await send(`GETFILE ${path}`, timeoutMs);
      if (msg.payload.length !== expected) {
        throw new Error(
          `GETFILE ${path}: expected ${expected} bytes, received ${msg.payload.length}`,
        );
      }
      return msg.payload;
    });
  }

  /** `DELFILE <path>`. */
  async deleteFile(path: string): Promise<void> {
    assertCommandArgument("path", path);
    await this.command(`DELFILE ${path}`);
  }

  /**
   * Upload one file (`usb.md` §5, §7.4): the five-command cycle, checksum-verified end to end.
   *
   * ```
   * DELFILE <path>                  clear any stale file at the friendly name
   * CRCSENDFILE "<crc>*<path>",…    the bytes, prefixed by our own checksum
   * COMPUTEFILECRC "<path>"         → the GUID the device actually stored it under
   * GETFILESLEN + LISTALLFILES      the host re-lists
   * GETFILECRC "<guid path>"        → the device's checksum, to compare against ours
   * ```
   *
   * Details that are load-bearing and not obvious from the command names (`usb.md` §7.4):
   *
   * - **`DELFILE` on a file that isn't there is normal.** It answers with a `passThrough` binary
   *   payload — `05 00 09 00`, "no such file", a third member of §5's status-code family — rather
   *   than an error code, and three of the capture's four uploads got exactly that. A first
   *   upload to a clean directory always does, so treating it as fatal would break the ordinary
   *   path.
   * - **`COMPUTEFILECRC` returns no CRC.** Despite the name, it hands back the *GUID name* the
   *   device stored the file under (`<dir>\<guid>;0000`). That name is the only way to ask about
   *   the stored copy, which is why the verification step needs it — and the GUID is transient,
   *   gone from the listing by the next file's upload, so it is used immediately and not kept.
   * - **The middle listing is a UI refresh**, not a protocol requirement — the GUID is already
   *   known. It is kept because the `GETFILESLEN`/`LISTALLFILES` *pairing* is mandatory wherever
   *   a listing happens (see {@link listFiles}) and this whole cycle already holds the channel.
   *
   * Resolves with both checksums so the caller can report a mismatch — including the
   * even-length-file ambiguity of `crc.ts`, which this is the only place that can measure.
   * Throws only if the instrument rejects a command outright.
   */
  async sendFile(path: string, bytes: Uint8Array): Promise<CfxUploadResult> {
    assertCommandArgument("path", path);
    const crc = cfxFileCrc(bytes);
    const prefix = ENCODER.encode(`CRCSENDFILE "${formatCfxFileCrc(crc)}*${path}",`);
    const payload = new Uint8Array(prefix.length + bytes.length);
    payload.set(prefix, 0);
    payload.set(bytes, prefix.length);
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("\\")));

    return this.sequence(async ({ command, tryCommand, sendBytes }) => {
      // Not `command`: a missing file is the normal case on a first upload — see above.
      await tryCommand(`DELFILE ${path}`);
      const sent = parseResponse((await sendBytes(`CRCSENDFILE ${path}`, payload, 60_000)).payload);
      if (!sent.ok) throw new CfxCommandError(`CRCSENDFILE ${path}`, sent);
      const stored = await command(`COMPUTEFILECRC "${path}"`);
      const storedPath = (stored.value ?? "").trim();
      // `tryCommand`, because this pair is the UI refresh noted above rather than a step the
      // upload depends on: `GETFILESLEN` answers a directory it can't measure with a binary
      // payload (§5), which would parse as a failure and take a perfectly good upload with it.
      await tryCommand(`GETFILESLEN ${dir}`);
      await tryCommand(`LISTALLFILES ${dir}`);
      // Without a GUID there is nothing to interrogate; report the upload unverified rather than
      // inventing a path, which would ask the device about a file that doesn't exist.
      if (storedPath === "") {
        return {
          path,
          storedPath: null,
          bytes: bytes.length,
          crcSent: crc,
          crcStored: null,
          verified: false,
        };
      }
      const echoed = await command(`GETFILECRC "${storedPath}"`);
      const raw = Number(echoed.value);
      const crcStored = Number.isFinite(raw) ? raw : null;
      return {
        path,
        storedPath,
        bytes: bytes.length,
        crcSent: crc,
        crcStored,
        verified: crcStored === crc,
      };
    });
  }

  // ---- run control ------------------------------------------------------

  /**
   * Clear `\Storage Card\PCRunReport` of the previous run's report (`usb.md` §7.1).
   *
   * Worth doing rather than skipping: with the directory emptied first, the `.alf` the finished
   * run writes is the only entry in it, so collecting it afterwards needs no name or timestamp
   * matching. Failures are swallowed — this is housekeeping, and a run must not be blocked by it.
   */
  async clearRunReports(): Promise<string[]> {
    const dir = await this.listFiles(CFX_RUN_REPORT_DIR);
    const deleted: string[] = [];
    for (const name of dir.names) {
      try {
        await this.deleteFile(`${CFX_RUN_REPORT_DIR}\\${name}`);
        deleted.push(name);
      } catch {
        /* housekeeping; the run is what matters */
      }
    }
    return deleted;
  }

  /**
   * Run a protocol, start to started (`usb.md` §7).
   *
   * The order is the capture's, and it is **not** the one §5's upload machinery suggests. The
   * protocol is typed in as ASCII directives and `RemoteRun` starts *that*; the file upload
   * happens afterwards, with the run already under way, and is a **deposit rather than an
   * instruction** (§7.4) — it is what makes the finished run folder a self-contained experiment,
   * and nothing executes it. Uploading first would put files somewhere the starting run is about
   * to rewrite.
   *
   * ```
   * 7.1  clear the old .alf                     (optional housekeeping)
   * 7.2  PROTOCOL 'PCRUN', the directives, END  one command each, each acked 0000
   * 7.3  RemoteRun …                            ← the run starts HERE, nothing further required
   *      ADDCYCLES 0                            a no-op the capture sends as ordinary setup
   * 7.4  the files                              deposited into the run folder, after the start
   * ```
   *
   * **There is no confirmation step.** An earlier reading of the capture had `PROCEED` as the
   * "operator has closed the lid" confirmation; §7.5 measured it as *skip to the next step*,
   * issued mid-run to cut a 3-minute denaturation short. Sending it here would silently skip the
   * run's first step. Expect `STATUS?` to leave `IDLE` within ~10 s of `RemoteRun`, and expect
   * the *lid* to heat first — the block sits at ambient for ~3 minutes while it does, which a
   * caller watching block temperature will mistake for a hang.
   *
   * The authoring runs inside one {@link sequence}: a status poll interleaving with it is
   * harmless, but a second caller authoring concurrently would splice two step lists into one
   * with no way to detect it afterwards.
   */
  async startRun(plan: RunPlan, onProgress?: (what: string) => void): Promise<CfxRunStartResult> {
    if (!plan.startable) {
      throw new Error("This run plan has unresolved errors and must not be started.");
    }
    onProgress?.("Clearing the previous run report");
    try {
      await this.clearRunReports();
    } catch {
      /* §7.1 is housekeeping — see clearRunReports */
    }
    await this.sequence(async ({ command }) => {
      for (const [i, line] of plan.commands.entries()) {
        onProgress?.(`Sending protocol (${i + 1}/${plan.commands.length})`);
        await command(line);
      }
      onProgress?.("Starting the run");
      // The run begins on this command. Everything after it is deposit and housekeeping.
      await command(plan.remoteRun);
      await command("ADDCYCLES 0");
    });
    // Outside the sequence above: each upload is its own multi-command operation that takes the
    // channel for itself, and nesting one inside a held channel would deadlock (see `sequence`).
    //
    // Failures here are reported, never thrown: by this point the run is *already going*, and
    // aborting a started run because a provenance file didn't copy would be the wrong trade —
    // §7.4's whole point is that a client wanting only the fluorescence can skip this phase.
    const uploads: CfxUploadResult[] = [];
    const uploadErrors: string[] = [];
    for (const [i, upload] of plan.uploads.entries()) {
      onProgress?.(`Uploading ${upload.name} (${i + 1}/${plan.uploads.length})`);
      try {
        const result = await this.sendFile(upload.path, upload.bytes);
        uploads.push(result);
        if (!result.verified) {
          uploadErrors.push(
            `${upload.name} may not have copied intact: sent ${result.crcSent}, the instrument ` +
              `reports ${result.crcStored ?? "nothing"}.`,
          );
        }
      } catch (e) {
        uploadErrors.push(`${upload.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { uploads, uploadErrors };
  }

  /**
   * `CANCEL` — acknowledge a finished run, releasing the instrument back to idle (`usb.md` §7.6).
   *
   * Named for what it does at the *end* of a run, which is the only place this library uses it.
   * When a protocol completes, `STATUS?` reports `IDLE` with the run's name still attached and
   * the method still `CALC`; `CANCEL` clears that to the empty-name idle state, and the final
   * plate read, the `ended` marker and the `.alf` report only appear in the run folder afterwards.
   * On a run still in progress the same command aborts it — which is why nothing here sends it
   * without checking the status first.
   */
  async acknowledgeRun(): Promise<CfxResponse> {
    return this.tryCommand("CANCEL");
  }

  // ---- actions ----------------------------------------------------------

  /**
   * Run one of the {@link CFX_COMMANDS} action commands.
   *
   * Deliberately does not throw on a non-zero code: the entries marked `unverified` are guesses at
   * a command name, and "the instrument rejected it" is a result the caller should be able to
   * show, not an exception to swallow. Check `.ok` on the response.
   */
  async runAction(name: CfxCommandName): Promise<CfxResponse> {
    return this.tryCommand(CFX_COMMANDS[name].command);
  }
}
