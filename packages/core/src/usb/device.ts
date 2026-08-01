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
 * for B. {@link CfxDevice.sequence} therefore holds the channel across several commands, and
 * every multi-command operation here runs inside one.
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
import {
  CFX_CONFIGURATION,
  CFX_ENDPOINT_IN,
  CFX_ENDPOINT_OUT,
  CFX_INTERFACE,
  CFX_READ_CHUNK,
  transferBytes,
  type UsbDeviceLike,
} from "./transport.js";

/** The ASCII command channel (`usb.md` §3). */
const CHANNEL_ASCII = 1;

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

export interface CfxDeviceOptions {
  /** Called for every logical message in both directions, in wire order. */
  onTraffic?: (event: CfxTrafficEvent) => void;
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
    try {
      while (!this.closing) {
        const result = await this.usb.transferIn(CFX_ENDPOINT_IN, CFX_READ_CHUNK);
        const chunk = transferBytes(result);
        if (chunk.length === 0) continue;
        for (const msg of this.inbound.push(chunk)) this.dispatch(msg);
      }
    } catch (e) {
      // A close() in progress rejects the in-flight transfer; that isn't a failure.
      if (!this.closing) error = e instanceof Error ? e : new Error(String(e));
    }
    if (error) this.failAll(error);
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
    if (this.closed) throw new Error("device is closed");
    const payload = encodeCommand(command);
    const header = { ...REQUEST_HEADER, channel: CHANNEL_ASCII };
    const frame = encodeFrame(header, payload);
    const reply = new Promise<CfxMessage>((resolve, reject) => {
      const pending: Pending = { command, resolve, reject, timer: null };
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
    await this.usb.transferOut(CFX_ENDPOINT_OUT, frame);
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
  async sequence<T>(
    fn: (ops: {
      send: (command: string, timeoutMs?: number) => Promise<CfxMessage>;
      command: (command: string, timeoutMs?: number) => Promise<CfxResponse>;
      tryCommand: (command: string, timeoutMs?: number) => Promise<CfxResponse>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.hold(() =>
      fn({
        send: (c, t) => this.exchange(c, t),
        command: async (c, t) => checked(c, parseResponse((await this.exchange(c, t)).payload)),
        tryCommand: async (c, t) => parseResponse((await this.exchange(c, t)).payload),
      }),
    );
  }

  /**
   * Send one command line and resolve with the raw reply message.
   *
   * Most callers want {@link command}, which parses the reply. This is the escape hatch for the
   * replies that are *not* `value;code` text — `GETFILE`'s file bytes, and any `passThrough`
   * response — where parsing would corrupt the payload.
   */
  async send(command: string, timeoutMs?: number): Promise<CfxMessage> {
    return this.hold(() => this.exchange(command, timeoutMs));
  }

  /** Send a command and parse its reply. Throws {@link CfxCommandError} on a non-`0000` code. */
  async command(command: string, timeoutMs?: number): Promise<CfxResponse> {
    return checked(command, parseResponse((await this.send(command, timeoutMs)).payload));
  }

  /** As {@link command}, but returns the failing response instead of throwing — for the queries
   * gathered best-effort at connect time, and for deliberately probing an unverified command. */
  async tryCommand(command: string, timeoutMs?: number): Promise<CfxResponse> {
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
    return this.sequence(async ({ send, command }) => {
      const sizeRes = await command(`GETFILESIZE ${path}`);
      const expected = Number(sizeRes.value);
      if (!Number.isFinite(expected)) {
        throw new Error(`GETFILESIZE ${path}: unparseable size ${sizeRes.raw}`);
      }
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
    await this.command(`DELFILE ${path}`);
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
