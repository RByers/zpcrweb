/**
 * The one run-level derivation every consumer of a run's Cq shares: matching the plate's
 * fluorophores to `.Dcal` calibration data, grouping wells by target, running channel→dye color
 * separation, and — on top of those — **the** Cq table.
 *
 * A Cq is not a property of one curve: its group's threshold is the median baseline noise across
 * the curves it's computed *with* (`threshold.md` §5.2), so computing it over different subsets
 * of the plate for different consumers produces different, legitimately disagreeing answers for
 * the same well. There is exactly one Cq per well/fluorophore pair per run, computed here over
 * the whole plate; every caller — the web app's chart, table and hover cards, and any other
 * consumer of this library — filters the result for display and never recomputes a subset.
 *
 * ## The analysis pipeline is format-independent, by rule
 *
 * **Nothing in this module may read a field that only one source format carries.** Calibration
 * and thresholding consume `Zpcr` — reads, plate, `.Dcal` calibrations, protocol — and every one
 * of those is populated identically by `parseZpcr` and `parsePcrd`. A `.zpcr` and the `.pcrd`
 * saved from the same run must produce the same curves, the same thresholds and the same Cq,
 * because they are the same measurement; a number that changes with the container it was saved
 * in is not a measurement result, it's an artifact.
 *
 * This is checked, not just asserted: `.zpcr`/`.pcrd` pairs of one run agree to ~4e-5 cycles in
 * Cq, the residual being nothing but storage precision (a `.pcrd` writes well readings as text
 * rounded to two decimals, a `.zpcr` as binary float32).
 */

import {
  ANALYSIS_BASELINE_MODE,
  computeCqTable,
  correctCurveForDisplay,
  type CqTableCurve,
  type CqTableEntry,
  type CurveBaselineResult,
} from "./analysis.js";
import type { LinearBaselineFit } from "./baseline.js";
import {
  buildCalibrationMatrix,
  buildDyeResponseCurve,
  preprocessChannelReadings,
  separateChannels,
  type CalibrationMatrix,
  type DyeResponseCurve,
  type NormalizationMode,
} from "./calibration.js";
import type { Dcal } from "./dcal.js";
import { REFERENCE_ROW, wellKey } from "./pivot.js";
import type { PlateDefinition } from "./pltd.js";
import type { DarkCurve, DcalEntry, FileAnalysis, PltdEntry, WellCurve, Zpcr } from "./types.js";
import type { ZpcrwebSettings } from "./zpcrwebSettings.js";

// ---- Fluorophore calibration and color separation --------------------------------------------

/** The two physical tube/plate types Bio-Rad calibrates against — see `dcal.md`. */
export type TubeType = "BR Clear" | "BR White";

/**
 * A plate's tube type comes from `plateName` (see pltd.md "Vessel type"), compared
 * case-insensitively per that doc's warning. `MJ White` — the legacy MJ-lineage vessel — has no
 * calibration of its own and joins against the same `BR White` half of the archive's `.Dcal`
 * data as `BR White`. Anything else (including no plate data) defaults to Clear.
 */
export function resolveTubeType(plateName: string | undefined): TubeType {
  return plateName?.trim().toLowerCase().includes("white") ? "BR White" : "BR Clear";
}

/**
 * The tube type one well sits in: its own {@link WellDefinition.vessel} when the plate states one
 * per well, else the plate's {@link PlateDefinition.plateName}. Only a `.plt.csv` can state it
 * per well — see that field — so for every CFX-authored plate this is the plate's own answer for
 * every well, exactly as before.
 */
export function wellTubeType(plate: PlateDefinition | undefined, row: number, col: number): TubeType {
  const well = plate?.wells.find((w) => w.row === row && w.col === col);
  return resolveTubeType(well?.vessel ?? plate?.plateName);
}

/**
 * Every tube type present on a plate, plate order, deduplicated — one entry for a normal
 * single-vessel plate, two for a mixed one. Drives how many calibration matrices a run needs
 * ({@link computeRunAnalysis}).
 */
export function plateTubeTypes(plate: PlateDefinition | undefined): TubeType[] {
  if (!plate) return [resolveTubeType(undefined)];
  const seen: TubeType[] = [];
  for (const w of plate.wells) {
    const tube = resolveTubeType(w.vessel ?? plate.plateName);
    if (!seen.includes(tube)) seen.push(tube);
  }
  return seen.length ? seen : [resolveTubeType(plate.plateName)];
}

/** One fluorophore present on the plate, with its calibration curve if a matching `.Dcal` was found. */
export interface FluorCalibration {
  fluor: string;
  /** Primary optical channel — used only for coloring/labeling, never fed into the solve itself.
   * Undefined when the plate doesn't know it (see `PlateFluor.channel`); the solve is unaffected,
   * since it works off the `.Dcal` response curves and never this field. */
  channel?: number;
  curve?: DyeResponseCurve;
}

/**
 * Match each of the plate's fluorophores (one per dye layer, see `pltd.md`) to the `.Dcal`
 * calibration for the given tube type. A fluor with no matching calibration file still appears,
 * with `curve` unset, so callers can show it as present-but-uncalibrated rather than silently
 * dropping it.
 */
