import type { WellReading } from "./types.js";
import { CHANNELS, WELLS_PER_CHANNEL } from "./plateread.js";
import { parseIcff } from "./icff.js";

/**
 * Binary **writer** for Bio-Rad CFX `.Plateread` files — the inverse of `plateread.ts`'s reader.
 * See `plateread.md` §7, which documents this encoder; §1–§6 document the format itself.
 *
 * Unlike the reader, this is **not** reverse-engineered behaviour: no instrument ever asked for
 * a file to be written. It exists so a plate read can be *synthesized* — the CFX emulator makes
 * one per `PLATEREAD` step, giving every well the same curve — and its only claim to being right
 * is that re-encoding a decoded real file reproduces that file byte for byte
 * (`platereadEncode.test.ts`, over every `.Plateread` in `samples/`).
 */

/** Each WELLDATA/DARKDATA record is four float32 values: mean, std, min, max. */
const RECORD_SIZE = 16;
/** Wells per channel × channels: the 648 records of the fluorescence table (`plateread.md` §2). */
const WELL_RECORDS = CHANNELS * WELLS_PER_CHANNEL;
/** ICFF index-entry layout, mirrored from `icff.ts` — name(255) + offset(4) + length(4) + flag(1). */
const NAME_SIZE = 255;
const ENTRY_STRIDE = 264;
/** The flag byte every index entry in every observed file carries. */
const ENTRY_FLAG = 1;

/**
 * The file's field schema: every field a `PLATEREADVERSION 2` file carries, in the order it
 * carries them, with how its bytes are read. This is the one place the layout is stated — the
 * offsets in `plateread.md` §3 are a consequence of it, since the data region is these fields
 * packed back to back from offset 0 with no padding (measured: every committed sample's
 * descriptors tile `0x000`…the dictionary exactly, with no gaps and no overlaps).
 *
 * `int` is a big-endian `int32`, `float` a big-endian `float32`, `text` ASCII plus one NUL, and
 * the two array kinds are the little-endian `[count][float32 × count]` blocks of §2.
 */
const SCHEMA = [
  { name: "PRFILEVERSION", kind: "int", key: "prFileVersion" },
  { name: "PLATEREADVERSION", kind: "int", key: "plateReadVersion" },
  { name: "CRC", kind: "int", key: "crc" },
  { name: "RUNGUID", kind: "text", key: "runGuid" },
  { name: "ALPHASERIALNUMBER", kind: "text", key: "alphaSerialNumber" },
  { name: "BASESERIALNUMBER", kind: "text", key: "baseSerialNumber" },
  { name: "HEADSERIALNUMBER", kind: "text", key: "headSerialNumber" },
  { name: "FIRMWAREVERSIONS", kind: "text", key: "firmwareVersions" },
  { name: "SHUTTLEPARAM", kind: "text", key: "shuttleParam" },
  { name: "SCANMODE", kind: "int", key: "scanMode" },
  { name: "RETRIEVALTYPE", kind: "int", key: "retrievalType" },
  { name: "SCANINDEX", kind: "int", key: "scanIndex" },
  { name: "STEPIDENTIFICATION", kind: "int", key: "stepIdentification" },
  { name: "STEP", kind: "int", key: "step" },
  { name: "CYCLE", kind: "int", key: "cycle" },
  { name: "ERRORNUMBER", kind: "int", key: "errorNumber" },
  { name: "ERRORDESCRIPTION", kind: "text", key: "errorDescription" },
  { name: "BLOCKTEMP", kind: "float", key: "blockTempC" },
  { name: "AMBIENTTEMP", kind: "float", key: "ambientTempC" },
  { name: "SHUTTLETEMP", kind: "float", key: "shuttleTempC" },
  { name: "SAMPLETEMP", kind: "float", key: "sampleTempC" },
  { name: "LIDTEMP", kind: "float", key: "lidTempC" },
  { name: "LEDCURRENT01", kind: "int", key: "ledCurrent1" },
  { name: "LEDCURRENT02", kind: "int", key: "ledCurrent2" },
  { name: "LEDCURRENT03", kind: "int", key: "ledCurrent3" },
  { name: "LEDCURRENT04", kind: "int", key: "ledCurrent4" },
  { name: "LEDCURRENT05", kind: "int", key: "ledCurrent5" },
  { name: "LEDCURRENT06", kind: "int", key: "ledCurrent6" },
  { name: "FANSTATE", kind: "int", key: "fanState" },
  // Set points, not measurements — int32 °C where the five temperatures above are float32
  // (`plateread.md` §3, "Temperatures").
  { name: "FANOFFTEMP", kind: "int", key: "fanOffTempC" },
  { name: "FANONTEMP", kind: "int", key: "fanOnTempC" },
  { name: "LIDSTATE", kind: "int", key: "lidState" },
  { name: "LIDFORCE", kind: "int", key: "lidForce" },
  { name: "LIDPOSITION", kind: "int", key: "lidPosition" },
  { name: "CHANNELMASK", kind: "int", key: "channelMask" },
  { name: "NUMBERCOLUMNS", kind: "int", key: "numberColumns" },
  { name: "NUMBERROWS", kind: "int", key: "numberRows" },
  { name: "DATETIME", kind: "text", key: "dateTime" },
  { name: "DELTATIME", kind: "int", key: "deltaTime" },
  { name: "WELLDATA", kind: "wells", key: "" },
  { name: "DARKDATA", kind: "dark", key: "" },
  { name: "FILEPATH", kind: "text", key: "filePath" },
] as const;

