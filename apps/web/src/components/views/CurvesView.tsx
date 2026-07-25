import { useEffect, useMemo, useRef } from "react";
import {
  buildCalibrationMatrix,
  REFERENCE_ROW,
  type Zpcr,
  type WellCurve,
  type DarkCurve,
  type TemperatureCurve,
  type NormalizationMode,
} from "@zpcrweb/core";
import {
  wellKey,
  type BandsMode,
  type CurveBaselineMode,
  type FileSettings,
  type Scale,
} from "../../state/useZpcrStore";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelLabel } from "../../lib/channelColors";
import {
  computeFluorCurves,
  matchFluorCalibrations,
  resolveTubeType,
  type FluorCorrections,
} from "../../lib/fluorCurves";
import { ChannelBar } from "../curves/ChannelBar";
import { FluorBar } from "../curves/FluorBar";
import { WellMatrix } from "../curves/WellMatrix";
import { CurveChart } from "../curves/CurveChart";
import { TempBar } from "../curves/TempBar";
import { BaselineRangeSlider } from "../curves/BaselineRangeSlider";
import { PasswordPrompt } from "../PasswordPrompt";
import { Toggle } from "../Toggle";
import { ResetIcon } from "../ResetIcon";
import type { PlotCurve } from "../../lib/uplot/chart";

/** Fallback baseline-region preview shown while auto-detecting, mirroring `chart.ts`'s
 * `fallbackRegion` (threshold.md §3.1/§8's default cycles 2–9), clamped to the run. */
