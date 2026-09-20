/**
 * The wire half of the emulator — `emulator.md` §3.
 *
 * A {@link UsbDeviceLike} that frames and reassembles exactly as `frame.ts` describes: a command
 * arrives as a complete logical message on the OUT endpoint, its reply goes back as a
 * {@link REQUEST_HEADER}-shaped frame on the IN endpoint, and `transferIn` **parks** while there
 * is nothing to say, the way a real bulk endpoint blocks. No shortcuts: a test against something
 * that answered a decoded command string would prove nothing about the framing the client
 * actually has to get right.
 *
 * This is deliberately *only* the transport. It knows nothing about the command language — it
 * hands each message's payload to a reply function and pushes back whatever comes out — which is
 * what lets both the stateful emulator ({@link EmulatedInstrument}) and `usbDevice.test.ts`'s
 * scripted replies share one shell instead of two drifting copies of the framing.
 */
import { FrameReassembler, encodeFrame, type CfxFrameHeader } from "../frame.js";
import type { UsbDeviceLike, UsbInTransferResultLike } from "../transport.js";
import { CFX_PRODUCT_ID, CFX_VENDOR_ID } from "../transport.js";

/** One reply to one command. `passThrough` marks a raw-bytes payload (`usb.md` §2); omitting
 * `channel` answers on the ASCII channel the command came in on. */
export interface EmulatorReply {
  payload: Uint8Array;
  passThrough?: boolean;
  channel?: number;
}

/**
 * What answers a command. `command` is the payload decoded as latin1 with its terminator
 * stripped — the ordinary case — and `payload` is the same message's raw bytes, which is what
 * `CRCSENDFILE` needs, being the one command whose payload is not all text (`usb.md` §5).
 *
 * Returning null says nothing at all comes back, which is how a test simulates an instrument
 * that has stopped answering.
 */
export type EmulatorResponder = (command: string, payload: Uint8Array) => EmulatorReply | null;

const LATIN1 = new TextDecoder("latin1");

/**
 * The header bytes a *device* reply carries — measured, and not the same as a request's.
 *
 * `usb.md` §2: a host request sets `ascii` and `textPayload` (byte 2 = `0x0c`) and the fixed 7/7
 * timeout pair, while a response leaves byte 1 and byte 2 at `0x00` even for ordinary text —
 * `01 00 00 00 <len>`, or `01 00 02 00 <len>` when `passThrough` marks a raw-bytes payload. Those
 * two flags describe what the *sender* declares about its own payload, so an emulator that echoed
 * the request header back would be inventing a reply shape no instrument produces.
 */
const RESPONSE_HEADER: Omit<CfxFrameHeader, "channel"> = {
  handle: 0,
  newLine: false,
  charTimeout: 0,
  msgTimeout: 0,
  ascii: false,
  textPayload: false,
  passThrough: false,
  dummyAdded: false,
};

/**
 * A framed, parking transport that answers through `respond`.
 *
 * The failure-injection fields are here rather than in a test-only subclass because the read
 * pump's error handling is the part of `CfxDevice` most worth exercising and the least
 * observable: a stalled endpoint, a cancelled transfer and a write that never goes out are three
 * different recoveries, and all three are one queued `Error` away from being testable.
 */
export class EmulatorTransport implements UsbDeviceLike {
  readonly vendorId = CFX_VENDOR_ID;
  readonly productId = CFX_PRODUCT_ID;
  opened = false;
  configuration: unknown = null;
  /** Interface numbers `claimInterface` was called with. */
  readonly claimed: number[] = [];
  /** Command lines received, in order — the assertion surface for sequencing. */
  readonly sent: string[] = [];
  /** Errors `transferIn` throws instead of resolving, one per call, oldest first. */
  transferInFailures: Error[] = [];
  /** Errors `transferOut` throws instead of resolving, one per call, oldest first. */
  transferOutFailures: Error[] = [];
  /** Every `clearHalt` the read pump asked for, as `direction:endpoint`. */
  readonly halts: string[] = [];

  private readonly inbound = new FrameReassembler();
  private readonly outbox: Uint8Array[] = [];
  private readonly waiters: ((v: UsbInTransferResultLike) => void)[] = [];

  constructor(private readonly respond: EmulatorResponder) {}

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  async selectConfiguration(n: number): Promise<void> {
    this.configuration = { configurationValue: n };
  }
  async claimInterface(n: number): Promise<void> {
    this.claimed.push(n);
  }
  async releaseInterface(): Promise<void> {}
  async clearHalt(direction: "in" | "out", endpointNumber: number): Promise<void> {
    this.halts.push(`${direction}:${endpointNumber}`);
  }

  /** Frame `payload` and push it toward the host, waking a parked `transferIn`. */
  push(payload: Uint8Array, { channel = 1, passThrough = false } = {}): void {
    this.pushRaw(encodeFrame({ ...RESPONSE_HEADER, channel, passThrough }, payload));
  }

  /** Push already-framed bytes, so a caller can split one message across several transfers. */
  pushRaw(bytes: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
    else this.outbox.push(bytes);
  }

  async transferOut(_endpoint: number, data: ArrayBuffer | ArrayBufferView): Promise<unknown> {
    const failure = this.transferOutFailures.shift();
    if (failure) throw failure;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    // Through the reassembler, not a per-packet header parse: the host is free to split a large
    // `CRCSENDFILE` across several transfers, and a real instrument reads until the announced
    // length has arrived (`usb.md` §2).
    for (const msg of this.inbound.push(bytes)) {
      const command = LATIN1.decode(msg.payload).replace(/\r?\n$/, "");
      this.sent.push(command);
      const reply = this.respond(command, msg.payload);
      if (reply) {
        this.push(reply.payload, {
          channel: reply.channel ?? msg.channel,
          passThrough: reply.passThrough,
        });
      }
    }
    return {};
  }

  async transferIn(): Promise<UsbInTransferResultLike> {
    const failure = this.transferInFailures.shift();
    if (failure) throw failure;
    const next = this.outbox.shift();
    if (next) return { data: new DataView(next.buffer, next.byteOffset, next.byteLength) };
    // Park until something is pushed — a real bulk endpoint blocks the same way, and this is what
    // makes the read pump's "one long-lived transferIn" shape meaningful here.
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

