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
import { channelLabel } from "./channelColors";
import {
  computeFluorCurves,
  matchFluorCalibrations,
  plateBackgroundLevels,
  resolveTubeType,
  type FluorCalibration,
  type FluorCorrections,
  type FluorCurve,
  type TubeType,
} from "./fluorCurves";

/**
 * The one run-level derivation the Curves and Analysis views share: the plate, its
 * fluorophore/target groups, the color-separation inputs, the dye-space curves — and, on top of
 * those, **the** Cq table.
 *
 * Both views used to derive all of this independently, and to compute Cq three separate times over
 * three different subsets of the plate (the Analysis table's enabled wells, the Curves chart's
 * plotted curves, and every curve for the Curves hover cards). A Cq is not a property of one curve:
 * its group's threshold is the median baseline noise across the curves it's computed *with*
 * (`threshold.md` §5.1), so those three runs legitimately disagreed — the same well showing a Cq in
 * one view and "—" in another. There is now exactly one Cq per well/fluor pair per run, computed
 * over the whole plate; views filter the table for display and never recompute from a subset.
 */

/** Identity of a single curve — one well, one fluorophore. See {@link CqTableCurve.key}. */
export function curveKey(row: number, col: number, fluor: string): string {
  return `${row},${col},${fluor}`;
}

/** Identity of a channel-space curve, which belongs to no target — see {@link RunAnalysis.channelCqTable}. */
export function channelCurveKey(row: number, col: number, channel: number): string {
  return `${row},${col},ch${channel}`;
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
  plateBackgroundAvailable: boolean;
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
   * copy. Covers the whole plate regardless of any view's filters, so every view reads the same
   * number for the same well.
   */
  cqTable: Map<string, CqTableEntry>;
  /**
   * Cq over the *raw channel* curves, keyed by {@link channelCurveKey} — what the Curves view marks
   * while color separation is off. A separate quantity, not a second copy of the same one: a
   * channel curve mixes every dye that emits into that filter and belongs to no target, so it has
   * no well/target Cq to be consistent with. Computed the same way, over the whole plate.
   */
  channelCqTable: Map<string, CqTableEntry>;
  /** The threshold group a well/fluor pair belongs to — its target, the {@link NO_TARGET} catch-all,
   * or (on a plate with no targets at all) the fluorophore itself. */
  groupOf: (row: number, col: number, fluor: string) => string;
}

/**
 * @param dyeSpace whether the dye-space solve is needed at all. The Curves view skips it while
 * color separation is off (one pseudo-inverse per well per cycle is real work); it never changes
 * the *result*, only whether it's computed.
 */
export function useRunAnalysis(
  zpcr: Zpcr,
  settings: FileSettings,
  pltdPassword: string,
  activeStep: number | undefined,
  dyeSpace = true,
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
    // §4.2: whichever additive background the user picked, as a per-cycle table. `dark` varies per
    // scan (DARKDATA is re-read every cycle); `plate` is one temperature-interpolated constant,
    // broadcast across the cycles so both take the same code path downstream.
    const darkByChannel = new Map(darkCurves.map((d) => [d.channel, d]));
    const plateLevels =
      settings.calibrationBackground === "plate"
        ? plateBackgroundLevels(calibrations, tube, stepTemperatureC, available)
        : undefined;
    const backgroundLevel =
      settings.calibrationBackground === "dark"
        ? available.map((ch) => darkByChannel.get(ch)?.mean ?? [])
        : plateLevels
          ? plateLevels.map((level) => reads.map(() => level))
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
    settings.calibrationBackground,
    tube,
    stepTemperatureC,
  ]);

  // Whether the "Plate" background is actually backed by data — a file can carry .Dcal entries for
  // other vessel types than this plate's, in which case that mode silently subtracts nothing.
  const plateBackgroundAvailable = useMemo(
    () => plateBackgroundLevels(calibrations, tube, stepTemperatureC, available) != null,
    [calibrations, tube, stepTemperatureC, available],
  );

  const allFluorCurves = useMemo(() => {
    if (!matrix || !dyeSpace) return [];
    const dyeChannels = calibratedFluors.map((f) => f.channel);
    return computeFluorCurves(allCurves, matrix, available, dyeChannels, corrections);
  }, [matrix, dyeSpace, allCurves, available, calibratedFluors, corrections]);

  // ---- The Cq table ------------------------------------------------------------------------
  // Over every well/dye pair on the plate, never a filtered subset. Pairs the plate doesn't load
  // still get an entry — the Curves view can plot them ("Unloaded") and they need a Cq of their own
  // — but stay out of their group's noise cohort, since a dye that was never pipetted into a well
  // shouldn't set the threshold bar for the wells that were.
  const cqTable = useMemo(() => {
    const inputs: CqTableCurve[] = allFluorCurves.map((c) => ({
      key: curveKey(c.row, c.col, c.dye),
      group: groupOf(c.row, c.col, c.dye),
      cycles: c.cycles,
      values: c.mean,
      contributesToThreshold: loadedFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false,
    }));
    return computeCqTable(inputs, {
      algorithm: settings.analysisCqAlgorithm,
      thresholdOverrides: settings.analysisThresholdOverrides,
    });
  }, [
    allFluorCurves,
    groupOf,
    loadedFluors,
    settings.analysisCqAlgorithm,
    settings.analysisThresholdOverrides,
  ]);

  const channelCqTable = useMemo(() => {
    const inputs: CqTableCurve[] = allCurves
      .filter((c) => available.includes(c.channel))
      .map((c) => ({
        key: channelCurveKey(c.row, c.col, c.channel),
        group: channelLabel(c.channel),
        cycles: c.cycles,
        values: c.mean,
        contributesToThreshold: (loadedFluors.get(wellKey(c.row, c.col))?.size ?? 0) > 0,
      }));
    return computeCqTable(inputs, {
      algorithm: settings.analysisCqAlgorithm,
      thresholdOverrides: settings.analysisThresholdOverrides,
    });
  }, [
    allCurves,
    available,
    loadedFluors,
    settings.analysisCqAlgorithm,
    settings.analysisThresholdOverrides,
  ]);

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
    plateBackgroundAvailable,
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
    channelCqTable,
    groupOf,
  };
}
