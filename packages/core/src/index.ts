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
export {
  subtractSeries,
  baselineCorrectCurve,
  computeCqTable,
  ANALYSIS_BASELINE_MODE,
} from "./analysis.js";
export {
  toCurves,
  toDarkCurves,
  toTemperatureCurves,
  toLedCurves,
  toSteps,
  toChannels,
  wellLabel,
  REFERENCE_ROW,
} from "./pivot.js";
export { parseFactoryRefRowCal, compareRefToCal } from "./refcal.js";
export { extractTemps, tempLabel } from "./temps.js";
export { extractLeds, ledLabel, ledChannel } from "./leds.js";
export { parseIcff, icffFieldMap } from "./icff.js";
export {
  parseRunInfo,
  parseRunInfoRaw,
  popcount,
} from "./runinfo.js";
export {
  decodePlateRead,
  decodePlateReadDetail,
  buildWellTable,
  isPlateReadName,
  plateReadNumber,
  CHANNELS,
  WELLS_PER_CHANNEL,
  COLUMNS,
  ROWS,
} from "./plateread.js";
export { parsePltd, parsePlatesetup2, isPltdName } from "./pltd.js";
export { plateToCsv, parsePlateCsv, isPlateCsvName, isBlankWell } from "./plateCsv.js";
export { attachPlateToZpcr } from "./attachPlate.js";
export {
  parseZpcrwebSettings,
  parseZpcrwebSettingsJson,
  formatZpcrwebSettings,
  writeZpcrwebSettings,
  hasZpcrwebSettings,
  ZPCRWEB_SETTINGS_NAME,
  ZPCRWEB_SETTINGS_VERSION,
} from "./zpcrwebSettings.js";
export { parsePrcl, parseProtocol2, isPrclName } from "./prcl.js";
export { parseDcal, findDcalBlock, isDcalName, dyeChannelLookup } from "./dcal.js";
export { parsePcrd, isPcrdName, pcrdFromBlob } from "./pcrd.js";
export {
  buildDyeResponseCurve,
  buildDyeReadingCurves,
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
  refineBaselineStart,
  validateBaselineRegion,
  subtractBaseline,
  fitLinearBaseline,
} from "./baseline.js";
export { stdDev, meanSquaredSuccessiveDifference, whiteness, median } from "./stats.js";
export {
  baselineNoise,
  residualWhiteness,
  autoThreshold,
  resolveThreshold,
  isAmplified,
  findThresholdCrossing,
  findInflectionCq,
  computeCq,
} from "./threshold.js";

export type {
  Zpcr,
  RunMetadata,
  PlateRead,
  PlateReadField,
  PlateReadBinaryFile,
  WellReading,
  WellTable,
  WellCurve,
  WellFactors,
  DarkCurve,
  PlateReadTemp,
  TemperatureCurve,
  TempKind,
  PlateReadLed,
  LedCurve,
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
export type {
  CurveBaselineResult,
  CqTableCurve,
  CqTableEntry,
  CqTableOptions,
} from "./analysis.js";
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
export type { ZpcrwebSettings, ZpcrwebAnalysisSettings } from "./zpcrwebSettings.js";
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
  ReadingKnot,
  DyeReadingCurves,
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
  BaselineStartRefinementOptions,
  BaselineValidationOptions,
  BaselineMode,
  LinearBaselineFit,
} from "./baseline.js";
export type {
  NoiseEstimator,
  BaselineNoiseOptions,
  AutoThresholdOptions,
  ThresholdOptions,
  AmplificationOptions,
  CqCrossingOptions,
  CqAlgorithm,
  CqOptions,
} from "./threshold.js";
