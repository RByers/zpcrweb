/**
 * @zpcrweb/core — read Bio-Rad CFX qPCR `.zpcr` files in Node and the browser.
 *
 * Main entry point: {@link parseZpcr} takes raw bytes (`Uint8Array` | `ArrayBuffer`) and
 * returns a fully typed {@link Zpcr}. In Node you can also use {@link zpcrFromFile}; in the
 * browser, pass `await file.arrayBuffer()` (or a `Uint8Array`) to `parseZpcr`.
 */

export { parseZpcr, zpcrFromBlob } from "./zpcr.js";
export { zpcrFromFile } from "./node.js";

export { hexDump } from "./hex.js";
export { deltaBaseline, subtractSeries } from "./analysis.js";
export { toCurves, toDarkCurves, wellLabel, REFERENCE_ROW } from "./pivot.js";
export { parseFactoryRefRowCal, compareRefToCal } from "./refcal.js";
export {
  parseRunInfo,
  parseRunInfoRaw,
  popcount,
} from "./runinfo.js";
export {
  decodePlateRead,
  wellIndex,
  isPlateReadName,
  plateReadNumber,
  CHANNELS,
  WELLS_PER_CHANNEL,
  COLUMNS,
  ROWS,
} from "./plateread.js";

export type {
  Zpcr,
  RunMetadata,
  PlateRead,
  WellReading,
  WellCurve,
  DarkCurve,
  CurveOptions,
  ArchiveAccess,
  HexDumpOptions,
  RefWellCal,
  RefCalComparison,
} from "./types.js";
