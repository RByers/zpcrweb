/**
 * `CfxDevice` against a mock instrument.
 *
 * The mock is worth more than it looks: the parts of this client most likely to break are the
 * read pump and the command queue, and both are invisible to a parser test. The scripted replies
 * below are the real instrument's, so a regression here is a regression against measured
 * behaviour rather than against an invented fixture.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CfxDevice,
  FRAME_HEADER_BYTES,
  REQUEST_HEADER,
  decodeHeader,
  encodeFrame,
  type CfxTransferErrorEvent,
  type UsbDeviceLike,
  type UsbInTransferResultLike,
} from "../src/usb/index.js";

const text = (s: string) => new TextEncoder().encode(s);

/** A scripted instrument: answers each command line from `replies`, and can be told to emit
 * unsolicited channel-2 traffic the way the real one does. */
class MockInstrument implements UsbDeviceLike {
  vendorId = 0x0614;
  productId = 0x057b;
  opened = false;
  configuration: unknown = null;
  claimed: number[] = [];
  /** Commands received, in order — the assertion surface for sequencing. */
  sent: string[] = [];
  /** Queued IN frames the pump will drain. */
  private outbox: Uint8Array[] = [];
  private waiters: ((v: UsbInTransferResultLike) => void)[] = [];
  /** Errors `transferIn` throws instead of resolving, one per call, oldest first. */
  transferInFailures: Error[] = [];
  /** Errors `transferOut` throws instead of resolving, one per call, oldest first. */
  transferOutFailures: Error[] = [];
  /** Every `clearHalt` the pump asked for, as `direction:endpoint`. */
  halts: string[] = [];

  constructor(
    private readonly replies: (cmd: string) => { payload: Uint8Array; passThrough?: boolean; channel?: number } | null,
  ) {}

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async selectConfiguration(n: number) {
    this.configuration = { configurationValue: n };
  }
  async claimInterface(n: number) {
    this.claimed.push(n);
  }
  async releaseInterface() {}
  async clearHalt(direction: "in" | "out", endpointNumber: number) {
    this.halts.push(`${direction}:${endpointNumber}`);
  }

  /** Push a frame toward the host, waking a blocked `transferIn` if one is parked. */
  push(payload: Uint8Array, { channel = 1, passThrough = false } = {}): void {
    this.pushRaw(encodeFrame({ ...REQUEST_HEADER, channel, passThrough }, payload));
  }

  /** Push already-framed bytes, so a test can split one message across several transfers. */
  pushRaw(bytes: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
    else this.outbox.push(bytes);
  }

