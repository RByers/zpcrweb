import type { RunMetadata } from "./types.js";

/**
 * Parser for `RunInfo.xml`. The file is a flat, regular list of
 * `<KeyValuePairs><Key>NAME</Key><Value>VALUE</Value></KeyValuePairs>` blocks, so a small
 * scan is sufficient and avoids pulling in an XML dependency.
 */

const PAIR_RE =
  /<Key>([\s\S]*?)<\/Key>\s*(?:<Value\s*\/>|<Value>([\s\S]*?)<\/Value>)/g;

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

/** Parse `RunInfo.xml` text into a flat key/value map. */
export function parseRunInfoRaw(xml: string): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const match of xml.matchAll(PAIR_RE)) {
    const key = decodeEntities((match[1] ?? "").trim());
    if (key === "") continue;
    // match[2] is undefined for a self-closing <Value /> → empty string.
    raw[key] = match[2] === undefined ? "" : decodeEntities(match[2].trim());
  }
  return raw;
}

function toInt(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Count set bits in a non-negative integer. */
export function popcount(n: number): number {
  let count = 0;
  let v = n >>> 0;
  while (v !== 0) {
    v &= v - 1;
    count++;
  }
  return count;
}

/** Build typed {@link RunMetadata} from `RunInfo.xml` text. */
export function parseRunInfo(xml: string): RunMetadata {
  const raw = parseRunInfoRaw(xml);

  const scanMask = toInt(raw["ScanMask"]);
  const numberReferenceRows = toInt(raw["NumberReferenceRows"]);
  const numberPlateRows = toInt(raw["NumberPlateRows"]);
  const runStartTime = raw["RunStartTime"] ?? "";
  const parsedDate = runStartTime ? new Date(runStartTime) : null;

  return {
    identifier: raw["Identifier"] ?? "",
    // No key in `RunInfo.xml` holds a run's short name (see `RunMetadata.experimentName`), so
    // this is always empty here. It is left as a field rather than omitted because the *shape*
    // is format-neutral — `biomeme.ts` builds the same `RunMetadata` and does have one.
    experimentName: "",
    dataFile: raw["DataFile"] ?? "",
    baseSerialNumber: raw["BaseSerialNumber"] ?? "",
    blockDescription: raw["BlockDescription"] ?? "",
    runStartTime,
    runStartDate:
      parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    scanMask,
    // Only the low 6 bits are optical channels (e.g. 0x81 = C1 only; bit 7 is a flag).
    channelCount: popcount(scanMask & 0x3f),
    numberPlateColumns: toInt(raw["NumberPlateColumns"]),
    numberPlateRows,
    numberReferenceRows,
    rowsIncludingReference: numberPlateRows + numberReferenceRows,
    raw,
  };
}
