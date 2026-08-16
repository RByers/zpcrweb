/**
 * A run's results table: one row per (target, well) pair — `threshold.md` §5–§7's Cq and
 * endpoint ΔRFU, laid out as a table (or a CSV) instead of a chart.
 *
 * Every number here is *looked up* in {@link RunAnalysis.cqTable}, never recomputed from a
 * filtered subset — a caller's own filters decide which rows to show, nothing more, so a row
 * always agrees with whatever marker a chart draws for the same curve.
 */

import { safeFileBase } from "./fileName.js";
import type { MeltAnalysis } from "./meltAnalysis.js";
import type { SampleType } from "./pltd.js";
import { curveKey, formatBaselineFormula, type RunAnalysis } from "./runAnalysis.js";

/**
 * Display label for a channel — always "Ch1"–"Ch6", never a dye guess, and
 * {@link UNKNOWN_CHANNEL_LABEL} when there is no channel to name. "Ch" rather than "C" to avoid
 * ambiguity with a well column/position.
 */
export const UNKNOWN_CHANNEL_LABEL = "Ch?";

export function channelLabel(index: number | null | undefined): string {
  return index == null ? UNKNOWN_CHANNEL_LABEL : `Ch${index + 1}`;
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC4180-ish quoting of one CSV row. */
export function csvRow(cells: string[]): string {
  return cells.map(csvField).join(",") + "\r\n";
}

export interface AnalysisRow {
  /** The threshold group: the target/gene, the `(none)` catch-all, or — on a plate with no
   * targets at all — the fluorophore itself. See `RunAnalysis.groupOf`. */
  target: string;
  fluor: string;
  /** Optical channel, or null/undefined when it isn't known — exported as `Ch?` (see
   * {@link channelLabel}). Display only; no reported number depends on it. */
  channel?: number | null;
  row: number;
  col: number;
  wellLabel: string;
  sample: string;
  /** The well's normalized sample type (unknown/standard/NTC/…). Display only. */
  sampleType: SampleType;
  /** Diagnostic: the linear baseline actually fitted for this curve, rendered as a formula
   * (e.g. "2000 + 4c") — helps explain a surprising threshold/Cq. */
  baselineFormula: string;
  threshold: number;
  noise: number;
  deltaRfu: number;
  /** End-point RFU — the mean of the corrected curve's last five cycles (`threshold.md` §7).
   * The number the instrument's own End Point export reports, and what an assay with no Cq at all
   * reads instead. Distinct from {@link deltaRfu}, which is the last single value's rise: on a
   * still-climbing well the two differ by hundreds of RFU. */
  endRfu: number;
  cq: number | null;
}

/** Whether a given well/fluor pair should appear in the table — a caller's own filter predicate
 * (rail chips, wells, samples, …), applied identically to whatever else it's driving (a chart's
 * plotted curves, say), so the table and that other view always show the same set. */
export type CurveVisible = (row: number, col: number, fluor: string) => boolean;

/** Rows for every loaded well/fluor pair `visible` lets through, sorted by target then plate
 * position. Only *loaded* wells get rows: an unloaded well/fluor pair can still be plotted
 * elsewhere but has no real measurement to tabulate. */
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
        deltaRfu: entry.deltaRfu,
        endRfu: entry.endRfu,
        cq: entry.cq,
      });
    }
  }
  return out.sort((a, b) => a.target.localeCompare(b.target) || a.row - b.row || a.col - b.col);
}

/** The same columns the table shows, in the same order, plus `channel` (redundant on screen — a
 * rendered table can carry it as a chip colour instead of text). */
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
    ]);
  }
  return csv;
}

/** `<run name>_analysis.csv` — the same `dataFile`-derived naming a raw per-cycle export uses. */
export function analysisCsvFilename(dataFile: string): string {
  const runName = safeFileBase(dataFile.replace(/\.(zpcr|pcrd)$/i, "")) || "run";
  return `${runName}_analysis.csv`;
}

// ---------------------------------------------------------------------------
// The melt equivalent (`melt.md`)
// ---------------------------------------------------------------------------

/** One row of a melt step's results: a well, a channel and the melting temperature it gave. */
export interface MeltRow {
  row: number;
  col: number;
  wellLabel: string;
  /** Optical channel — melt analysis stays in channel space, so there is no fluor or target. */
  channel: number;
  /** Melting temperature, °C, or null where no peak stood clear of the noise. */
  tmC: number | null;
  /** The derivative's height at the peak, or null when there is no Tm. */
  peakHeight: number | null;
}

/**
 * Whether a given well/channel curve should appear in the melt table — the melt counterpart of
 * {@link CurveVisible}, keyed on the channel because a melt is analysed in channel space.
 */
export type MeltCurveVisible = (row: number, col: number, channel: number) => boolean;

/**
 * Rows for every melt curve `visible` lets through, sorted by plate position then channel.
 *
 * Unlike {@link buildAnalysisRows} this needs no plate: a melt is read per channel, so a run whose
 * plate definition is missing or encrypted still tabulates completely. Curves with no Tm are kept
 * rather than dropped — "this well melted at nothing" is a result, and dropping it would silently
 * shorten the table.
 */
export function buildMeltRows(analysis: MeltAnalysis, visible: MeltCurveVisible): MeltRow[] {
  const out: MeltRow[] = [];
  for (const curve of analysis.curves) {
    if (curve.isReference) continue;
    if (!visible(curve.row, curve.col, curve.channel)) continue;
    out.push({
      row: curve.row,
      col: curve.col,
      wellLabel: curve.wellLabel,
      channel: curve.channel,
      tmC: curve.tmC,
      peakHeight: curve.peakHeight,
    });
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col || a.channel - b.channel);
}

/** The melt table as CSV — the same columns in the same order. */
export function meltCsv(rows: MeltRow[]): string {
  let csv = csvRow(["well", "channel", "tm", "peakHeight"]);
  for (const r of rows) {
    csv += csvRow([
      r.wellLabel,
      channelLabel(r.channel),
      r.tmC != null ? r.tmC.toFixed(2) : "",
      r.peakHeight != null ? r.peakHeight.toFixed(1) : "",
    ]);
  }
  return csv;
}

/** `<run name>_melt.csv` — the same `dataFile`-derived naming {@link analysisCsvFilename} uses. */
export function meltCsvFilename(dataFile: string): string {
  const runName = safeFileBase(dataFile.replace(/\.(zpcr|pcrd)$/i, "")) || "run";
  return `${runName}_melt.csv`;
}