export function matchFluorCalibrations(
  plateFluors: { fluor: string; channel?: number }[],
  calibrations: DcalEntry[],
  tube: TubeType,
): FluorCalibration[] {
  // Case-insensitive: shipped .Dcal/calibrationCollection data is inconsistent between
  // display-cased ("BR White") and upper-cased ("BR WHITE") forms of the same tube type —
  // see pltd.md's vessel-type section.
  const wantedTube = tube.trim().toLowerCase();
  const byDye = new Map<string, Dcal>();
  for (const { dcal } of calibrations) {
    // Dye names are matched case-insensitively too: a hand-edited `.plt.csv` plate won't
    // reproduce Bio-Rad's own casing ("Tex 615", "Cal Gold 540") exactly, and a case slip
    // shouldn't silently cost that fluor its calibration.
    if (dcal.plate.trim().toLowerCase() === wantedTube) byDye.set(dcal.dye.trim().toLowerCase(), dcal);
  }
  const seen = new Map<string, FluorCalibration>();
  for (const f of plateFluors) {
    if (seen.has(f.fluor)) continue; // a plate lists each fluor once per dye layer already
    const dcal = byDye.get(f.fluor.trim().toLowerCase());
    seen.set(f.fluor, {
      fluor: f.fluor,
      channel: f.channel,
      curve: dcal ? buildDyeResponseCurve(dcal) : undefined,
    });
  }
  return [...seen.values()];
}

/**
 * The per-cycle, per-well corrections `calibration.md` §4 applies to a raw reading before the
 * solve. All three parts are optional and independent: a run may carry any combination.
 */
export interface FluorCorrections {
  /**
   * Per-channel reference level per cycle — `referenceLevel[i][cycle]`, where `i` indexes the
   * `channels` array passed to {@link computeFluorCurves}. The pivot for the gain correction
   * (§4.1); with no `wellFactor` it has no effect, by design.
   */
  referenceLevel?: number[][];
  /**
   * Per-channel additive background per cycle, same indexing — subtracted outright (§4.2). The
   * plate read's LED-off `DARKDATA`, present only when the user-facing "Subtract dark" setting
   * is on; left undefined when it is off, which is the default.
   */
  backgroundLevel?: number[][];
  /** One well's gain factors across `channels`, or undefined when the run has none (§4.1). */
  wellFactor?: (row: number, col: number) => number[] | undefined;
}

/** Pull cycle `i`'s column out of a `[channel][cycle]` table, skipping non-finite entries. */
function columnAt(table: number[][] | undefined, i: number): number[] | undefined {
  if (!table) return undefined;
  const out = table.map((series) => series[i]);
  return out.every((v) => v !== undefined && Number.isFinite(v)) ? (out as number[]) : undefined;
}

/** One fluorophore's separated concentration curve for a single well — mirrors `WellCurve`. */
export interface FluorCurve {
  dye: string;
  /** The fluor's primary channel, carried through for consistent coloring only — undefined when
   * the plate doesn't know it, which colors the curve neutrally rather than as some channel. */
  channel?: number;
  row: number;
  col: number;
  wellLabel: string;
  isReference: boolean;
  cycles: number[];
  mean: number[];
  /** This curve's baseline/threshold/Cq as its source file reports them — see `FileAnalysis`.
   * Only a dye-space source (`Zpcr.dyeSpace`, currently Biomeme) carries one; a color-separated
   * curve never does, since separation is this library's own arithmetic with no file-side
   * equivalent. */
  fileAnalysis?: FileAnalysis;
}

/** The calibration a single well is solved against — one vessel's matrix, plus each of its
 * columns' primary channel (aligned with `matrix.dyes`, and used only for the returned curves'
 * coloring, never fed into the solve). */
export interface DyeSolver {
  matrix: CalibrationMatrix;
  dyeChannels: (number | undefined)[];
}

/**
 * Run color separation for every well and cycle: build the raw per-channel vector (restricted
 * to `channels`, in that order), apply `calibration.md` §4's corrections, and solve against the
 * {@link DyeSolver} `solverFor` returns for that well.
 *
 * `solverFor` is per well rather than per run because a plate may mix vessel types, and white
 * and clear plastic have separate pure-dye calibrations (`calibration.md` §3.1). Returning
 * `undefined` skips the well entirely — that vessel has no usable calibration — which is the
 * same treatment an uncalibrated dye already gets.
 *
 * `corrections` carries the per-cycle reference/dark levels and per-well gain factors. Omitting
 * it skips §4 entirely, which is only right for a run that genuinely has none of that data —
 * the reference and dark levels are per-channel, so dropping them doesn't merely offset every
 * dye's baseline, it changes the channel proportions the solve unmixes.
 *
 * Unlike a raw channel reading (mean/std/min/max), a color-separated value has no direct
 * min/max/std of its own — those describe the pre-separation optical distribution within a
 * well, not the recovered dye concentration — so only a mean series is produced here.
 */
