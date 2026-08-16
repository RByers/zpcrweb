import { useEffect, useMemo, useRef, useState } from "react";
import {
  analysisCsv,
  analysisCsvFilename,
  buildAnalysisRows,
  buildMeltRows,
  computeMeltAnalysisFor,
  meltCsv,
  meltCurvesFromFluor,
  meltSegments,
  meltCsvFilename,
  NO_TARGET,
  wellLabel,
  type LedCurve,
  type MeltCurve,
  type Zpcr,
  type TemperatureCurve,
} from "@zpcrweb/core";
import { computeWellTypes } from "../../lib/wellTypes";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import {
  wellKey,
  type AnalysisSource,
  type CurveView,
  type FileSettings,
  type FluorViewMode,
  type MeltView,
  type Scale,
} from "../../state/useZpcrStore";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelColor, channelLabel } from "../../lib/channelColors";
import { curveColor } from "../../lib/fluorColors";
import {
  channelCurveKey,
  curveKey,
  darkCurveKey,
  useRunAnalysis,
} from "../../lib/runAnalysis";
import { downloadText } from "../../lib/download";
import { vesselLabel } from "../../lib/plateNames";
import { ChannelBar } from "../curves/ChannelBar";
import { FluorBar, type FluorChip } from "../curves/FluorBar";
import { SampleBar } from "../curves/SampleBar";
import { useHoverCard, type HoverCardData, type HoverCardRow } from "../curves/HoverCard";
import { WellMatrix } from "../curves/WellMatrix";
import { CurveChart, type CqDragTarget } from "../curves/CurveChart";
import { CurveTable } from "../curves/CurveTable";
import { MeltChart } from "../curves/MeltChart";
import { MeltTable } from "../curves/MeltTable";
import { CqRange } from "../curves/CqRange";
import {
  ThresholdSection,
  type ThresholdCurveRow,
  type ThresholdGroupRow,
} from "../curves/ThresholdSection";
import { AuxBar } from "../curves/AuxBar";
import { ledAxis, noRightAxis, selectAux, temperatureAxis } from "../../lib/rightAxis";
import { PasswordPrompt } from "../PasswordPrompt";
import { Toggle } from "../Toggle";
import { Switch } from "../Switch";
import { ResetIcon } from "../ResetIcon";
import { DownloadIcon } from "../DownloadIcon";
import type { HighlightMatch, PlotCurve } from "../../lib/uplot/chart";
import type { MeltHighlight, MeltPlotCurve } from "../../lib/uplot/meltChart";

interface Props {
  zpcr: Zpcr;
  settings: FileSettings;
  onChange: (patch: Partial<FileSettings>) => void;
}

