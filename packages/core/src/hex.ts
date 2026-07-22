import type { HexDumpOptions } from "./types.js";

/**
 * Produce a canonical hex + ASCII dump of a byte buffer, in the classic `hexdump -C`
 * style: an 8-digit offset, up to `bytesPerRow` hex byte pairs, then the printable ASCII
 * gutter. Intended for the web UI to show raw contents of files we do not yet fully parse.
 */
export function hexDump(data: Uint8Array, options: HexDumpOptions = {}): string {
  const bytesPerRow = options.bytesPerRow ?? 16;
  const limit =
    options.maxBytes === undefined
      ? data.length
      : Math.min(options.maxBytes, data.length);

  const lines: string[] = [];
  for (let offset = 0; offset < limit; offset += bytesPerRow) {
    const rowEnd = Math.min(offset + bytesPerRow, limit);

    let hex = "";
    let ascii = "";
    for (let i = offset; i < offset + bytesPerRow; i++) {
      if (i < rowEnd) {
        const byte = data[i] as number;
        hex += byte.toString(16).padStart(2, "0") + " ";
        ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
      } else {
        hex += "   ";
      }
      if (i - offset === bytesPerRow / 2 - 1) hex += " ";
    }

    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex} |${ascii}|`);
  }

  if (limit < data.length) {
    lines.push(`… ${data.length - limit} more bytes (truncated)`);
  }

  return lines.join("\n");
}