export function computeFluorCurves(
  wellCurves: WellCurve[],
  solverFor: (row: number, col: number) => DyeSolver | undefined,
  channels: number[],
  corrections: FluorCorrections = {},
): FluorCurve[] {
  const byWell = new Map<string, Map<number, WellCurve>>();
  for (const c of wellCurves) {
    const key = wellKey(c.row, c.col);
    const forWell = byWell.get(key) ?? new Map<number, WellCurve>();
    forWell.set(c.channel, c);
    byWell.set(key, forWell);
  }

  const out: FluorCurve[] = [];
  for (const byChannel of byWell.values()) {
    const first = [...byChannel.values()][0];
    if (!first) continue;
    // Per well, because the plate may mix vessels and each plastic has its own calibration
    // (`WellDefinition.vessel`). On the single-vessel plates every CFX format can express, every
    // well gets the same solver and this is the one matrix it always was.
    const solver = solverFor(first.row, first.col);
    if (!solver) continue;
    const { matrix, dyeChannels } = solver;
    const cycles = first.cycles;
    const perDye: number[][] = matrix.dyes.map(() => new Array<number>(cycles.length).fill(0));
    // Per well, not per cycle: the gain factors are a fixed property of the plate position.
    const wellFactor = corrections.wellFactor?.(first.row, first.col);

    for (let i = 0; i < cycles.length; i++) {
      const raw = channels.map((ch) => byChannel.get(ch)?.mean[i] ?? 0);
      const corrected = preprocessChannelReadings(raw, {
        referenceLevel: columnAt(corrections.referenceLevel, i),
        wellFactor,
        backgroundLevel: columnAt(corrections.backgroundLevel, i),
      });
      const { concentrations } = separateChannels(matrix, corrected);
      concentrations.forEach((v, d) => {
        perDye[d]![i] = v;
      });
    }

    matrix.dyes.forEach((dye, d) => {
      out.push({
        dye,
        // Left undefined when unknown — never defaulted to a real channel index.
        channel: dyeChannels[d],
        row: first.row,
        col: first.col,
        wellLabel: first.wellLabel,
        isReference: first.isReference,
        cycles,
        mean: perDye[d]!,
      });
    });
  }
  return out;
}

/**
 * The dye-space equivalent of {@link computeFluorCurves} for a source that needs no color
 * separation (`Zpcr.dyeSpace`, e.g. Biomeme): each raw curve's channel index already *is* a
 * dye, one-to-one, so this just relabels {@link WellCurve}s as {@link FluorCurve}s — no solve,
 * no calibration matrix — and carries each curve's `fileAnalysis` through untouched, which is
 * how the file/computed toggles reach a dye-space run's Cq table.
 */
export function dyeSpaceFluorCurves(
  wellCurves: WellCurve[],
  fluorForChannel: (channel: number) => string | undefined,
): FluorCurve[] {
  return wellCurves.map((c) => ({
    dye: fluorForChannel(c.channel) ?? `Ch${c.channel}`,
    channel: c.channel,
    row: c.row,
    col: c.col,
    wellLabel: c.wellLabel,
    isReference: c.isReference,
    cycles: c.cycles,
    mean: c.mean,
    fileAnalysis: c.fileAnalysis,
  }));
}

// ---- Target grouping --------------------------------------------------------------------------

/** Group label for a loaded well/fluor pair the plate assigns no target/gene to — a real group
 * in target mode rather than a silent fall back to the fluor name, so those curves stay visible,
 * labelled and toggleable. Parenthesized so it can't collide with a real `geneName`. */
export const NO_TARGET = "(none)";

/** Distinct target names on a plate, each carrying the fluor it's first seen assigned to (for
 * coloring — the app colors a dye from its name) — same "first occurrence wins" approach as
 * {@link targetGroups}. */
export function plateTargets(plate: PlateDefinition): { name: string; fluor: string | null }[] {
  const fluorByTarget = new Map<string, string>();
  for (const w of plate.wells) {
    for (const wf of w.fluors) {
      if (wf.target && !fluorByTarget.has(wf.target)) fluorByTarget.set(wf.target, wf.fluor);
    }
  }
  return plate.targets.map((name) => ({ name, fluor: fluorByTarget.get(name) ?? null }));
}

/** One group of curves in target mode: a target/gene, or the {@link NO_TARGET} catch-all. */
export interface TargetGroup {
  target: string;
  /** Every fluorophore this target is loaded as, in plate order — a chip's sublabel. */
  fluors: string[];
  /** Optical channel, for the `Ch<n>` sublabel a chip carries in fluorophore mode; nullish when
   * the group spans several fluorophores, or when the channel isn't known. Not a color — a dye's
   * color comes from its own name (the app's `fluorColors.ts`), so this decides nothing visual
   * beyond that label. */
  channel?: number | null;
  /** Calibration curve of the first of `fluors` that has one — unset when none do, which shows
   * the group as present-but-uncalibrated. */
  curve?: DyeResponseCurve;
}

/**
 * Group a plate's (well, fluor) pairs by their target/gene, in first-seen plate order, with the
 * loaded pairs carrying no target of their own collected into one trailing {@link NO_TARGET}
 * group so they stay labelled and toggleable.
 *
 * That catch-all is only added alongside real targets: a plate with no `geneName` at all is
 * already de facto fluorophore mode, and lumping its dyes into one group would merge their
 * per-group Cq thresholds (`threshold.md` §5.2). Callers fall back to grouping by fluorophore in
 * that case — see {@link RunAnalysis.usingTargets}.
 */