type SchemaField = (typeof SCHEMA)[number];
type ScalarField = Extract<SchemaField, { kind: "int" | "float" | "text" }>;

/**
 * Every scalar and string the file carries, named after its dictionary field. Derived from
 * {@link SCHEMA} so the two cannot drift: `text` fields are strings, the rest are numbers.
 *
 * The temperatures are °C as measured (`blockTempC`, `lidTempC` and friends), `cycle`/`step`
 * place the read in the run, `filePath` is the instrument's own path for it
 * (`\Storage Card\CurrentRun\Read0000N.xlateread` — the extension really is misspelled in the
 * file), and the serials, firmware banner and LED currents identify the machine that took it.
 */
export type PlateReadHeader = {
  [F in ScalarField as F["key"]]: F["kind"] extends "text" ? string : number;
};

/** Everything {@link encodePlateRead} needs to write a `.Plateread` file. */
export interface PlateReadSpec {
  /** The scalar header (`plateread.md` §3). */
  header: PlateReadHeader;
  /**
   * The fluorescence table (`plateread.md` §2), asked for one reading at a time: `channel` is
   * 0–5 and `well` is the row-major index `row * 12 + col`, 0–107, row 8 being the reference
   * row. A caller giving every well the same curve returns the same reading for every `well`.
   */
  readings: (channel: number, well: number) => WellReading;
  /** The LED-off background reading for `channel` (0–5) — the DARKDATA record. */
  dark: (channel: number) => WellReading;
}

/** Read a NUL-terminated ASCII string out of a field's bytes. */
function asciiZ(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let i = start; i < start + length && bytes[i] !== 0; i++) {
    text += String.fromCharCode(bytes[i] as number);
  }
  return text;
}

/** Write `text` plus its terminating NUL. */
function textBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Write one 16-byte record: mean, std, min, max as little-endian float32. */
function writeRecord(view: DataView, offset: number, r: WellReading): void {
  view.setFloat32(offset, r.mean, true);
  view.setFloat32(offset + 4, r.std, true);
  view.setFloat32(offset + 8, r.min, true);
  view.setFloat32(offset + 12, r.max, true);
}

/** The `[count][float32 × count]` block a float array field is framed as, count included. */
function arrayBytes(records: number, record: (index: number) => WellReading): Uint8Array {
  const bytes = new Uint8Array(4 + records * RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, records * 4, true); // count of floats, little-endian like the payload
  for (let i = 0; i < records; i++) writeRecord(view, 4 + i * RECORD_SIZE, record(i));
  return bytes;
}

/** This field's data bytes, in the form the file stores them. */
function fieldBytes(field: SchemaField, spec: PlateReadSpec): Uint8Array {
  switch (field.kind) {
    case "wells":
      return arrayBytes(WELL_RECORDS, (i) =>
        spec.readings(Math.floor(i / WELLS_PER_CHANNEL), i % WELLS_PER_CHANNEL),
      );
    case "dark":
      return arrayBytes(CHANNELS, (i) => spec.dark(i));
    case "text":
      return textBytes(spec.header[field.key]);
    default: {
      const bytes = new Uint8Array(4);
      const view = new DataView(bytes.buffer);
      // Big-endian, unlike the arrays above — the mixed endianness of `plateread.md`'s preamble.
      if (field.kind === "float") view.setFloat32(0, spec.header[field.key], false);
      else view.setInt32(0, spec.header[field.key], false);
      return bytes;
    }
  }
}

