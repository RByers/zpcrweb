import { useMemo } from "react";
import {
  ANALYSIS_BASELINE_MODE,
  correctCurveForDisplay,
  buildCalibrationMatrix,
  computeCqTable,
  REFERENCE_ROW,
  type CqTableCurve,
  type CqTableEntry,
  type CurveBaselineResult,
  type DarkCurve,
  type FileAnalysis,
  type PlateDefinition,
  type PltdEntry,
  type WellCurve,
  type Zpcr,
} from "@zpcrweb/core";
import { wellKey, type FileSettings } from "../state/useZpcrStore";
import { NO_TARGET, targetGroups, type TargetGroup } from "./plateTargets";
import {
  computeFluorCurves,
  dyeSpaceFluorCurves,
  matchFluorCalibrations,
  resolveTubeType,
  type FluorCalibration,
  type FluorCorrections,
  type FluorCurve,
  type TubeType,
} from "./fluorCurves";

/**
 * The one run-level derivation the Curves view's chart, hover cards and table mode share: the
 * plate, its fluorophore/target groups, the color-separation inputs, the dye-space curves — and,
 * on top of those, **the** Cq table.
 *
 * These used to derive all of this independently, and to compute Cq three separate times over three
 * different subsets of the plate (the Analysis table's enabled wells, the Curves chart's plotted
 * curves, and every curve for the Curves hover cards). A Cq is not a property of one curve: its
 * group's threshold is the median baseline noise across the curves it's computed *with*
 * (`threshold.md` §5.2), so those three runs legitimately disagreed — the same well showing a Cq in
 * one view and "—" in another. There is now exactly one Cq per well/fluor pair per run, computed
 * over the whole plate; callers filter the table for display and never recompute from a subset.
 *
 * ## The analysis pipeline is format-independent, by rule
 *
 * **Nothing from here down may read a field that only one source format carries.** Calibration and
 * thresholding consume `Zpcr` — reads, plate, `.Dcal` calibrations, protocol — and every one of
 * those is populated identically by `parseZpcr` and `parsePcrd`. A `.zpcr` and the `.pcrd` saved
 * from the same run must produce the same curves, the same thresholds and the same Cq, because
 * they are the same measurement; a number that changes with the container it was saved in is not a
 * measurement result, it's an artifact.
 *
 * This is checked, not just asserted: `.zpcr`/`.pcrd` pairs of one run agree to ~4e-5 cycles in Cq,
 * the residual being nothing but storage precision (a `.pcrd` writes well readings as text rounded
 * to two decimals, a `.zpcr` as binary float32).
 *
 * The one field that violated this was `Zpcr.wellFactors` — see the `corrections` memo below.
 * `Zpcr.archive`, `RunResult.documentXml` and `RunResult.selfEncrypted` are the other
 * format-asymmetric surfaces; they belong to the raw views alone (see `apps/web/ARCHITECTURE.md`).
 */

/**
 * The block temperature a step's calibration matrix is built at: the mean across that step's
 * plate reads, defaulting to 60 °C for a run that reports none. Block temperature is essentially
 * constant across a single PLATEREAD step's cycles (see `plateread.md` §3), so one representative
 * temperature per step is accurate.
 *
 * Shared with the Calibration view, which marks it on the response curves — the point on the x
 * axis the analysis actually samples them at.
 */