export function targetGroups(plate: PlateDefinition, fluorCals: FluorCalibration[]): TargetGroup[] {
  const byFluor = new Map(fluorCals.map((f) => [f.fluor, f]));
  const fluorsByTarget = new Map<string, string[]>();
  const untargeted: string[] = [];
  for (const w of plate.wells) {
    for (const wf of w.fluors) {
      if (!wf.target) {
        if (w.loaded && !untargeted.includes(wf.fluor)) untargeted.push(wf.fluor);
        continue;
      }
      const fluors = fluorsByTarget.get(wf.target) ?? [];
      if (!fluors.includes(wf.fluor)) fluors.push(wf.fluor);
      fluorsByTarget.set(wf.target, fluors);
    }
  }
  const group = (target: string, fluors: string[]): TargetGroup => {
    const cals = fluors.map((f) => byFluor.get(f));
    return {
      target,
      fluors,
      channel: fluors.length === 1 ? (cals[0]?.channel ?? null) : null,
      curve: cals.find((c) => c?.curve)?.curve,
    };
  };
  const groups = [...fluorsByTarget].map(([target, fluors]) => group(target, fluors));
  if (groups.length > 0 && untargeted.length > 0) groups.push(group(NO_TARGET, untargeted));
  return groups;
}

// ---- Baseline formatting -----------------------------------------------------------------------

/** An RFU level, as a whole number. Fluorescence readings run to thousands and carry nothing
 * meaningful below the ones place, so decimals here are noise dressed as precision. */
export function formatRfu(n: number): string {
  return String(Math.round(n));
}

/** A Cq, to one decimal. The second decimal is well inside the run-to-run spread of replicates,
 * so showing it invites comparisons the number can't support — a CSV export should keep more
 * digits for downstream use instead of calling this. */
export function formatCq(n: number | null | undefined): string {
  return n == null ? "—" : n.toFixed(1);
}

