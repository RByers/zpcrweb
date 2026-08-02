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
 * Which half is which is **measured**, not inferred. The captures could not settle it — every file
 * they upload is odd-length, and on an odd length this is indistinguishable from the degenerate
 * CRC-16 with polynomial `x^16 + 1`, which is a far more likely thing to find behind a command
 * called `GETFILECRC`. Five even-length files uploaded to a real C1000 came back matching the form
 * below and not the byte-swapped one, which retires that hypothesis; `usb.md` §9.2 has the vectors
 * and `runPlan.test.ts` pins them.
 */

/**
 * The checksum the instrument agrees with for a file's bytes (`usb.md` §7.4).
 *
 * Verified against all four files the reference capture uploaded, each of which the instrument
 * echoed back unchanged through `GETFILECRC`, and against five even-length files sent to real
 * hardware to fix the byte order (`usb.md` §9.2).
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