/**
 * Write a `.Plateread` file: the fields of {@link SCHEMA} packed from offset 0, then the ICFF
 * descriptor dictionary locating each one, then the 8-byte footer locating the dictionary
 * (`plateread.md` §4, `icff.md`).
 *
 * Nothing about the layout is hardcoded here: offsets fall out of the field sizes, so a longer
 * serial number or firmware banner simply shifts what follows it, exactly as the instrument's
 * own files do.
 */
export function encodePlateRead(spec: PlateReadSpec): Uint8Array {
  const data = SCHEMA.map((field) => fieldBytes(field, spec));
  const dataSize = data.reduce((sum, b) => sum + b.length, 0);
  const indexSize = 4 + SCHEMA.length * ENTRY_STRIDE;
  const out = new Uint8Array(dataSize + indexSize + 8);
  const view = new DataView(out.buffer);

  let offset = 0;
  const offsets: number[] = [];
  for (const bytes of data) {
    offsets.push(offset);
    out.set(bytes, offset);
    offset += bytes.length;
  }

  // The dictionary: the `ICFF` magic, then one fixed-width entry per field.
  const index = offset;
  out.set([0x49, 0x43, 0x46, 0x46], index); // "ICFF"
  let p = index + 4;
  for (let i = 0; i < SCHEMA.length; i++) {
    const name = SCHEMA[i]!.name;
    for (let c = 0; c < name.length; c++) out[p + c] = name.charCodeAt(c) & 0xff;
    view.setUint32(p + NAME_SIZE, offsets[i]!, true);
    view.setUint32(p + NAME_SIZE + 4, data[i]!.length, true);
    out[p + NAME_SIZE + 8] = ENTRY_FLAG;
    p += ENTRY_STRIDE;
  }

  view.setUint32(p, index, true);
  view.setUint32(p + 4, ENTRY_STRIDE, true);
  return out;
}

/**
 * Read a `.Plateread` file back into the {@link PlateReadSpec} that would write it — the exact
 * inverse of {@link encodePlateRead}.
 *
 * `decodePlateRead` and `decodePlateReadDetail` both answer questions *about* a read (its curves,
 * its raw layout) and neither is invertible: the detail view types a field's bytes for display
 * and truncates the bulk arrays to a hex preview. This one keeps every value instead, so that
 * a read can be taken apart, altered and written back — which is how the emulator turns a
 * recorded read into the one its own run is producing.
 *
 * Throws if the file is not a `PLATEREADVERSION 2`-shaped read: a field of {@link SCHEMA}
 * missing, or an array field the wrong length.
 */
export function decodePlateReadSpec(bytes: Uint8Array): PlateReadSpec {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = new Map(parseIcff(bytes).map((e) => [e.name, e]));

  const header = {} as Record<string, number | string>;
  let wellStart = 0;
  let darkStart = 0;
  for (const field of SCHEMA) {
    const entry = fields.get(field.name);
    if (!entry) throw new Error(`not a .Plateread: no ${field.name} field`);
    switch (field.kind) {
      case "int":
        header[field.key] = view.getInt32(entry.offset, false);
        break;
      case "float":
        header[field.key] = view.getFloat32(entry.offset, false);
        break;
      case "text": {
        const text = asciiZ(bytes, entry.offset, entry.length);
        // A string field is its text plus exactly one NUL in every observed file. Anything else
        // — padding, or bytes past the terminator — would be lost on the way back out, so refuse
        // it rather than quietly re-encode something shorter than what was read.
        if (text.length + 1 !== entry.length) {
          throw new Error(`${field.name}: ${entry.length} bytes is not a NUL-terminated string`);
        }
        header[field.key] = text;
        break;
      }
      default: {
        const records = field.kind === "wells" ? WELL_RECORDS : CHANNELS;
        if (entry.length !== 4 + records * RECORD_SIZE) {
          throw new Error(`${field.name}: expected ${records} records, got ${entry.length} bytes`);
        }
        if (field.kind === "wells") wellStart = entry.offset + 4;
        else darkStart = entry.offset + 4;
      }
    }
  }

  const record = (start: number, index: number): WellReading => {
    const at = start + index * RECORD_SIZE;
    return {
      mean: view.getFloat32(at, true),
      std: view.getFloat32(at + 4, true),
      min: view.getFloat32(at + 8, true),
      max: view.getFloat32(at + 12, true),
    };
  };

  return {
    header: header as PlateReadHeader,
    readings: (channel, well) => record(wellStart, channel * WELLS_PER_CHANNEL + well),
    dark: (channel) => record(darkStart, channel),
  };
}
