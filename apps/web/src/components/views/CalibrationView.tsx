import { useEffect, useMemo, useRef, useState } from "react";
import type { Zpcr } from "@zpcrweb/core";
import type { FileSettings, Scale } from "../../state/useZpcrStore";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelLabel } from "../../lib/channelColors";
import { resolveTubeType } from "../../lib/fluorCurves";
import { stepTemperature } from "../../lib/runAnalysis";
import {
  calChannels,
  calPlateTypes,
  calibrationFiles,
  defaultCalKeys,
} from "../../lib/calibrationCurves";
import type { CalHighlight, CalPlotSeries } from "../../lib/uplot/calChart";
import { ChannelBar } from "../curves/ChannelBar";
import { FluorBar, type FluorChip } from "../curves/FluorBar";
import { CalChart } from "../calibration/CalChart";
import { Toggle } from "../Toggle";
import { ResetIcon } from "../ResetIcon";

interface Props {
  zpcr: Zpcr;
  settings: FileSettings;
  onChange: (patch: Partial<FileSettings>) => void;
}

/**
 * Every `.Dcal` pure-dye calibration in the run, as response curves: block temperature on x, RFU
 * on y, one line per (calibration file × optical channel). This is the *input* to color
 * separation — `calibration.md` §2's `max(0, dye − empty)` per channel — so the plot shows
 * directly what the matrix at any given block temperature is built from, and how much each dye
 * bleeds into its neighbours' channels.
 *
 * Shown by default: only the files the run's analysis actually reads (this plate's fluorophores,
 * on the tube type the plate resolves to). The rest of the archive's calibrations — every other
 * dye, and the other tube type — are one chip-click away, drawn dashed so the ones the analysis
 * uses stay identifiable.
 *
 * The rail is deliberately the Curves view's: the same `FluorBar` chips (dye chips here rather
 * than target chips), the same `ChannelBar` reading the same `enabledChannels` setting, the same
 * `.curves__rail` layout and reset/solo/hover behavior.
 */
