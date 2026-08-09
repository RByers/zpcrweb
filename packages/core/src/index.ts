/**
 * @zpcrweb/core — read Bio-Rad CFX qPCR `.zpcr` files in Node and the browser.
 *
 * Main entry point: {@link parseZpcr} takes raw bytes (`Uint8Array` | `ArrayBuffer`) and
 * returns a fully typed {@link Zpcr}. In Node you can also use {@link zpcrFromFile}; in the
 * browser, pass `await file.arrayBuffer()` (or a `Uint8Array`) to `parseZpcr`.
 */

export { parseZpcr, parseZpcrArchive, zpcrFromBlob } from "./zpcr.js";
export { zpcrFromFile, pcrdFromFile } from "./node.js";

export { hexDump } from "./hex.js";
export {
  baselineCorrectCurve,
  correctCurveForDisplay,
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
  wellKey,
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
export { parsePltd, parsePlatesetup2, isPltdName, SAMPLE_TYPES, SAMPLE_TYPE_TO_RAW } from "./pltd.js";
export { plateToCsv, parsePlateCsv, isPlateCsvName, isBlankWell } from "./plateCsv.js";
export {
  editWells,
  applyWellPatches,
  setPlateFluors,
  normalizePlate,
  wellPatch,
  clearPatch,
} from "./plateEdit.js";
export type { WellPatch } from "./plateEdit.js";
export { formatPlateBlock, parsePlateBlock } from "./plateClipboard.js";
export type { PlateBlock } from "./plateClipboard.js";
export { attachPlate, attachProtocol } from "./attachPlate.js";
export { buildExperimentArchive } from "./experimentArchive.js";
export type { ExperimentArchiveParts } from "./experimentArchive.js";
/** A `.zpcr` as a file, and a `.zpcr` as the entries it holds. Everything else in this library
 * that touches an archive takes and returns the latter — see `ZpcrArchive`, which is also what a
 * run directory off the instrument already is. */
export { unzipArchive, zipArchive } from "./archive.js";
export type { ZpcrArchive } from "./archive.js";
export {
  zpcrFromRunFiles,
  zpcrNameFromRunFiles,
  runIdentityFileNames,
  isSameRun,
  runFilesToFetch,
  runProgressFromNames,
  runCompleteness,
  markExperimentBegun,
  RUN_BEGUN_MARKER,
  RUN_ENDED_MARKER,
} from "./runFolder.js";
export type { RunProgress, RunCompleteness, RunFolderNaming } from "./runFolder.js";
export {
  parseZpcrwebSettings,
  parseZpcrwebSettingsJson,
  formatZpcrwebSettings,
  writeZpcrwebSettings,
  hasZpcrwebSettings,
  ZPCRWEB_SETTINGS_NAME,
  ZPCRWEB_SETTINGS_VERSION,
} from "./zpcrwebSettings.js";
export {
  parsePrcl,
  parseProtocol2,
  isPrclName,
  protocolDocumentFromRunDefinition,
  formatRunDefinitionText,
  parseRunDefinitionText,
  describeProtocolStep,
} from "./prcl.js";
export {
  parseRunDefinition,
  expectedPlateReads,
  splitRunDefinition,
  isRunDefinitionVerb,
  parseScanMask,
  parseScanMaskOperand,
  formatScanMaskOperand,
  RUN_DEFINITION_VERBS,
  SCAN_MASK_CHANNELS,
  SCAN_MASK_FLYOVER_BIT,
} from "./runDefinition.js";
/** How every user-visible length of time is spelled — `45:00`, not `2700 s`. */
export { formatDuration } from "./duration.js";
/** The editable counterpart of `runDefinition.ts` — see `protocol.md` §10. */
export {
  ProtocolBuilder,
  ProtocolBuilderError,
  defaultProtocolHeader,
  defaultScanSelection,
  defaultStepDraft,
  describeScanSelection,
  scanSelectionFromMask,
  scanSelectionToMask,
  validateProtocolHeader,
  validateStepDraft,
  MAX_PROTOCOL_STEPS,
  PROTOCOL_LIMITS,
  PROTOCOL_METHODS,
  PROTOCOL_STEP_KINDS,
  SCAN_CHANNEL_CHOICES,
  STEP_MODIFIERS,
} from "./protocolBuilder.js";
export type {
  GotoStepDraft,
  GradStepDraft,
  MeltStepDraft,
  PlateReadStepDraft,
  ProtocolHeaderDraft,
  ProtocolIssue,
  ProtocolLimit,
  ProtocolMethod,
  ProtocolStepDraft,
  ProtocolStepKind,
  ScanChannelChoice,
  ScanSelection,
  TempStepDraft,
} from "./protocolBuilder.js";
/** The `.alf` run report (`alf.md`) — the instrument's own per-step execution log. */
export { parseAlf, isAlfName, alfThermalProfile } from "./alf.js";
export type {
  AlfReport,
  AlfHeader,
  AlfErrorSummary,
  AlfStep,
  AlfSetpoint,
  AlfEntry,
  ThermalPhase,
  ThermalSegment,
  ThermalRead,
  ThermalProfile,
} from "./alf.js";
export { parseDcal, findDcalBlock, isDcalName, dyeChannelLookup } from "./dcal.js";
export { parsePcrd, isPcrdName, pcrdFromBlob } from "./pcrd.js";
export { parseBiomeme } from "./biomeme.js";
export {
  fileCategory,
  fileKindDescription,
  fileKindFromName,
  matchesSupportedExtension,
  SUPPORTED_EXTENSIONS,
} from "./fileKind.js";
export {
  buildDyeResponseCurve,
  buildDyeReadingCurves,
  interpolateResponse,
  buildCalibrationMatrix,
  preprocessChannelReadings,
  separateChannels,
  separateDyes,
} from "./calibration.js";
/** Live-instrument USB client (`usb.md`) — the one subsystem here that talks to hardware rather
 * than decoding bytes, hence its own directory. Isomorphic like the rest: see
 * `usb/transport.ts` for why WebUSB and Node share a single implementation. */
export * from "./usb/index.js";
/** The USB traffic log this app records for a run it drove itself (`usb-traffic.md`). */
export {
  UsbTrafficRecorder,
  USB_TRAFFIC_LOG_NAME,
  USB_TRAFFIC_TEXT_NAME,
  formatUsbTrafficLog,
  formatUsbTrafficBytes,
  isUsbTrafficLog,
  isUsbTrafficName,
  parseUsbTrafficLog,
  usbTrafficText,
  usbTrafficPreview,
  USB_PREVIEW_UNITS,
} from "./usbTraffic.js";
export type {
  UsbTrafficRecord,
  UsbTrafficMessage,
  UsbTrafficError,
  UsbTrafficGap,
} from "./usbTraffic.js";
export {
  deriveExperimentName,
  nextFreeRunFileBase,
  resolveExperimentName,
  runFileBaseName,
} from "./experiment.js";
export { zipCryptoDecrypt } from "./zipcrypto.js";
export { inflateRaw } from "./inflate.js";
export {
  baselineRegion,
  subtractBaseline,
  fitLinearBaseline,
  smoothPlateauTail,
  endPointRfu,
  BASELINE_BEGIN_CYCLE,
  BASELINE_END_MARGIN,
  END_POINT_CYCLES,
} from "./baseline.js";
export {
  stdDev,
  median,
  baselineNoise,
  autoThreshold,
  resolveThreshold,
  computeCq,
  DEFAULT_THRESHOLD_MULTIPLIER,
} from "./threshold.js";
export {
  resolveTubeType,
  wellTubeType,
  plateTubeTypes,
  wellDyeSet,
  matchFluorCalibrations,
  computeFluorCurves,
  dyeSpaceFluorCurves,
  NO_TARGET,
  plateTargets,
  targetGroups,
  formatRfu,
  formatCq,
  formatBaselineFormula,
  curveKey,
  channelCurveKey,
  darkCurveKey,
  stepTemperature,
  runAnalysisSettingsFromZpcrweb,
  computeRunAnalysis,
} from "./runAnalysis.js";
export {
  channelLabel,
  csvRow,
  buildAnalysisRows,
  analysisCsv,
  analysisCsvFilename,
  UNKNOWN_CHANNEL_LABEL,
} from "./analysisRows.js";

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
export type {
  ScanMask,
  RunDefinitionProgram,
  RunDefinitionDirective,
  RunDefinitionVerb,
  MethodDirective,
  HotLidDirective,
  VolumeDirective,
  TempDirective,
  GradDirective,
  IncDirective,
  RateDirective,
  PlateReadDirective,
  GotoDirective,
  EndDirective,
  UnknownDirective,
} from "./runDefinition.js";
export type { Pcrd, PcrdContainer, PcrdOptions } from "./pcrd.js";
export type { FileKind, FileCategory } from "./fileKind.js";
export type { FileAnalysis } from "./types.js";
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
export type { BaselineRegion, BaselineMode, LinearBaselineFit } from "./baseline.js";
export type { AutoThresholdOptions, ThresholdOptions } from "./threshold.js";
export type {
  TubeType,
  DyeSolver,
  FluorCalibration,
  FluorCorrections,
  FluorCurve,
  TargetGroup,
  AnalysisSource,
  RunAnalysisSettings,
  CurveAnalysis,
  RunAnalysis,
} from "./runAnalysis.js";
export type { AnalysisRow, CurveVisible } from "./analysisRows.js";
