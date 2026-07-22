/**
 * The `.Plateread` trailing **descriptor dictionary** — the file's own self-describing
 * schema. After the data regions, the file lists field-name slots; each name is followed
 * 255 bytes later by a descriptor `[uint32 offset][uint32 length][uint8 type]` giving the
 * absolute file offset, byte length, and a type tag of that field's data.
 *
 * This lets us locate every field (scalars, strings, and the WELLDATA/DARKDATA arrays)
 * without hardcoded offsets. Note the encoding is **mixed-endian**: the scalar metadata and
 * these descriptors are read here as needed, while the fluorescence float arrays
 * (WELLDATA/DARKDATA) are little-endian (see plateread.ts).
 */

/** Anchor: the first field name in every CFX plateread dictionary. */
const ANCHOR = "ICFFPRFILEVERSION";
/** A descriptor sits this many bytes after the start of its field name. */
const DESCRIPTOR_GAP = 255;
/** Nominal slot stride (name area + descriptor). */
const SLOT_STRIDE = 264;

/** One decoded descriptor-dictionary entry. */
export interface PlatereadField {
  /** Field name, e.g. `CYCLE`, `BLOCKTEMP`, `WELLDATA`. */
  name: string;
  /** Absolute byte offset of the field's data in the file. */
  offset: number;
  /** Byte length of the field's data. */
  length: number;
  /** Raw type tag (1 across observed files). */
  type: number;
  /** Big-endian int32 value, when the field is a 4-byte scalar. */
  int?: number;
  /** Big-endian float32 value, when the field is a 4-byte scalar. */
  float?: number;
  /** NUL-terminated ASCII text, when the field holds a string. */
  text?: string;
  /** Hex of the first bytes of the field's data (for display). */
  hex: string;
}

/** The fully-decoded structural view of a `.Plateread` file. */
export interface PlatereadDetail {
  /** File size in bytes. */
  size: number;
  /** The three big-endian version/magic words at 0x000. */
  versionWords: number[];
  /** Every descriptor-dictionary field, with decoded values. */
  fields: PlatereadField[];
}

function isNameByte(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39); // A–Z or 0–9
}

function indexOfAscii(bytes: Uint8Array, needle: string, from = 0): number {
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
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
 * Parse the descriptor dictionary into typed fields with their values. Scalars (length 4)
 * are decoded big-endian; longer fields are decoded as ASCII text. Returns `[]` if the
 * dictionary anchor is not found.
 */
export function parseDescriptors(bytes: Uint8Array): PlatereadField[] {
  const dictStart = indexOfAscii(bytes, ANCHOR, 0x0100);
  if (dictStart < 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const fields: PlatereadField[] = [];
  let i = dictStart;
  while (i < bytes.length) {
    if (!isNameByte(bytes[i] as number)) {
      i++;
      continue;
    }
    const start = i;
    while (i < bytes.length && isNameByte(bytes[i] as number)) i++;
    const name = String.fromCharCode(...bytes.subarray(start, i));
    const desc = start + DESCRIPTOR_GAP;
    if (name.length >= 3 && desc + 9 <= bytes.length) {
      const offset = view.getUint32(desc, true);
      const length = view.getUint32(desc + 4, true);
      const type = bytes[desc + 8] as number;
      const field: PlatereadField = {
        name,
        offset,
        length,
        type,
        hex: offset > 0 && offset < bytes.length ? hexOf(bytes, offset, length) : "",
      };
      if (offset > 0 && offset + length <= bytes.length) {
        if (length === 4) {
          field.int = view.getInt32(offset, false); // big-endian scalar
          field.float = view.getFloat32(offset, false);
        } else if (length > 4 && length < 512) {
          field.text = asciiZ(bytes, offset, length);
        }
      }
      fields.push(field);
      i = start + SLOT_STRIDE; // skip past this slot; the loop re-finds the next name
      continue;
    }
    // Not a real slot — keep scanning from just after this run.
  }
  return fields;
}

/** Fully decode a `.Plateread` file's structure (version words + descriptor fields). */
export function decodePlateReadDetail(bytes: Uint8Array): PlatereadDetail {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionWords = [
    view.getInt32(0, false),
    view.getInt32(4, false),
    view.getInt32(8, false),
  ];
  return { size: bytes.length, versionWords, fields: parseDescriptors(bytes) };
}

/** Build a name→field map for quick lookups. */
export function fieldMap(fields: PlatereadField[]): Map<string, PlatereadField> {
  const m = new Map<string, PlatereadField>();
  for (const f of fields) m.set(f.name, f);
  return m;
}
