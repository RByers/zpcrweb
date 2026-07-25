import { useMemo } from "react";
import {
  buildCalibrationMatrix,
  type Zpcr,
  type WellCurve,
  type DarkCurve,
  type TemperatureCurve,
  type NormalizationMode,
} from "@zpcrweb/core";
import {
  wellKey,
  type Baseline,
  type BandsMode,
  type FileSettings,
  type Scale,
} from "../../state/useZpcrStore";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelLabel } from "../../lib/channelColors";
import {
  computeFluorCurves,
  matchFluorCalibrations,
  resolveTubeType,
  restrictToChannels,
} from "../../lib/fluorCurves";
import { ChannelBar } from "../curves/ChannelBar";
import { FluorBar } from "../curves/FluorBar";
import { WellMatrix } from "../curves/WellMatrix";
import { CurveChart } from "../curves/CurveChart";
import { TempBar } from "../curves/TempBar";
import { PasswordPrompt } from "../PasswordPrompt";
import type { PlotCurve } from "../../lib/uplot/chart";

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

  // Full curve set for the active step, including the reference row.
  const allCurves = useMemo<WellCurve[]>(
    () => zpcr.curves({ includeReference: true, step: activeStep }),
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

  // Dark (LED-off) subtraction only makes sense against a raw RFU baseline — ΔRFU already
  // removes each well's own starting offset, so subtracting a separate dark level on top of
  // that is meaningless. Disable rather than silently ignore, so the setting the user left on
  // resumes working the moment they switch back to Raw.
  const darkApplicable = settings.baseline !== "delta";
  const effectiveSubtractDark = darkApplicable && settings.subtractDark;

  // ---- Dye-space (color-separated) curves ------------------------------------------------
  // See calibration.md. Uses the plate's own fluorophore list matched against this run's
  // `.Dcal` calibration data — both need to be available for this to do anything.

  const plateEntry = useMemo(
    () => zpcr.plates(pltdPassword || undefined)[0],
    [zpcr, pltdPassword],
  );
  const plate = plateEntry?.pltd.plate;
  const calibrations = useMemo(() => zpcr.calibrations(), [zpcr]);

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
    const raw = buildCalibrationMatrix(
      calibratedFluors.map((f) => f.curve!),
      stepTemperatureC,
      { normalization: settings.calibrationNormalization },
    );
    return restrictToChannels(raw, available);
  }, [calibratedFluors, stepTemperatureC, settings.calibrationNormalization, available]);

  // The separation solve is real work (one pseudo-inverse per well per cycle) — skip it
  // entirely while the feature is off rather than computing curves nobody will see.
  const allFluorCurves = useMemo(() => {
    if (!matrix || !calibrationOn) return [];
    const dyeChannels = calibratedFluors.map((f) => f.channel);
    return computeFluorCurves(allCurves, darkCurves, matrix, available, dyeChannels, {
      subtractDark: effectiveSubtractDark,
    });
  }, [
    matrix,
    calibrationOn,
    allCurves,
    darkCurves,
    available,
    calibratedFluors,
    effectiveSubtractDark,
  ]);

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
  // real min/max/std of their own (§5 of calibration.md solves for a single concentration
  // per channel vector, not a distribution), and pre-separation dark subtraction already
  // happened inside computeFluorCurves — so bands, the dark overlay, and chart-level dark
  // subtraction are all channel-space-only concepts.

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

  const logDelta = settings.scale === "log" && settings.baseline === "delta";

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
          <div className="rail__title">Wells</div>
          <WellMatrix
            enabled={settings.enabledWells}
            onChange={(next) => onChange({ enabledWells: next })}
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
              ["delta", "ΔRFU"],
            ]}
            value={settings.baseline}
            onChange={(v) => onChange({ baseline: v as Baseline })}
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
          <Toggle
            label={calibrationOn ? "Dark (pre-separation)" : "Dark (LED-off)"}
            options={[
              ["off", "Off"],
              ["on", "On"],
            ]}
            value={settings.subtractDark ? "on" : "off"}
            onChange={(v) => onChange({ subtractDark: v === "on" })}
            disabled={!darkApplicable}
          />
          {!calibrationOn && (
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
          )}
        </div>

        <div className="rail__stat mono">
          {plotCurves.length} / {calibrationOn ? allFluorCurves.length : allCurves.length}{" "}
          curves
          {!calibrationOn && !effectiveSubtractDark && " + dark"}
          {visibleTemps.length > 0 && ` + ${visibleTemps.length} temp`}
        </div>
        {logDelta && (
          <div className="rail__note mono">
            Log + ΔRFU: non-positive points are hidden (gaps).
          </div>
        )}
      </aside>

      <section className="curves__plot">
        <CurveChart
          curves={plotCurves}
          darkCurves={calibrationOn ? [] : enabledDark}
          tempCurves={visibleTemps}
          baseline={settings.baseline}
          scale={settings.scale}
          subtractDark={calibrationOn ? false : effectiveSubtractDark}
          bands={calibrationOn ? "off" : settings.bands}
        />
      </section>
    </div>
  );
}

function Toggle({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle">
      <div className="toggle__label">{label}</div>
      <div className="segmented segmented--sm">
        {options.map(([val, text]) => (
          <button
            key={val}
            className={"segmented__item" + (value === val ? " is-active" : "")}
            disabled={disabled}
            onClick={() => onChange(val)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
