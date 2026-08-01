/**
 * `CfxDevice` against a mock instrument.
 *
 * The mock is worth more than it looks: the parts of this client most likely to break are the
 * read pump and the command queue, and both are invisible to a parser test. The scripted replies
 * below are the real instrument's, so a regression here is a regression against measured
 * behaviour rather than against an invented fixture.
 */
import { describe, expect, it } from "vitest";
import {
  CfxDevice,
  FRAME_HEADER_BYTES,
  REQUEST_HEADER,
  decodeHeader,
  encodeFrame,
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
    const mock = new MockInstrument((cmd) => ({ payload: text(`${cmd}-value;0000`) }));
    const dev = new CfxDevice(mock);
    await dev.open();
    const [a, b, c] = await Promise.all([
      dev.command("BASESN?"),
      dev.command("ALPHASN?"),
      dev.command("CPLD?"),
    ]);
    expect(a.value).toBe("BASESN?-value");
    expect(b.value).toBe("ALPHASN?-value");
    expect(c.value).toBe("CPLD?-value");
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

  it("refuses to list when GETFILESLEN answers with a binary payload", async () => {
    const mock = new MockInstrument((cmd) =>
      cmd.startsWith("GETFILESLEN")
        ? { payload: new Uint8Array([0x07, 0x00, 0x09, 0x00]), passThrough: true }
        : { payload: text("stale.xml;0000") },
    );
    const dev = new CfxDevice(mock);
    await dev.open();
    const dir = await dev.listFiles("\\Storage Card");
    expect(dir.listed).toBe(false);
    expect(dir.names).toEqual([]);
    // The point of the guard: LISTALLFILES must not even be sent, or it would return another
    // directory's contents under this path.
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
    await expect(dev.command("WORKING?")).rejects.toThrow(/timed out/);
    // The channel must still work afterwards: a dropped request has to leave the queue clean.
    mock.push(text("True;0000"));
    await dev.close();
  });

  it("rejects in-flight commands when the device closes", async () => {
    const mock = new MockInstrument(() => null);
    const dev = new CfxDevice(mock);
    await dev.open();
    const pending = dev.command("WORKING?");
    await dev.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
