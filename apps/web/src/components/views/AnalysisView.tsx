import { useMemo } from "react";
import type { CqAlgorithm, Zpcr } from "@zpcrweb/core";
import { wellKey, type FileSettings } from "../../state/useZpcrStore";
import { formatBaselineFormula } from "../../lib/cq";
import { computeWellTypes } from "../../lib/wellTypes";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelLabel } from "../../lib/channelColors";
import { curveKey, useRunAnalysis } from "../../lib/runAnalysis";
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
  /** Diagnostic: the linear baseline actually fitted for this curve (see
   * `CurveBaselineResult.baselineFit`), rendered as a formula (e.g. "2000 + 4c") — helps explain
   * a surprising threshold/Cq. */
  baselineFormula: string;
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
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);

  // Every Cq this view shows comes out of the run-level table — see `runAnalysis.ts`. This view
  // filters that table for display (enabled wells, enabled targets); it never recomputes from the
  // filtered subset, which is what used to make it disagree with the Curves view.
  const run = useRunAnalysis(zpcr, settings, pltdPassword, activeStep);
  const { plateEntry, plate, tube, groupInfos, usingTargets, cqTable, groupOf } = run;
  const calibrationAvailable = run.calibrationAvailable;
  const wellTypes = useMemo(() => computeWellTypes(plate), [plate]);

  const chipItems: FluorChip[] = useMemo(
    () =>
      groupInfos.map((g) => ({
        key: g.target,
        label: g.target,
        sublabel: usingTargets ? g.fluors.join(", ") : channelLabel(g.channel ?? 0),
        channel: g.channel,
        calibrated: !!g.curve,
      })),
    [groupInfos, usingTargets],
  );

  const toggleTarget = (target: string) => {
    const next = new Set(settings.analysisDisabledTargets);
    next.has(target) ? next.delete(target) : next.add(target);
    onChange({ analysisDisabledTargets: next });
  };

  const algorithm: CqAlgorithm = settings.analysisCqAlgorithm;

  // ---- Build one row per active (target, well) pair --------------------------------------

  const rows: AnalysisRow[] = useMemo(() => {
    if (!plate || cqTable.size === 0) return [];
    const out: AnalysisRow[] = [];
    for (const w of plate.wells) {
      if (!w.loaded) continue;
      if (!settings.enabledWells.has(wellKey(w.row, w.col))) continue;
      for (const wf of w.fluors) {
        // A well/fluor pair with no target of its own still gets a row: it lands in the shared
        // NO_TARGET group (NTC/NRT wells and the like), rather than being dropped for lack of a name.
        const group = groupOf(w.row, w.col, wf.fluor);
        if (!group || settings.analysisDisabledTargets.has(group)) continue;
        const entry = cqTable.get(curveKey(w.row, w.col, wf.fluor));
        if (!entry) continue;
        const info = groupInfos.find((g) => g.target === group);
        out.push({
          target: group,
          fluor: wf.fluor,
          channel: info?.channel ?? wf.channel,
          row: w.row,
          col: w.col,
          wellLabel: w.label,
          sample: w.sample ?? "",
          baselineFormula: formatBaselineFormula(entry.baselineFit),
          threshold: entry.threshold,
          noise: entry.noise,
          amplified: entry.amplified,
          deltaRfu: entry.deltaRfu,
          cq: entry.cq,
        });
      }
    }
    return out.sort((a, b) => a.target.localeCompare(b.target) || a.row - b.row || a.col - b.col);
  }, [
    plate,
    cqTable,
    groupOf,
    settings.enabledWells,
    settings.analysisDisabledTargets,
    groupInfos,
  ]);

  const download = () => {
    let csv = csvRow([
      "well",
      "sample",
      "fluor",
      "target",
      "channel",
      "baseline",
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
        r.baselineFormula,
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
                  Baseline: always an auto-detected linear fit (see the Curves view's "Draw
                  baseline" toggle).
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
                <th>Baseline</th>
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
                  <td className="mono">{r.baselineFormula}</td>
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
