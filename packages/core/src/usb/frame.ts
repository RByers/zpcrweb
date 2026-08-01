/**
 * The CFX96 application-layer frame — `usb.md` §2.
 *
 * Every logical message in either direction is a 5-byte header followed by exactly the payload
 * length the header announces. This is the application's own framing, carried inside the payload
 * bytes of a bulk transfer on endpoint 2 OUT / 6 IN; it is unrelated to USB's own packetization.
 *
 * The distinction that matters for a reader: **the header describes the whole logical message,
 * which is routinely larger than one 64-byte USB packet.** Only the first packet of a message
 * carries a header; everything after it is raw continuation payload. A reader that tries to parse
 * a header out of every packet will eventually mistake continuation bytes for one — which is
 * exactly the bug `usb.md` §8 records in an earlier version of the capture decoder. {@link
 * FrameReassembler} is therefore the only supported way to read this stream: feed it whatever
 * chunks the transport hands back, and it emits complete messages.
 */

/** Bytes of header preceding every logical message's payload. */
export const FRAME_HEADER_BYTES = 5;

/** The header's bit-packed fields (`usb.md` §2). */
export interface CfxFrameHeader {
  /** Logical session id. Always 0 in every message of both reference captures (`usb.md` §9). */
  handle: number;
  /** 0–3, multiplexing independent streams over one endpoint pair. 1 is the ASCII command
   * channel (`usb.md` §3); 0 and 2 carry short binary payloads that are only partly understood
   * (§4); 3 has never been observed. */
  channel: number;
  newLine: boolean;
  charTimeout: number;
  msgTimeout: number;
  ascii: boolean;
  textPayload: boolean;
  /**
   * Set by the device on a response whose payload is **raw bytes rather than text**. The
   * reference captures never varied this bit, so `usb.md` §2 could only name it; this library
   * measured it against a live instrument, where `GETFILESLEN "\Storage Card"` answers with
   * `passThrough` set and four binary bytes while every text response leaves it clear. Treat it
   * as the signal to skip {@link parseResponse} and take the payload as-is.
   */
  passThrough: boolean;
  dummyAdded: boolean;
}

/** A complete logical message: its header plus exactly `length` payload bytes. */
export interface CfxMessage extends CfxFrameHeader {
  payload: Uint8Array;
}

/**
 * Header values a host request uses. Every channel-1 request in both reference captures carries
 * exactly these — `newLine` set, the fixed 7/7 timeout pair, and the two text flags — so they are
 * constants of the protocol rather than anything a caller needs to vary (`usb.md` §2).
 */
export const REQUEST_HEADER: Omit<CfxFrameHeader, "channel"> = {
  handle: 0,
  newLine: true,
  charTimeout: 7,
  msgTimeout: 7,
  ascii: true,
  textPayload: true,
  passThrough: false,
  dummyAdded: false,
};

/** Decode the 5 header bytes at the start of `bytes`. Also returns the announced payload length,
 * which is not itself a header *field* the caller sets — it always follows from the payload. */
export function decodeHeader(
  bytes: Uint8Array,
): CfxFrameHeader & { payloadLength: number } {
  if (bytes.length < FRAME_HEADER_BYTES) {
    throw new Error(`frame header needs ${FRAME_HEADER_BYTES} bytes, got ${bytes.length}`);
  }
  const [b0, b1, b2, b3, b4] = [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!];
  return {
    handle: b0 >> 2,
    channel: b0 & 0b11,
    newLine: !!(b1 & 0b0100_0000),
    charTimeout: (b1 >> 3) & 0b111,
    msgTimeout: b1 & 0b111,
    ascii: !!(b2 & 0b1000),
    textPayload: !!(b2 & 0b0100),
    passThrough: !!(b2 & 0b0010),
    dummyAdded: !!(b2 & 0b0001),
    // Big-endian, unlike the little-endian float arrays inside a `.Plateread` (`plateread.md`).
    payloadLength: (b3 << 8) | b4,
  };
}

/** Encode one logical message. The length field is derived from `payload`, never passed in. */
export function encodeFrame(header: CfxFrameHeader, payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffff) {
    throw new Error(`payload too long for a 16-bit length field: ${payload.length}`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  out[0] = ((header.handle & 0b111111) << 2) | (header.channel & 0b11);
  out[1] =
    (header.newLine ? 0b0100_0000 : 0) |
    ((header.charTimeout & 0b111) << 3) |
    (header.msgTimeout & 0b111);
  out[2] =
    (header.ascii ? 0b1000 : 0) |
    (header.textPayload ? 0b0100 : 0) |
    (header.passThrough ? 0b0010 : 0) |
    (header.dummyAdded ? 0b0001 : 0);
  out[3] = (payload.length >> 8) & 0xff;
  out[4] = payload.length & 0xff;
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Reassembles one direction's byte stream into complete logical messages.
 *
 * Stateful and direction-specific: give the IN stream and the OUT stream each their own instance.
 * {@link push} appends a chunk and returns however many complete messages that chunk finished —
 * none, one, or several — holding any partial remainder for the next call.
 */
export class FrameReassembler {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): CfxMessage[] {
    if (chunk.length > 0) {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
    const out: CfxMessage[] = [];
    for (;;) {
      if (this.buf.length < FRAME_HEADER_BYTES) break;
      const header = decodeHeader(this.buf);
      const total = FRAME_HEADER_BYTES + header.payloadLength;
      if (this.buf.length < total) break; // still owed continuation bytes
      const { payloadLength, ...rest } = header;
      out.push({ ...rest, payload: this.buf.slice(FRAME_HEADER_BYTES, total) });
      this.buf = this.buf.slice(total);
    }
    return out;
  }

  /** Bytes held back as an incomplete message — non-zero mid-transfer, and a desync signal if it
   * stays non-zero while the link is idle. */
  get pending(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}
