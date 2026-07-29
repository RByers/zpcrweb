import type { SampleType } from "@zpcrweb/core";

import { channelLabel } from "./channelColors";
import { formatBaselineFormula } from "./cq";
import { csvRow } from "./download";
import { curveKey, type RunAnalysis } from "./runAnalysis";

/**
 * The Curves view's table mode: one row per (target, well) pair — `threshold.md` §5–§7's Cq and
 * endpoint ΔRFU, laid out as a table instead of a chart.
 *
 * Every number here is *looked up* in the run's single Cq table (`runAnalysis.ts`), never
 * recomputed from the filtered subset — the rail's filters decide which rows are shown, nothing
 * more, so a row always agrees with the marker the chart draws for the same curve.
 */
export interface AnalysisRow {
  /** The threshold group: the target/gene, the `(none)` catch-all, or — on a plate with no
   * targets at all — the fluorophore itself. See `RunAnalysis.groupOf`. */
  target: string;
  fluor: string;
  /** Optical channel, or null/undefined when it isn't known — exported as `Ch?` (see
   * `channelLabel`). Display only; no reported number depends on it. */
  channel?: number | null;
  row: number;
  col: number;
  wellLabel: string;
  sample: string;
  /** The well's normalized sample type (unknown/standard/NTC/…). Display only — it tints the
   * table row the same colour the plate map paints the well, so a control reads as a control
   * without hunting for its label. */
  sampleType: SampleType;
  /** Diagnostic: the linear baseline actually fitted for this curve (see
   * `CurveBaselineResult.baselineFit`), rendered as a formula (e.g. "2000 + 4c") — helps explain
   * a surprising threshold/Cq. */
  baselineFormula: string;
  threshold: number;
  noise: number;
  amplified: boolean;
  deltaRfu: number;
  /** End-point RFU — the mean of the corrected curve's last five cycles (`threshold.md` §8).
   * The number the instrument's own End Point export reports, and what an assay with no Cq at all
   * reads instead. Distinct from {@link deltaRfu}, which is the last single value's rise: on a
   * still-climbing well the two differ by hundreds of RFU. */
  endRfu: number;
  cq: number | null;
}

/** Whether the rail's filters (wells, chips, samples) leave a given well/fluor pair visible —
 * the same predicate that decides whether the chart plots its curve, so the table and the chart
 * always show the same set. */
export type CurveVisible = (row: number, col: number, fluor: string) => boolean;

/** Rows for every loaded well/fluor pair the rail's filters leave visible, sorted by target then
 * plate position. Only *loaded* wells get rows: an unloaded well/fluor pair can still be plotted
 * (the "Unloaded" switch) but has no real measurement to tabulate. */
export function buildAnalysisRows(run: RunAnalysis, visible: CurveVisible): AnalysisRow[] {
  const { plate, cqTable, groupInfos, groupOf } = run;
  if (!plate || cqTable.size === 0) return [];
  const out: AnalysisRow[] = [];
  for (const w of plate.wells) {
    if (!w.loaded) continue;
    for (const wf of w.fluors) {
      if (!visible(w.row, w.col, wf.fluor)) continue;
      // A well/fluor pair with no target of its own still gets a row: it lands in the shared
      // NO_TARGET group (NTC/NRT wells and the like), rather than being dropped for lack of a name.
      const group = groupOf(w.row, w.col, wf.fluor);
      if (!group) continue;
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
        sampleType: w.sampleType,
        baselineFormula: formatBaselineFormula(entry.baselineFit),
        threshold: entry.threshold,
        noise: entry.noise,
        amplified: entry.amplified,
        deltaRfu: entry.deltaRfu,
        endRfu: entry.endRfu,
        cq: entry.cq,
      });
    }
  }
  return out.sort((a, b) => a.target.localeCompare(b.target) || a.row - b.row || a.col - b.col);
}

/** The same columns the table shows, in the same order, plus `channel` and `amplified` (harmless
 * in an export, redundant on screen — the table carries them as a chip colour and a greyed row
 * rather than as text). */
export function analysisCsv(rows: AnalysisRow[]): string {
  let csv = csvRow([
    "well",
    "sample",
    "sampleType",
    "fluor",
    "target",
    "channel",
    "baseline",
    "threshold",
    "cq",
    "deltaRfu",
    "endRfu",
    "amplified",
  ]);
  for (const r of rows) {
    csv += csvRow([
      r.wellLabel,
      r.sample,
      r.sampleType,
      r.fluor,
      r.target,
      channelLabel(r.channel),
      r.baselineFormula,
      r.threshold.toFixed(1),
      r.cq != null ? r.cq.toFixed(3) : "",
      r.deltaRfu.toFixed(1),
      r.endRfu.toFixed(1),
      r.amplified ? "yes" : "no",
    ]);
  }
  return csv;
}

function sanitizeFilePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").trim();
}

/** `<run name>_analysis.csv` — the same `dataFile`-derived naming the Raw view's per-cycle
 * export uses. */
export function analysisCsvFilename(dataFile: string): string {
  const runName = sanitizeFilePart(dataFile.replace(/\.(zpcr|pcrd)$/i, "")) || "run";
  return `${runName}_analysis.csv`;
}
