import { useEffect, useMemo, useRef, useState } from "react";
import { wellLabel, type Zpcr, type TemperatureCurve } from "@zpcrweb/core";
import { computeWellTypes } from "../../lib/wellTypes";
import { NO_TARGET } from "../../lib/plateTargets";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import {
  wellKey,
  type CurveView,
  type FileSettings,
  type FluorViewMode,
  type Scale,
} from "../../state/useZpcrStore";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelColor, channelLabel } from "../../lib/channelColors";
import {
  channelCurveKey,
  curveKey,
  darkCurveKey,
  useRunAnalysis,
} from "../../lib/runAnalysis";
import {
  analysisCsv,
  analysisCsvFilename,
  buildAnalysisRows,
} from "../../lib/analysisRows";
import { downloadText } from "../../lib/download";
import { ChannelBar } from "../curves/ChannelBar";
import { FluorBar, type FluorChip } from "../curves/FluorBar";
import { SampleBar } from "../curves/SampleBar";
import { useHoverCard, type HoverCardData, type HoverCardRow } from "../curves/HoverCard";
import { WellMatrix } from "../curves/WellMatrix";
import { CurveChart } from "../curves/CurveChart";
import { CurveTable } from "../curves/CurveTable";
import {
  ThresholdSection,
  type ThresholdCurveRow,
  type ThresholdGroupRow,
} from "../curves/ThresholdSection";
import { TempBar } from "../curves/TempBar";
import { PasswordPrompt } from "../PasswordPrompt";
import { Toggle } from "../Toggle";
import { Switch } from "../Switch";
import { ResetIcon } from "../ResetIcon";
import { DownloadIcon } from "../DownloadIcon";
import type { HighlightMatch, PlotCurve } from "../../lib/uplot/chart";

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
    tube,
    fluorCals,
    calibrationAvailable,
    wellFluorTargets,
    wellFluors,
    wellSample,
    targetInfos,
    usingTargets,
    groupInfos,
    thresholdGroups,
    loadedFluors,
    allFluorCurves,
    cqTable,
    plainBaselines,
  } = run;

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
  const isHoveredWell = (row: number, col: number) =>
    hoverHighlight?.kind === "well" && hoverHighlight.label === wellLabel(row, col);
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
            channel: g.channel,
            calibrated: !!g.curve,
          }))
        : fluorCals.map((f) => ({
            key: f.fluor,
            label: f.fluor,
            sublabel: channelLabel(f.channel),
            channel: f.channel,
            calibrated: !!f.curve,
          })),
    [groupByTarget, groupInfos, usingTargets, fluorCals],
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
      sampleVisible(row, col)
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
        cq: c.analysis?.cq,
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

  // Double-clicking any legend item isolates it within its own dimension — every other
  // channel/target/well/sample turns off, leaving only the one that was double-clicked.
  const soloChannel = (ch: number) => onChange({ enabledChannels: new Set([ch]) });

  const soloFluor = (key: string) => {
    const next = new Set(chipItems.map((c) => c.key));
    next.delete(key);
    onChange({ disabledFluors: next });
  };

  const soloWell = (row: number, col: number) => onChange({ enabledWells: new Set([wellKey(row, col)]) });

  const soloSample = (name: string) => {
    const next = new Set(sampleList);
    next.delete(name);
    onChange({ disabledSamples: next });
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
      fluorViewMode,
      wellFluorTargets,
      hasNoTargetGroup,
      wellSample,
    ],
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
        .filter((g) => g.curve)
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
                baselineValid: e.baselineValid,
                threshold: e.threshold,
                override: settings.curveThresholdOverrides.get(key),
              },
            ];
          }),
        })),
    [
      thresholdGroups,
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
        : { kind: "well", label: c.wellLabel },
    );
    setHoverThreshold(calibrationOn ? { fluor: g.fluor, curveKey: c.key, regions: true } : null);
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
            {plateEntry.pltd.container.encrypted &&
            (plateEntry.pltd.needsPassword || plateEntry.pltd.error) ? (
              <PasswordPrompt
                wrong={!!plateEntry.pltd.error}
                onSubmit={setPltdPassword}
              />
            ) : plateEntry.pltd.error ? (
              <div className="rail__note mono">{plateEntry.pltd.error}</div>
            ) : (
              <>
                <div className="rail__row">
                  {/* "Table" is a fourth option here rather than a tab of its own: it shows the
                      same run, grouped by target like "Target" mode, as a Cq/ΔRFU table instead of
                      a chart — with the whole rail (wells, targets, samples, background,
                      thresholds) still driving it. */}
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
            enabled={settings.enabledWells}
            onChange={(next) => onChange({ enabledWells: next })}
            wellTypes={wellTypes}
            positiveWells={positiveWells}
            onHoverWell={(label) => setHoverHighlight(label ? { kind: "well", label } : null)}
            onSoloWell={soloWell}
            cardData={cardForWell}
          />
        </div>

        <div className="rail__section">
          <div className="rail__title">
            {!calibrationOn
              ? "Channels"
              : groupByTarget && usingTargets
                ? "Targets"
                : "Fluorophores"}
            <button
              className="rail__link rail__icon-btn"
              onClick={!calibrationOn ? resetChannels : resetFluors}
              title={
                !calibrationOn
                  ? "Reset to the channels present in the plate configuration"
                  : "Re-enable all"
              }
            >
              <ResetIcon />
            </button>
          </div>
          {calibrationOn ? (
            <>
              <FluorBar
                items={chipItems}
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

        {sampleList.length > 0 && (
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
              items={sampleList}
              disabled={settings.disabledSamples}
              onToggle={toggleSample}
              onHover={(sample) => setHoverHighlight(sample ? { kind: "sample", sample } : null)}
              onSolo={soloSample}
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

        {/* Chart-only controls — nothing they change is visible in table mode. */}
        {!tableMode && (
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

        {/* §4.2's optional dark-current stage. Only meaningful in dye space: with color separation
            off the raw channel curves are shown as read. Deliberately outside the !tableMode
            wrapper above, unlike the display controls it sits under: this one feeds the color
            separation, so it moves the RFU the table and the CSV export report too. */}
        {calibrationOn && (
          <div className="rail__section rail__row">
            <Switch
              label="Subtract dark"
              checked={settings.subtractDark}
              onChange={(v) => onChange({ subtractDark: v })}
              title="Subtract each plate read's LED-off dark current before color separation"
            />
          </div>
        )}

        {/* Cq is always threshold.md §6.1's threshold crossing (there is no algorithm selector any
            more), so a per-group threshold is always meaningful. An override applies to the whole
            run's Cq table — chart markers, hover cards and table alike.

            Shown in **every** view mode, channel space included. Thresholds are always
            target-based (or fluorophore-based on a plate with no targets — see `usingTargets`);
            channel mode doesn't get thresholds of its own, it gets the same target thresholds,
            because that's what the run's one Cq table is keyed on. It used to be hidden there,
            which made the multiplier below silently move the channel chart's Cq markers with no
            visible cause. */}
        {calibrationAvailable && (
          <details className="rail__section rail__details">
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
          <button
            className="raw__download analysis__download"
            onClick={downloadCsv}
            disabled={tableRows.length === 0}
            aria-label="Download the Cq/ΔRFU table as CSV"
            title="Download the Cq/ΔRFU table as CSV"
          >
            <DownloadIcon /> CSV
          </button>
        </div>

        <div className="rail__stat mono">
          {tableMode ? (
            <>{tableRows.length} rows</>
          ) : (
            <>
              {plotCurves.length} / {calibrationOn ? allFluorCurves.length : allCurves.length}{" "}
              curves
              {!calibrationOn && settings.showDark && " + dark"}
              {visibleTemps.length > 0 && ` + ${visibleTemps.length} temp`}
            </>
          )}
        </div>
        {!tableMode && logBaselined && (
          <div className="rail__note mono">
            Log + baseline: all curves shifted alike so the plot's minimum reads 1.
          </div>
        )}
      </aside>

      {tableMode ? (
        <section className="analysis__table-wrap">
          <CurveTable rows={tableRows} usingTargets={usingTargets} />
        </section>
      ) : (
        <section className="curves__plot">
          <CurveChart
            curves={plotCurves}
            darkCurves={!calibrationOn && settings.showDark ? enabledDark : []}
            tempCurves={visibleTemps}
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
          />
        </section>
      )}
    </div>
  );
}
