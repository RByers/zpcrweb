import { useMemo } from "react";
import {
  buildCalibrationMatrix,
  computeCqTable,
  REFERENCE_ROW,
  type CqTableCurve,
  type CqTableEntry,
  type DarkCurve,
  type PlateDefinition,
  type PltdEntry,
  type WellCurve,
  type Zpcr,
} from "@zpcrweb/core";
import { wellKey, type FileSettings } from "../state/useZpcrStore";
import { NO_TARGET, targetGroups, type TargetGroup } from "./plateTargets";
import {
  computeFluorCurves,
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
 * (`threshold.md` §5.1), so those three runs legitimately disagreed — the same well showing a Cq in
 * one view and "—" in another. There is now exactly one Cq per well/fluor pair per run, computed
 * over the whole plate; callers filter the table for display and never recompute from a subset.
 */

/** Cq is always `threshold.md` §6.1's threshold crossing — the instrument's own default, and the
 * only algorithm whose per-group threshold the "Threshold overrides" rail section can talk about.
 * §6.2's 2nd-derivative variant used to be selectable in the Analysis view; the selector is gone,
 * though `computeCqTable` still accepts either. */
const CQ_ALGORITHM = "Threshold" as const;

/** Identity of a single curve — one well, one fluorophore. See {@link CqTableCurve.key}. */
export function curveKey(row: number, col: number, fluor: string): string {
  return `${row},${col},${fluor}`;
}

export interface RunAnalysis {
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
  /** The *display* group a well/fluor pair belongs to — its target, the {@link NO_TARGET}
   * catch-all, or (on a plate with no targets at all) the fluorophore itself. Organizes chips,
   * table rows and colors. **Not** the threshold group — see {@link thresholdGroupOf}. */
  groupOf: (row: number, col: number, fluor: string) => string;
  /**
   * The **threshold** group a well/fluor pair belongs to: its **fluorophore**, always.
   *
   * Deliberately not the target. A threshold is `multiplier × median baseline noise`
   * (`threshold.md` §5.1), and baseline noise is an optical property of the dye, the instrument and
   * the well — the target is a biological label attached to the same physical measurement. Keying
   * the threshold on the target therefore splits one dye's wells into cohorts that differ only in
   * what the experimenter called them, which is exactly the "Cq incomparable across a plate"
   * failure §5.1 exists to prevent: on `20260720.zpcr` the three loaded Texas Red wells carry two
   * targets (HMPV Ma in A3/B3, PIV3 Bo in D3) and used to come out with thresholds 3.3× apart —
   * 162 vs 49 RFU — for near-identical curves. It also made cohorts tiny: PIV3 Bo's was a single
   * well, so its "median noise" was that one well's noise, with no robustness at all.
   *
   * This also matches what the instrument does. CFX persists its analysis parameters —
   * `thresholdOverrideValue` and `autoCalculateThreshold` included — under
   * `fluorDataAnalysisParam fluorId=…`, one entry per **fluorophore** (`pcrd.md` §2.5,
   * `threshold.md` §1). There is no per-target threshold anywhere in the format.
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
  const available = useMemo(() => zpcr.channels(), [zpcr]);

  const allCurves = useMemo<WellCurve[]>(
    () => zpcr.curves({ includeReference: false, step: activeStep }),
    [zpcr, activeStep],
  );
  const darkCurves = useMemo<DarkCurve[]>(() => zpcr.darkCurves(activeStep), [zpcr, activeStep]);

  const plateEntry = useMemo(() => zpcr.plates(pltdPassword || undefined)[0], [zpcr, pltdPassword]);
  const plate = plateEntry?.pltd.plate;
  const calibrations = useMemo(() => zpcr.calibrations(), [zpcr]);
  const tube = resolveTubeType(plate?.plateName);

  const fluorCals = useMemo(
    () => (plate ? matchFluorCalibrations(plate.fluors, calibrations, tube) : []),
    [plate, calibrations, tube],
  );
  const calibratedFluors = useMemo(() => fluorCals.filter((f) => f.curve), [fluorCals]);
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

  // Block temperature is essentially constant across a single PLATEREAD step's cycles (see
  // plateread.md §3), so one representative matrix per step is accurate.
  const stepTemperatureC = useMemo(() => {
    const temps = zpcr.reads
      .filter((r) => r.step === activeStep)
      .map((r) => r.blockTempC)
      .filter((t): t is number => t != null);
    return temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 60;
  }, [zpcr, activeStep]);

  const matrix = useMemo(() => {
    if (calibratedFluors.length === 0) return null;
    // `channels` is passed in rather than slicing rows afterwards so the matrix's column norms —
    // the RFU scale factor of calibration.md §5 — are computed over the rows the solve uses.
    return buildCalibrationMatrix(
      calibratedFluors.map((f) => f.curve!),
      stepTemperatureC,
      { normalization: settings.calibrationNormalization, channels: available },
    );
  }, [calibratedFluors, stepTemperatureC, settings.calibrationNormalization, available]);

  // The §4 corrections applied to every raw reading before the solve. The levels are read per scan,
  // so these are `[channelIndex][cycle]` tables aligned with `available`.
  const corrections = useMemo<FluorCorrections>(() => {
    const reads = zpcr.reads.filter((r) => r.step === activeStep);
    // §4.1: one position of the reference row — the first — per channel, LED on.
    const referenceLevel = available.map((ch) => reads.map((r) => r.get(ch, REFERENCE_ROW, 0).mean));
    // §4.2: the optional dark-current subtraction, as a per-cycle table — DARKDATA is re-read
    // every scan, so the level varies cycle to cycle. Off by default, in which case nothing is
    // subtracted and the stage is skipped entirely.
    const darkByChannel = new Map(darkCurves.map((d) => [d.channel, d]));
    const backgroundLevel = settings.subtractDark
      ? available.map((ch) => darkByChannel.get(ch)?.mean ?? [])
      : undefined;
    // §4.1: per-well gain factors, only ever present in a `.pcrd` (a `.zpcr` stores none), and only
    // when that run actually saved a set — otherwise the gain correction stays inactive and the
    // reference level correctly has no effect of its own.
    const factors = zpcr.wellFactors;
    return {
      referenceLevel,
      backgroundLevel,
      wellFactor: factors
        ? (row, col) => {
            const perChannel = factors.get(row, col);
            return perChannel && available.map((ch) => perChannel[ch] ?? 1);
          }
        : undefined,
    };
  }, [
    zpcr,
    activeStep,
    available,
    darkCurves,
    calibrations,
    settings.subtractDark,
    tube,
    stepTemperatureC,
  ]);

  const allFluorCurves = useMemo(() => {
    if (!matrix) return [];
    const dyeChannels = calibratedFluors.map((f) => f.channel);
    return computeFluorCurves(allCurves, matrix, available, dyeChannels, corrections);
  }, [matrix, allCurves, available, calibratedFluors, corrections]);

  // ---- The Cq table ------------------------------------------------------------------------
  // Over every well/dye pair on the plate, never a filtered subset. Pairs the plate doesn't load
  // still get an entry — the Curves view can plot them ("Unloaded") and they need a Cq of their own
  // — but stay out of their group's noise cohort, since a dye that was never pipetted into a well
  // shouldn't set the threshold bar for the wells that were.
  const cqTable = useMemo(() => {
    const inputs: CqTableCurve[] = allFluorCurves.map((c) => ({
      key: curveKey(c.row, c.col, c.dye),
      group: c.dye, // the fluorophore, never the target — see `thresholdGroupOf`
      cycles: c.cycles,
      values: c.mean,
      contributesToThreshold: loadedFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false,
    }));
    return computeCqTable(inputs, {
      algorithm: CQ_ALGORITHM,
      thresholdOverrides: settings.thresholdOverrides,
      autoThreshold: { multiplier: settings.thresholdMultiplier },
    });
  }, [allFluorCurves, loadedFluors, settings.thresholdOverrides, settings.thresholdMultiplier]);

  return {
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
    groupOf,
    thresholdGroupOf,
    thresholdGroups: calibratedFluors,
  };
}