export function stepTemperature(zpcr: Zpcr, step: number | undefined): number {
  const temps = zpcr.reads
    .filter((r) => r.step === step)
    .map((r) => r.blockTempC)
    .filter((t): t is number => t != null);
  return temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 60;
}

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
 * Substitute a curve's own {@link FileAnalysis} for the matching half of its computed
 * {@link CqTableEntry}, per `settings.baselineSource`/`cqSource` — see the {@link RunAnalysis.cqTable}
 * doc comment for why this is the one place either setting takes effect.
 *
 * The two halves are independent by design (two separate toggles): baseline fields
 * (`correctedValues`/`baselineFit`/`baselineRegion`/`noise`/`deltaRfu`) follow `baselineSource`,
 * Cq fields (`cq`/`threshold`/`endRfu`) follow `cqSource`. Mixing "file baseline" with "computed
 * Cq" (or the reverse) is a real combination a user can pick — the chart's Cq marker and
 * threshold line then sit on the file's threshold against this library's own corrected curve
 * (or vice versa), which won't necessarily land the marker exactly on the crossing; that's an
 * honest picture of two independent analyses compared piecewise, not a bug to paper over.
 *
 * `noise` has no file equivalent (Biomeme states no noise estimate, only the threshold it
 * implies) and always stays this library's own, whichever way `baselineSource` points — it's
 * used only as an internal diagnostic (the Threshold rail's σ), never displayed as "the file's
 * noise".
 */
function blendWithFileAnalysis(
  entry: CqTableEntry,
  cycles: number[],
  fileAnalysis: FileAnalysis | undefined,
  settings: Pick<FileSettings, "baselineSource" | "cqSource">,
): CqTableEntry {
  if (!fileAnalysis) return entry;
  const out = { ...entry };
  if (settings.baselineSource === "file") {
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
  if (settings.cqSource === "file") {
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
 * Cq). One optional type covers both, so a consumer that only needs the baseline — the chart —
 * treats every series identically.
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
  /** The first plate entry in the archive, whatever its decode state — the views read
   * `needsPassword`/`error` off it to show the password prompt. */
  plateEntry: PltdEntry | undefined;
  plate: PlateDefinition | undefined;
  /** Raw per-channel curves for the active step, reference row excluded. */
  allCurves: WellCurve[];
  darkCurves: DarkCurve[];
  /** Optical channels this run actually scanned. */
  available: number[];
  tube: TubeType;
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
   * copy, and the only Cq the app computes at all. Covers the whole plate regardless of any view's
   * filters, so every view reads the same number for the same well.
   *
   * **There is deliberately no channel-space equivalent.** There used to be one, marking Cq on the
   * raw per-channel curves while color separation was off. It was real arithmetic but not a real
   * measurement: a raw channel sees everything that emits into that filter, so an optical channel
   * the plate assigns no fluorophore to still produced a confident-looking Cq — one belonging to
   * whichever neighbouring dye was bleeding into it. Quantification is per-fluorophore, after
   * color separation (that is what the separation is *for*), and the instrument reports it that
   * way too. Channel space is now purely a look at the raw signal: no Cq, no threshold, no
   * baseline fit.
   */
  cqTable: Map<string, CqTableEntry>;
  /**
   * The baseline half of the same analysis, for the plotted series that have no Cq: the raw
   * per-channel curves ({@link channelCurveKey}) and the dark overlay ({@link darkCurveKey}).
   *
   * The Curves view's "Relative" mode subtracts a fitted baseline from *whatever* it is plotting,
   * channel space included — so those series need a baseline even though they will never be
   * quantified. It comes from one library call ({@link correctCurveForDisplay}, which runs the
   * same two passes {@link computeCqTable} does with a cohort of one) at a single point in the
   * app, which is the whole point: the chart used to run its own copy of the baseline selection,
   * and the copy had drifted, so it plotted curves baselined over a region the Cq had not been
   * computed on and the threshold line missed the Cq marker by the difference.
   */
  plainBaselines: Map<string, CurveBaselineResult>;
  /** The *display* group a well/fluor pair belongs to — its target, the {@link NO_TARGET}
   * catch-all, or (on a plate with no targets at all) the fluorophore itself. Organizes chips,
   * table rows and colors. **Not** the threshold group — see {@link thresholdGroupOf}. */
  groupOf: (row: number, col: number, fluor: string) => string;
  /**
   * The **threshold** group a well/fluor pair belongs to: its **fluorophore**, always.
   *
   * Deliberately not the target. A threshold is `multiplier × median baseline noise`
   * (`threshold.md` §5.2), and baseline noise is an optical property of the dye, the instrument and
   * the well — the target is a biological label attached to the same physical measurement. Keying
   * the threshold on the target therefore splits one dye's wells into cohorts that differ only in
   * what the experimenter called them, which is exactly the "Cq incomparable across a plate"
   * failure §5.2 exists to prevent: on `20260720_FirstQualification.zpcr` the three loaded Tex 615
   * wells carry two targets (HMPV Ma in A3/B3, PIV3 Bo in D3) and used to come out with
   * thresholds 3.3× apart —
   * 162 vs 49 RFU — for near-identical curves. It also made cohorts tiny: PIV3 Bo's was a single
   * well, so its "median noise" was that one well's noise, with no robustness at all.
   *
   * This also matches what the instrument does. CFX persists its analysis parameters —
   * `thresholdOverrideValue` and `autoCalculateThreshold` included — under
   * `fluorDataAnalysisParam fluorId=…`, one entry per **fluorophore** (`pcrd.md` §2.5,
   * `threshold.md` §9). There is no per-target threshold anywhere in the format.
   */
  thresholdGroupOf: (row: number, col: number, fluor: string) => string;
  /** The fluorophores thresholds are actually resolved per — the groups {@link thresholdGroupOf}
   * returns, and the keys {@link FileSettings.thresholdOverrides} uses. */
  thresholdGroups: FluorCalibration[];
}

/**
 * The dye-space solve runs unconditionally, including while the Curves view is showing channel
 * space. It used to be skipped there (one pseudo-inverse per well per cycle is real work), but the
 * target thresholds and the CSV export are target-based in *every* view mode, and both read
 * {@link RunAnalysis.cqTable} — which is empty without it. It never changed the result either way,
 * only whether it was computed, and the Overview view already pays for it on every run.
 */
export function useRunAnalysis(
  zpcr: Zpcr,
  settings: FileSettings,
  pltdPassword: string,
  activeStep: number | undefined,
): RunAnalysis {
  const dyeSpace = !!zpcr.dyeSpace;
  const available = useMemo(() => zpcr.channels(), [zpcr]);

  const allCurves = useMemo<WellCurve[]>(
    () => zpcr.curves({ includeReference: false, step: activeStep }),
    [zpcr, activeStep],
  );
  const darkCurves = useMemo<DarkCurve[]>(() => zpcr.darkCurves(activeStep), [zpcr, activeStep]);
  const hasFileAnalysis = useMemo(() => allCurves.some((c) => c.fileAnalysis), [allCurves]);

  const plateEntry = useMemo(() => zpcr.plates(pltdPassword || undefined)[0], [zpcr, pltdPassword]);
  const plate = plateEntry?.pltd.plate;
  const calibrations = useMemo(() => zpcr.calibrations(), [zpcr]);
  const tube = resolveTubeType(plate?.plateName);

  const fluorCals = useMemo(
    () => (plate ? matchFluorCalibrations(plate.fluors, calibrations, tube) : []),
    [plate, calibrations, tube],
  );
  // A dye-space source has no `.Dcal` calibration to match — its fluors are trustworthy by
  // construction, not by having found one (see `RunAnalysis.dyeSpace`).
  const calibratedFluors = useMemo(
    () => (dyeSpace ? fluorCals : fluorCals.filter((f) => f.curve)),
    [dyeSpace, fluorCals],
  );
  const calibrationAvailable = calibratedFluors.length > 0;

  // Target/gene assigned to each (well, fluor) pair — pltd.md's per-well target, distinct from the
  // fluor itself: the same dye can carry a different target in different wells.
  const wellFluorTargets = useMemo(() => {
    const m = new Map<string, Map<string, string>>();
    if (plate) {
      for (const w of plate.wells) {
        const inner = new Map<string, string>();
        for (const wf of w.fluors) if (wf.target) inner.set(wf.fluor, wf.target);
        m.set(wellKey(w.row, w.col), inner);
      }
    }
    return m;
  }, [plate]);

  // Per-well set of fluor names the plate assigns to that well (pltd.md dye layers) — a dye layer
  // doesn't necessarily cover every well.
  const wellFluors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (plate) {
      for (const w of plate.wells) {
        m.set(wellKey(w.row, w.col), new Set(w.fluors.map((f) => f.fluor)));
      }
    }
    return m;
  }, [plate]);

  // The same, restricted to wells the plate actually loads — the noise cohort for the Cq table's
  // thresholds. A dye assigned to a well that was never loaded carries no real signal.
  const loadedFluors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (plate) {
      for (const w of plate.wells) {
        if (w.loaded) m.set(wellKey(w.row, w.col), new Set(w.fluors.map((f) => f.fluor)));
      }
    }
    return m;
  }, [plate]);

  const wellSample = useMemo(() => {
    const m = new Map<string, string>();
    if (plate) for (const w of plate.wells) if (w.sample) m.set(wellKey(w.row, w.col), w.sample);
    return m;
  }, [plate]);

  const targetInfos = useMemo(
    () => (plate ? targetGroups(plate, fluorCals) : []),
    [plate, fluorCals],
  );
  const usingTargets = targetInfos.length > 0;
  const groupInfos = useMemo<TargetGroup[]>(
    () =>
      usingTargets
        ? targetInfos
        : fluorCals.map((f) => ({
            target: f.fluor,
            fluors: [f.fluor],
            channel: f.channel,
            curve: f.curve,
          })),
    [usingTargets, targetInfos, fluorCals],
  );

  // A well/fluor pair with no target of its own joins the NO_TARGET catch-all rather than being
  // dropped: an NTC/NRT well still gets a real threshold and a real Cq. On a plate with no targets
  // anywhere, the fluorophore *is* the group (see `targetGroups`).
  const groupOf = useMemo(
    () => (row: number, col: number, fluor: string) =>
      usingTargets
        ? (wellFluorTargets.get(wellKey(row, col))?.get(fluor) ?? NO_TARGET)
        : fluor,
    [usingTargets, wellFluorTargets],
  );

  // Thresholds group by fluorophore regardless of targets — see `RunAnalysis.thresholdGroupOf`.
  const thresholdGroupOf = useMemo(() => (_row: number, _col: number, fluor: string) => fluor, []);

  // One representative matrix per step — see `stepTemperature`.
  const stepTemperatureC = useMemo(() => stepTemperature(zpcr, activeStep), [zpcr, activeStep]);

  const matrix = useMemo(() => {
    // A dye-space source has no channel mixing to solve for at all (see `RunAnalysis.dyeSpace`)
    // — `allFluorCurves` below reads its curves straight off `allCurves` instead.
    if (dyeSpace || calibratedFluors.length === 0) return null;
    // `channels` is passed in rather than slicing rows afterwards so the matrix's column norms —
    // the RFU scale factor of calibration.md §5 — are computed over the rows the solve uses.
    return buildCalibrationMatrix(
      calibratedFluors.map((f) => f.curve!),
      stepTemperatureC,
      { normalization: settings.calibrationNormalization, channels: available },
    );
  }, [dyeSpace, calibratedFluors, stepTemperatureC, settings.calibrationNormalization, available]);

  // The §4 corrections applied to every raw reading before the solve. The levels are read per scan,
  // so these are `[channelIndex][cycle]` tables aligned with `available`.
  const corrections = useMemo<FluorCorrections>(() => {
    const reads = zpcr.reads.filter((r) => r.step === activeStep);
    // §4.1: one position of the reference row — the first — per channel, LED on.
    const referenceLevel = available.map((ch) => reads.map((r) => r.wells[ch]![REFERENCE_ROW]![0]!.mean));
    // §4.2 has no second stage here: the LED-off `DARKDATA` is deliberately **not** subtracted.
    // Measured against CFX's own exported curves, subtracting it makes the reconstruction 260×
    // worse (median residual 7.3e-3 → 1.90 RFU), because the dark level is re-read every cycle and
    // its scatter is random noise no linear baseline can absorb (`calibration.md` §4.2a). Any
    // *constant* background, meanwhile, is removed by baselining before anything is reported, so
    // the choice of one cannot change a result. `DARKDATA` stays a plotted diagnostic overlay.
    // §4.1's per-well gain factors are deliberately *not* passed. `Zpcr.wellFactors` is decoded
    // only from a `.pcrd`'s `wellFactorsCollection`; a `.zpcr` stores no equivalent, so feeding it
    // in would make the same run quantify differently depending on which file you opened — exactly
    // what the format-independence rule above forbids. See the TODO in `calibration.md` §4.1 if a
    // `.zpcr`-side source for these is ever found. (`referenceLevel` is the pivot for that
    // correction and has no effect on its own, so it stays and costs nothing.)
    return { referenceLevel };
  }, [zpcr, activeStep, available]);

  const allFluorCurves = useMemo(() => {
    if (dyeSpace) {
      const fluorForChannel = new Map(plate?.fluors.map((f) => [f.channel, f.fluor]) ?? []);
      return dyeSpaceFluorCurves(allCurves, (ch) => fluorForChannel.get(ch));
    }
    if (!matrix) return [];
    const dyeChannels = calibratedFluors.map((f) => f.channel);
    return computeFluorCurves(allCurves, matrix, available, dyeChannels, corrections);
  }, [dyeSpace, plate, matrix, allCurves, available, calibratedFluors, corrections]);

  // ---- The Cq table ------------------------------------------------------------------------
  // Over every well/dye pair on the plate, never a filtered subset. Pairs the plate doesn't load
  // still get an entry — the Curves view can plot them ("Unloaded") and they need a Cq of their own
  // — but stay out of their group's noise cohort, since a dye that was never pipetted into a well
  // shouldn't set the threshold bar for the wells that were.
  //
  // This library's own algorithm runs unconditionally, even for a curve carrying `fileAnalysis` —
  // it's the only thing that can resolve a group threshold at all, and it's what `settings.
  // baselineSource`/`cqSource` fall back to for a curve the file left unanalyzed. Where a curve
  // does carry `fileAnalysis` and a setting says "file", {@link blendWithFileAnalysis} below
  // substitutes the file's own numbers for the matching half of the record (baseline fields, or
  // Cq/threshold/endRfu) — so this is the *one* place the toggle takes effect, and every
  // downstream reader (chart, table, hover cards, CSV) needs no format-specific code at all.
  const cqTable = useMemo(() => {
    const inputs: CqTableCurve[] = allFluorCurves.map((c) => ({
      key: curveKey(c.row, c.col, c.dye),
      group: c.dye, // the fluorophore, never the target — see `thresholdGroupOf`
      cycles: c.cycles,
      values: c.mean,
      contributesToThreshold: loadedFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false,
    }));
    const computed = computeCqTable(inputs, {
      thresholdOverrides: settings.thresholdOverrides,
      curveThresholdOverrides: settings.curveThresholdOverrides,
      autoThreshold: { multiplier: settings.thresholdMultiplier },
    });
    if (!hasFileAnalysis) return computed;
    const out = new Map<string, CqTableEntry>();
    for (const c of allFluorCurves) {
      const key = curveKey(c.row, c.col, c.dye);
      const entry = computed.get(key);
      if (entry) out.set(key, blendWithFileAnalysis(entry, c.cycles, c.fileAnalysis, settings));
    }
    return out;
  }, [
    allFluorCurves,
    hasFileAnalysis,
    loadedFluors,
    settings.thresholdOverrides,
    settings.curveThresholdOverrides,
    settings.thresholdMultiplier,
    settings.baselineSource,
    settings.cqSource,
  ]);

  // Display baselines for the no-Cq series — see `RunAnalysis.plainBaselines`. Computed over the
  // whole run rather than the plotted subset, like the Cq table, so toggling a well or a channel
  // can never change what another curve looks like.
  const plainBaselines = useMemo(() => {
    const m = new Map<string, CurveBaselineResult>();
    for (const c of allCurves) {
      m.set(
        channelCurveKey(c.row, c.col, c.channel),
        correctCurveForDisplay(c.cycles, c.mean, ANALYSIS_BASELINE_MODE, {
          multiplier: settings.thresholdMultiplier,
        }),
      );
    }
    for (const d of darkCurves) {
      m.set(
        darkCurveKey(d.channel),
        correctCurveForDisplay(d.cycles, d.mean, ANALYSIS_BASELINE_MODE, {
          multiplier: settings.thresholdMultiplier,
        }),
      );
    }
    return m;
  }, [allCurves, darkCurves, settings.thresholdMultiplier]);

  return {
    dyeSpace,
    hasFileAnalysis,
    plateEntry,
    plate,
    allCurves,
    darkCurves,
    available,
    tube,
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
