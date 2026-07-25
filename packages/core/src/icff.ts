/**
 * "ICFF" — Bio-Rad's hand-rolled index container format. See `icff.md` for the full
 * reverse-engineered layout. Used by `.Plateread` (see `plateread.ts`) and, per private
 * reverse-engineering notes, `.Dcal` calibration files.
 *
 * Values are packed first; a trailing index (found via the file's last 8 bytes) lists every
 * field's name, offset, and length, preceded by an `ICFF` magic. The index itself is
 * little-endian; what a given field's bytes *mean* is up to the format built on top, but both
 * known consumers decode scalar int32/float32 fields big-endian and bulk float arrays
 * little-endian.
 */

const MAGIC = "ICFF";
/** Name field width within each index entry. */
const NAME_SIZE = 255;
/** Total bytes per index entry: name(255) + offset(4) + length(4) + flag(1). */
const ENTRY_STRIDE = 264;
/** Trailing `[index_offset][entry_stride]`, both u32 LE. */
const FOOTER_SIZE = 8;

/** One decoded ICFF index entry. */
export interface IcffEntry {
  /** Field name, e.g. `CYCLE`, `BLOCKTEMP`, `WELLDATA`. */
  name: string;
  /** Absolute byte offset of the field's data in the file. */
  offset: number;
  /** Byte length of the field's data. */
  length: number;
  /** Raw flag/count byte from the index entry (`0x01` in every file observed). */
  flag: number;
  /** Big-endian int32 value, when the field is a 4-byte scalar. */
  int?: number;
  /** Big-endian float32 value, when the field is a 4-byte scalar. */
  float?: number;
  /** NUL-terminated ASCII text, when the field looks like a string. */
  text?: string;
  /** Hex of the first bytes of the field's data (for display). */
  hex: string;
}

function asciiZ(bytes: Uint8Array, start: number, maxLen: number): string {
  let s = "";
  const end = Math.min(bytes.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

function hexOf(bytes: Uint8Array, start: number, length: number): string {
  const end = Math.min(bytes.length, start + Math.min(length, 16));
  let s = "";
  for (let i = start; i < end; i++) s += (bytes[i] as number).toString(16).padStart(2, "0");
  return length > 16 ? s + "…" : s;
}

/**
 * Parse an ICFF container's trailing index into typed entries. Reads the footer
 * (`index_offset`, `entry_stride`) from the file's last 8 bytes, confirms the `ICFF` magic at
 * `index_offset`, then walks entries until the footer. Scalars (length 4) are decoded
 * big-endian; longer fields are decoded as ASCII text when plausible. Returns `[]` if the file
 * has no ICFF footer/magic.
 */
export function parseIcff(bytes: Uint8Array): IcffEntry[] {
  if (bytes.length < FOOTER_SIZE) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const footerOffset = bytes.length - FOOTER_SIZE;
  const indexOffset = view.getUint32(footerOffset, true);
  const stride = view.getUint32(footerOffset + 4, true) || ENTRY_STRIDE;
  if (indexOffset <= 0 || indexOffset + 4 > bytes.length) return [];
  if (asciiZ(bytes, indexOffset, 4) !== MAGIC) return [];

  const entries: IcffEntry[] = [];
  let p = indexOffset + 4;
  while (p + stride <= footerOffset) {
    const name = asciiZ(bytes, p, NAME_SIZE);
    const offset = view.getUint32(p + NAME_SIZE, true);
    const length = view.getUint32(p + NAME_SIZE + 4, true);
    const flag = bytes[p + NAME_SIZE + 8] as number;
    const entry: IcffEntry = {
      name,
      offset,
      length,
      flag,
      hex: offset > 0 && offset < bytes.length ? hexOf(bytes, offset, length) : "",
    };
    if (offset > 0 && offset + length <= bytes.length) {
      if (length === 4) {
        entry.int = view.getInt32(offset, false); // big-endian scalar
        entry.float = view.getFloat32(offset, false);
      } else if (length > 4 && length < 512) {
        entry.text = asciiZ(bytes, offset, length);
      }
    }
    entries.push(entry);
    p += stride;
  }
  return entries;
}

/** Build a name→entry map for quick lookups. */
export function icffFieldMap(entries: IcffEntry[]): Map<string, IcffEntry> {
  const m = new Map<string, IcffEntry>();
  for (const e of entries) m.set(e.name, e);
  return m;
}
