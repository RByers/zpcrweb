import { useMemo } from "react";
import {
  baselineCorrectCurve,
  buildCalibrationMatrix,
  computeCq,
  resolveThreshold,
  REFERENCE_ROW,
  type CqAlgorithm,
  type DarkCurve,
  type WellCurve,
  type Zpcr,
} from "@zpcrweb/core";
import { wellKey, type FileSettings } from "../../state/useZpcrStore";
import { libBaselineMode } from "../../lib/cq";
import { computeWellTypes } from "../../lib/wellTypes";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelLabel } from "../../lib/channelColors";
import {
  computeFluorCurves,
  matchFluorCalibrations,
  plateBackgroundLevels,
  resolveTubeType,
  type FluorCorrections,
} from "../../lib/fluorCurves";
import { FluorBar, type FluorChip } from "../curves/FluorBar";
import { WellMatrix } from "../curves/WellMatrix";
import { PasswordPrompt } from "../PasswordPrompt";
import { Toggle } from "../Toggle";
import { DownloadIcon } from "../DownloadIcon";
import { csvRow, downloadText } from "../../lib/download";

interface Props {
  zpcr: Zpcr;
  settings: FileSettings;
  onChange: (patch: Partial<FileSettings>) => void;
}

/** One row of the Analysis table: a target/gene assigned to a fluor, in one well. */
export interface AnalysisRow {
  target: string;
  fluor: string;
  channel: number;
  row: number;
  col: number;
  wellLabel: string;
  sample: string;
  threshold: number;
  noise: number;
  amplified: boolean;
  deltaRfu: number;
  cq: number | null;
}

function sanitizeFilePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").trim();
}