  async transferOut(_ep: number, data: ArrayBuffer | ArrayBufferView) {
    const failure = this.transferOutFailures.shift();
    if (failure) throw failure;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(
      (data as ArrayBufferView).buffer,
      (data as ArrayBufferView).byteOffset,
      (data as ArrayBufferView).byteLength,
    );
    const { payloadLength } = decodeHeader(bytes);
    const cmd = new TextDecoder().decode(
      bytes.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLength),
    ).replace(/\r?\n$/, "");
    this.sent.push(cmd);
    const reply = this.replies(cmd);
    if (reply) this.push(reply.payload, { channel: reply.channel ?? 1, passThrough: reply.passThrough });
    return {};
  }

  async transferIn(): Promise<UsbInTransferResultLike> {
    const failure = this.transferInFailures.shift();
    if (failure) throw failure;
    const next = this.outbox.shift();
    if (next) return { data: new DataView(next.buffer, next.byteOffset, next.byteLength) };
    // Park until something is pushed — the real endpoint blocks the same way.
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const STATUS_IDLE =
  '18.40;23.8;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;18.40;CLOSED;0;0000';

describe("CfxDevice", () => {
  it("opens, configures and claims the vendor interface", async () => {
    const mock = new MockInstrument(() => ({ payload: text("0000") }));
    const dev = new CfxDevice(mock);
    await dev.open();
    expect(mock.opened).toBe(true);
    expect(mock.claimed).toEqual([0]);
    await dev.close();
  });

  it("parses a real *IDN? reply", async () => {
    const mock = new MockInstrument((cmd) =>
      cmd === "*IDN?"
        ? { payload: text("BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0;0000\r\n") }
        : null,
    );
    const dev = new CfxDevice(mock);
    await dev.open();
    expect(await dev.identify()).toMatchObject({ model: "C1000", serial: "CT019138" });
    await dev.close();
  });

  it("ignores unsolicited channel-2 traffic instead of matching it to a command", async () => {
    // The bug a per-command reader has: a channel-2 message arriving between request and reply
    // would be returned as the answer.
    const mock = new MockInstrument((cmd) => {
      if (cmd !== "STATUS?") return null;
      // Interleave a binary channel-2 message ahead of the real reply.
      mock.push(new Uint8Array([0x04, 0x00, 0x00, 0x04, 0x64, 0x00]), { channel: 2 });
      return { payload: text(STATUS_IDLE) };
    });
    const seen: { channel: number; unsolicited: boolean }[] = [];
    const dev = new CfxDevice(mock, {
      onTraffic: (e) => {
        if (e.direction === "in") seen.push({ channel: e.channel, unsolicited: e.unsolicited });
      },
    });
    await dev.open();
    const status = await dev.status();
    expect(status.blockTempC).toBe(18.4);
    expect(status.lid).toBe("CLOSED");
    expect(seen).toEqual([
      { channel: 2, unsolicited: true },
      { channel: 1, unsolicited: false },
    ]);
    await dev.close();
  });

  it("serializes concurrent commands so each caller gets its own reply", async () => {
    // Three different typed operations in flight at once: the protocol has no request ids, so a
    // reply is matched purely by arrival order and a lost turn shows up as one caller receiving
    // another's answer.
    const mock = new MockInstrument((cmd) => {
      if (cmd === "*IDN?") return { payload: text("BIO-RAD LABORATORIES,C1000,CT019138,2.0;0000") };
      if (cmd === "STATUS?") return { payload: text(STATUS_IDLE) };
      if (cmd === "ERRORLIST A") return { payload: text("E01,E02;0000") };
      return null;
    });
    const dev = new CfxDevice(mock);
    await dev.open();
    const [idn, status, errors] = await Promise.all([
      dev.identify(),
      dev.status(),
      dev.errorList(),
    ]);
    expect(idn.serial).toBe("CT019138");
    expect(status.blockTempC).toBe(18.4);
    expect(errors).toEqual(["E01", "E02"]);
    expect(mock.sent).toEqual(["*IDN?", "STATUS?", "ERRORLIST A"]);
    await dev.close();
  });

  it("refuses a path that would inject a second command line", async () => {
    const mock = new MockInstrument(() => ({ payload: text("0000") }));
    const dev = new CfxDevice(mock);
    await dev.open();
    // A CR ends the line, so everything after it would be framed as a command of its own.
    await expect(dev.getFile("\\x\\y\r\nLID OPEN")).rejects.toThrow(/cannot go in a command line/);
    await expect(dev.listFiles("\\x\nCANCEL")).rejects.toThrow(/cannot go in a command line/);
    await expect(dev.deleteFile("\\x\nCANCEL")).rejects.toThrow(/cannot go in a command line/);
    expect(mock.sent).toEqual([]);
    await dev.close();
  });

  it("keeps GETFILESLEN and LISTALLFILES adjacent under concurrent listing", async () => {
    // The measured hazard: LISTALLFILES replays whatever the last GETFILESLEN buffered, so two
    // interleaved listings would each report the other's directory.
    const listings: Record<string, string> = {
      "\\A": "one.xml,two.xml",
      "\\B": "three.xml",
    };
    let buffered: string | null = null;
    const mock = new MockInstrument((cmd) => {
      const len = /^GETFILESLEN (.+)$/.exec(cmd);
      if (len) {
        buffered = len[1]!;
        return { payload: text(`${listings[buffered]!.length};0000`) };
      }
      if (/^LISTALLFILES /.test(cmd)) {
        // Deliberately ignores its own argument, exactly like the instrument.
        return { payload: text(`${listings[buffered!]!};0000`) };
      }
      return null;
    });
    const dev = new CfxDevice(mock);
    await dev.open();
    const [a, b] = await Promise.all([dev.listFiles("\\A"), dev.listFiles("\\B")]);
    expect(a.names).toEqual(["one.xml", "two.xml"]);
    expect(b.names).toEqual(["three.xml"]);
    expect(mock.sent).toEqual([
      "GETFILESLEN \\A",
      "LISTALLFILES \\A",
      "GETFILESLEN \\B",
      "LISTALLFILES \\B",
    ]);
    await dev.close();
  });

  // The three binary GETFILESLEN replies, per `usb.md` §5. In every case LISTALLFILES must not
  // even be sent: with nothing newly buffered it returns another directory's contents under this
  // path. `empty` differs only in that the empty `names` is then a true statement about the path.
  it.each([
    { label: "an empty directory", bytes: [0x07, 0x00, 0x09, 0x00], status: "empty", listed: true },
    { label: "a missing path", bytes: [0x04, 0x00, 0x09, 0x00], status: "missing", listed: false },
    { label: "an unknown code", bytes: [0x63, 0x00, 0x09, 0x00], status: "unknown", listed: false },
  ])("reads GETFILESLEN's binary reply as $status for $label", async ({ bytes, status, listed }) => {
    const mock = new MockInstrument((cmd) =>
      cmd.startsWith("GETFILESLEN")
        ? { payload: new Uint8Array(bytes), passThrough: true }
        : { payload: text("stale.xml;0000") },
    );
    const dev = new CfxDevice(mock);
    await dev.open();
    const dir = await dev.listFiles("\\Storage Card");
    expect(dir.status).toBe(status);
    expect(dir.listed).toBe(listed);
    expect(dir.names).toEqual([]);
    expect(dir.listingBytes).toBeNull();
    expect(mock.sent).toEqual(["GETFILESLEN \\Storage Card"]);
    await dev.close();
  });

  it("returns GETFILE's bytes verbatim and checks them against GETFILESIZE", async () => {
    // A payload containing both a semicolon and a `0000` run — parseResponse would mangle it.
    const file = new Uint8Array([0x00, 0x3b, 0x30, 0x30, 0x30, 0x30, 0xff, 0x3b, 0x41]);
    const mock = new MockInstrument((cmd) => {
      if (cmd.startsWith("GETFILESIZE")) return { payload: text(`${file.length};0000`) };
      if (cmd.startsWith("GETFILE")) return { payload: file };
      return null;
    });
    const dev = new CfxDevice(mock);
    await dev.open();
    expect(Array.from(await dev.getFile("\\x\\y.Plateread"))).toEqual(Array.from(file));
    await dev.close();
  });

  it("skips the GETFILE round-trip for a zero-byte file", async () => {
    // A run's `begun`/`ended` markers are always zero-content; GETFILE for one has been observed
    // to hang on real hardware, so getFile must short-circuit on GETFILESIZE reporting 0 rather
    // than sending GETFILE and waiting on a reply that may never come.
    const mock = new MockInstrument((cmd) => {
      if (cmd.startsWith("GETFILESIZE")) return { payload: text("0;0000") };
      if (cmd.startsWith("GETFILE")) throw new Error("GETFILE should not have been sent");
      return null;
    });
    const dev = new CfxDevice(mock);
    await dev.open();
    expect(Array.from(await dev.getFile("\\CurrentRun\\begun"))).toEqual([]);
    await dev.close();
  });

  it("fails a truncated GETFILE rather than returning a short file", async () => {
    const mock = new MockInstrument((cmd) => {
      if (cmd.startsWith("GETFILESIZE")) return { payload: text("100;0000") };
      if (cmd.startsWith("GETFILE")) return { payload: new Uint8Array(40) };
      return null;
    });
    const dev = new CfxDevice(mock);
    await dev.open();
    await expect(dev.getFile("\\x\\y")).rejects.toThrow(/expected 100 bytes, received 40/);
    await dev.close();
  });

  it("reassembles a reply split across many USB-sized packets", async () => {
    const big = new Uint8Array(5000).fill(0x41);
    const mock = new MockInstrument((cmd) => {
      if (cmd.startsWith("GETFILESIZE")) return { payload: text(`${big.length};0000`) };
      return null;
    });
    const dev = new CfxDevice(mock);
    await dev.open();
    const pending = dev.getFile("\\big");
    // Hand the frame over in 64-byte pieces, the way the endpoint would.
    await new Promise((r) => setTimeout(r, 0));
    const frame = encodeFrame({ ...REQUEST_HEADER, channel: 1 }, big);
    for (let i = 0; i < frame.length; i += 64) mock.pushRaw(frame.slice(i, i + 64));
    expect((await pending).length).toBe(5000);
    await dev.close();
  });

  it("times out rather than hanging when the instrument never answers", async () => {
    const mock = new MockInstrument(() => null);
    const dev = new CfxDevice(mock, { timeoutMs: 30 });
    await dev.open();
    await expect(dev.status()).rejects.toThrow(/timed out/);
    // The channel must still work afterwards: a dropped request has to leave the queue clean.
    mock.push(text("True;0000"));
    await dev.close();
  });

  it("rejects in-flight commands when the device closes", async () => {
    const mock = new MockInstrument(() => null);
    const dev = new CfxDevice(mock);
    await dev.open();
    const pending = dev.status();
    await dev.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("survives a transient transferIn error without dropping the connection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = new MockInstrument((cmd) =>
      cmd === "STATUS?" ? { payload: text(STATUS_IDLE) } : null,
    );
    // Fewer than the retry limit — the pump should recover on its own.
    mock.transferInFailures = [new Error("A transfer error has occurred")];
    let closed: Error | null | undefined;
    const transferErrors: CfxTransferErrorEvent[] = [];
    const dev = new CfxDevice(mock, {
      onClose: (e) => (closed = e),
      onTransferError: (e) => transferErrors.push(e),
    });
    await dev.open();
    const res = await dev.status();
    expect(res.running).toBe(false);
    expect(closed).toBeUndefined();
    expect(dev.isOpen).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    // The one retried failure is reported, but as recoverable — not fatal, and never reaching
    // onClose, which is exactly the gap this event closes: a retry that worked used to leave no
    // trace outside a console.error.
    expect(transferErrors).toHaveLength(1);
    expect(transferErrors[0]).toMatchObject({ direction: "in", attempt: 1, fatal: false });
    await dev.close();
    errSpy.mockRestore();
  });

  it("gives up and fires onClose after repeated transferIn errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = new MockInstrument(() => null);
    // More than the retry limit — every retry fails, so the pump must eventually give up.
    mock.transferInFailures = Array.from({ length: 10 }, () => new Error("A transfer error has occurred"));
    let closed: Error | null | undefined;
    const transferErrors: CfxTransferErrorEvent[] = [];
    const dev = new CfxDevice(mock, {
      onClose: (e) => (closed = e),
      onTransferError: (e) => transferErrors.push(e),
    });
    await dev.open();
    const pending = dev.status();
    await expect(pending).rejects.toThrow(/transfer error/);
    expect(closed).toBeInstanceOf(Error);
    expect(dev.isOpen).toBe(false);
    // One event per attempt, escalating attempt counts, only the last marked fatal.
    expect(transferErrors).toHaveLength(4);
    expect(transferErrors.map((e) => e.attempt)).toEqual([1, 2, 3, 4]);
    expect(transferErrors.map((e) => e.fatal)).toEqual([false, false, false, true]);
    errSpy.mockRestore();
  });

  it("clears a halted endpoint before retrying a transient failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = new MockInstrument((cmd) =>
      cmd === "STATUS?" ? { payload: text(STATUS_IDLE) } : null,
    );
    mock.transferInFailures = [new Error("A transfer error has occurred")];
    const dev = new CfxDevice(mock);
    await dev.open();
    await dev.status();
    // Without this the endpoint stays halted and every remaining retry fails identically.
    expect(mock.halts).toEqual(["in:6"]);
    await dev.close();
    errSpy.mockRestore();
  });

  it("treats a cancelled transfer as fatal immediately, without burning the retries", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = new MockInstrument(() => null);
    // `Cancelled` means the handle is gone, not that the endpoint glitched: retrying re-reads a
    // pipe that no longer exists, so the pump must hand off to the caller's reconnect at once.
    mock.transferInFailures = Array.from({ length: 10 }, () => new Error("Cancelled"));
    const transferErrors: CfxTransferErrorEvent[] = [];
    const closed = new Promise<Error | null>((resolve) => {
      void new CfxDevice(mock, {
        onClose: resolve,
        onTransferError: (e) => transferErrors.push(e),
      })
        .open()
        .then(() => undefined);
    });
    expect(await closed).toBeInstanceOf(Error);
    // One attempt, not four: the pump gave up on the first one rather than spending the retry
    // budget re-reading a pipe that no longer exists.
    expect(transferErrors).toHaveLength(1);
    expect(transferErrors[0]).toMatchObject({ attempt: 1, fatal: true });
    // Nothing was retried, so nothing was cleared.
    expect(mock.halts).toEqual([]);
    errSpy.mockRestore();
  });

  it("treats a disconnected device as fatal immediately", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = new MockInstrument(() => null);
    const err = new Error("The device was disconnected.");
    err.name = "NotFoundError";
    mock.transferInFailures = [err, err, err, err, err];
    const transferErrors: CfxTransferErrorEvent[] = [];
    const closed = new Promise<Error | null>((resolve) => {
      void new CfxDevice(mock, {
        onClose: resolve,
        onTransferError: (e) => transferErrors.push(e),
      })
        .open()
        .then(() => undefined);
    });
    expect(await closed).toBeInstanceOf(Error);
    expect(transferErrors.map((e) => e.fatal)).toEqual([true]);
    errSpy.mockRestore();
  });

  it("fails a command immediately once the read pump has given up", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = new MockInstrument(() => null);
    mock.transferInFailures = [new Error("Cancelled")];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    const dev = new CfxDevice(mock, { onClose: () => resolveClosed() });
    await dev.open();
    await closed;
    // The pump is gone; the reply to this can never arrive, so it must not sit in the queue
    // waiting out a timeout.
    await expect(dev.status()).rejects.toThrow(/closed/);
    errSpy.mockRestore();
  });

  it("reports a transferOut failure and drops the stranded pending reply", async () => {
    const mock = new MockInstrument((cmd) =>
      cmd === "STATUS?" ? { payload: text(STATUS_IDLE) } : null,
    );
    mock.transferOutFailures = [new Error("The device was disconnected.")];
    const transferErrors: CfxTransferErrorEvent[] = [];
    const dev = new CfxDevice(mock, { onTransferError: (e) => transferErrors.push(e) });
    await dev.open();
    await expect(dev.status()).rejects.toThrow(/disconnected/);
    expect(transferErrors).toEqual([
      { at: expect.any(Number), direction: "out", message: "The device was disconnected.", attempt: 1, fatal: true },
    ]);
    // The channel must still work afterwards: a write that never went out must not leave a
    // phantom entry in the reply queue for the next command's answer to be matched against.
    const res = await dev.status();
    expect(res.running).toBe(false);
    await dev.close();
  });
});
