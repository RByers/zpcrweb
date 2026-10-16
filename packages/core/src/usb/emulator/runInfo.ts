/**
 * The emulated run's own `RunInfo.xml` (`emulator.md` §7).
 *
 * The recording supplies one, and most of it is the instrument rather than the run — serial
 * numbers, firmware versions, factory calibration — so that part is kept byte for byte. Four keys
 * belong to the run itself and are rewritten here, because a host treats `RunInfo.xml` as the
 * run's identity: the follower decides which open file a run folder belongs to by comparing it
 * exactly (`runFolder.ts`'s `isSameRun`). Carried verbatim, every emulated run had the recorded
 * run's identity, so a second run was taken for the first and its reads were merged into the
 * first run's file.
 */
import type { EmulatorRunData } from "./data.js";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** What makes one run's `RunInfo.xml` its own. */
export interface RunInfoFields {
  /** `Identifier` — a GUID, fresh per run on the instrument. */
  identifier: string;
  /** `RunStartTime`, an RFC 1123 "GMT" stamp — the same clock `.Plateread` `DATETIME` uses. */
  startedAt: Date;
  /** `DataFile` — the file name the instrument proposes for the run. */
  dataFile: string;
  /** `RunDefinition` — the protocol as recorded, `;`-joined. */
  runDefinition: string;
}

/**
 * A GUID-shaped identifier for the run requested at `requestedAtMs` under `name`.
 *
 * Derived rather than random so an emulated session is reproducible: the same requests at the same
 * simulated times give the same files. It is unique where it has to be — one instrument never
 * accepts two runs at the same instant — and makes no claim to be a real GUID. FNV-1a, four seeds
 * for the four 32-bit words. *This library's own*; nothing about the real one's generation is known.
 */
export function emulatedRunIdentifier(requestedAtMs: number, name: string): string {
  const text = `${requestedAtMs}|${name}`;
  const words = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).toUpperCase().padStart(8, "0");
  });
  const hex = words.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `<yyyymmdd>_<hhmmss>_<serial>_<name>.zpcr` — the recorded `DataFile`'s shape
 * (`20260720_211747_CT019138_Luna_noRT.zpcr`): the `.alf`'s stem (`report.ts`'s
 * `reportFileName`) but with the name's case kept and not cut to twelve characters. *Derived* from
 * that one recording; how the instrument sanitizes a name for it is not known, so anything not
 * filename-safe becomes `_`.
 */
export function dataFileName(startedAt: Date, baseSerial: string, runName: string): string {
  const d = `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}`;
  const t = `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
  return `${d}_${t}_${baseSerial}_${runName.replace(/[^A-Za-z0-9_-]/g, "_")}.zpcr`;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * `recorded` with this run's {@link RunInfoFields} written over the recording's. Each key's
 * `<Value>` is replaced in place, so layout, line endings and every other key keep the recording's
 * exact bytes; a key the recording lacks is left absent rather than invented.
 */
export function emulatedRunInfo(recorded: Uint8Array, fields: RunInfoFields): Uint8Array {
  const values: Record<string, string> = {
    Identifier: fields.identifier,
    RunStartTime: fields.startedAt.toUTCString(),
    DataFile: fields.dataFile,
    RunDefinition: fields.runDefinition,
  };
  // Byte-per-char both ways, so a non-ASCII byte in the recording survives untouched.
  let xml = "";
  for (const b of recorded) xml += String.fromCharCode(b);
  for (const [key, value] of Object.entries(values)) {
    const pair = new RegExp(`(<Key>${key}</Key>\\s*)(<Value\\s*/>|<Value>[^<]*</Value>)`);
    xml = xml.replace(pair, (_, head: string) => `${head}<Value>${escapeXml(value)}</Value>`);
  }
  const out = new Uint8Array(xml.length);
  for (let i = 0; i < xml.length; i++) out[i] = xml.charCodeAt(i) & 0xff;
  return out;
}

/** The support files a run folder starts with: the recording's, with its `RunInfo.xml` made this run's. */
export function runSupportFiles(data: EmulatorRunData, fields: RunInfoFields): Record<string, Uint8Array> {
  const files = data.supportFiles();
  const recorded = files["RunInfo.xml"];
  if (recorded !== undefined) files["RunInfo.xml"] = emulatedRunInfo(recorded, fields);
  return files;
}