export function CalibrationView({ zpcr, settings, onChange }: Props) {
  const [pltdPassword] = usePltdPassword();

  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);
  const runTemperatureC = useMemo(
    () => stepTemperature(zpcr, activeStep),
    [zpcr, activeStep],
  );

  const calibrations = useMemo(() => zpcr.calibrations(), [zpcr]);
  // The plate only decides *which* calibrations are in use (its fluorophores and tube type), so
  // it's read directly rather than through `useRunAnalysis` — this view needs none of the color
  // separation, Cq table or curve baselines that hook computes.
  const plate = useMemo(
    () => zpcr.plates(pltdPassword || undefined)[0]?.pltd.plate,
    [zpcr, pltdPassword],
  );
  const tube = resolveTubeType(plate?.plateName);
  const files = useMemo(
    () => calibrationFiles(calibrations, tube, plate?.fluors.map((f) => f.fluor) ?? []),
    [calibrations, tube, plate],
  );
  const plateTypes = useMemo(() => calPlateTypes(files), [files]);
  const available = useMemo(() => calChannels(files), [files]);
  const defaultKeys = useMemo(() => defaultCalKeys(files, tube), [files, tube]);
  /** True while the default is a fallback rather than a real match — see `defaultCalKeys`. */
  const usingFallback = files.length > 0 && !files.some((f) => f.inUse);

  // Seed the selection from the run once the calibrations are known, and only while nothing has
  // been selected yet — the same apply-once-per-source pattern the Curves view's well/channel
  // defaults use, so a selection restored from storage is left alone.
  const seededFor = useRef<typeof files>(undefined);
  useEffect(() => {
    if (files.length === 0 || seededFor.current === files) return;
    seededFor.current = files;
    if (settings.calFiles.size === 0 && defaultKeys.size > 0) onChange({ calFiles: defaultKeys });
  }, [files, defaultKeys, settings.calFiles, onChange]);

  const enabledFiles = useMemo(
    () => files.filter((f) => settings.calFiles.has(f.key)),
    [files, settings.calFiles],
  );

  const [highlight, setHighlight] = useState<CalHighlight | null>(null);

  /** One line per enabled (file × enabled channel). Order follows the file list, so a rebuild
   * can't reshuffle colors under the cursor. */
  const series = useMemo<CalPlotSeries[]>(
    () =>
      enabledFiles.flatMap((f) =>
        available
          .filter((ch) => settings.enabledChannels.has(ch))
          .map((ch) => ({
            key: `${f.key}|${ch}`,
            fileKey: f.key,
            dye: f.dye,
            plateType: f.plateType,
            channel: ch,
            primary: ch === f.primaryChannel,
            inUse: f.inUse,
            knots: f.channels[ch] ?? [],
          })),
      ),
    [enabledFiles, available, settings.enabledChannels],
  );

  const toggleCal = (key: string) => {
    const next = new Set(settings.calFiles);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange({ calFiles: next });
  };
  const soloCal = (key: string) => onChange({ calFiles: new Set([key]) });
  const resetCals = () => onChange({ calFiles: defaultKeys });

  const toggleChannel = (ch: number) => {
    const next = new Set(settings.enabledChannels);
    next.has(ch) ? next.delete(ch) : next.add(ch);
    onChange({ enabledChannels: next });
  };
  const soloChannel = (ch: number) => onChange({ enabledChannels: new Set([ch]) });
  /** Back to the channels this run actually scanned — the same meaning the Curves view's channel
   * reset has, even though this view can also show the ones it didn't. */
  const resetChannels = () => onChange({ enabledChannels: new Set(zpcr.channels()) });

  /** `FluorBar` works in opt-*out* terms (chips are on unless listed), while a calibration is
   * opt-*in* — most of the archive's 28 files are off. Passing the complement is what lets the
   * Curves view's chip component be reused verbatim rather than forked for one inverted flag. */
  const hiddenKeys = useMemo(
    () => new Set(files.filter((f) => !settings.calFiles.has(f.key)).map((f) => f.key)),
    [files, settings.calFiles],
  );

  const chipsFor = (plateType: string): FluorChip[] =>
    files
      .filter((f) => f.plateType === plateType)
      .map((f) => ({
        key: f.key,
        label: f.dye,
        sublabel: channelLabel(f.primaryChannel),
        channel: f.primaryChannel,
        // Every file here has real data by construction; the dimmed "no calibration" state the
        // Curves view uses this flag for has no counterpart in a list *of* calibrations.
        calibrated: true,
      }));

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
                  className={"segmented__item" + (s.step === activeStep ? " is-active" : "")}
                  onClick={() => onChange({ step: s.step })}
                  title={`Protocol STEP ${s.step}, ${s.readCount} cycles`}
                >
                  {i} · {s.readCount}c
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rail__section">
          <div className="rail__title">
            Calibrations
            <button
              className="rail__link rail__icon-btn"
              onClick={resetCals}
              title="Reset to the calibrations this run's analysis uses"
            >
              <ResetIcon />
            </button>
          </div>
          {files.length === 0 ? (
            <div className="rail__note mono">This run carries no .Dcal calibration data.</div>
          ) : (
            <>
              {plateTypes.map((plateType) => (
                <div key={plateType} className="calgroup">
                  <div className="calgroup__title mono">
                    {plateType}
                    {plateType === tube && <span className="calgroup__tag">plate</span>}
                  </div>
                  <FluorBar
                    items={chipsFor(plateType)}
                    disabled={hiddenKeys}
                    onToggle={toggleCal}
                    onHover={(key) => setHighlight(key ? { kind: "file", fileKey: key } : null)}
                    onSolo={soloCal}
                  />
                </div>
              ))}
              {usingFallback && (
                <div className="rail__note mono">
                  No plate data, so no calibration is in use — showing every {tube} calibration
                  instead.
                </div>
              )}
            </>
          )}
        </div>

        <div className="rail__section">
          <div className="rail__title">
            Channels
            <button
              className="rail__link rail__icon-btn"
              onClick={resetChannels}
              title="Reset to the channels this run scanned"
            >
              <ResetIcon />
            </button>
          </div>
          <ChannelBar
            enabled={settings.enabledChannels}
            available={available}
            onToggle={toggleChannel}
            onHover={(ch) => setHighlight(ch != null ? { kind: "channel", channel: ch } : null)}
            onSolo={soloChannel}
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

        <div className="rail__stat mono">
          {enabledFiles.length} / {files.length} calibrations · {series.length} curves
        </div>

        <div className="rail__note mono">
          Response is the pure-dye read minus the empty-plate read, per channel (calibration.md
          §2). Lines are straight because the algorithm interpolates linearly between these four
          measured temperatures; the marker sits at this step's block temperature, where the
          calibration matrix is sampled. Dashed lines aren't used by this run's analysis.
        </div>
      </aside>

      <section className="curves__plot">
        <CalChart
          series={series}
          runTemperatureC={files.length > 0 ? runTemperatureC : null}
          scale={settings.scale}
          highlight={highlight}
        />
      </section>
    </div>
  );
}
