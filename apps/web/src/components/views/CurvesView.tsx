import { useEffect, useMemo, useRef, useState } from "react";
import {
  baselineCorrectCurve,
  buildCalibrationMatrix,
  computeCq,
  resolveThreshold,
  REFERENCE_ROW,
  type CqAlgorithm,
  type Zpcr,
  type WellCurve,
  type DarkCurve,
  type TemperatureCurve,
} from "@zpcrweb/core";
import { ANALYSIS_BASELINE_MODE, formatBaselineFormula } from "../../lib/cq";
import { computeWellTypes } from "../../lib/wellTypes";
import { NO_TARGET, targetGroups } from "../../lib/plateTargets";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import {
  wellKey,
  type BandsMode,
  type CurveView,
  type FileSettings,
  type FluorViewMode,
  type Scale,
} from "../../state/useZpcrStore";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelColor, channelLabel } from "../../lib/channelColors";
import {
  computeFluorCurves,
  matchFluorCalibrations,
  plateBackgroundLevels,
  resolveTubeType,
  type CalibrationBackground,
  type FluorCorrections,
} from "../../lib/fluorCurves";
import { ChannelBar } from "../curves/ChannelBar";
import { FluorBar, type FluorChip } from "../curves/FluorBar";
import { SampleBar } from "../curves/SampleBar";
import type { HoverCardData, HoverCardRow } from "../curves/HoverCard";
import { WellMatrix } from "../curves/WellMatrix";
import { CurveChart } from "../curves/CurveChart";
import { TempBar } from "../curves/TempBar";
import { PasswordPrompt } from "../PasswordPrompt";
import { Toggle } from "../Toggle";
import { Switch } from "../Switch";
import { ResetIcon } from "../ResetIcon";
import type { HighlightMatch, PlotCurve } from "../../lib/uplot/chart";

/** Baseline + Cq for a set of curves, grouped by `dyeLabel` (`threshold.md` §5.1: one threshold
 * per group, from the median baseline noise across that group's own curves) — factored out so
 * it can run twice: once over the plotted set (drives the chart's own Cq markers) and once over
 * every curve on the plate regardless of rail filters (drives the hover cards, so a greyed-out
 * row still shows a real Cq instead of always reading "—"). The two runs are intentionally
 * independent — a group's threshold in the "all curves" run is computed across the whole plate,
 * not just what's currently selected, so it won't match the chart's own Cq for the same curve
 * when a filter has narrowed the plotted set; that's expected, not a bug, since the hover card's
 * job is to summarize the whole plate, not to double as an alternate chart legend. Baselining
 * itself is never a parameter here — always the auto-detected linear baseline, regardless of
 * what the chart currently *displays* (see `CurveView`). */
function computeCurveMetrics(
  curves: { cycles: number[]; mean: number[]; dyeLabel: string }[],
  algorithm: CqAlgorithm,
  thresholdOverrides: Map<string, number>,
): { cq: number | null; baselineFormula: string }[] {
  if (curves.length === 0) return [];
  const baselines = curves.map((c) => baselineCorrectCurve(c.cycles, c.mean, ANALYSIS_BASELINE_MODE));
  const noisesByLabel = new Map<string, number[]>();
  curves.forEach((c, i) => {
    const list = noisesByLabel.get(c.dyeLabel) ?? [];
    list.push(baselines[i]!.noise);
    noisesByLabel.set(c.dyeLabel, list);
  });
  const thresholdByLabel = new Map<string, number>();
  for (const [label, noises] of noisesByLabel) {
    thresholdByLabel.set(label, resolveThreshold(noises, { overrideValue: thresholdOverrides.get(label) }));
  }
  return curves.map((c, i) => {
    const b = baselines[i]!;
    const threshold = thresholdByLabel.get(c.dyeLabel) ?? 0;
    const cq = computeCq(c.cycles, b.correctedValues, {
      algorithm,
      threshold: algorithm === "Threshold" ? threshold : undefined,
      noise: b.noise,
      baselineValid: b.baselineValid,
    });
    return { cq, baselineFormula: formatBaselineFormula(b.baselineFit) };
  });
}

interface Props {
  zpcr: Zpcr;
  settings: FileSettings;
  onChange: (patch: Partial<FileSettings>) => void;
}

