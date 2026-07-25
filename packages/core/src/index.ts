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
export { parsePltd, parsePlatesetup2, isPltdName } from "./pltd.js";
export { parsePrcl, parseProtocol2, isPrclName } from "./prcl.js";
export { parseDcal, findDcalBlock, isDcalName } from "./dcal.js";
export { parsePcrd, isPcrdName, pcrdFromBlob } from "./pcrd.js";
export {
  buildDyeResponseCurve,
  interpolateResponse,
  buildCalibrationMatrix,
  preprocessChannelReadings,
  separateChannels,
  separateDyes,
} from "./calibration.js";
export { zipCryptoDecrypt } from "./zipcrypto.js";
export { inflateRaw } from "./inflate.js";
export {
  smoothCurve,
  skipCycles,
  clampBaselineRegion,
  dataWindowRange,
  findBaselineByCurvature,
  findBaselineByRegression,
  autoBaselineRegion,
  subtractBaseline,
} from "./baseline.js";

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
  PrclEntry,
  DcalEntry,
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
export type { Dcal, DcalBlock, DcalSecurity, DcalSerials } from "./dcal.js";
export type {
  Prcl,
  PrclContainer,
  PrclOptions,
  ProtocolDocument,
  ProtocolStep,
  TemperatureStep,
  GradientStep,
  MeltCurveStep,
  GotoStep,
} from "./prcl.js";
export type { Pcrd, PcrdContainer, PcrdOptions } from "./pcrd.js";
export type {
  ResponseKnot,
  DyeResponseCurve,
  NormalizationMode,
  CalibrationMatrix,
  ChannelPreprocessOptions,
  ColorSeparationResult,
} from "./calibration.js";
export type {
  SmoothingMode,
  SmoothingOptions,
  BaselineRegion,
  BaselineRegionConstraints,
  DataWindowOptions,
  CurvatureBaselineOptions,
  RegressionBaselineOptions,
  AutoBaselineOptions,
  BaselineMode,
} from "./baseline.js";