function defaultRangePreview(maxCycle: number): [number, number] {
  return [Math.min(2, maxCycle), Math.min(9, maxCycle)];
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

  // ---- Channel-space (raw) curves --------------------------------------------------------

  const visibleChannel = useMemo(
    () =>
      allCurves.filter(
        (c) =>
          available.includes(c.channel) &&
          settings.enabledChannels.has(c.channel) &&
          settings.enabledWells.has(wellKey(c.row, c.col)),
      ),
    [allCurves, available, settings.enabledChannels, settings.enabledWells],
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

  // Per-well sample type (from the plate definition), for coloring the well-selection grid to
  // match the Plates view, and for defaulting well selection to non-empty wells.
  const wellTypes = useMemo(() => {
    if (!plate) return undefined;
    const m = new Map<string, (typeof plate.wells)[number]["sampleType"]>();
    for (const w of plate.wells) m.set(wellKey(w.row, w.col), w.sampleType);
    return m;
  }, [plate]);

  const fullWellSet = useMemo(() => {
    const s = new Set<string>();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 12; c++) s.add(wellKey(r, c));
    return s;
  }, []);

  // The set of wells a plate definition marks as non-empty — the default selection for a newly
  // opened file, and what the "reset" button next to Wells restores.
  const nonEmptyWellSet = useMemo(() => {
    if (!plate) return null;
    const s = new Set<string>();
    for (const w of plate.wells) if (w.sampleType !== "empty") s.add(wellKey(w.row, w.col));
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

  // The §4 corrections applied to every raw reading before the solve. Both levels are read
  // per scan, so these are `[channelIndex][cycle]` tables aligned with `available`.
  const corrections = useMemo<FluorCorrections>(() => {
    const reads = zpcr.reads.filter((r) => r.step === activeStep);
    // §4.1: one position of the reference row — the first — per channel, LED on.
    const referenceLevel = available.map((ch) =>
      reads.map((r) => r.get(ch, REFERENCE_ROW, 0).mean),
    );
    // §4.2: the per-channel LED-off background, from the same reads' DARKDATA.
    const darkByChannel = new Map(darkCurves.map((d) => [d.channel, d]));
    const darkLevel = available.map((ch) => darkByChannel.get(ch)?.mean ?? []);
    // §4.1: per-well gain factors, only ever present in a `.pcrd` (a `.zpcr` stores none), and
    // only when that run actually saved a set — otherwise the gain correction stays inactive
    // and the reference level correctly has no effect of its own.
    const factors = zpcr.wellFactors;
    return {
      referenceLevel,
      darkLevel,
      wellFactor: factors
        ? (row, col) => {
            const perChannel = factors.get(row, col);
            return perChannel && available.map((ch) => perChannel[ch] ?? 1);
          }
        : undefined,
    };
  }, [zpcr, activeStep, available, darkCurves]);

  // The separation solve is real work (one pseudo-inverse per well per cycle) — skip it
  // entirely while the feature is off rather than computing curves nobody will see.
  const allFluorCurves = useMemo(() => {
    if (!matrix || !calibrationOn) return [];
    const dyeChannels = calibratedFluors.map((f) => f.channel);
    return computeFluorCurves(allCurves, matrix, available, dyeChannels, corrections);
  }, [matrix, calibrationOn, allCurves, available, calibratedFluors, corrections]);

  const visibleFluor = useMemo(
    () =>
      allFluorCurves.filter(
        (c) =>
          settings.enabledWells.has(wellKey(c.row, c.col)) &&
          !settings.disabledFluors.has(c.dye),
      ),
    [allFluorCurves, settings.enabledWells, settings.disabledFluors],
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

  const plotCurves: PlotCurve[] = calibrationOn
    ? visibleFluor.map((c) => ({
        channel: c.channel,
        dyeLabel: c.dye,
        row: c.row,
        col: c.col,
        wellLabel: c.wellLabel,
        isReference: c.isReference,
        cycles: c.cycles,
        mean: c.mean,
        std: c.cycles.map(() => 0),
        min: c.mean,
        max: c.mean,
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
      }));

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

  const logBaselined = settings.scale === "log" && settings.curveBaseline !== "raw";
  const maxCycle = steps.find((s) => s.step === activeStep)?.readCount ?? 1;

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
            <div className="rail__title">Calibration</div>
            {plateEntry.pltd.needsPassword || plateEntry.pltd.error ? (
              <PasswordPrompt
                wrong={!!plateEntry.pltd.error}
                onSubmit={setPltdPassword}
              />
            ) : (
              <>
                <div className="rail__row">
                  <Toggle
                    label="Color separation"
                    options={[
                      ["off", "Off"],
                      ["on", "On"],
                    ]}
                    value={calibrationOn ? "on" : "off"}
                    onChange={(v) => onChange({ calibration: v === "on" })}
                  />
                </div>
                {calibrationOn && (
                  <div className="rail__row">
                    <Toggle
                      label="Normalization"
                      options={[
                        ["global", "Global"],
                        ["column", "Per-dye"],
                        ["none", "None"],
                      ]}
                      value={settings.calibrationNormalization}
                      onChange={(v) =>
                        onChange({ calibrationNormalization: v as NormalizationMode })
                      }
                    />
                  </div>
                )}
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
          <div className="rail__title">{calibrationOn ? "Fluorophores" : "Channels"}</div>
          {calibrationOn ? (
            <FluorBar
              fluors={fluorCals}
              disabled={settings.disabledFluors}
              onToggle={toggleFluor}
            />
          ) : (
            <ChannelBar
              enabled={settings.enabledChannels}
              available={available}
              onToggle={toggleChannel}
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
          />
        </div>

        {allTemps.length > 0 && (
          <div className="rail__section">
            <div className="rail__title">
              Temperature (right axis)
              <button
                className="rail__link"
                onClick={() =>
                  onChange({
                    temps:
                      visibleTemps.length > 0
                        ? new Set<string>()
                        : new Set(
                            allTemps.filter((t) => t.kind === "measured").map((t) => t.key),
                          ),
                  })
                }
              >
                {visibleTemps.length > 0 ? "none" : "all"}
              </button>
            </div>
            <TempBar temps={allTemps} enabled={settings.temps} onToggle={toggleTemp} />
          </div>
        )}

        <div className="rail__section rail__row">
          <Toggle
            label="Baseline"
            options={[
              ["raw", "Raw"],
              ["constant", "Constant"],
              ["linear", "Linear"],
            ]}
            value={settings.curveBaseline}
            onChange={(v) => onChange({ curveBaseline: v as CurveBaselineMode })}
          />
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
                label="Dark"
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

        {settings.curveBaseline !== "raw" && (
          <div className="rail__section">
            <BaselineRangeSlider
              min={1}
              max={maxCycle}
              value={settings.curveBaselineRange ?? defaultRangePreview(maxCycle)}
              isManual={settings.curveBaselineRange != null}
              onChange={(range) => onChange({ curveBaselineRange: range })}
              onReset={() => onChange({ curveBaselineRange: null })}
            />
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
            Log + baseline: non-positive points are hidden (gaps).
          </div>
        )}
      </aside>

      <section className="curves__plot">
        <CurveChart
          curves={plotCurves}
          darkCurves={!calibrationOn && settings.showDark ? enabledDark : []}
          tempCurves={visibleTemps}
          baseline="raw"
          curveBaselineMode={settings.curveBaseline}
          curveBaselineRange={settings.curveBaselineRange}
          scale={settings.scale}
          bands={calibrationOn ? "off" : settings.bands}
        />
      </section>
    </div>
  );
}