export function CurvesView({ zpcr, settings, onChange }: Props) {
  const [pltdPassword, setPltdPassword] = usePltdPassword();
  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  // Only channels actually scanned (CHANNELMASK) are offered/plotted.
  const available = useMemo(() => zpcr.channels(), [zpcr]);
  // Selected step: the stored one if still valid, else the first step.
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);

  // Full curve set for the active step. The reference row is shown separately, in the
  // Reference view — see RefColBar/ReferenceView.
  const allCurves = useMemo<WellCurve[]>(
    () => zpcr.curves({ includeReference: false, step: activeStep }),
    [zpcr, activeStep],
  );
  const darkCurves = useMemo<DarkCurve[]>(
    () => zpcr.darkCurves(activeStep),
    [zpcr, activeStep],
  );
  // Every temperature the platereads carry, for this step. Which of them are plotted is a
  // per-file setting; the right-hand axis appears only when at least one is selected.
  const allTemps = useMemo<TemperatureCurve[]>(
    () => zpcr.temperatureCurves(activeStep),
    [zpcr, activeStep],
  );
  const visibleTemps = useMemo(
    () => allTemps.filter((t) => settings.temps.has(t.key)),
    [allTemps, settings.temps],
  );

  // Dark lines/subtraction only concern the enabled, available channels.
  const enabledDark = useMemo(
    () =>
      darkCurves.filter(
        (d) => available.includes(d.channel) && settings.enabledChannels.has(d.channel),
      ),
    [darkCurves, available, settings.enabledChannels],
  );

  // ---- Dye-space (color-separated) curves ------------------------------------------------
  // See calibration.md. Uses the plate's own fluorophore list matched against this run's
  // `.Dcal` calibration data — both need to be available for this to do anything.

  const plateEntry = useMemo(
    () => zpcr.plates(pltdPassword || undefined)[0],
    [zpcr, pltdPassword],
  );
  const plate = plateEntry?.pltd.plate;
  const calibrations = useMemo(() => zpcr.calibrations(), [zpcr]);

  // Per-well sample type, for coloring the well-selection grid to match the Plates view — see
  // `computeWellTypes`; shared with AnalysisView's well matrix.
  const wellTypes = useMemo(() => computeWellTypes(plate), [plate]);

  const fullWellSet = useMemo(() => {
    const s = new Set<string>();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 12; c++) s.add(wellKey(r, c));
    return s;
  }, []);

  // The set of wells the plate definition actually loads (a real, loaded tube) — the default
  // selection for a newly opened file, and what the "reset" button next to Wells restores.
  // `loaded`, not `sampleType !== "empty"`: a well can carry a non-"empty" sampleType (e.g. the
  // default "unknown"/wcSample) while still having no fluor loaded into it.
  const nonEmptyWellSet = useMemo(() => {
    if (!plate) return null;
    const s = new Set<string>();
    for (const w of plate.wells) if (w.loaded) s.add(wellKey(w.row, w.col));
    return s.size > 0 ? s : null;
  }, [plate]);

  const setsEqual = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((k) => b.has(k));

  // Apply the plate-derived default exactly once per plate, and only while the selection still
  // looks like the untouched "all wells" default — so a file whose selection was already
  // customized (including a restore from storage) is left alone.
  const appliedDefaultForPlate = useRef<typeof plate>(undefined);
  useEffect(() => {
    if (!plate || !nonEmptyWellSet) return;
    if (appliedDefaultForPlate.current === plate) return;
    appliedDefaultForPlate.current = plate;
    if (setsEqual(settings.enabledWells, fullWellSet)) {
      onChange({ enabledWells: nonEmptyWellSet });
    }
  }, [plate, nonEmptyWellSet, fullWellSet, settings.enabledWells, onChange]);

  const resetWells = () => onChange({ enabledWells: nonEmptyWellSet ?? fullWellSet });

  const tube = resolveTubeType(plate?.plateName);

  const fluorCals = useMemo(
    () => (plate ? matchFluorCalibrations(plate.fluors, calibrations, tube) : []),
    [plate, calibrations, tube],
  );
  const calibratedFluors = useMemo(() => fluorCals.filter((f) => f.curve), [fluorCals]);
  const calibrationAvailable = calibratedFluors.length > 0;
  const calibrationOn = settings.calibration ?? calibrationAvailable;
  const fluorViewMode: FluorViewMode = settings.fluorViewMode;

  // Target/gene name assigned to each (well, fluor) pair — pltd.md's per-well target, distinct
  // from the fluor itself: the same dye can carry a different target in different wells.
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

  // Distinct targets across the plate, plus the {@link NO_TARGET} catch-all for loaded
  // well/fluor pairs with no target of their own — the "Target" view mode's legend, coloring
  // and toggle keys. See `targetGroups`.
  const targetInfos = useMemo(
    () => (plate ? targetGroups(plate, fluorCals) : []),
    [plate, fluorCals],
  );

  /** Whether targetInfos carries a {@link NO_TARGET} group — i.e. whether untargeted curves have
   * a chip to be labelled and toggled by, rather than falling back to their fluor name. */
  const hasNoTargetGroup = useMemo(
    () => targetInfos.some((t) => t.target === NO_TARGET),
    [targetInfos],
  );

  // Label a dye-space curve for display/toggling: its fluor name normally, or in target view
  // mode the target assigned to it in its own well — {@link NO_TARGET} when it has none (which
  // also covers the curves `showUnloadedFluors` draws for pairs the plate never loads), or the
  // fluor name when this plate has no targets at all.
  const labelForFluorCurve = (row: number, col: number, dye: string): string =>
    fluorViewMode === "target"
      ? (wellFluorTargets.get(wellKey(row, col))?.get(dye) ?? (hasNoTargetGroup ? NO_TARGET : dye))
      : dye;

  // Hovering a target/fluor chip or a well-grid cell in the rail highlights the matching
  // curve(s) in the chart, the same way hovering the chart itself dims every other curve.
  const [hoverHighlight, setHoverHighlight] = useState<HighlightMatch | null>(null);

  const chipItems: FluorChip[] = useMemo(
    () =>
      fluorViewMode === "target"
        ? targetInfos.map((t) => ({
            key: t.target,
            label: t.target,
            sublabel: t.fluors.join(", "),
            channel: t.channel,
            calibrated: !!t.curve,
          }))
        : fluorCals.map((f) => ({
            key: f.fluor,
            label: f.fluor,
            sublabel: channelLabel(f.channel),
            channel: f.channel,
            calibrated: !!f.curve,
          })),
    [fluorViewMode, targetInfos, fluorCals],
  );

  // Block temperature is essentially constant across a single PLATEREAD step's cycles (see
  // plateread.md §3), so one representative matrix per step is accurate without recomputing
  // it every cycle.
  const stepTemperatureC = useMemo(() => {
    const temps = zpcr.reads
      .filter((r) => r.step === activeStep)
      .map((r) => r.blockTempC)
      .filter((t): t is number => t != null);
    return temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 60;
  }, [zpcr, activeStep]);

  const matrix = useMemo(() => {
    if (calibratedFluors.length === 0) return null;
    // `channels` is passed in rather than slicing rows afterwards so the matrix's column norms
    // — the RFU scale factor of calibration.md §5 — are computed over the rows the solve uses.
    return buildCalibrationMatrix(
      calibratedFluors.map((f) => f.curve!),
      stepTemperatureC,
      { normalization: settings.calibrationNormalization, channels: available },
    );
  }, [calibratedFluors, stepTemperatureC, settings.calibrationNormalization, available]);

  // The §4 corrections applied to every raw reading before the solve. The levels are read per
  // scan, so these are `[channelIndex][cycle]` tables aligned with `available`.
  const corrections = useMemo<FluorCorrections>(() => {
    const reads = zpcr.reads.filter((r) => r.step === activeStep);
    // §4.1: one position of the reference row — the first — per channel, LED on.
    const referenceLevel = available.map((ch) =>
      reads.map((r) => r.get(ch, REFERENCE_ROW, 0).mean),
    );
    // §4.2: whichever additive background the user picked, as a per-cycle table. `dark` varies
    // per scan (DARKDATA is re-read every cycle); `plate` is one temperature-interpolated
    // constant, broadcast across the cycles so both take the same code path downstream.
    const darkByChannel = new Map(darkCurves.map((d) => [d.channel, d]));
    const plateLevels =
      settings.calibrationBackground === "plate"
        ? plateBackgroundLevels(zpcr.calibrations(), tube, stepTemperatureC, available)
        : undefined;
    const backgroundLevel =
      settings.calibrationBackground === "dark"
        ? available.map((ch) => darkByChannel.get(ch)?.mean ?? [])
        : plateLevels
          ? plateLevels.map((level) => reads.map(() => level))
          : undefined;
    // §4.1: per-well gain factors, only ever present in a `.pcrd` (a `.zpcr` stores none), and
    // only when that run actually saved a set — otherwise the gain correction stays inactive
    // and the reference level correctly has no effect of its own.
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
    settings.calibrationBackground,
    tube,
    stepTemperatureC,
  ]);

  // Whether the "Plate" background is actually backed by data — a file can carry .Dcal entries
  // for other vessel types than this plate's, in which case that mode silently subtracts nothing.
  const plateBackgroundAvailable = useMemo(
    () => plateBackgroundLevels(zpcr.calibrations(), tube, stepTemperatureC, available) != null,
    [zpcr, tube, stepTemperatureC, available],
  );

  // The separation solve is real work (one pseudo-inverse per well per cycle) — skip it
  // entirely while the feature is off rather than computing curves nobody will see.
  const allFluorCurves = useMemo(() => {
    if (!matrix || !calibrationOn) return [];
    const dyeChannels = calibratedFluors.map((f) => f.channel);
    return computeFluorCurves(allCurves, matrix, available, dyeChannels, corrections);
  }, [matrix, calibrationOn, allCurves, available, calibratedFluors, corrections]);

  // Per-well set of fluor names actually loaded into that well (pltd.md dye layers) — a well
  // can be enabled and a fluor can be globally on while that particular well/fluor pair was
  // never loaded (a dye layer doesn't necessarily cover every well), so no line should be
  // drawn for it.
  const wellFluors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (plate) {
      for (const w of plate.wells) m.set(wellKey(w.row, w.col), new Set(w.fluors.map((f) => f.fluor)));
    }
    return m;
  }, [plate]);

  // Per-well sample name (pltd.md's `conditionName`, exposed as `WellDefinition.sample`) — for
  // the Samples rail section's chips and for filtering plotted curves by sample.
  const wellSample = useMemo(() => {
    const m = new Map<string, string>();
    if (plate) {
      for (const w of plate.wells) if (w.sample) m.set(wellKey(w.row, w.col), w.sample);
    }
    return m;
  }, [plate]);

  // Distinct sample names actually assigned to a well on this plate, in plate order — declared
  // names with no well (`plate.samples`) are left out since there'd be nothing to toggle.
  const sampleList = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    if (plate) {
      for (const w of plate.wells) {
        if (w.sample && !seen.has(w.sample)) {
          seen.add(w.sample);
          list.push(w.sample);
        }
      }
    }
    return list;
  }, [plate]);

  const sampleVisible = (row: number, col: number): boolean => {
    const sample = wellSample.get(wellKey(row, col));
    return !sample || !settings.disabledSamples.has(sample);
  };

  const toggleSample = (name: string) => {
    const next = new Set(settings.disabledSamples);
    next.has(name) ? next.delete(name) : next.add(name);
    onChange({ disabledSamples: next });
  };

  // ---- Channel-space (raw) curves --------------------------------------------------------

  const visibleChannel = useMemo(
    () =>
      allCurves.filter(
        (c) =>
          available.includes(c.channel) &&
          settings.enabledChannels.has(c.channel) &&
          settings.enabledWells.has(wellKey(c.row, c.col)) &&
          sampleVisible(c.row, c.col),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCurves, available, settings.enabledChannels, settings.enabledWells, settings.disabledSamples, wellSample],
  );

  const visibleFluor = useMemo(
    () =>
      allFluorCurves.filter(
        (c) =>
          settings.enabledWells.has(wellKey(c.row, c.col)) &&
          !settings.disabledFluors.has(labelForFluorCurve(c.row, c.col, c.dye)) &&
          (settings.showUnloadedFluors ||
            (wellFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false)) &&
          sampleVisible(c.row, c.col),
      ),
    [
      allFluorCurves,
      settings.enabledWells,
      settings.disabledFluors,
      settings.showUnloadedFluors,
      settings.disabledSamples,
      wellFluors,
      wellSample,
      fluorViewMode,
      wellFluorTargets,
      hasNoTargetGroup,
    ],
  );

  // Whether to show the run in dye space: the user's toggle, independent of whether any
  // fluor actually matched a calibration file — see the FluorBar's dimmed chips and the
  // "no calibration matches" note below for that case, rather than silently reverting to
  // channel space while the toggle still reads "On".

  // ---- What actually gets plotted --------------------------------------------------------
  // Channel space and dye space never mix on the same plot: color-separated curves carry no
  // real min/max/std of their own (§5 of calibration.md solves for a single concentration per
  // channel vector, not a distribution) — so bands and the dark overlay are both
  // channel-space-only concepts, hidden once color separation is on.

  const baseCurves: Omit<PlotCurve, "cq">[] = useMemo(
    () =>
      calibrationOn
        ? visibleFluor.map((c) => ({
            channel: c.channel,
            dyeLabel: labelForFluorCurve(c.row, c.col, c.dye),
            row: c.row,
            col: c.col,
            wellLabel: c.wellLabel,
            isReference: c.isReference,
            cycles: c.cycles,
            mean: c.mean,
            std: c.cycles.map(() => 0),
            min: c.mean,
            max: c.mean,
            sample: wellSample.get(wellKey(c.row, c.col)),
          }))
        : visibleChannel.map((c) => ({
            channel: c.channel,
            dyeLabel: channelLabel(c.channel),
            row: c.row,
            col: c.col,
            wellLabel: c.wellLabel,
            isReference: c.isReference,
            cycles: c.cycles,
            mean: c.mean,
            std: c.std,
            min: c.min,
            max: c.max,
            sample: wellSample.get(wellKey(c.row, c.col)),
          })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [calibrationOn, visibleFluor, visibleChannel, fluorViewMode, wellFluorTargets, hasNoTargetGroup, wellSample],
  );

  // Every curve on the plate for the active view mode, ignoring the enabled-wells/channels/
  // fluors/samples filters (but still skipping fluor/well pairs the plate itself never loads,
  // unless "Unloaded" is on — that's a data-validity gate, not a selection filter). Exists only
  // to power the rail hover cards below, so a filtered-out element still lists its neighbors
  // (greyed out) instead of the card going empty.
  const allBaseCurves: Omit<PlotCurve, "cq">[] = useMemo(
    () =>
      calibrationOn
        ? allFluorCurves
            .filter(
              (c) =>
                settings.showUnloadedFluors ||
                (wellFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false),
            )
            .map((c) => ({
              channel: c.channel,
              dyeLabel: labelForFluorCurve(c.row, c.col, c.dye),
              row: c.row,
              col: c.col,
              wellLabel: c.wellLabel,
              isReference: c.isReference,
              cycles: c.cycles,
              mean: c.mean,
              std: c.cycles.map(() => 0),
              min: c.mean,
              max: c.mean,
              sample: wellSample.get(wellKey(c.row, c.col)),
            }))
        : allCurves
            .filter((c) => available.includes(c.channel))
            .map((c) => ({
              channel: c.channel,
              dyeLabel: channelLabel(c.channel),
              row: c.row,
              col: c.col,
              wellLabel: c.wellLabel,
              isReference: c.isReference,
              cycles: c.cycles,
              mean: c.mean,
              std: c.std,
              min: c.min,
              max: c.max,
              sample: wellSample.get(wellKey(c.row, c.col)),
            })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      calibrationOn,
      allFluorCurves,
      allCurves,
      available,
      settings.showUnloadedFluors,
      wellFluors,
      fluorViewMode,
      wellFluorTargets,
      hasNoTargetGroup,
      wellSample,
    ],
  );

  // Cq markers (`threshold.md` §6), one per plotted curve, computed per the Analysis view's
  // settings — same algorithm, same per-group (dye/target/channel label) threshold, same
  // (always auto-linear) baseline this chart itself plots with — so a curve's marker always
  // matches what the Analysis table would report for it.
  const curveMetrics = useMemo(
    () => computeCurveMetrics(baseCurves, settings.analysisCqAlgorithm, settings.analysisThresholdOverrides),
    [baseCurves, settings.analysisCqAlgorithm, settings.analysisThresholdOverrides],
  );

  const plotCurves: PlotCurve[] = baseCurves.map((c, i) => ({
    ...c,
    cq: curveMetrics[i]?.cq ?? null,
    baselineFormula: curveMetrics[i]?.baselineFormula ?? null,
  }));

  // Same Cq computation, but over every curve on the plate (see `allBaseCurves`) — powers the
  // hover cards' greyed-out rows. Independent of `curveMetrics`: a group's threshold here is
  // resolved across the whole plate rather than just the currently-plotted subset, so a curve's
  // Cq in a hover card can legitimately differ from its Cq on the chart once a filter narrows
  // what's plotted — the card is summarizing the plate, not re-deriving the chart's own marker.
  const allCurveMetrics = useMemo(
    () => computeCurveMetrics(allBaseCurves, settings.analysisCqAlgorithm, settings.analysisThresholdOverrides),
    [allBaseCurves, settings.analysisCqAlgorithm, settings.analysisThresholdOverrides],
  );

  const allPlotCurves: PlotCurve[] = allBaseCurves.map((c, i) => ({
    ...c,
    cq: allCurveMetrics[i]?.cq ?? null,
    baselineFormula: allCurveMetrics[i]?.baselineFormula ?? null,
  }));

  // ---- Rail hover cards -------------------------------------------------------------------
  // Each card lists every curve on the plate for the hovered chip/cell (`allPlotCurves`), not
  // just the currently-plotted ones, so a filtered-out well/target/channel/sample still shows up
  // — just marked unselected so `HoverCard` can grey it out and sort it after the selected rows.
  // A row's color is its curve's channel, matching the chip/legend coloring elsewhere.

  const selectedCurveKeys = useMemo(
    () => new Set(plotCurves.map((c) => `${c.row},${c.col},${c.dyeLabel}`)),
    [plotCurves],
  );
  const isSelected = (c: PlotCurve) => selectedCurveKeys.has(`${c.row},${c.col},${c.dyeLabel}`);

  /** Selected rows first (each group's own original order preserved within that half). */
  function selectedFirst<T extends { selected: boolean }>(rows: T[]): T[] {
    return [...rows.filter((r) => r.selected), ...rows.filter((r) => !r.selected)];
  }

  const cardForWell = (label: string): HoverCardData | null => {
    const well = plate?.wells.find((w) => w.label === label);
    if (!well) return null;
    const rows: HoverCardRow[] = selectedFirst(
      allPlotCurves
        .filter((c) => c.wellLabel === label)
        .map((c) => ({
          key: `${c.dyeLabel}-${c.channel}`,
          label: c.dyeLabel,
          cq: c.cq ?? null,
          color: channelColor(c.channel),
          selected: isSelected(c),
        })),
    );
    // Sample type is shown the same way the grid colors the cell: a well that isn't loaded reads
    // as "empty" whatever type the plate design assigned it (see `computeWellTypes`).
    const meta = SAMPLE_TYPE_META[well.loaded ? well.sampleType : "empty"];
    const parts = [meta.label, well.sample ? `Sample: ${well.sample}` : null].filter(Boolean);
    return { title: `Well ${label}`, subtitle: parts.join(" · "), rows };
  };

  const cardForDyeLabel = (dyeLabel: string): HoverCardData | null => {
    const matches = allPlotCurves.filter((c) => c.dyeLabel === dyeLabel);
    if (matches.length === 0) return null;
    const rows: HoverCardRow[] = selectedFirst(
      matches.map((c) => ({
        key: `${c.row},${c.col}`,
        label: c.wellLabel,
        sublabel: c.sample,
        cq: c.cq ?? null,
        color: channelColor(c.channel),
        selected: isSelected(c),
      })),
    );
    return { title: dyeLabel, rows };
  };

  const cardForChannel = (channel: number): HoverCardData | null => {
    const matches = allPlotCurves.filter((c) => c.channel === channel);
    if (matches.length === 0) return null;
    const rows: HoverCardRow[] = selectedFirst(
      matches.map((c) => ({
        key: `${c.row},${c.col}`,
        label: c.wellLabel,
        sublabel: c.sample,
        cq: c.cq ?? null,
        color: channelColor(channel),
        selected: isSelected(c),
      })),
    );
    return { title: channelLabel(channel), rows };
  };

  const cardForSample = (sample: string): HoverCardData | null => {
    const matches = allPlotCurves.filter((c) => c.sample === sample);
    if (matches.length === 0) return null;
    const rows: HoverCardRow[] = selectedFirst(
      matches.map((c) => ({
        key: `${c.row},${c.col}-${c.dyeLabel}`,
        label: c.dyeLabel,
        sublabel: c.wellLabel,
        cq: c.cq ?? null,
        color: channelColor(c.channel),
        selected: isSelected(c),
      })),
    );
    return { title: sample, rows };
  };

  const toggleTemp = (key: string) => {
    const next = new Set(settings.temps);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange({ temps: next });
  };

  const toggleChannel = (ch: number) => {
    const next = new Set(settings.enabledChannels);
    next.has(ch) ? next.delete(ch) : next.add(ch);
    onChange({ enabledChannels: next });
  };

  const toggleFluor = (dye: string) => {
    const next = new Set(settings.disabledFluors);
    next.has(dye) ? next.delete(dye) : next.add(dye);
    onChange({ disabledFluors: next });
  };

  const logBaselined = settings.scale === "log" && settings.curveView === "relative";

  return (
    <div className="curves">
      <aside className="curves__rail">
        {steps.length > 1 && (
          <div className="rail__section">
            <div className="rail__title">Plate-read step</div>
            <div className="segmented segmented--sm stepsel">
              {steps.map((s, i) => (
                <button
                  key={s.step}
                  className={
                    "segmented__item" + (s.step === activeStep ? " is-active" : "")
                  }
                  onClick={() => onChange({ step: s.step })}
                  title={`Protocol STEP ${s.step}, ${s.readCount} cycles`}
                >
                  {i} · {s.readCount}c
                </button>
              ))}
            </div>
          </div>
        )}

        {plateEntry && (
          <div className="rail__section">
            {plateEntry.pltd.needsPassword || plateEntry.pltd.error ? (
              <PasswordPrompt
                wrong={!!plateEntry.pltd.error}
                onSubmit={setPltdPassword}
              />
            ) : (
              <>
                <div className="rail__row">
                  <Toggle
                    label="View"
                    options={[
                      ["channel", "Channel"],
                      ["fluorophore", "Fluorophore"],
                      ["target", "Target"],
                    ]}
                    value={calibrationOn ? fluorViewMode : "channel"}
                    onChange={(v) =>
                      v === "channel"
                        ? onChange({ calibration: false })
                        : onChange({ calibration: true, fluorViewMode: v as FluorViewMode })
                    }
                  />
                </div>
                {/* Where a "Normalization" toggle used to sit. It was a no-op by construction:
                    calibration.md §5.1 divides the column scaling back out, so every mode
                    reports identical RFU unless the matrix is rank-deficient. The setting still
                    exists (see FileSettings) — it just isn't a user-facing choice. */}
                {calibrationOn && !calibrationAvailable && (
                  <div className="rail__note mono">
                    No .Dcal calibration matches this plate's fluorophores for {tube}. Check
                    the Calibration files under Raw files.
                  </div>
                )}
                {calibrationOn &&
                  calibrationAvailable &&
                  fluorCals.some((f) => !f.curve) && (
                    <div className="rail__note mono">
                      No {tube} calibration for:{" "}
                      {fluorCals
                        .filter((f) => !f.curve)
                        .map((f) => f.fluor)
                        .join(", ")}
                      .
                    </div>
                  )}
              </>
            )}
          </div>
        )}

        <div className="rail__section">
          <div className="rail__title">
            {calibrationOn ? (fluorViewMode === "target" ? "Targets" : "Fluorophores") : "Channels"}
          </div>
          {calibrationOn ? (
            <>
              <FluorBar
                items={chipItems}
                disabled={settings.disabledFluors}
                onToggle={toggleFluor}
                onHover={(key) => setHoverHighlight(key ? { kind: "target", dyeLabel: key } : null)}
                cardData={cardForDyeLabel}
              />
              <div className="rail__row" style={{ marginTop: 8 }}>
                <Switch
                  label="Unloaded"
                  checked={settings.showUnloadedFluors}
                  onChange={(v) => onChange({ showUnloadedFluors: v })}
                  title="Draw curves for every enabled well, even ones the plate configuration doesn't load this fluor/target into"
                />
              </div>
            </>
          ) : (
            <ChannelBar
              enabled={settings.enabledChannels}
              available={available}
              onToggle={toggleChannel}
              onHover={(ch) => setHoverHighlight(ch != null ? { kind: "channel", channel: ch } : null)}
              cardData={cardForChannel}
            />
          )}
        </div>

        <div className="rail__section">
          <div className="rail__title">
            Wells
            <button
              className="rail__link rail__icon-btn"
              onClick={resetWells}
              title="Reset to the wells present in the plate definition"
            >
              <ResetIcon />
            </button>
          </div>
          <WellMatrix
            enabled={settings.enabledWells}
            onChange={(next) => onChange({ enabledWells: next })}
            wellTypes={wellTypes}
            onHoverWell={(label) => setHoverHighlight(label ? { kind: "well", label } : null)}
            cardData={cardForWell}
          />
        </div>

        {sampleList.length > 0 && (
          <details className="rail__section rail__details">
            <summary className="rail__title">
              <span>
                <span className="rail__chevron" aria-hidden="true">
                  ▸
                </span>
                Samples
              </span>
              <button
                className="rail__link"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({
                    disabledSamples:
                      settings.disabledSamples.size > 0 ? new Set<string>() : new Set(sampleList),
                  });
                }}
              >
                {settings.disabledSamples.size > 0 ? "all" : "none"}
              </button>
            </summary>
            <SampleBar
              items={sampleList}
              disabled={settings.disabledSamples}
              onToggle={toggleSample}
              onHover={(sample) => setHoverHighlight(sample ? { kind: "sample", sample } : null)}
              cardData={cardForSample}
            />
          </details>
        )}

        {allTemps.length > 0 && (
          <details className="rail__section rail__details">
            <summary className="rail__title">
              <span>
                <span className="rail__chevron" aria-hidden="true">
                  ▸
                </span>
                Temperature (right axis)
              </span>
              <button
                className="rail__link"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({
                    temps:
                      visibleTemps.length > 0
                        ? new Set<string>()
                        : new Set(
                            allTemps.filter((t) => t.kind === "measured").map((t) => t.key),
                          ),
                  });
                }}
              >
                {visibleTemps.length > 0 ? "none" : "all"}
              </button>
            </summary>
            <TempBar temps={allTemps} enabled={settings.temps} onToggle={toggleTemp} />
          </details>
        )}

        <div className="rail__section rail__row">
          <Toggle
            label="View"
            options={[
              ["relative", "Relative"],
              ["absolute", "Absolute"],
            ]}
            value={settings.curveView}
            onChange={(v) => onChange({ curveView: v as CurveView })}
          />
          <Switch
            label="Draw baseline"
            checked={settings.drawBaseline}
            onChange={(v) => onChange({ drawBaseline: v })}
            title="Overlay each curve's auto-detected linear baseline at 50% opacity"
          />
        </div>

        <div className="rail__section rail__row">
          <Toggle
            label="Scale"
            options={[
              ["linear", "Linear"],
              ["log", "Log"],
            ]}
            value={settings.scale}
            onChange={(v) => onChange({ scale: v as Scale })}
          />
          {!calibrationOn && (
            <>
              <Toggle
                label="Show dark"
                options={[
                  ["off", "Off"],
                  ["on", "On"],
                ]}
                value={settings.showDark ? "on" : "off"}
                onChange={(v) => onChange({ showDark: v === "on" })}
              />
              <Toggle
                label="Min/max band"
                options={[
                  ["off", "Off"],
                  ["auto", "Auto"],
                  ["on", "On"],
                ]}
                value={settings.bands}
                onChange={(v) => onChange({ bands: v as BandsMode })}
              />
            </>
          )}
        </div>

        {calibrationOn && (
          <div className="rail__section">
            <div className="rail__row">
              <Toggle
                label="Background"
                options={[
                  ["none", "None"],
                  ["dark", "Dark"],
                  ["plate", "Plate"],
                ]}
                value={settings.calibrationBackground}
                onChange={(v) =>
                  onChange({ calibrationBackground: v as CalibrationBackground })
                }
              />
            </div>
            {settings.calibrationBackground === "plate" && !plateBackgroundAvailable && (
              <div className="rail__note mono">
                No {tube} empty-plate calibration in this file — no background subtracted.
              </div>
            )}
          </div>
        )}

        <div className="rail__stat mono">
          {plotCurves.length} / {calibrationOn ? allFluorCurves.length : allCurves.length}{" "}
          curves
          {!calibrationOn && settings.showDark && " + dark"}
          {visibleTemps.length > 0 && ` + ${visibleTemps.length} temp`}
        </div>
        {logBaselined && (
          <div className="rail__note mono">
            Log + baseline: each curve shifted so its own minimum reads 1.
          </div>
        )}
      </aside>

      <section className="curves__plot">
        <CurveChart
          curves={plotCurves}
          darkCurves={!calibrationOn && settings.showDark ? enabledDark : []}
          tempCurves={visibleTemps}
          baseline="raw"
          curveView={settings.curveView}
          drawBaseline={settings.drawBaseline}
          scale={settings.scale}
          bands={calibrationOn ? "off" : settings.bands}
          highlight={hoverHighlight}
        />
      </section>
    </div>
  );
}