export function AnalysisView({ zpcr, settings, onChange }: Props) {
  const [pltdPassword, setPltdPassword] = usePltdPassword();
  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  const available = useMemo(() => zpcr.channels(), [zpcr]);
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);

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
  const wellTypes = useMemo(() => computeWellTypes(plate), [plate]);

  const targetInfos = useMemo(() => {
    if (!plate) return [];
    const byFluor = new Map(fluorCals.map((f) => [f.fluor, f]));
    const seen = new Map<string, { target: string; fluor: string; channel: number; curve: unknown }>();
    for (const w of plate.wells) {
      for (const wf of w.fluors) {
        if (!wf.target || seen.has(wf.target)) continue;
        const cal = byFluor.get(wf.fluor);
        seen.set(wf.target, {
          target: wf.target,
          fluor: wf.fluor,
          channel: cal?.channel ?? wf.channel,
          curve: cal?.curve,
        });
      }
    }
    return [...seen.values()];
  }, [plate, fluorCals]);

  // No per-well target assigned anywhere on the plate: group by fluorophore instead, mirroring
  // CurvesView's Fluorophore view mode, so the Analysis table still has something to group on.
  const usingTargets = targetInfos.length > 0;
  const groupInfos = useMemo(
    () =>
      usingTargets
        ? targetInfos
        : fluorCals.map((f) => ({ target: f.fluor, fluor: f.fluor, channel: f.channel, curve: f.curve })),
    [usingTargets, targetInfos, fluorCals],
  );

  const chipItems: FluorChip[] = useMemo(
    () =>
      groupInfos.map((g) => ({
        key: g.target,
        label: g.target,
        sublabel: usingTargets ? g.fluor : channelLabel(g.channel),
        channel: g.channel,
        calibrated: !!g.curve,
      })),
    [groupInfos, usingTargets],
  );

  const stepTemperatureC = useMemo(() => {
    const temps = zpcr.reads
      .filter((r) => r.step === activeStep)
      .map((r) => r.blockTempC)
      .filter((t): t is number => t != null);
    return temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 60;
  }, [zpcr, activeStep]);

  const matrix = useMemo(() => {
    if (calibratedFluors.length === 0) return null;
    return buildCalibrationMatrix(
      calibratedFluors.map((f) => f.curve!),
      stepTemperatureC,
      { normalization: settings.calibrationNormalization, channels: available },
    );
  }, [calibratedFluors, stepTemperatureC, settings.calibrationNormalization, available]);

  const corrections = useMemo<FluorCorrections>(() => {
    const reads = zpcr.reads.filter((r) => r.step === activeStep);
    const referenceLevel = available.map((ch) => reads.map((r) => r.get(ch, REFERENCE_ROW, 0).mean));
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
  }, [zpcr, activeStep, available, darkCurves, settings.calibrationBackground, tube, stepTemperatureC]);

  const allFluorCurves = useMemo(() => {
    if (!matrix) return [];
    const dyeChannels = calibratedFluors.map((f) => f.channel);
    return computeFluorCurves(allCurves, matrix, available, dyeChannels, corrections);
  }, [matrix, allCurves, available, calibratedFluors, corrections]);

  const toggleTarget = (target: string) => {
    const next = new Set(settings.analysisDisabledTargets);
    next.has(target) ? next.delete(target) : next.add(target);
    onChange({ analysisDisabledTargets: next });
  };

  const baselineMode = libBaselineMode(settings.curveBaseline);
  const manualRegion = useMemo<{ beginCycle: number; endCycle: number } | null>(
    () =>
      settings.curveBaselineRange
        ? { beginCycle: settings.curveBaselineRange[0], endCycle: settings.curveBaselineRange[1] }
        : null,
    [settings.curveBaselineRange],
  );
  const algorithm: CqAlgorithm = settings.analysisCqAlgorithm;

  // ---- Build one row per active (target, well) pair --------------------------------------

  const rows: AnalysisRow[] = useMemo(() => {
    if (!plate || allFluorCurves.length === 0) return [];
    const curveByWellDye = new Map<string, { cycles: number[]; mean: number[] }>();
    for (const c of allFluorCurves) curveByWellDye.set(`${c.row},${c.col},${c.dye}`, c);

    interface Prepped {
      target: string;
      fluor: string;
      channel: number;
      row: number;
      col: number;
      wellLabel: string;
      sample: string;
      cycles: number[];
      correctedValues: number[];
      noise: number;
      amplified: boolean;
      deltaRfu: number;
    }
    const prepped: Prepped[] = [];
    for (const w of plate.wells) {
      if (!w.loaded) continue;
      if (!settings.enabledWells.has(wellKey(w.row, w.col))) continue;
      for (const wf of w.fluors) {
        const group = usingTargets ? wf.target : wf.fluor;
        if (!group || settings.analysisDisabledTargets.has(group)) continue;
        const curve = curveByWellDye.get(`${w.row},${w.col},${wf.fluor}`);
        if (!curve) continue;
        const info = groupInfos.find((g) => g.target === group);
        const baseline = baselineCorrectCurve(curve.cycles, curve.mean, baselineMode, manualRegion);
        prepped.push({
          target: group,
          fluor: wf.fluor,
          channel: info?.channel ?? wf.channel,
          row: w.row,
          col: w.col,
          wellLabel: w.label,
          sample: w.sample ?? "",
          cycles: curve.cycles,
          correctedValues: baseline.correctedValues,
          noise: baseline.noise,
          amplified: baseline.amplified,
          deltaRfu: baseline.deltaRfu,
        });
      }
    }

    // §5.1: one threshold per target, from the median baseline noise across that target's wells.
    const noisesByTarget = new Map<string, number[]>();
    for (const p of prepped) {
      const list = noisesByTarget.get(p.target) ?? [];
      list.push(p.noise);
      noisesByTarget.set(p.target, list);
    }
    const thresholdByTarget = new Map<string, number>();
    for (const [target, noises] of noisesByTarget) {
      thresholdByTarget.set(
        target,
        resolveThreshold(noises, { overrideValue: settings.analysisThresholdOverrides.get(target) }),
      );
    }

    return prepped
      .map((p): AnalysisRow => {
        const threshold = thresholdByTarget.get(p.target) ?? 0;
        const cq = computeCq(p.cycles, p.correctedValues, {
          algorithm,
          threshold: algorithm === "Threshold" ? threshold : undefined,
          noise: p.noise,
        });
        return {
          target: p.target,
          fluor: p.fluor,
          channel: p.channel,
          row: p.row,
          col: p.col,
          wellLabel: p.wellLabel,
          sample: p.sample,
          threshold,
          noise: p.noise,
          amplified: p.amplified,
          deltaRfu: p.deltaRfu,
          cq,
        };
      })
      .sort((a, b) => a.target.localeCompare(b.target) || a.row - b.row || a.col - b.col);
  }, [
    plate,
    allFluorCurves,
    settings.enabledWells,
    settings.analysisDisabledTargets,
    settings.analysisThresholdOverrides,
    usingTargets,
    groupInfos,
    baselineMode,
    manualRegion,
    algorithm,
  ]);

  const download = () => {
    let csv = csvRow([
      "well",
      "sample",
      "fluor",
      "target",
      "channel",
      "threshold",
      "cq",
      "deltaRfu",
      "amplified",
    ]);
    for (const r of rows) {
      csv += csvRow([
        r.wellLabel,
        r.sample,
        r.fluor,
        r.target,
        channelLabel(r.channel),
        r.threshold.toFixed(1),
        r.cq != null ? r.cq.toFixed(3) : "",
        r.deltaRfu.toFixed(1),
        r.amplified ? "yes" : "no",
      ]);
    }
    const runName = sanitizeFilePart(zpcr.metadata.dataFile.replace(/\.(zpcr|pcrd)$/i, "")) || "run";
    downloadText(`${runName}_analysis.csv`, csv, "text/csv");
  };

  return (
    <div className="curves analysis">
      <aside className="curves__rail">
        {plateEntry && (plateEntry.pltd.needsPassword || plateEntry.pltd.error) ? (
          <div className="rail__section">
            <PasswordPrompt wrong={!!plateEntry.pltd.error} onSubmit={setPltdPassword} />
          </div>
        ) : (
          <>
            {!plate && (
              <div className="rail__note mono">No plate definition attached to this run.</div>
            )}
            {plate && !calibrationAvailable && (
              <div className="rail__note mono">
                No {tube} calibration in this file — the Analysis table needs channel→dye color
                separation to compute per-target curves. Check the Calibration files under Raw
                files.
              </div>
            )}

            {plate && calibrationAvailable && (
              <>
                <div className="rail__section">
                  <div className="rail__title">{usingTargets ? "Targets" : "Fluorophores"}</div>
                  <FluorBar
                    items={chipItems}
                    disabled={settings.analysisDisabledTargets}
                    onToggle={toggleTarget}
                  />
                </div>

                <div className="rail__section">
                  <div className="rail__title">Wells</div>
                  <WellMatrix
                    enabled={settings.enabledWells}
                    onChange={(next) => onChange({ enabledWells: next })}
                    wellTypes={wellTypes}
                  />
                </div>

                <div className="rail__section rail__row">
                  <Toggle
                    label="Cq mode"
                    options={[
                      ["Threshold", "Threshold"],
                      ["NoThreshold", "2nd derivative"],
                    ]}
                    value={algorithm}
                    onChange={(v) => onChange({ analysisCqAlgorithm: v as CqAlgorithm })}
                  />
                </div>

                {algorithm === "Threshold" && (
                  <details className="rail__section rail__details">
                    <summary className="rail__title">
                      <span>
                        <span className="rail__chevron" aria-hidden="true">
                          ▸
                        </span>
                        Threshold overrides
                      </span>
                    </summary>
                    <div className="analysis__thresholds">
                      {groupInfos
                        .filter((g) => !settings.analysisDisabledTargets.has(g.target) && g.curve)
                        .map((g) => {
                          const auto = rows.find((r) => r.target === g.target)?.threshold;
                          const override = settings.analysisThresholdOverrides.get(g.target);
                          return (
                            <label key={g.target} className="analysis__threshold-row mono">
                              <span>{g.target}</span>
                              <input
                                type="number"
                                placeholder={auto != null ? auto.toFixed(1) : "auto"}
                                value={override ?? ""}
                                onChange={(e) => {
                                  const next = new Map(settings.analysisThresholdOverrides);
                                  const raw = e.currentTarget.value;
                                  if (raw === "") next.delete(g.target);
                                  else next.set(g.target, Number(raw));
                                  onChange({ analysisThresholdOverrides: next });
                                }}
                              />
                            </label>
                          );
                        })}
                    </div>
                  </details>
                )}

                <div className="rail__note mono">
                  Baseline: {settings.curveBaseline} (set in Curves view).
                </div>

                <div className="rail__section">
                  <button
                    className="raw__download analysis__download"
                    onClick={download}
                    disabled={rows.length === 0}
                    aria-label="Download analysis table as CSV"
                    title="Download analysis table as CSV"
                  >
                    <DownloadIcon /> CSV
                  </button>
                </div>

                <div className="rail__stat mono">{rows.length} rows</div>
              </>
            )}
          </>
        )}
      </aside>

      <section className="analysis__table-wrap">
        {rows.length === 0 ? (
          <div className="chart__empty mono">
            No target/well combinations selected — enable targets and wells to populate the table.
          </div>
        ) : (
          <table className="analysis__tbl runlog__tbl">
            <thead>
              <tr>
                <th>Well</th>
                <th>Sample</th>
                <th>Fluor</th>
                {usingTargets && <th>Target</th>}
                <th>Threshold</th>
                <th>Cq</th>
                <th>ΔRFU</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.target}-${r.wellLabel}`}
                  className={"analysis__row" + (r.cq == null ? " is-unamplified" : "")}
                >
                  <td>{r.wellLabel}</td>
                  <td>{r.sample || "—"}</td>
                  <td>{r.fluor}</td>
                  {usingTargets && <td>{r.target}</td>}
                  <td>{algorithm === "Threshold" ? r.threshold.toFixed(1) : "—"}</td>
                  <td>{r.cq != null ? r.cq.toFixed(2) : "—"}</td>
                  <td>{r.deltaRfu.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
