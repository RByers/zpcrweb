/**
 * The file checksum `CRCSENDFILE` carries (`usb.md` §7.4).
 *
 * Uploading a file means announcing its checksum first — `CRCSENDFILE "<crc>*<path>",<bytes>` —
 * and the instrument recomputes the same number over what it stored, which `GETFILECRC` reports
 * back. Get it wrong and the two disagree, so this is the difference between an upload the
 * instrument accepts and one it distrusts.
 *
 * Despite the command names it is **not a CRC**: it is a byte-interleaved XOR, bytes at even
 * indices into the high half and odd indices into the low half. `usb.md` §7.4 derives it, and it
 * reproduces all four uploads in the reference capture exactly.
 *
 * ## The parity ambiguity, and why it is handled rather than resolved
 *
 * All four files the capture uploaded have an **odd** byte length (17,299 / 1,821 / 8,751 /
 * 1,291). That is not the coincidence it looks like — it is the limit of what the capture can
 * settle. The same four values are also produced by the degenerate CRC-16 with polynomial
 * `x^16 + 1` (a register that XORs in each byte and rotates right eight times), which is a far
 * more likely thing to find behind a function called `GETFILECRC`. The two agree on every
 * odd-length input and **swap halves on every even-length one**, so the capture cannot tell them
 * apart, and neither can this library.
 *
 * So {@link cfxFileCrc} implements what `usb.md` §7.4 states, {@link cfxFileCrcSwapped} is the
 * other reading, and `CfxDevice.sendFile` compares the instrument's answer against both. An
 * even-length upload therefore *measures* the question instead of merely failing it: a file that
 * comes back matching the swapped value says, in one line, that the shift-register reading is the
 * right one and this file should be flipped. Until an even-length file has actually been sent to
 * an instrument, neither answer is knowable from here.
 */

/**
 * The checksum the instrument agrees with for a file's bytes (`usb.md` §7.4).
 *
 * Verified against all four files the reference capture uploaded, each of which the instrument
 * echoed back unchanged through `GETFILECRC`. For an even-length file see the module comment.
 */
export function cfxFileCrc(bytes: Uint8Array): number {
  let even = 0;
  let odd = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (i & 1) odd ^= bytes[i] as number;
    else even ^= bytes[i] as number;
  }
  return ((even << 8) | odd) & 0xffff;
}

/**
 * The same checksum under the shift-register reading — identical for an odd-length input, halves
 * swapped for an even-length one. See the module comment: this exists so a failed verification
 * can say *which* of the two conventions the instrument actually uses.
 */
export function cfxFileCrcSwapped(bytes: Uint8Array): number {
  const crc = cfxFileCrc(bytes);
  return ((crc << 8) | (crc >>> 8)) & 0xffff;
}

/**
 * True when the two readings above differ for this length, i.e. the checksum is a guess.
 *
 * Only even-length files are ambiguous. A caller can use this to warn *before* sending, rather
 * than discovering it from a mismatch afterwards.
 */
export function cfxFileCrcIsAmbiguous(byteLength: number): boolean {
  return byteLength % 2 === 0 && byteLength > 0;
}

/**
 * The wire form of a checksum: five decimal digits, zero-padded.
 *
 * The padding is what the capture shows the host sending (`05672`, not `5672`), and it is
 * deliberately *not* symmetric — the instrument answers `GETFILECRC` with the unpadded number.
 * Since both are only ever compared as integers, the padding matters solely for byte-identical
 * command lines, which is reason enough to keep it.
 */
export function formatCfxFileCrc(crc: number): string {
  return String(crc).padStart(5, "0");
}
