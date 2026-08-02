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
  DEFAULT_THRESHOLD_MULTIPLIER,
  runAnalysisSettingsFromZpcrweb,
  ZPCRWEB_SETTINGS_VERSION,
  type RunAnalysisSettings,
  type ZpcrwebAnalysisSettings,
  type ZpcrwebSettings,
} from "@zpcrweb/core";

export { DEFAULT_THRESHOLD_MULTIPLIER };

/**
 * File-backed analysis parameters, in-memory form: the library's own {@link RunAnalysisSettings}
 * — the math-affecting fields, defined and documented in `@zpcrweb/core`'s `runAnalysis.ts` — minus
 * `baselineSource`/`cqSource` (those are real per-run analysis inputs too, but browser-local
 * display toggles rather than something `zpcrweb.json` round-trips; `useZpcrStore.ts`'s
 * `FileSettings` carries them instead, straight from IndexedDB), plus {@link experimentName},
 * which this app also routes into the file (see below) but which changes no number, so it stays
 * out of the library's own type.
 */
export interface AnalysisSettings
  extends Required<Omit<RunAnalysisSettings, "baselineSource" | "cqSource">> {
  /**
   * What the run is called (`zpcrweb.json`'s top-level `experimentName`; see `experiment.ts` in
   * `@zpcrweb/core` for why no Bio-Rad format has a field for it). `""` means unnamed, and the
   * app falls back to the format's own name or the filename — it is *not* written back, so
   * renaming the file on disk still renames the run.
   *
   * Not analysis — it changes no number — but it is file-backed state, and this interface is
   * how a key gets routed into the file rather than into IndexedDB (see {@link ANALYSIS_KEYS}).
   * That is the distinction that matters here: a name belongs to the run, not to the browser
   * that opened it, for exactly the reasons in this module's header.
   */
  experimentName: string;
}

/**
 * The keys of {@link AnalysisSettings}, as a runtime list — `updateSettings` routes a patch by
 * membership in this set, which is what keeps every call site writing one flat
 * `onChange({ … })` regardless of where the value ends up being stored.
 */
export const ANALYSIS_KEYS = [
  "experimentName",
  "thresholdOverrides",
  "curveThresholdOverrides",
  "thresholdMultiplier",
  "calibrationNormalization",
] as const;

export type AnalysisKey = (typeof ANALYSIS_KEYS)[number];

const ANALYSIS_KEY_SET: ReadonlySet<string> = new Set<string>(ANALYSIS_KEYS);

export function isAnalysisKey(key: string): key is AnalysisKey {
  return ANALYSIS_KEY_SET.has(key);
}

export function defaultAnalysisSettings(): AnalysisSettings {
  return {
    experimentName: "",
    thresholdOverrides: new Map<string, number>(),
    curveThresholdOverrides: new Map<string, number>(),
    thresholdMultiplier: DEFAULT_THRESHOLD_MULTIPLIER,
    calibrationNormalization: "global",
  };
}

/** Seed in-memory state from a file's `zpcrweb.json` (or from nothing, for a file that has
 * none). Any field the document omits — or that failed the library's validation — falls back to
 * the app default, so a partial document is as usable as a complete one.
 *
 * The math-affecting fields are `runAnalysisSettingsFromZpcrweb`'s own conversion — this just
 * layers `experimentName` (not analysis, see {@link AnalysisSettings}) on top and fills in
 * whatever the library left absent with this app's defaults, since `RunAnalysisSettings`'s
 * fields are all optional and `AnalysisSettings`'s aren't. */
export function analysisFromZpcrweb(doc: ZpcrwebSettings | null | undefined): AnalysisSettings {
  const base = defaultAnalysisSettings();
  const fromFile = runAnalysisSettingsFromZpcrweb(doc);
  return {
    // Top-level, not under `analysis` — and read even when the document has no analysis block at
    // all, which is the shape a file named but never re-thresholded ends up with.
    experimentName: doc?.experimentName ?? base.experimentName,
    thresholdOverrides: fromFile.thresholdOverrides
      ? new Map(fromFile.thresholdOverrides)
      : base.thresholdOverrides,
    curveThresholdOverrides: fromFile.curveThresholdOverrides
      ? new Map(fromFile.curveThresholdOverrides)
      : base.curveThresholdOverrides,
    thresholdMultiplier: fromFile.thresholdMultiplier ?? base.thresholdMultiplier,
    calibrationNormalization: fromFile.calibrationNormalization ?? base.calibrationNormalization,
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
    calibrationNormalization: settings.calibrationNormalization,
  };
  const doc: ZpcrwebSettings = {
    version: ZPCRWEB_SETTINGS_VERSION,
    generator: "zpcrweb",
    updatedAt: new Date().toISOString(),
    analysis,
  };
  // Omitted rather than written as `""`: absent is what "nobody named this run" means on disk,
  // and it is what lets the reader fall back to the filename (see `AnalysisSettings`).
  if (settings.experimentName.trim()) doc.experimentName = settings.experimentName.trim();
  return doc;
}