function formatCoefficient(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/** Render a fitted linear baseline as "2000 + 4c" (or "2000 - 4c" for a negative slope) — `c`
 * stands for the cycle number. Used everywhere a baseline is displayed or exported, in place of
 * a single diagnostic RFU value, since the fit is a line, not a point. */
export function formatBaselineFormula(fit: LinearBaselineFit): string {
  const sign = fit.slope < 0 ? "-" : "+";
  // Intercept is an RFU level (thousands); slope is RFU per cycle, often well under 1, so it keeps
  // its decimals — rounding it to a whole number would erase most baselines' drift entirely.
  return `${formatRfu(fit.intercept)} ${sign} ${formatCoefficient(Math.abs(fit.slope))}c`;
}

// ---- The run analysis itself -------------------------------------------------------------------

/** Identity of a single curve — one well, one fluorophore. See {@link CqTableCurve.key}. */
export function curveKey(row: number, col: number, fluor: string): string {
  return `${row},${col},${fluor}`;
}

/** Identity of one raw per-channel curve, for {@link RunAnalysis.plainBaselines}. */
export function channelCurveKey(row: number, col: number, channel: number): string {
  return `ch:${row},${col},${channel}`;
}

/** Identity of one channel's dark (LED-off) overlay, for {@link RunAnalysis.plainBaselines}. */
export function darkCurveKey(channel: number): string {
  return `dark:${channel}`;
}

/**
 * The block temperature a step's calibration matrix is built at: the mean across that step's
 * plate reads, defaulting to 60 °C for a run that reports none. Block temperature is essentially
 * constant across a single PLATEREAD step's cycles (see `plateread.md` §3), so one representative
 * temperature per step is accurate.
 */
export function stepTemperature(zpcr: Zpcr, step: number | undefined): number {
  const temps = zpcr.reads
    .filter((r) => r.step === step)
    .map((r) => r.blockTempC)
    .filter((t): t is number => t != null);
  return temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 60;
}

/** Where a curve's baseline/Cq numbers come from when its source file carries its own
 * ({@link FileAnalysis}) — this library's own computation, or the file's. */
export type AnalysisSource = "file" | "computed";

/**
 * The subset of `ZpcrwebSettings.analysis` (plus the browser-local file/computed toggles) that
 * changes a **number** {@link computeRunAnalysis} reports. Every field is optional: absent means
 * "no opinion", and the documented default applies.
 */
export interface RunAnalysisSettings {
  /** Manual per-fluorophore threshold override (RFU), keyed by threshold group — the
   * fluorophore, always (see {@link RunAnalysis.thresholdGroupOf}). A group with no entry uses
   * the automatic threshold (`threshold.md` §5.2). */
  thresholdOverrides?: ReadonlyMap<string, number>;
  /** Manual per-*curve* threshold override (RFU), keyed by {@link curveKey} — one well's one
   * dye. Outranks {@link thresholdOverrides}, which in turn outranks the auto value. */
  curveThresholdOverrides?: ReadonlyMap<string, number>;
  /** §5.1's auto-threshold multiplier: `threshold = k × median baseline noise`. Default
   * {@link DEFAULT_THRESHOLD_MULTIPLIER}. */
  thresholdMultiplier?: number;
  /** Calibration matrix column normalization; see `calibration.md` §3. Default `"global"`.
   * Doesn't change any reported RFU for a full-column-rank matrix — only conditioning. */
  calibrationNormalization?: NormalizationMode;
  /** Whether {@link RunAnalysis.cqTable}'s baseline fields (correctedValues/baselineFit/
   * baselineRegion/deltaRfu) come from this library's computation or the source file's own
   * {@link FileAnalysis}, for a curve that carries one. Default `"file"`. */
  baselineSource?: AnalysisSource;
  /** Same as {@link baselineSource}, for the Cq fields (cq/threshold/endRfu). Default `"file"`. */
  cqSource?: AnalysisSource;
}

/**
 * Unpack `doc.analysis` into {@link RunAnalysisSettings} — the pure conversion half of what a
 * file's `zpcrweb.json` carries. Doesn't touch `doc.experimentName`: that's run *metadata*, not
 * anything that changes a number, so it stays out of the type this function returns (a consumer
 * that wants it reads `doc.experimentName` directly).
 */
export function runAnalysisSettingsFromZpcrweb(
  doc: ZpcrwebSettings | null | undefined,
): RunAnalysisSettings {
  const a = doc?.analysis;
  if (!a) return {};
  return {
    thresholdOverrides: a.thresholdOverrides ? new Map(Object.entries(a.thresholdOverrides)) : undefined,
    curveThresholdOverrides: a.curveThresholdOverrides
      ? new Map(Object.entries(a.curveThresholdOverrides))
      : undefined,
    thresholdMultiplier: a.thresholdMultiplier,
    calibrationNormalization: a.calibrationNormalization,
  };
}

/**
 * Substitute a curve's own {@link FileAnalysis} for the matching half of its computed
 * {@link CqTableEntry}, per `settings.baselineSource`/`cqSource` — see {@link RunAnalysis.cqTable}
 * for why this is the one place either setting takes effect.
 *
 * The two halves are independent by design (two separate toggles): baseline fields
 * (`correctedValues`/`baselineFit`/`baselineRegion`/`noise`/`deltaRfu`) follow `baselineSource`,
 * Cq fields (`cq`/`threshold`/`endRfu`) follow `cqSource`. Mixing "file baseline" with "computed
 * Cq" (or the reverse) is a real combination a caller can pick — the chart's Cq marker and
 * threshold line then sit on the file's threshold against this library's own corrected curve
 * (or vice versa), which won't necessarily land the marker exactly on the crossing; that's an
 * honest picture of two independent analyses compared piecewise, not a bug to paper over.
 *
 * `noise` has no file equivalent (Biomeme states no noise estimate, only the threshold it
 * implies) and always stays this library's own, whichever way `baselineSource` points.
 */
function blendWithFileAnalysis(
  entry: CqTableEntry,
  cycles: number[],
  fileAnalysis: FileAnalysis | undefined,
  settings: Pick<RunAnalysisSettings, "baselineSource" | "cqSource">,
): CqTableEntry {
  if (!fileAnalysis) return entry;
  const out = { ...entry };
  if ((settings.baselineSource ?? "file") === "file") {
    const { region, correctedValues, fit } = fileAnalysis;
    let regionSum = 0;
    let regionCount = 0;
    for (let i = 0; i < cycles.length; i++) {
      if (cycles[i]! >= region.beginCycle && cycles[i]! <= region.endCycle) {
        regionSum += correctedValues[i] ?? 0;
        regionCount++;
      }
    }
    out.baselineRegion = region;
    out.correctedValues = correctedValues;
    out.baselineFit = fit;
    // Mirrors `analysis.ts`'s `baselineCorrectCurve`: last corrected value minus the region mean.
    out.deltaRfu = (correctedValues.at(-1) ?? 0) - (regionCount > 0 ? regionSum / regionCount : 0);
  }
  if ((settings.cqSource ?? "file") === "file") {
    out.cq = fileAnalysis.cq;
    out.threshold = fileAnalysis.threshold;
    out.endRfu = fileAnalysis.endRfu;
  }
  return out;
}

/**
 * The analysis record every plotted series carries — the *only* description of a curve's baseline
 * anywhere downstream of this module.
 *
 * A dye-space curve's record is its {@link CqTableEntry}, which additionally carries the Cq and the
 * threshold it was taken against. A channel-space or dark curve's is a plain
 * {@link CurveBaselineResult}: those series are baselined for *display* but quantify nothing, so
 * `cq`/`threshold` are simply absent (see {@link RunAnalysis.cqTable} for why channel space gets no
 * Cq). One optional type covers both, so a consumer that only needs the baseline treats every
 * series identically.
 */
export type CurveAnalysis = CurveBaselineResult & {
  cq?: number | null;
  threshold?: number | null;
};

export interface RunAnalysis {
  /** `Zpcr.dyeSpace` — true when the source already reports one curve per dye and needs no
   * channel→dye color separation (currently only Biomeme; see `biomeme.ts`). Callers that gate
   * on "has a calibration curve" (`FluorCalibration.curve`) to decide whether a fluor's Cq is
   * trustworthy should treat every fluor as trustworthy here instead — there is no separation to
   * have failed. */
  dyeSpace: boolean;
  /** Whether any curve on this run carries its own {@link FileAnalysis} — whether the file/
   * computed baseline and Cq toggles have anything to offer. */
  hasFileAnalysis: boolean;
  /** The first plate entry in the archive, whatever its decode state — a caller reads
   * `needsPassword`/`error` off it to know whether to prompt for a password. */
  plateEntry: PltdEntry | undefined;
  plate: PlateDefinition | undefined;
  /** Raw per-channel curves for the active step, reference row excluded. */
  allCurves: WellCurve[];
  darkCurves: DarkCurve[];
  /** Optical channels this run actually scanned. */
  available: number[];
  /** The plate's own vessel — its {@link PlateDefinition.plateName}. On a mixed-vessel plate
   * (`.plt.csv` only) that name is empty and this is the default the wells that state nothing
   * fall back to; {@link tubes} is what such a run is actually analysed against. */
  tube: TubeType;
  /** Every vessel type the plate's wells sit in — one entry for any plate CFX can write, two
   * for a mixed one. One calibration matrix is built per entry. */
  tubes: TubeType[];
  fluorCals: FluorCalibration[];
  calibratedFluors: FluorCalibration[];
  calibrationAvailable: boolean;
  stepTemperatureC: number;
  /** Target/gene assigned to each (well, fluor) pair — `Map<wellKey, Map<fluor, target>>`. */
  wellFluorTargets: Map<string, Map<string, string>>;
  /** Fluorophores the plate assigns to each well — `Map<wellKey, Set<fluor>>`. */
  wellFluors: Map<string, Set<string>>;
  /** The same, for loaded wells only — the Cq table's noise cohort. */
  loadedFluors: Map<string, Set<string>>;
  /** Sample name per well, where the plate assigns one. */
  wellSample: Map<string, string>;
  /** Targets on the plate, plus the {@link NO_TARGET} catch-all — empty when the plate has none. */
  targetInfos: TargetGroup[];
  /** Whether this plate has any target at all; when it doesn't, grouping falls back to fluorophore. */
  usingTargets: boolean;
  /** The threshold groups actually in use: {@link targetInfos}, or one group per fluorophore. */
  groupInfos: TargetGroup[];
  /** Color-separated curves for every well and dye — empty when the run has no usable calibration. */
  allFluorCurves: FluorCurve[];
  /**
   * The run's Cq values, one entry per well/fluorophore pair, keyed by {@link curveKey} — the only
   * copy, and the only Cq this library computes at all. Covers the whole plate regardless of any
   * caller's filters, so every caller reads the same number for the same well.
   *
   * **There is deliberately no channel-space equivalent.** A raw channel sees everything that
   * emits into that filter, so an optical channel the plate assigns no fluorophore to would still
   * produce a confident-looking Cq — one belonging to whichever neighbouring dye was bleeding
   * into it. Quantification is per-fluorophore, after color separation (that is what the
   * separation is *for*), and the instrument reports it that way too.
   */
  cqTable: Map<string, CqTableEntry>;
  /**
   * The baseline half of the same analysis, for the plotted series that have no Cq: the raw
   * per-channel curves ({@link channelCurveKey}) and the dark overlay ({@link darkCurveKey}).
   *
   * A "relative"/baseline-corrected display mode subtracts a fitted baseline from *whatever* it
   * is plotting, channel space included — so those series need a baseline even though they will
   * never be quantified. Computed by one call ({@link correctCurveForDisplay}, the same two
   * passes {@link computeCqTable} runs, with a cohort of one) rather than by each caller
   * separately, so a chart's threshold line can never miss its own Cq marker.
   */
  plainBaselines: Map<string, CurveBaselineResult>;
  /** The *display* group a well/fluor pair belongs to — its target, the {@link NO_TARGET}
   * catch-all, or (on a plate with no targets at all) the fluorophore itself. **Not** the
   * threshold group — see {@link thresholdGroupOf}. */
  groupOf: (row: number, col: number, fluor: string) => string;
  /**
   * The **threshold** group a well/fluor pair belongs to: its **fluorophore**, always.
   *
   * Deliberately not the target. A threshold is `multiplier × median baseline noise`
   * (`threshold.md` §5.2), and baseline noise is an optical property of the dye, the instrument and
   * the well — the target is a biological label attached to the same physical measurement. Keying
   * the threshold on the target therefore splits one dye's wells into cohorts that differ only in
   * what the experimenter called them, which is exactly the "Cq incomparable across a plate"
   * failure §5.2 exists to prevent.
   *
   * This also matches what the instrument does. CFX persists its analysis parameters —
   * `thresholdOverrideValue` and `autoCalculateThreshold` included — under
   * `fluorDataAnalysisParam fluorId=…`, one entry per **fluorophore** (`pcrd.md` §2.5,
   * `threshold.md` §9). There is no per-target threshold anywhere in the format.
   */
  thresholdGroupOf: (row: number, col: number, fluor: string) => string;
  /** The fluorophores thresholds are actually resolved per — the groups {@link thresholdGroupOf}
   * returns, and the keys {@link RunAnalysisSettings.thresholdOverrides} uses. */
  thresholdGroups: FluorCalibration[];
}

/**
 * Compute {@link RunAnalysis} for one step of one run — the plate, its fluorophore/target
 * groups, the color-separation inputs, the dye-space curves, and the run's single Cq table.
 *
 * The dye-space solve runs unconditionally, including for a caller only interested in channel
 * space: target thresholds and any export are target-based regardless of display mode, and both
 * read {@link RunAnalysis.cqTable} — which is empty without it.
 */
export function computeRunAnalysis(
  zpcr: Zpcr,
  settings: RunAnalysisSettings,
  activeStep: number | undefined,
  password?: string,
): RunAnalysis {
  const dyeSpace = !!zpcr.dyeSpace;
  const available = zpcr.channels();

  const allCurves: WellCurve[] = zpcr.curves({ includeReference: false, step: activeStep });
  const darkCurves: DarkCurve[] = zpcr.darkCurves(activeStep);
  const hasFileAnalysis = allCurves.some((c) => c.fileAnalysis);

  const plateEntry = zpcr.plates(password)[0];
  const plate = plateEntry?.pltd.plate;
  const calibrations = zpcr.calibrations();
  const tube = resolveTubeType(plate?.plateName);
  // One entry for every plate CFX can write; two only for a `.plt.csv` that mixes plastics.
  const tubes = plateTubeTypes(plate);
  // Per-vessel calibration: the same dye has a different pure-dye response in white than in
  // clear, so each vessel present gets its own matched fluor list and its own matrix below.
  const calsByTube = new Map<TubeType, FluorCalibration[]>(
    tubes.map((t) => [t, plate ? matchFluorCalibrations(plate.fluors, calibrations, t) : []]),
  );

  // The run-level fluor list the UI groups and labels by. A dye is one dye whichever plastic it
  // sits in, so this is merged across vessels rather than duplicated per vessel: the plate's own
  // vessel answers first, and any other present vessel supplies a curve for a dye that one
  // doesn't cover.
  const fluorCals: FluorCalibration[] = (calsByTube.get(tube) ?? calsByTube.get(tubes[0]!) ?? []).map(
    (f) => ({
      ...f,
      curve: f.curve ?? tubes.map((t) => calsByTube.get(t)?.find((o) => o.fluor === f.fluor)?.curve).find(Boolean),
    }),
  );
  // A dye-space source has no `.Dcal` calibration to match — its fluors are trustworthy by
  // construction, not by having found one (see `RunAnalysis.dyeSpace`).
  const calibratedFluors = dyeSpace ? fluorCals : fluorCals.filter((f) => f.curve);
  const calibrationAvailable = calibratedFluors.length > 0;

  // Target/gene assigned to each (well, fluor) pair — pltd.md's per-well target, distinct from the
  // fluor itself: the same dye can carry a different target in different wells.
  const wellFluorTargets = new Map<string, Map<string, string>>();
  if (plate) {
    for (const w of plate.wells) {
      const inner = new Map<string, string>();
      for (const wf of w.fluors) if (wf.target) inner.set(wf.fluor, wf.target);
      wellFluorTargets.set(wellKey(w.row, w.col), inner);
    }
  }

  // Per-well set of fluor names the plate assigns to that well (pltd.md dye layers) — a dye layer
  // doesn't necessarily cover every well.
  const wellFluors = new Map<string, Set<string>>();
  if (plate) {
    for (const w of plate.wells) {
      wellFluors.set(wellKey(w.row, w.col), new Set(w.fluors.map((f) => f.fluor)));
    }
  }

  // The same, restricted to wells the plate actually loads — the noise cohort for the Cq table's
  // thresholds. A dye assigned to a well that was never loaded carries no real signal.
  const loadedFluors = new Map<string, Set<string>>();
  if (plate) {
    for (const w of plate.wells) {
      if (w.loaded) loadedFluors.set(wellKey(w.row, w.col), new Set(w.fluors.map((f) => f.fluor)));
    }
  }

  const wellSample = new Map<string, string>();
  if (plate) for (const w of plate.wells) if (w.sample) wellSample.set(wellKey(w.row, w.col), w.sample);

  const targetInfos = plate ? targetGroups(plate, fluorCals) : [];
  const usingTargets = targetInfos.length > 0;
  const groupInfos: TargetGroup[] = usingTargets
    ? targetInfos
    : fluorCals.map((f) => ({ target: f.fluor, fluors: [f.fluor], channel: f.channel, curve: f.curve }));

  // A well/fluor pair with no target of its own joins the NO_TARGET catch-all rather than being
  // dropped: an NTC/NRT well still gets a real threshold and a real Cq. On a plate with no targets
  // anywhere, the fluorophore *is* the group (see `targetGroups`).
  const groupOf = (row: number, col: number, fluor: string) =>
    usingTargets ? (wellFluorTargets.get(wellKey(row, col))?.get(fluor) ?? NO_TARGET) : fluor;

  // Thresholds group by fluorophore regardless of targets — see `RunAnalysis.thresholdGroupOf`.
  const thresholdGroupOf = (_row: number, _col: number, fluor: string) => fluor;

  // One representative matrix per step — see `stepTemperature`.
  const stepTemperatureC = stepTemperature(zpcr, activeStep);

  // A dye-space source has no channel mixing to solve for at all (see `RunAnalysis.dyeSpace`) —
  // `allFluorCurves` below reads its curves straight off `allCurves` instead.
  // One solver per vessel present — normally exactly one. Each is built over the dyes *that*
  // vessel has calibration for, so a dye covered in clear but not white still quantifies in the
  // clear wells instead of costing the whole run its matrix.
  const solverByTube = new Map<TubeType, DyeSolver>();
  if (!dyeSpace) {
    for (const t of tubes) {
      const cals = (calsByTube.get(t) ?? []).filter((f) => f.curve);
      if (cals.length === 0) continue;
      solverByTube.set(t, {
        // `channels` is passed in rather than slicing rows afterwards so the matrix's column
        // norms — the RFU scale factor of calibration.md §5 — are computed over the rows the
        // solve uses.
        matrix: buildCalibrationMatrix(cals.map((f) => f.curve!), stepTemperatureC, {
          normalization: settings.calibrationNormalization ?? "global",
          channels: available,
        }),
        dyeChannels: cals.map((f) => f.channel),
      });
    }
  }
  // Well → vessel, resolved once: `wellTubeType` scans the plate's wells, and doing that per well
  // inside the separation loop would be quadratic for no gain.
  const tubeByWell = new Map<string, TubeType>();
  if (plate) {
    for (const w of plate.wells) {
      tubeByWell.set(wellKey(w.row, w.col), resolveTubeType(w.vessel ?? plate.plateName));
    }
  }
  const solverFor = (row: number, col: number): DyeSolver | undefined =>
    solverByTube.get(tubeByWell.get(wellKey(row, col)) ?? tube);

  // The §4 corrections applied to every raw reading before the solve. The levels are read per
  // scan, so this is a `[channelIndex][cycle]` table aligned with `available`.
  const stepReads = zpcr.reads.filter((r) => r.step === activeStep);
  // §4.1: one position of the reference row — the first — per channel, LED on.
  // §4.2 has no second stage here: the LED-off `DARKDATA` is deliberately **not** subtracted —
  // it's re-read every cycle and its scatter is random noise no linear baseline can absorb
  // (`calibration.md` §4.2a), 260× worse against CFX's own exported curves when subtracted.
  // §4.1's per-well gain factors are deliberately *not* passed: `Zpcr.wellFactors` is decoded
  // only from a `.pcrd`'s `wellFactorsCollection`, and a `.zpcr` stores no equivalent, so feeding
  // it in would make the same run quantify differently depending on which file you opened —
  // exactly what the format-independence rule above forbids.
  const corrections: FluorCorrections = {
    referenceLevel: available.map((ch) => stepReads.map((r) => r.wells[ch]![REFERENCE_ROW]![0]!.mean)),
  };

  const allFluorCurves = dyeSpace
    ? dyeSpaceFluorCurves(
        allCurves,
        (ch) => new Map(plate?.fluors.map((f) => [f.channel, f.fluor]) ?? []).get(ch),
      )
    : solverByTube.size > 0
      ? computeFluorCurves(allCurves, solverFor, available, corrections)
      : [];

  // ---- The Cq table ------------------------------------------------------------------------
  // Over every well/dye pair on the plate, never a filtered subset. Pairs the plate doesn't load
  // still get an entry — a caller can still plot them ("Unloaded") and they need a Cq of their
  // own — but stay out of their group's noise cohort, since a dye that was never pipetted into a
  // well shouldn't set the threshold bar for the wells that were.
  //
  // This library's own algorithm runs unconditionally, even for a curve carrying `fileAnalysis`
  // — it's the only thing that can resolve a group threshold at all, and it's what
  // `settings.baselineSource`/`cqSource` fall back to for a curve the file left unanalyzed. Where
  // a curve does carry `fileAnalysis` and a setting says "file", `blendWithFileAnalysis` below
  // substitutes the file's own numbers for the matching half of the record — so this is the
  // *one* place the toggle takes effect, and every downstream reader needs no format-specific
  // code at all.
  const computedCqTable = computeCqTable(
    allFluorCurves.map(
      (c): CqTableCurve => ({
        key: curveKey(c.row, c.col, c.dye),
        group: c.dye, // the fluorophore, never the target — see `thresholdGroupOf`
        cycles: c.cycles,
        values: c.mean,
        contributesToThreshold: loadedFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false,
      }),
    ),
    {
      thresholdOverrides: settings.thresholdOverrides,
      curveThresholdOverrides: settings.curveThresholdOverrides,
      autoThreshold: { multiplier: settings.thresholdMultiplier },
    },
  );
  let cqTable: Map<string, CqTableEntry>;
  if (!hasFileAnalysis) {
    cqTable = computedCqTable;
  } else {
    cqTable = new Map();
    for (const c of allFluorCurves) {
      const key = curveKey(c.row, c.col, c.dye);
      const entry = computedCqTable.get(key);
      if (entry) cqTable.set(key, blendWithFileAnalysis(entry, c.cycles, c.fileAnalysis, settings));
    }
  }

  // Display baselines for the no-Cq series — see `RunAnalysis.plainBaselines`. Computed over the
  // whole run rather than a filtered subset, like the Cq table, so toggling one well or channel
  // can never change what another curve looks like.
  const plainBaselines = new Map<string, CurveBaselineResult>();
  for (const c of allCurves) {
    plainBaselines.set(
      channelCurveKey(c.row, c.col, c.channel),
      correctCurveForDisplay(c.cycles, c.mean, ANALYSIS_BASELINE_MODE, {
        multiplier: settings.thresholdMultiplier,
      }),
    );
  }
  for (const d of darkCurves) {
    plainBaselines.set(
      darkCurveKey(d.channel),
      correctCurveForDisplay(d.cycles, d.mean, ANALYSIS_BASELINE_MODE, {
        multiplier: settings.thresholdMultiplier,
      }),
    );
  }

  return {
    dyeSpace,
    hasFileAnalysis,
    plateEntry,
    plate,
    allCurves,
    darkCurves,
    available,
    tube,
    tubes,
    fluorCals,
    calibratedFluors,
    calibrationAvailable,
    stepTemperatureC,
    wellFluorTargets,
    wellFluors,
    loadedFluors,
    wellSample,
    targetInfos,
    usingTargets,
    groupInfos,
    allFluorCurves,
    cqTable,
    plainBaselines,
    groupOf,
    thresholdGroupOf,
    thresholdGroups: calibratedFluors,
  };
}