export function CurvesView({ zpcr, settings, onChange }: Props) {
  const [pltdPassword, setPltdPassword] = usePltdPassword();

  // Landscape-phone drawer state (see `.curves__rail`'s media query in app.css). Irrelevant
  // outside that viewport shape — the toggle button and scrim that drive it are `display: none`
  // everywhere else, so the rail just renders as the permanent column it always was.
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen]);
  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  // Selected step: the stored one if still valid, else the first step.
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);

  /**
   * Melt mode. A plate-read step whose reads sweep temperature is a melt curve rather than an
   * amplification one (`melt.md` §2), and almost nothing this view normally does applies to it:
   * there are no cycles, no baseline, no threshold and no Cq. When the selected step is one, the
   * chart, the table, the CSV and most of the rail below switch over.
   *
   * This is the **channel-space** melt, which is always available: it needs no plate definition
   * and no password, which is what lets melt mode work on a run whose plate is encrypted — the
   * committed melt sample being exactly that. `meltFluor` below is the color-separated
   * counterpart, for the View toggle's dye modes.
   */
  const melt = useMemo(
    () => computeMeltAnalysisFor(zpcr, activeStep),
    [zpcr, activeStep],
  );
  const meltMode = melt !== undefined;
  /** Every melt step of the run, so the step selector can name one for what it is rather than by
   * its index — a run's melt is the step people go looking for. */
  const meltSteps = useMemo(() => meltSegments(zpcr), [zpcr]);
  const stepMelt = (step: number) => meltSteps.find((m) => m.step === step);
  /** A ramp endpoint, written the way the instrument's own protocol writes it: 65, not 65.0. */
  const fmtTemp = (c: number) => (Number.isInteger(c) ? String(c) : c.toFixed(1));

  // The run-level derivation this view is built on — plate, targets, color separation and, above
  // all, the run's single Cq table. See `runAnalysis.ts`: the chart, the hover cards and table mode
  // all read Cq values out of that one table and never recompute them for the subset they happen to
  // be showing, which is what used to make them disagree with each other.
  const run = useRunAnalysis(zpcr, settings, pltdPassword, activeStep);
  const {
    plateEntry,
    plate,
    allCurves,
    darkCurves,
    available,
    tubes,
    fluorCals,
    calibrationAvailable,
    wellFluorTargets,
    wellFluors,
    wellSample,
    targetInfos,
    usingTargets,
    dyeSpace,
    hasFileAnalysis,
    groupInfos,
    thresholdGroups,
    loadedFluors,
    allFluorCurves,
    cqTable,
    plainBaselines,
  } = run;

  // Everything the platereads carry that can ride the chart's right axis, for this step:
  // instrument temperatures and the excitation LEDs' drive currents. Which are plotted is a
  // per-file setting, and the two are mutually exclusive — one axis, and °C and DAC counts share
  // no scale (see `rightAxis.ts`), enforced in the store rather than here.
  const allTemps = useMemo<TemperatureCurve[]>(
    () => zpcr.temperatureCurves(activeStep),
    [zpcr, activeStep],
  );
  const allLeds = useMemo<LedCurve[]>(() => zpcr.ledCurves(activeStep), [zpcr, activeStep]);
  // Built from the *full* series list so a chip's color and its line's color are the same one,
  // then filtered to what's enabled — the axis the chart gets carries only the plotted series.
  const tempAxis = useMemo(() => temperatureAxis(allTemps), [allTemps]);
  const ledAxisAll = useMemo(() => ledAxis(allLeds), [allLeds]);
  const rightAxis = useMemo(() => {
    if (settings.leds.size > 0) return selectAux(ledAxisAll, settings.leds);
    if (settings.temps.size > 0) return selectAux(tempAxis, settings.temps);
    return noRightAxis();
  }, [ledAxisAll, tempAxis, settings.leds, settings.temps]);

  // Dark lines/subtraction only concern the enabled, available channels. Each carries its
  // display baseline from the run's analysis, like every other plotted series — the "Relative"
  // view baselines the dark overlay too.
  const enabledDark = useMemo(
    () =>
      darkCurves
        .filter((d) => available.includes(d.channel) && settings.enabledChannels.has(d.channel))
        .map((d) => ({ ...d, analysis: plainBaselines.get(darkCurveKey(d.channel)) })),
    [darkCurves, available, settings.enabledChannels, plainBaselines],
  );

  // ---- Plate-derived selection state -----------------------------------------------------
  // The dye-space curves themselves come from `useRunAnalysis` above (see calibration.md); what's
  // left here is the per-view selection/labelling state built on top of the plate.

  // Per-well sample type, for coloring the well-selection grid to match the Plates view — see
  // `computeWellTypes`; shared with AnalysisView's well matrix.
  const wellTypes = useMemo(() => computeWellTypes(plate), [plate]);

  // Wells holding at least one positive curve — one the run's Cq table gave a Cq, i.e. it crossed
  // its threshold — mapped to the *lowest* such Cq, which is what fades the grid's `+` (see
  // `plusOpacity`). Read from that table rather than from the plotted subset, so the mark doesn't
  // come and go as the rail's filters change: a well is positive or it isn't.
  const positiveWells = useMemo(() => {
    const m = new Map<string, number>();
    for (const [key, e] of cqTable) {
      if (e.cq == null) continue;
      // `curveKey` is `row,col,fluor` — the well key is its first two fields.
      const [row, col] = key.split(",");
      const k = wellKey(Number(row), Number(col));
      const prev = m.get(k);
      if (prev == null || e.cq < prev) m.set(k, e.cq);
    }
    return m;
  }, [cqTable]);

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

  const setsEqual = <T,>(a: Set<T>, b: Set<T>) =>
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

  // Channels assigned to a fluor in the plate configuration — the default selection for a newly
  // opened file's raw Channels view (calibration off), and what its reset button restores.
  const plateChannelSet = useMemo(() => {
    if (!plate) return null;
    // Fluors whose channel is unknown select nothing: this drives which raw optical channels to
    // show, and there is no channel to show for them (see `PlateFluor.channel`).
    const s = new Set<number>();
    for (const f of plate.fluors) if (f.channel !== undefined) s.add(f.channel);
    return s.size > 0 ? s : null;
  }, [plate]);

  const defaultEnabledChannels = useMemo(() => {
    if (!plateChannelSet) return new Set(available);
    const s = new Set(available.filter((ch) => plateChannelSet.has(ch)));
    return s.size > 0 ? s : new Set(available);
  }, [available, plateChannelSet]);

  // Same apply-once-per-plate pattern as the wells default above.
  const appliedChannelDefaultForPlate = useRef<typeof plate>(undefined);
  useEffect(() => {
    if (!plate || !plateChannelSet) return;
    if (appliedChannelDefaultForPlate.current === plate) return;
    appliedChannelDefaultForPlate.current = plate;
    if (setsEqual(settings.enabledChannels, new Set([0, 1, 2, 3, 4]))) {
      onChange({ enabledChannels: defaultEnabledChannels });
    }
  }, [plate, plateChannelSet, defaultEnabledChannels, settings.enabledChannels, onChange]);

  const resetChannels = () => onChange({ enabledChannels: defaultEnabledChannels });
  const resetFluors = () => onChange({ disabledFluors: new Set<string>() });

  const calibrationOn = settings.calibration ?? calibrationAvailable;
  /** Names the plastic the calibration warnings below are talking about — both of them, on a
   * plate that mixes vessels, since each has its own calibration and either can be the one
   * missing. */
  const vessels = vesselLabel(tubes);
  const fluorViewMode: FluorViewMode = settings.fluorViewMode;
  /** Table mode replaces the chart with the run's Cq/ΔRFU table (the former Analysis view). It is
   * dye-space-only for the same reason the "Target" mode is: a per-target Cq needs color
   * separation. */
  const tableMode = calibrationOn && fluorViewMode === "table";
  /** How dye-space curves are grouped and labelled. Table mode groups by target, like "target"
   * mode — so the rail's chips, the threshold overrides and the table's rows all key on the same
   * label, whichever of the two is showing. */
  const groupByTarget = fluorViewMode !== "fluorophore";

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
    groupByTarget
      ? (wellFluorTargets.get(wellKey(row, col))?.get(dye) ?? (hasNoTargetGroup ? NO_TARGET : dye))
      : dye;

  // Hovering a target/fluor chip or a well-grid cell in the rail highlights the matching
  // curve(s) in the chart, the same way hovering the chart itself dims every other curve.
  const [hoverHighlight, setHoverHighlight] = useState<HighlightMatch | null>(null);

  // Hovering a row in the Threshold rail also marks that threshold on the chart: a dotted line at
  // its RFU, plus — for a single curve's row — that curve's baseline region and σ (see CurveChart's
  // `thresholdLine`/`thresholdRegions` props). Set alongside `hoverHighlight` so isolating the
  // curves and marking their threshold always appear together.
  //
  // What's stored is *which* row is hovered, not the RFU it had when the pointer arrived: the
  // threshold's own input sits inside the hovered row, so typing or arrow-stepping it changes the
  // number without any pointer event to refresh a snapshot, and a captured value would leave the
  // line behind at the old level. Resolved against `thresholdRows` on every render below, the line
  // tracks the edit — and the auto-multiplier slider — live.
  const [hoverThreshold, setHoverThreshold] = useState<{
    fluor: string;
    /** Set when a single curve's row is hovered; absent for the fluorophore's own row. */
    curveKey?: string;
    regions: boolean;
  } | null>(null);

  // A hovered item should be shown even when it's individually disabled — the "peek" a rail
  // hover is supposed to give — so the visibility filters below let the hovered well/channel/
  // target/sample bypass its own disabled check (but only its own; hovering a disabled target
  // doesn't also reveal wells the user turned off).
  //
  // `plateRows`/`cellLabel` mirror `WellMatrix`'s own row-count-aware labelling (see that
  // component's doc comment) rather than always using core's `wellLabel()`: a Biomeme run's
  // synthesized plate is a single row, and `WellMatrix` sends hover labels with no row letter
  // for one — this has to construct the same string to recognize them.
  const plateRows = plate?.rows ?? 8;
  const cellLabel = (row: number, col: number) =>
    plateRows === 1 ? String(col + 1) : wellLabel(row, col);
  const isHoveredWell = (row: number, col: number) =>
    hoverHighlight?.kind === "wells" && hoverHighlight.labels.includes(cellLabel(row, col));
  const isHoveredChannel = (channel: number) =>
    hoverHighlight?.kind === "channel" && hoverHighlight.channel === channel;
  const isHoveredSample = (sample: string | undefined) =>
    !!sample && hoverHighlight?.kind === "sample" && hoverHighlight.sample === sample;
  const isHoveredTarget = (label: string) =>
    hoverHighlight?.kind === "target" && hoverHighlight.dyeLabel === label;

  // Target/table mode chips come from `groupInfos` — the threshold groups themselves — so a plate
  // with no targets at all still gets chips (its groups are its fluorophores; see `usingTargets`)
  // rather than an empty bar.
  const chipItems: FluorChip[] = useMemo(
    () =>
      groupByTarget
        ? groupInfos.map((g) => ({
            key: g.target,
            label: g.target,
            sublabel: usingTargets ? g.fluors.join(", ") : channelLabel(g.channel ?? 0),
            // One dye colors the chip; a target spanning several has no one dye to borrow from.
            fluor: g.fluors.length === 1 ? g.fluors[0] : null,
            // A dye-space source has no `.Dcal` calibration to have matched — see `dyeSpace`.
            calibrated: dyeSpace || !!g.curve,
          }))
        : fluorCals.map((f) => ({
            key: f.fluor,
            label: f.fluor,
            sublabel: channelLabel(f.channel),
            fluor: f.fluor,
            calibrated: dyeSpace || !!f.curve,
          })),
    [groupByTarget, groupInfos, usingTargets, fluorCals, dyeSpace],
  );

  /** The chip keys the *enabled* wells can actually produce — every dye those wells load, mapped
   * through the same labelling the curves themselves use. With "Unloaded" on, a well can draw any
   * of the plate's dyes, so every chip stays reachable. */
  const wellReachableKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!plate) return keys;
    for (const w of plate.wells) {
      if (!settings.enabledWells.has(wellKey(w.row, w.col))) continue;
      const dyes = settings.showUnloadedFluors
        ? plate.fluors.map((f) => f.fluor)
        : (w.fluors?.map((f) => f.fluor) ?? []);
      for (const dye of dyes) keys.add(labelForFluorCurve(w.row, w.col, dye));
    }
    return keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    plate,
    settings.enabledWells,
    settings.showUnloadedFluors,
    groupByTarget,
    hasNoTargetGroup,
    wellFluorTargets,
  ]);

  /** What the rail actually lists: only targets/fluorophores some enabled well can show. Turning
   * a well off takes its target off the bar with it, so the list describes the selection on
   * screen rather than the whole plate. The unfiltered `chipItems` still backs double-click
   * solo, so isolating one target also disables the ones currently hidden. */
  const visibleChipItems = useMemo(
    () => chipItems.filter((c) => wellReachableKeys.has(c.key)),
    [chipItems, wellReachableKeys],
  );

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

  /** The same list, narrowed to samples sitting in an enabled well — see `visibleChipItems`. */
  const visibleSampleList = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    if (plate) {
      for (const w of plate.wells) {
        if (!w.sample || seen.has(w.sample)) continue;
        if (!settings.enabledWells.has(wellKey(w.row, w.col))) continue;
        seen.add(w.sample);
        list.push(w.sample);
      }
    }
    return list;
  }, [plate, settings.enabledWells]);

  const sampleVisible = (row: number, col: number): boolean => {
    const sample = wellSample.get(wellKey(row, col));
    return !sample || !settings.disabledSamples.has(sample) || isHoveredSample(sample);
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
          (settings.enabledChannels.has(c.channel) || isHoveredChannel(c.channel)) &&
          (settings.enabledWells.has(wellKey(c.row, c.col)) || isHoveredWell(c.row, c.col)) &&
          sampleVisible(c.row, c.col),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      allCurves,
      available,
      settings.enabledChannels,
      settings.enabledWells,
      settings.disabledSamples,
      wellSample,
      hoverHighlight,
    ],
  );

  /** The rail's filters, as one predicate over a well/fluor pair — shared by the plotted dye-space
   * curves and by table mode's rows, so the two always show the same set. The "is this pair
   * actually loaded" check is deliberately *not* here: it's a data-validity gate the chart can
   * bypass ("Unloaded") and the table never applies (it only lists loaded wells). */
  const fluorCurveVisible = (row: number, col: number, dye: string): boolean => {
    const label = labelForFluorCurve(row, col, dye);
    return (
      (settings.enabledWells.has(wellKey(row, col)) || isHoveredWell(row, col)) &&
      (!settings.disabledFluors.has(label) || isHoveredTarget(label)) &&
      sampleVisible(row, col) &&
      cqInRange(row, col, dye)
    );
  };

  /** The rail's Cq filter (see `FileSettings.cqMin` and the `CqRange` slider). Read out of the
   * run's Cq table like everything else about a curve's Cq — never recomputed here — so a curve
   * is filtered on exactly the number the chart marker, hover card and table all show for it.
   *
   * Unlike the chip filters above it takes no hover override: there is no chip to hover, and a
   * peeked well should still respect the range the user is looking at. A curve with no Cq
   * survives only while the upper bound is unset, which is the slider's top stop. */
  const cqInRange = (row: number, col: number, dye: string): boolean => {
    if (settings.cqMin == null && settings.cqMax == null) return true;
    const cq = cqTable.get(curveKey(row, col, dye))?.cq ?? null;
    if (cq == null) return settings.cqMax == null;
    return (
      (settings.cqMin == null || cq >= settings.cqMin) &&
      (settings.cqMax == null || cq <= settings.cqMax)
    );
  };

  const visibleFluor = useMemo(
    () =>
      allFluorCurves.filter(
        (c) =>
          fluorCurveVisible(c.row, c.col, c.dye) &&
          (settings.showUnloadedFluors ||
            (wellFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false)),
      ),
    [
      allFluorCurves,
      settings.enabledWells,
      settings.disabledFluors,
      settings.showUnloadedFluors,
      settings.disabledSamples,
      settings.cqMin,
      settings.cqMax,
      cqTable,
      wellFluors,
      wellSample,
      fluorViewMode,
      wellFluorTargets,
      hasNoTargetGroup,
      hoverHighlight,
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

  // The analysis record for one plotted curve — *looked up*, never recomputed. The run's tables
  // (`runAnalysis.ts`) already hold exactly one record per curve, computed over the whole plate;
  // deriving one again from whatever subset happens to be plotted is precisely what used to make
  // the chart's markers, the hover cards and the Analysis table disagree. Everything the chart
  // draws about a curve's baseline, threshold or Cq comes from here.
  const dyeAnalysis = (row: number, col: number, dye: string) => cqTable.get(curveKey(row, col, dye));
  // Channel space gets no Cq of its own — see `RunAnalysis.cqTable`. A raw channel curve carries
  // every dye that emits into that filter and belongs to no target, so quantifying it would be
  // measuring crosstalk. Its record is therefore the baseline-only kind: enough for the "Relative"
  // view to subtract the same baseline the rest of the app would, with no Cq or threshold attached.
  // What channel curves carry instead, and dye-space curves don't, is the real min/max/σ spread.
  const channelAnalysis = (row: number, col: number, channel: number) =>
    plainBaselines.get(channelCurveKey(row, col, channel));

  const plotCurves: PlotCurve[] = useMemo(
    () =>
      calibrationOn
        ? visibleFluor.map((c) => ({
            channel: c.channel,
            dyeLabel: labelForFluorCurve(c.row, c.col, c.dye),
            fluor: c.dye,
            row: c.row,
            col: c.col,
            wellLabel: c.wellLabel,
            isReference: c.isReference,
            cycles: c.cycles,
            mean: c.mean,
            sample: wellSample.get(wellKey(c.row, c.col)),
            analysis: dyeAnalysis(c.row, c.col, c.dye),
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
            analysis: channelAnalysis(c.row, c.col, c.channel),
          })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      calibrationOn,
      visibleFluor,
      visibleChannel,
      fluorViewMode,
      wellFluorTargets,
      hasNoTargetGroup,
      wellSample,
      cqTable,
    ],
  );

  // Every curve on the plate for the active view mode, ignoring the enabled-wells/channels/
  // fluors/samples filters (but still skipping fluor/well pairs the plate itself never loads,
  // unless "Unloaded" is on — that's a data-validity gate, not a selection filter). Exists only
  // to power the rail hover cards below, so a filtered-out element still lists its neighbors
  // (greyed out) instead of the card going empty. Cq values come from the same table as the
  // plotted curves', so a hover card and the chart always agree on a given curve.
  const allPlotCurves: PlotCurve[] = useMemo(
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
              fluor: c.dye,
              row: c.row,
              col: c.col,
              wellLabel: c.wellLabel,
              isReference: c.isReference,
              cycles: c.cycles,
              mean: c.mean,
              sample: wellSample.get(wellKey(c.row, c.col)),
              analysis: dyeAnalysis(c.row, c.col, c.dye),
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
              analysis: channelAnalysis(c.row, c.col, c.channel),
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
      cqTable,
    ],
  );

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
          cq: c.analysis?.cq,
          color: curveColor(c),
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
        cq: c.analysis?.cq,
        color: curveColor(c),
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
        cq: c.analysis?.cq,
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
        cq: c.analysis?.cq,
        color: curveColor(c),
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

  const toggleLed = (key: string) => {
    const next = new Set(settings.leds);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange({ leds: next });
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

  // Double-clicking any legend item isolates it within its own dimension — every other
  // channel/target/well/sample turns off, leaving only the one that was double-clicked.
  const soloChannel = (ch: number) => onChange({ enabledChannels: new Set([ch]) });

  const soloFluor = (key: string) => {
    const next = new Set(chipItems.map((c) => c.key));
    next.delete(key);
    onChange({ disabledFluors: next });
  };

  const soloWells = (keys: string[]) => onChange({ enabledWells: new Set(keys) });

  const soloSample = (name: string) => {
    const next = new Set(sampleList);
    next.delete(name);
    onChange({ disabledSamples: next });
  };

  // Clicking a Well/Target/Sample value in table mode: isolate what was clicked — exactly the
  // rail's own double-click solo — and leave the table for the Target view, so the answer to
  // "what does this row look like?" is the chart of that one thing. Only the clicked dimension
  // is touched; the other two keep whatever the rail already had.
  const pickWell = (row: number, col: number) => {
    onChange({ fluorViewMode: "target", enabledWells: new Set([wellKey(row, col)]) });
  };
  const pickTarget = (key: string) => {
    const next = new Set(chipItems.map((c) => c.key));
    next.delete(key);
    onChange({ fluorViewMode: "target", disabledFluors: next });
  };
  const pickSample = (name: string) => {
    const next = new Set(sampleList);
    next.delete(name);
    onChange({ fluorViewMode: "target", disabledSamples: next });
  };
  // The row's result numbers name one curve, not one dimension: isolating both the well and the
  // target leaves exactly the curve those numbers were measured on.
  const pickCurve = (row: number, col: number, key: string) => {
    const fluors = new Set(chipItems.map((c) => c.key));
    fluors.delete(key);
    onChange({
      fluorViewMode: "target",
      enabledWells: new Set([wellKey(row, col)]),
      disabledFluors: fluors,
    });
  };

  // ---- Table mode / CSV export -------------------------------------------------------------
  // One row per visible (target, well) pair, filtered by exactly the same rail state as the chart
  // and reading the same Cq table (see `lib/analysisRows.ts`). Built in every view mode, not only
  // in table mode or dye space: the rows are what the Threshold section's live auto values and the
  // CSV button read, and both are available in channel mode too. Rows are target-based regardless
  // of which space the chart is showing — a threshold belongs to a target, never to a filter.
  const tableRows = useMemo(
    () => buildAnalysisRows(run, fluorCurveVisible),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      run,
      settings.enabledWells,
      settings.disabledFluors,
      settings.disabledSamples,
      settings.cqMin,
      settings.cqMax,
      fluorViewMode,
      wellFluorTargets,
      hasNoTargetGroup,
      wellSample,
    ],
  );

  /** How many cycles the active step actually read — the domain the table's Cq axis spans, and
   * the same one the chart's x axis uses. Taken from a curve rather than from the protocol: a run
   * stopped early has fewer plate reads than its `.prcl` asked for, and the axis has to match the
   * data that exists. */
  const cycleCount = useMemo(
    () => allCurves.reduce((m, c) => Math.max(m, c.cycles.at(-1) ?? 0), 0),
    [allCurves],
  );

  /** The live threshold per group (an override, or §5.1's auto value), read straight from the
   * run's Cq table rather than from `tableRows`: a group's threshold is a property of the run and
   * its noise cohort, not of which of its wells the rail happens to have selected, so the
   * Threshold section keeps showing a real value even when a filter hides every row. */
  const groupThresholds = useMemo(() => {
    const m = new Map<string, number>();
    // `groupThreshold`, not `threshold`: the latter is what that one curve is measured against,
    // which a per-curve override replaces — reading it would let overriding a single well rewrite
    // the number its whole fluorophore row displays.
    for (const e of cqTable.values()) if (!m.has(e.group)) m.set(e.group, e.groupThreshold);
    return m;
  }, [cqTable]);

  /** The Threshold section's rows: one per calibrated fluorophore, each carrying the curves its
   * threshold was derived from — the plate's *loaded* wells for that dye, which is exactly the
   * §5.1 noise cohort (`CqTableCurve.contributesToThreshold`). Every fluorophore with a matched
   * calibration curve gets a row regardless of the chip opt-out above: one hidden from the chart
   * still has a real threshold worth checking or overriding, and there'd otherwise be nothing on
   * screen to bring it back once its row vanished with its chip. */
  const thresholdRows = useMemo<ThresholdGroupRow[]>(
    () =>
      thresholdGroups
        .filter((g) => dyeSpace || g.curve)
        .map((g) => ({
          fluor: g.fluor,
          channel: g.channel,
          threshold: groupThresholds.get(g.fluor),
          override: settings.thresholdOverrides.get(g.fluor),
          curves: (plate?.wells ?? []).flatMap((w) => {
            if (!w.loaded || !(loadedFluors.get(wellKey(w.row, w.col))?.has(g.fluor) ?? false)) {
              return [];
            }
            const key = curveKey(w.row, w.col, g.fluor);
            const e = cqTable.get(key);
            if (!e) return [];
            return [
              {
                key,
                wellLabel: w.label,
                beginCycle: e.baselineRegion.beginCycle,
                endCycle: e.baselineRegion.endCycle,
                noise: e.noise,
                // §A.4's "baseline above threshold" case: a curve whose corrected minimum already
                // exceeds the threshold can never cross it, so it reports no Cq however obviously
                // it amplifies. Worth flagging, because in the table it is indistinguishable from
                // a flat well and means the opposite thing.
                aboveThreshold: Math.min(...e.correctedValues) > e.threshold,
                threshold: e.threshold,
                override: settings.curveThresholdOverrides.get(key),
              },
            ];
          }),
        })),
    [
      thresholdGroups,
      dyeSpace,
      groupThresholds,
      plate,
      loadedFluors,
      cqTable,
      settings.thresholdOverrides,
      settings.curveThresholdOverrides,
    ],
  );

  const downloadCsv = () =>
    downloadText(
      analysisCsvFilename(zpcr.metadata.dataFile),
      analysisCsv(tableRows),
      "text/csv",
    );

  // ---- Melt mode ----------------------------------------------------------------------------

  /**
   * The melt in **dye space** — the same color separation the amplification view does, over the
   * melt step's reads. The separation itself is already in hand: `allFluorCurves` is the run
   * analysis for the selected step, and for a melt step that means each read solved against a
   * matrix built at *that read's* block temperature (`calibration.md` §2.1), which is what makes
   * a color-separated melt mean anything across a 30 °C ramp.
   *
   * Undefined when the step isn't a melt, or when the run has no usable calibration — in which
   * case the View toggle's channel mode is the only one with curves in it, exactly as for an
   * amplification step.
   */
  const meltFluor = useMemo(
    () =>
      melt && allFluorCurves.length > 0
        ? meltCurvesFromFluor(melt.segment, allFluorCurves, available)
        : undefined,
    [melt, allFluorCurves, available],
  );
  /** The melt analysis the chart, the table and the CSV all read — dye space when the View toggle
   * is on a dye mode and there is a separation to show, channel space otherwise. */
  const meltActive = calibrationOn && meltFluor ? meltFluor : melt;
  /** Whether that active analysis is the color-separated one. Distinct from `calibrationOn`,
   * which can be on for a run with nothing to separate. */
  const meltInDyeSpace = meltActive === meltFluor && meltFluor !== undefined;
  /** Whether the rail's series chips are dyes/targets rather than optical channels. Follows the
   * View toggle, except that a melt with nothing to separate keeps its channel chips — those are
   * what its curves are actually filtered by, and dead dye chips would filter nothing. */
  const dyeChips = calibrationOn && (!meltMode || meltInDyeSpace);

  /** The label a melt curve is drawn and toggled by — the target, the fluorophore or the
   * channel, following the same View toggle the amplification chart follows. */
  const meltLabel = (c: MeltCurve): string =>
    c.dye ? labelForFluorCurve(c.row, c.col, c.dye) : channelLabel(c.channel);

  /** The rail's filters over one melt curve, in whichever space it is in: the channel chips and
   * wells in channel space, the fluor/target chips and wells in dye space. Deliberately not
   * `fluorCurveVisible` — that also applies the Cq range, and a melt has no Cq at all, so a
   * range left over from an amplification step would silently empty the plot. */
  const meltCurveVisible = (c: MeltCurve): boolean => {
    if (!(settings.enabledWells.has(wellKey(c.row, c.col)) || isHoveredWell(c.row, c.col))) {
      return false;
    }
    if (!sampleVisible(c.row, c.col)) return false;
    if (c.dye === undefined) {
      return (
        c.channel !== undefined &&
        available.includes(c.channel) &&
        (settings.enabledChannels.has(c.channel) || isHoveredChannel(c.channel))
      );
    }
    const label = meltLabel(c);
    if (settings.disabledFluors.has(label) && !isHoveredTarget(label)) return false;
    // The same "Unloaded" switch the amplification view offers, for the same reason: a dye the
    // plate never put in this well still has a solved curve, and it is off by default.
    return (
      settings.showUnloadedFluors || (wellFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false)
    );
  };

  const visibleMelt: MeltPlotCurve[] = useMemo(
    () =>
      (meltActive?.curves ?? []).filter(meltCurveVisible).map((c) => ({
        key: `${c.row},${c.col}|${c.dye ?? c.channel}`,
        dyeLabel: meltLabel(c),
        curve: c,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      meltActive,
      available,
      settings.enabledChannels,
      settings.enabledWells,
      settings.disabledFluors,
      settings.showUnloadedFluors,
      settings.disabledSamples,
      fluorViewMode,
      wellFluors,
      wellFluorTargets,
      hasNoTargetGroup,
      wellSample,
      hoverHighlight,
    ],
  );

  const meltRows = useMemo(
    () =>
      meltActive
        ? buildMeltRows(meltActive, meltCurveVisible, {
            targetOf: (row, col, dye) =>
              groupByTarget ? labelForFluorCurve(row, col, dye) : undefined,
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      meltActive,
      available,
      settings.enabledChannels,
      settings.enabledWells,
      settings.disabledFluors,
      settings.showUnloadedFluors,
      settings.disabledSamples,
      fluorViewMode,
      wellFluors,
      wellFluorTargets,
      hasNoTargetGroup,
      wellSample,
    ],
  );

  const downloadMeltCsv = () =>
    downloadText(meltCsvFilename(zpcr.metadata.dataFile), meltCsv(meltRows), "text/csv");

  /** The rail's hover peek, in the shape the melt chart takes. Wells and channels in channel
   * space; a fluor/target chip resolves to the label its lines carry. */
  const meltHighlight: MeltHighlight | null =
    hoverHighlight?.kind === "wells"
      ? { kind: "wells", labels: hoverHighlight.labels }
      : hoverHighlight?.kind === "channel"
        ? { kind: "channel", channel: hoverHighlight.channel }
        : hoverHighlight?.kind === "target"
          ? { kind: "target", dyeLabel: hoverHighlight.dyeLabel }
          : null;

  /** `raw` empty clears the override, putting the group back on the auto threshold. Values are
   * rounded to whole RFU to match what the input displays and steps by. */
  const setThresholdOverride = (group: string, raw: string) => {
    const next = new Map(settings.thresholdOverrides);
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) next.delete(group);
    else next.set(group, Math.round(value));
    onChange({ thresholdOverrides: next });
  };

  /** The same, one curve at a time — `raw` empty drops back to the fluorophore's threshold. */
  const setCurveThresholdOverride = (key: string, raw: string) => {
    const next = new Map(settings.curveThresholdOverrides);
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) next.delete(key);
    else next.set(key, Math.round(value));
    onChange({ curveThresholdOverrides: next });
  };

  /**
   * Hovering a fluorophore's row in the Threshold section: isolate its curves and draw a dotted
   * line at its threshold — and nothing else. The per-curve baseline-region/σ overlay stays off
   * here; a dozen wells' worth of it at once was unreadable, and it's a curve at a time that the
   * region actually explains anything. `null` clears the hover.
   *
   * In channel mode there is no dye-space curve to isolate, and the threshold is a level on the
   * separated curve rather than on the raw channel one — so highlight the fluor's own channel
   * instead and draw no line.
   */
  const hoverThresholdGroup = (g: ThresholdGroupRow | null) => {
    if (!g) {
      setHoverHighlight(null);
      setHoverThreshold(null);
      return;
    }
    setHoverHighlight(
      calibrationOn
        ? { kind: "fluor", fluor: g.fluor }
        : g.channel != null
          ? { kind: "channel", channel: g.channel }
          : null,
    );
    setHoverThreshold(calibrationOn ? { fluor: g.fluor, regions: false } : null);
  };

  /** Hovering one curve's row: isolate that single curve, mark the threshold *it* is measured
   * against (its own override, when it has one), and add the baseline-region/σ overlay — the
   * diagnostic that explains where that curve's noise came from. */
  const hoverThresholdCurve = (g: ThresholdGroupRow, c: ThresholdCurveRow) => {
    setHoverHighlight(
      calibrationOn
        ? { kind: "curve", label: c.wellLabel, fluor: g.fluor }
        : { kind: "wells", labels: [c.wellLabel] },
    );
    setHoverThreshold(calibrationOn ? { fluor: g.fluor, curveKey: c.key, regions: true } : null);
  };

  /**
   * Dragging a Cq ring on the chart (see `CurveChart`'s `onCqDrag`) is the same edit as typing in
   * that curve's Threshold row, so it *opens that row* rather than editing invisibly: the rail's
   * Threshold section is forced open, the curve's fluorophore group expanded, the row scrolled into
   * view and marked — and the row's own field then tracks the drag, since it renders whatever
   * override is current. The chart shows the same edit from the other side: the hover state below
   * draws the dotted threshold line and the curve's baseline-region diagnostic for as long as the
   * drag lasts.
   */
  const thresholdDetailsRef = useRef<HTMLDetailsElement>(null);
  const [revealThresholdCurve, setRevealThresholdCurve] = useState<{
    fluor: string;
    key: string;
  } | null>(null);

  const beginCqDrag = (t: CqDragTarget) => {
    const key = curveKey(t.row, t.col, t.fluor);
    // Imperative rather than a controlled `open` prop: the section is a plain <details> the user
    // opens and closes themselves, and forcing it open is a one-off nudge, not ownership of its
    // state — closing it after the drag would throw away a deliberate open.
    if (thresholdDetailsRef.current) thresholdDetailsRef.current.open = true;
    setRevealThresholdCurve({ fluor: t.fluor, key });
    setHoverHighlight({ kind: "curve", label: t.wellLabel, fluor: t.fluor });
    setHoverThreshold({ fluor: t.fluor, curveKey: key, regions: true });
  };

  const dragCq = (t: CqDragTarget, threshold: number) =>
    setCurveThresholdOverride(curveKey(t.row, t.col, t.fluor), String(threshold));

  const endCqDrag = () => {
    setRevealThresholdCurve(null);
    setHoverHighlight(null);
    setHoverThreshold(null);
  };

  /** The RFU the hovered Threshold row currently stands at, read fresh out of `thresholdRows` so
   * an edit to that row's own input (or to the auto-threshold multiplier feeding it) moves the
   * chart's dotted line with it. `null` when nothing is hovered, or when the hovered row has no
   * threshold — a group whose curves all failed to produce one. */
  const hoverThresholdValue = useMemo(() => {
    if (!hoverThreshold) return null;
    const group = thresholdRows.find((g) => g.fluor === hoverThreshold.fluor);
    if (!group) return null;
    if (hoverThreshold.curveKey == null) return group.threshold ?? null;
    return group.curves.find((c) => c.key === hoverThreshold.curveKey)?.threshold ?? null;
  }, [hoverThreshold, thresholdRows]);

  const logBaselined = settings.scale === "log" && settings.curveView === "relative";

  return (
    <div className={"curves" + (railOpen ? " is-railopen" : "")}>
      <button
        type="button"
        className="curves__railtoggle"
        aria-expanded={railOpen}
        aria-controls="curves-rail"
        onClick={() => setRailOpen((open) => !open)}
      >
        ☰ Settings
      </button>
      {railOpen && (
        <div className="curves__scrim" onClick={() => setRailOpen(false)} />
      )}
      <aside className="curves__rail" id="curves-rail">
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
                  title={
                    stepMelt(s.step)
                      ? `Melt curve — ${s.readCount} reads from ${fmtTemp(stepMelt(s.step)!.startTempC)} to ${fmtTemp(stepMelt(s.step)!.endTempC)} °C`
                      : `Protocol STEP ${s.step}, ${s.readCount} cycles`
                  }
                >
                  {stepMelt(s.step) ? `Melt · ${s.readCount}` : `${i} · ${s.readCount}c`}
                </button>
              ))}
            </div>
          </div>
        )}

        {(plateEntry || meltMode) && (
          <div className="rail__section">
            {/* One View toggle for both kinds of step. A melt swaps what each mode *contains* —
                melt curves and melting temperatures rather than amplification curves and Cq — but
                the four modes mean the same four things, so there is one control rather than a
                second one that appears when the step changes.

                It shows for a melt even with no readable plate: a melt's channel curves and its
                Tm table need neither a plate nor a password (`melt.md` §1), and the committed melt
                run is exactly that case. For an amplification step there is nothing to choose
                until the plate opens, so the prompt below stands in its place. */}
            {(meltMode ||
              !(
                plateEntry?.pltd.container.encrypted &&
                (plateEntry.pltd.needsPassword || plateEntry.pltd.error)
              )) && (
              <div className="rail__row">
                {/* "Table" is a fourth option here rather than a tab of its own: it shows the
                    same run, grouped by target like "Target" mode, as a Cq/ΔRFU table instead of
                    a chart — a melt's melting temperatures instead of a melt chart — with the
                    whole rail (wells, targets, samples, background, thresholds) still driving
                    it. */}
                <Toggle
                  label="View"
                  options={[
                    ["channel", "Channel"],
                    ["fluorophore", "Fluorophore"],
                    ["target", "Target"],
                    ["table", "Table"],
                  ]}
                  value={calibrationOn ? fluorViewMode : "channel"}
                  onChange={(v) =>
                    v === "channel"
                      ? onChange({ calibration: false })
                      : onChange({ calibration: true, fluorViewMode: v as FluorViewMode })
                  }
                />
              </div>
            )}
            {plateEntry?.pltd.container.encrypted &&
            (plateEntry.pltd.needsPassword || plateEntry.pltd.error) ? (
              <PasswordPrompt
                wrong={!!plateEntry.pltd.error}
                onSubmit={setPltdPassword}
              />
            ) : plateEntry?.pltd.error ? (
              <div className="rail__note mono">{plateEntry.pltd.error}</div>
            ) : (
              <>
                {/* Where a "Normalization" toggle used to sit. It was a no-op by construction:
                    calibration.md §5.1 divides the column scaling back out, so every mode
                    reports identical RFU unless the matrix is rank-deficient. The setting still
                    exists (see FileSettings) — it just isn't a user-facing choice. */}
                {calibrationOn && !dyeSpace && !calibrationAvailable && (
                  <div className="rail__note mono">
                    No .Dcal calibration matches this plate's fluorophores for {vessels}. Check
                    the Calibration files under Raw files.
                  </div>
                )}
                {calibrationOn &&
                  !dyeSpace &&
                  calibrationAvailable &&
                  fluorCals.some((f) => !f.curve) && (
                    <div className="rail__note mono">
                      No {vessels} calibration for:{" "}
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

        {/* Wells sits directly under View: it's the selection the eye reaches for first, and the
            plate grid doubles as a map of which wells came out positive. */}
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
            rows={plateRows}
            cols={plate?.columns ?? 12}
            enabled={settings.enabledWells}
            onChange={(next) => onChange({ enabledWells: next })}
            wellTypes={wellTypes}
            positiveWells={positiveWells}
            onHoverWells={(labels) => setHoverHighlight(labels ? { kind: "wells", labels } : null)}
            onSoloWells={soloWells}
            cardData={cardForWell}
          />
        </div>

        <div className="rail__section">
          <div className="rail__title">
            {!dyeChips
              ? "Channels"
              : groupByTarget && usingTargets
                ? "Targets"
                : "Fluorophores"}
            <button
              className="rail__link rail__icon-btn"
              onClick={!dyeChips ? resetChannels : resetFluors}
              title={
                !dyeChips
                  ? "Reset to the channels present in the plate configuration"
                  : "Re-enable all"
              }
            >
              <ResetIcon />
            </button>
          </div>
          {dyeChips ? (
            <>
              <FluorBar
                items={visibleChipItems}
                disabled={settings.disabledFluors}
                onToggle={toggleFluor}
                onHover={(key) => setHoverHighlight(key ? { kind: "target", dyeLabel: key } : null)}
                onSolo={soloFluor}
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
              onSolo={soloChannel}
              cardData={cardForChannel}
            />
          )}
        </div>

        {visibleSampleList.length > 0 && (
          <details className="rail__section rail__details">
            <summary className="rail__title">
              <span>
                <span className="rail__chevron" aria-hidden="true">
                  ▸
                </span>
                Samples
              </span>
              {/* The same reset glyph as Channels/Targets and Wells — one button meaning "back to
                  the default" throughout the rail, rather than a label that changes under the
                  cursor. */}
              <button
                className="rail__link rail__icon-btn"
                title="Re-enable all samples"
                aria-label="Re-enable all samples"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({ disabledSamples: new Set<string>() });
                }}
              >
                <ResetIcon />
              </button>
            </summary>
            <SampleBar
              items={visibleSampleList}
              disabled={settings.disabledSamples}
              onToggle={toggleSample}
              onHover={(sample) => setHoverHighlight(sample ? { kind: "sample", sample } : null)}
              onSolo={soloSample}
              cardData={cardForSample}
            />
          </details>
        )}

        {!meltMode && allTemps.length > 0 && (
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
                      settings.temps.size > 0
                        ? new Set<string>()
                        : new Set(
                            allTemps.filter((t) => t.kind === "measured").map((t) => t.key),
                          ),
                  });
                }}
              >
                {settings.temps.size > 0 ? "none" : "all"}
              </button>
            </summary>
            <AuxBar
              curves={tempAxis.curves}
              unit={tempAxis.unit}
              decimals={tempAxis.decimals}
              enabled={settings.temps}
              onToggle={toggleTemp}
            />
          </details>
        )}

        {!meltMode && allLeds.length > 0 && (
          <details className="rail__section rail__details">
            <summary className="rail__title">
              <span>
                <span className="rail__chevron" aria-hidden="true">
                  ▸
                </span>
                LED current (right axis)
              </span>
              <button
                className="rail__link"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({
                    leds:
                      settings.leds.size > 0
                        ? new Set<string>()
                        : new Set(allLeds.map((l) => l.key)),
                  });
                }}
              >
                {settings.leds.size > 0 ? "none" : "all"}
              </button>
            </summary>
            <AuxBar
              curves={ledAxisAll.curves}
              unit={ledAxisAll.unit}
              decimals={ledAxisAll.decimals}
              enabled={settings.leds}
              onToggle={toggleLed}
            />
          </details>
        )}

        {meltMode && !tableMode && (
          <div className="rail__section rail__row">
            {/* Same slot, same label as the amplification "Values" toggle below — what the y axis
                reads, and nothing about which curves are shown (that is View, above). The
                derivative is the default: it is the form a melting product is a peak on, and the
                melting temperature is that peak's position. */}
            <Toggle
              label="Values"
              options={[
                ["derivative", "−dF/dT"],
                ["raw", "Raw"],
              ]}
              value={settings.meltView}
              onChange={(v) => onChange({ meltView: v as MeltView })}
            />
          </div>
        )}

        {/* Chart-only controls — nothing they change is visible in table mode. */}
        {!meltMode && !tableMode && (
          <>
            <div className="rail__section rail__row">
              {/* "Values", not "View": the mode toggle above is already labelled View, and these
                  two answer different questions — which curves, vs. what the y-axis reads. */}
              <Toggle
                label="Values"
                options={[
                  ["relative", "Relative"],
                  ["absolute", "Absolute"],
                ]}
                value={settings.curveView}
                onChange={(v) => onChange({ curveView: v as CurveView })}
              />
            </div>

            <div className="rail__section rail__row">
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
            </div>

            {/* Channel-space overlays, each on its own row like "Draw baseline" above rather than
                trailing the Scale toggle — they are switches, not modes, and a switch beside a
                segmented control wraps unevenly at rail width. */}
            {!calibrationOn && (
              <>
                <div className="rail__section rail__row">
                  <Switch
                    label="Show dark"
                    checked={settings.showDark}
                    onChange={(v) => onChange({ showDark: v })}
                    title="Overlay each channel's LED-off dark background as a dotted line"
                  />
                </div>
                <div className="rail__section rail__row">
                  <Switch
                    label="Min/max band"
                    checked={settings.bands}
                    onChange={(v) => onChange({ bands: v })}
                    title="Shade each curve's per-cycle min/max envelope"
                  />
                </div>
              </>
            )}
          </>
        )}

        {/* Filter by Cq — dye space only, for the same reason the Cq table itself is dye-space
            only (see `channelAnalysis`): a raw channel curve has no Cq to filter on. Grouped with
            "Subtract dark" below rather than with the chart-only display controls because, like
            it, it applies in table mode too — it's a selection filter, the same kind as the wells
            and chips above, and it feeds the table and the CSV export exactly as they do. */}
        {!meltMode && calibrationOn && cycleCount > 0 && (
          <div className="rail__section">
            <CqRange
              cycleCount={cycleCount}
              cqMin={settings.cqMin}
              cqMax={settings.cqMax}
              onChange={onChange}
            />
          </div>
        )}

        {/* Only a source that carries its own analysis (currently Biomeme — `Zpcr.dyeSpace`,
            `WellCurve.fileAnalysis`) has anything for these to switch between; a `.zpcr`/`.pcrd`
            run never shows them. Two independent toggles, not one: a user may want the instrument's
            own Cq call while still inspecting this app's baseline fit, or the reverse — see
            `runAnalysis.ts`'s `blendWithFileAnalysis`. Shown in every view mode, like Threshold
            below, since both act on the one Cq table every view reads. */}
        {!meltMode && hasFileAnalysis && (
          <div className="rail__section">
            <div className="rail__row">
              <Toggle
                label="Baseline"
                options={[
                  ["file", "File"],
                  ["computed", "Computed"],
                ]}
                value={settings.baselineSource}
                onChange={(v) => onChange({ baselineSource: v as AnalysisSource })}
              />
            </div>
            <div className="rail__row" style={{ marginTop: 8 }}>
              <Toggle
                label="Cq"
                options={[
                  ["file", "File"],
                  ["computed", "Computed"],
                ]}
                value={settings.cqSource}
                onChange={(v) => onChange({ cqSource: v as AnalysisSource })}
              />
            </div>
          </div>
        )}

        {/* Cq is always threshold.md §6's threshold crossing (there is no algorithm selector any
            more), so a per-group threshold is always meaningful. An override applies to the whole
            run's Cq table — chart markers, hover cards and table alike.

            Shown in **every** view mode, channel space included. Thresholds are always
            target-based (or fluorophore-based on a plate with no targets — see `usingTargets`);
            channel mode doesn't get thresholds of its own, it gets the same target thresholds,
            because that's what the run's one Cq table is keyed on. It used to be hidden there,
            which made the multiplier below silently move the channel chart's Cq markers with no
            visible cause. */}
        {!meltMode && calibrationAvailable && (
          <details className="rail__section rail__details" ref={thresholdDetailsRef}>
            <summary className="rail__title">
              <span>
                <span className="rail__chevron" aria-hidden="true">
                  ▸
                </span>
                Threshold
              </span>
            </summary>
            <ThresholdSection
              groups={thresholdRows}
              revealCurve={revealThresholdCurve}
              multiplier={settings.thresholdMultiplier}
              onMultiplierChange={(v) => onChange({ thresholdMultiplier: v })}
              onGroupOverride={setThresholdOverride}
              onCurveOverride={setCurveThresholdOverride}
              onHoverGroup={hoverThresholdGroup}
              onHoverCurve={hoverThresholdCurve}
            />
          </details>
        )}

        {/* Always present — the export is the same target-based Cq/ΔRFU table in every view mode,
            so there's no mode you have to switch to first. Disabled, not hidden, when the run has
            no rows to export (no usable calibration, or the rail filtered everything out). */}
        <div className="rail__section">
          {meltMode ? (
            <button
              className="raw__download analysis__download"
              onClick={downloadMeltCsv}
              disabled={meltRows.length === 0}
              aria-label="Download the melting-temperature table as CSV"
              title="Download the melting-temperature table as CSV"
            >
              <DownloadIcon /> CSV
            </button>
          ) : (
            <button
              className="raw__download analysis__download"
              onClick={downloadCsv}
              disabled={tableRows.length === 0}
              aria-label="Download the Cq/ΔRFU table as CSV"
              title="Download the Cq/ΔRFU table as CSV"
            >
              <DownloadIcon /> CSV
            </button>
          )}
        </div>

        <div className="rail__stat mono">
          {meltMode ? (
            <>
              {tableMode
                ? `${meltRows.length} rows`
                : `${visibleMelt.length} / ${(meltActive ?? melt).curves.length} curves`}
              {" · "}
              {meltRows.filter((r) => r.tmC != null).length} with a Tm
            </>
          ) : tableMode ? (
            <>{tableRows.length} rows</>
          ) : (
            <>
              {plotCurves.length} / {calibrationOn ? allFluorCurves.length : allCurves.length}{" "}
              curves
              {!calibrationOn && settings.showDark && " + dark"}
              {settings.temps.size > 0 && ` + ${rightAxis.curves.length} temp`}
              {settings.leds.size > 0 && ` + ${rightAxis.curves.length} LED`}
            </>
          )}
        </div>
        {!meltMode && !tableMode && logBaselined && (
          <div className="rail__note mono">
            Log + baseline: all curves shifted alike so the plot's minimum reads 1.
          </div>
        )}
      </aside>

      {meltMode ? (
        tableMode ? (
          <section className="analysis__table-wrap">
            <MeltTable
              rows={meltRows}
              seriesLabel={
                !meltInDyeSpace ? "Channel" : groupByTarget && usingTargets ? "Target" : "Fluorophore"
              }
              onPickWell={pickWell}
            />
          </section>
        ) : (
          <section className="curves__plot curves__plot--melt">
            <MeltChart
              curves={visibleMelt}
              temperaturesC={melt.segment.temperaturesC}
              view={settings.meltView}
              highlight={meltHighlight}
            />
          </section>
        )
      ) : tableMode ? (
        <section className="analysis__table-wrap">
          <CurveTable
            rows={tableRows}
            usingTargets={usingTargets}
            cycleCount={cycleCount}
            onPickWell={pickWell}
            onPickTarget={pickTarget}
            onPickSample={pickSample}
            onPickCurve={pickCurve}
          />
        </section>
      ) : (
        <section className="curves__plot">
          <CurveChart
            curves={plotCurves}
            darkCurves={!calibrationOn && settings.showDark ? enabledDark : []}
            aux={rightAxis}
            baseline="raw"
            curveView={settings.curveView}
            drawBaseline={settings.drawBaseline}
            scale={settings.scale}
            bands={!calibrationOn && settings.bands}
            highlight={hoverHighlight}
            thresholdLine={
              settings.curveView === "relative" ? hoverThresholdValue : null
            }
            thresholdRegions={settings.curveView === "relative" && !!hoverThreshold?.regions}
            onCqDragStart={beginCqDrag}
            // Channel space has no per-curve threshold to set — and no Cq rings either (see
            // `channelAnalysis`) — so the handles are simply absent there.
            onCqDrag={calibrationOn ? dragCq : undefined}
            onCqDragEnd={endCqDrag}
          />
        </section>
      )}
    </div>
  );
}
