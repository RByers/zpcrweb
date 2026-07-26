import { useEffect, useMemo, useRef, useState } from "react";
import type { Zpcr, TemperatureCurve } from "@zpcrweb/core";
import { formatBaselineFormula } from "../../lib/cq";
import { computeWellTypes } from "../../lib/wellTypes";
import { NO_TARGET } from "../../lib/plateTargets";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import {
  DEFAULT_THRESHOLD_MULTIPLIER,
  wellKey,
  type BandsMode,
  type CurveView,
  type FileSettings,
  type FluorViewMode,
  type Scale,
} from "../../state/useZpcrStore";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelColor, channelLabel } from "../../lib/channelColors";
import { channelCurveKey, curveKey, useRunAnalysis } from "../../lib/runAnalysis";
import {
  analysisCsv,
  analysisCsvFilename,
  buildAnalysisRows,
} from "../../lib/analysisRows";
import { downloadText } from "../../lib/download";
import { ChannelBar } from "../curves/ChannelBar";
import { FluorBar, type FluorChip } from "../curves/FluorBar";
import { SampleBar } from "../curves/SampleBar";
import type { HoverCardData, HoverCardRow } from "../curves/HoverCard";
import { WellMatrix } from "../curves/WellMatrix";
import { CurveChart } from "../curves/CurveChart";
import { CurveTable } from "../curves/CurveTable";
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
  const run = useRunAnalysis(zpcr, settings, pltdPassword, activeStep, settings.calibration !== false);
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
    allFluorCurves,
    cqTable,
    channelCqTable,
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

  // Dark lines/subtraction only concern the enabled, available channels.
  const enabledDark = useMemo(
    () =>
      darkCurves.filter(
        (d) => available.includes(d.channel) && settings.enabledChannels.has(d.channel),
      ),
    [darkCurves, available, settings.enabledChannels],
  );

  // ---- Plate-derived selection state -----------------------------------------------------
  // The dye-space curves themselves come from `useRunAnalysis` above (see calibration.md); what's
  // left here is the per-view selection/labelling state built on top of the plate.

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

  /** The rail's filters, as one predicate over a well/fluor pair — shared by the plotted dye-space
   * curves and by table mode's rows, so the two always show the same set. The "is this pair
   * actually loaded" check is deliberately *not* here: it's a data-validity gate the chart can
   * bypass ("Unloaded") and the table never applies (it only lists loaded wells). */
  const fluorCurveVisible = (row: number, col: number, dye: string): boolean =>
    settings.enabledWells.has(wellKey(row, col)) &&
    !settings.disabledFluors.has(labelForFluorCurve(row, col, dye)) &&
    sampleVisible(row, col);

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

  // Cq and the fitted baseline for one plotted curve — *looked up*, never recomputed. The run's
  // table (`runAnalysis.ts`) already holds exactly one value per well/fluor pair, computed over the
  // whole plate; deriving it again from whatever subset happens to be plotted is precisely what
  // used to make the chart's markers, the hover cards and the Analysis table disagree.
  const dyeCq = (row: number, col: number, dye: string) => {
    const e = cqTable.get(curveKey(row, col, dye));
    return { cq: e?.cq ?? null, baselineFormula: e ? formatBaselineFormula(e.baselineFit) : null };
  };
  // Channel space has no target to be consistent *with*: a raw channel curve mixes every dye
  // emitting into that filter, so it carries its own Cq from its own table. See `channelCqTable`.
  const channelCq = (row: number, col: number, channel: number) => {
    const e = channelCqTable.get(channelCurveKey(row, col, channel));
    return { cq: e?.cq ?? null, baselineFormula: e ? formatBaselineFormula(e.baselineFit) : null };
  };

  const plotCurves: PlotCurve[] = useMemo(
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
            ...dyeCq(c.row, c.col, c.dye),
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
            ...channelCq(c.row, c.col, c.channel),
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
      channelCqTable,
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
              ...dyeCq(c.row, c.col, c.dye),
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
              ...channelCq(c.row, c.col, c.channel),
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
      channelCqTable,
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

  // ---- Table mode / CSV export -------------------------------------------------------------
  // One row per visible (target, well) pair, filtered by exactly the same rail state as the chart
  // and reading the same Cq table (see `lib/analysisRows.ts`). Built whenever dye space is on, not
  // only in table mode, so the CSV button works without first switching to the table.
  const tableRows = useMemo(
    () => (calibrationOn ? buildAnalysisRows(run, fluorCurveVisible) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      calibrationOn,
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

        <div className="rail__section">
          <div className="rail__title">
            {!calibrationOn
              ? "Channels"
              : groupByTarget && usingTargets
                ? "Targets"
                : "Fluorophores"}
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

        {/* Chart-only controls — nothing they change is visible in table mode. */}
        {!tableMode && (
          <>
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
          </>
        )}

        {/* §4.2's optional dark-current stage. Only meaningful in dye space: with color separation
            off the raw channel curves are shown as read. Deliberately outside the !tableMode
            wrapper above, unlike the display controls it sits under: this one feeds the color
            separation, so it moves the RFU the table and the CSV export report too. */}
        {calibrationOn && (
          <div className="rail__section rail__row">
            <Toggle
              label="Subtract dark"
              options={[
                ["off", "Off"],
                ["on", "On"],
              ]}
              value={settings.subtractDark ? "on" : "off"}
              onChange={(v) => onChange({ subtractDark: v === "on" })}
            />
          </div>
        )}

        {/* Cq is always threshold.md §6.1's threshold crossing (there is no algorithm selector any
            more), so a per-group threshold is always meaningful. An override applies to the whole
            run's Cq table — chart markers, hover cards and table alike. Blank means auto, shown as
            the input's placeholder. */}
        {calibrationOn && calibrationAvailable && (
          <details className="rail__section rail__details">
            <summary className="rail__title">
              <span>
                <span className="rail__chevron" aria-hidden="true">
                  ▸
                </span>
                Threshold
              </span>
            </summary>
            {/* §5.1's `k` in `threshold = k × median baseline noise`. Adjustable because the
                calibrated default rests on two anchors from a single run (see
                `AutoThresholdOptions.multiplier`), and because it is the one number that moves
                every Cq on the plate — the per-group thresholds below update live as it moves, so
                its effect is visible rather than inferred. Overridden groups ignore it. */}
            <div className="threshold-k">
              <div className="threshold-k__head">
                <span>Auto threshold</span>
                <span className="threshold-k__value mono">
                  {settings.thresholdMultiplier}× noise
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={settings.thresholdMultiplier}
                aria-label="Auto-threshold multiplier, in multiples of median baseline noise"
                onChange={(e) =>
                  onChange({ thresholdMultiplier: Number(e.currentTarget.value) })
                }
              />
              <div className="threshold-k__foot">
                <span className="threshold-k__hint mono">
                  Default {DEFAULT_THRESHOLD_MULTIPLIER}×
                </span>
                <button
                  type="button"
                  className="rail__link"
                  disabled={settings.thresholdMultiplier === DEFAULT_THRESHOLD_MULTIPLIER}
                  onClick={() =>
                    onChange({ thresholdMultiplier: DEFAULT_THRESHOLD_MULTIPLIER })
                  }
                >
                  Reset
                </button>
              </div>
            </div>
            <div className="analysis__thresholds">
              {groupInfos
                .filter((g) => !settings.disabledFluors.has(g.target) && g.curve)
                .map((g) => {
                  const auto = tableRows.find((r) => r.target === g.target)?.threshold;
                  const override = settings.thresholdOverrides.get(g.target);
                  const isAuto = override === undefined;
                  // The field always carries a value — the live auto threshold when there's no
                  // override — rather than sitting empty behind a placeholder. An empty number
                  // input steps from 0, so one press of the down arrow used to jump the threshold
                  // from (say) 210 to nothing-or-zero; seeded this way the arrows nudge from where
                  // the threshold actually is. Whole RFU only: a threshold is a level on a curve
                  // running to thousands, and sub-unit steps are below anything the reading means.
                  const shown = isAuto ? (auto != null ? Math.round(auto) : "") : override;
                  return (
                    <div key={g.target} className="analysis__threshold-row mono">
                      <span>{g.target}</span>
                      <input
                        type="number"
                        step={1}
                        value={shown}
                        className={isAuto ? "is-auto" : ""}
                        aria-label={`${g.target} threshold in RFU`}
                        onChange={(e) => setThresholdOverride(g.target, e.currentTarget.value)}
                      />
                      <button
                        type="button"
                        className="rail__link"
                        disabled={isAuto}
                        title={`Return ${g.target} to its automatic threshold`}
                        onClick={() => setThresholdOverride(g.target, "")}
                      >
                        auto
                      </button>
                    </div>
                  );
                })}
            </div>
          </details>
        )}

        {calibrationOn && calibrationAvailable && (
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
        )}

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
            Log + baseline: each curve shifted so its own minimum reads 1.
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
            bands={calibrationOn ? "off" : settings.bands}
            highlight={hoverHighlight}
          />
        </section>
      )}
    </div>
  );
}
