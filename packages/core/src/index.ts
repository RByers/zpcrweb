/**
 * @zpcrweb/core — read Bio-Rad CFX qPCR `.zpcr` files in Node and the browser.
 *
 * Main entry point: {@link parseZpcr} takes raw bytes (`Uint8Array` | `ArrayBuffer`) and
 * returns a fully typed {@link Zpcr}. In Node you can also use {@link zpcrFromFile}; in the
 * browser, pass `await file.arrayBuffer()` (or a `Uint8Array`) to `parseZpcr`.
 */

export { parseZpcr, zpcrFromBlob } from "./zpcr.js";
export { zpcrFromFile, pcrdFromFile } from "./node.js";

export { hexDump } from "./hex.js";
export { deltaBaseline, subtractSeries } from "./analysis.js";
export {
  toCurves,
  toDarkCurves,
  toTemperatureCurves,
  toSteps,
  toChannels,
  wellLabel,
  REFERENCE_ROW,
} from "./pivot.js";
export { parseFactoryRefRowCal, compareRefToCal } from "./refcal.js";
export { extractTemps, tempLabel, tempRow } from "./temps.js";
export { parseIcff, icffFieldMap } from "./icff.js";
export {
  parseRunInfo,
  parseRunInfoRaw,
  popcount,
} from "./runinfo.js";
export {
  decodePlateRead,
  decodePlateReadDetail,
  wellIndex,
  isPlateReadName,
  plateReadNumber,
  CHANNELS,
  WELLS_PER_CHANNEL,
  COLUMNS,
  ROWS,
} from "./plateread.js";
export { parsePltd, isPltdName } from "./pltd.js";
export { parsePcrd, isPcrdName, pcrdFromBlob } from "./pcrd.js";
export { zipCryptoDecrypt } from "./zipcrypto.js";
export { inflateRaw } from "./inflate.js";

export type {
  Zpcr,
  RunMetadata,
  PlateRead,
  WellReading,
  WellCurve,
  DarkCurve,
  PlateReadTemp,
  TemperatureCurve,
  TempKind,
  CurveOptions,
  PlateReadStep,
  ArchiveAccess,
  HexDumpOptions,
  RefWellCal,
  RefCalComparison,
  PltdEntry,
} from "./types.js";
export type { IcffEntry } from "./icff.js";
export type { PlatereadDetail } from "./plateread.js";
export type {
  Pltd,
  PltdContainer,
  PltdOptions,
  PlateDefinition,
  WellDefinition,
  WellFluor,
  PlateFluor,
  SampleType,
} from "./pltd.js";
export type { Pcrd, PcrdContainer, PcrdOptions } from "./pcrd.js";
