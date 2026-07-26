/**
 * The per-run settings that change a **number** — and therefore live in the file, not in this
 * browser.
 *
 * Everything in {@link AnalysisSettings} feeds `useRunAnalysis`: the calibration matrix, the
 * corrections applied before the solve, and the thresholds every Cq is measured against. A
 * different value here means a different Cq for the same run. That made IndexedDB the wrong
 * home for them:
 *
 * - the interpretation of a run was invisible to anyone the file was sent to,
 * - the same file opened on a second machine (or after clearing site data) silently reverted to
 *   automatic thresholds, with the numbers changing and nothing on screen saying why,
 * - and a threshold set on one run leaked its *absence* onto every other run, since a per-file
 *   IndexedDB record and the file itself could disagree about which was authoritative.
 *
 * So they round-trip through the archive's own `zpcrweb.json` entry (see
 * `packages/core/src/zpcrwebSettings.ts` and `zpcrweb-json.md`). The in-memory shape here uses a
 * `Map` for the overrides, matching the rest of the app's settings; the on-disk shape uses a
 * plain object, matching JSON. This module is the one place that converts.
 *
 * **Display state is deliberately not here.** Which wells are selected, which fluorophores are
 * hidden, log vs. linear — none of it changes a computed value, all of it is a per-person view
 * onto the run, and it stays in IndexedDB (see `db.ts`).
 */

import {
  ZPCRWEB_SETTINGS_VERSION,
  type NormalizationMode,
  type ZpcrwebAnalysisSettings,
  type ZpcrwebSettings,
} from "@zpcrweb/core";

/** The library's default for `threshold.md` §5.1's auto-threshold multiplier, and the slider's
 * starting point. Must track `AutoThresholdOptions.multiplier`'s own default in `@zpcrweb/core`,
 * which documents where the figure comes from (and why it sits below what the CFX anchors
 * imply). */
export const DEFAULT_THRESHOLD_MULTIPLIER = 20;

/** File-backed analysis parameters, in-memory form. */
export interface AnalysisSettings {
  /** Manual per-fluorophore threshold override (RFU), keyed by threshold group — the
   * fluorophore, always (see `RunAnalysis.thresholdGroupOf`). A group with no entry uses the
   * automatic threshold (`threshold.md` §5.1). Edited in the Curves rail's "Threshold overrides"
   * section; applies to the chart's Cq markers, the hover cards and the table alike, since all
   * three read the run's one Cq table. */
  thresholdOverrides: Map<string, number>;
  /** Manual per-*curve* threshold override (RFU), keyed by `curveKey(row, col, fluor)` — one
   * well's one dye. Outranks {@link thresholdOverrides}, which in turn outranks the auto value:
   * a group threshold is a median that deliberately won't follow any single well, so this is the
   * only way to correct one outlier without moving every other well with it. Edited in the
   * Curves rail's Threshold section, under the fluorophore's expandable per-curve list. */
  curveThresholdOverrides: Map<string, number>;
  /** §5.1's auto-threshold multiplier: `threshold = k × median baseline noise` across the group's
   * wells, for every group with no entry in {@link thresholdOverrides}. The scale comes from the
   * thresholds CFX itself persisted in a `.pcrd` (see `AutoThresholdOptions.multiplier`), but
   * those are two anchors from one run and the default sits deliberately below them — and it is
   * the single knob that most affects where every Cq lands, so the Curves rail exposes it as a
   * slider rather than burying it. */
  thresholdMultiplier: number;
  /**
   * Whether the plate read's LED-off `DARKDATA` is subtracted from a reading before the solve —
   * the optional dark-current stage of `calibration.md` §4.2. Off by default.
   */
  subtractDark: boolean;
  /**
   * Calibration matrix column normalization; see `calibration.md` §3. Deliberately **not**
   * exposed in the UI: §5.1 divides the scaling back out, so all three modes report identical
   * RFU for any full-column-rank matrix — it only changes conditioning, which matters solely
   * for a rank-deficient one (more dyes than scanned channels). Kept as a setting so that case
   * stays reachable, and so stored files keep round-tripping.
   */
  calibrationNormalization: NormalizationMode;
}

/**
 * The keys of {@link AnalysisSettings}, as a runtime list — `updateSettings` routes a patch by
 * membership in this set, which is what keeps every call site writing one flat
 * `onChange({ … })` regardless of where the value ends up being stored.
 */
export const ANALYSIS_KEYS = [
  "thresholdOverrides",
  "curveThresholdOverrides",
  "thresholdMultiplier",
  "subtractDark",
  "calibrationNormalization",
] as const;

export type AnalysisKey = (typeof ANALYSIS_KEYS)[number];

const ANALYSIS_KEY_SET: ReadonlySet<string> = new Set<string>(ANALYSIS_KEYS);

export function isAnalysisKey(key: string): key is AnalysisKey {
  return ANALYSIS_KEY_SET.has(key);
}

export function defaultAnalysisSettings(): AnalysisSettings {
  return {
    thresholdOverrides: new Map<string, number>(),
    curveThresholdOverrides: new Map<string, number>(),
    thresholdMultiplier: DEFAULT_THRESHOLD_MULTIPLIER,
    // The dark-current stage is optional and off by default, which is what matches the reported
    // RFU scale of the reference run in `calibration.md` §8. See §4.2.
    subtractDark: false,
    calibrationNormalization: "global",
  };
}

/** Seed in-memory state from a file's `zpcrweb.json` (or from nothing, for a file that has
 * none). Any field the document omits — or that failed the library's validation — falls back to
 * the app default, so a partial document is as usable as a complete one. */
export function analysisFromZpcrweb(doc: ZpcrwebSettings | null | undefined): AnalysisSettings {
  const base = defaultAnalysisSettings();
  const a = doc?.analysis;
  if (!a) return base;
  return {
    thresholdOverrides: a.thresholdOverrides
      ? new Map(Object.entries(a.thresholdOverrides))
      : base.thresholdOverrides,
    curveThresholdOverrides: a.curveThresholdOverrides
      ? new Map(Object.entries(a.curveThresholdOverrides))
      : base.curveThresholdOverrides,
    thresholdMultiplier: a.thresholdMultiplier ?? base.thresholdMultiplier,
    subtractDark: a.subtractDark ?? base.subtractDark,
    calibrationNormalization: a.calibrationNormalization ?? base.calibrationNormalization,
  };
}

/**
 * The on-disk form. Every field is written, including ones that happen to equal today's default:
 * the entry exists to record *the parameters this run was analyzed with*, and a default that
 * shifts in a later build must not silently re-analyze an old run. (An empty overrides map is
 * still written as `{}`; the library drops it on read, which round-trips to the same empty map.)
 */
export function zpcrwebFromAnalysis(settings: AnalysisSettings): ZpcrwebSettings {
  const analysis: ZpcrwebAnalysisSettings = {
    thresholdOverrides: Object.fromEntries(settings.thresholdOverrides),
    curveThresholdOverrides: Object.fromEntries(settings.curveThresholdOverrides),
    thresholdMultiplier: settings.thresholdMultiplier,
    subtractDark: settings.subtractDark,
    calibrationNormalization: settings.calibrationNormalization,
  };
  return {
    version: ZPCRWEB_SETTINGS_VERSION,
    generator: "zpcrweb",
    updatedAt: new Date().toISOString(),
    analysis,
  };
}
