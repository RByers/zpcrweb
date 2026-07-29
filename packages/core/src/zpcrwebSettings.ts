/**
 * `zpcrweb.json` — zpcrweb's own settings entry inside a `.zpcr` archive.
 *
 * Everything that changes a *number* this app reports (a threshold, a Cq, an RFU) is analysis
 * state, and analysis state belongs to the **run**, not to the browser that happened to open it.
 * Keeping it in IndexedDB meant two people looking at the same file — or the same person on a
 * second machine — saw different Cq values with nothing in the file to explain the difference,
 * and a cleared site data wiped the interpretation of a run while the run itself survived.
 * So it goes in the archive, next to the data it describes.
 *
 * A `.zpcr` is a plain ZIP (see `archive.ts`), so this is just one more entry, added the same
 * way `attachPlate.ts` adds a plate. JSON rather than a binary blob because it is *ours*: it
 * should be greppable, diffable, and readable by anyone who unzips the archive without this
 * library. Bio-Rad's own tooling ignores entries it doesn't know, and `parseZpcr` only looks at
 * the entries it recognizes, so the addition is invisible to both.
 *
 * See `zpcrweb-json.md` for the on-disk schema and the compatibility rules.
 *
 * Reading is deliberately total: {@link parseZpcrwebSettings} never throws and never returns a
 * partially-typed object. A field that is missing, misspelled, out of range or the wrong type is
 * dropped, and the caller's own default applies — a file written by a newer version (or edited
 * by hand) degrades field by field instead of failing as a whole.
 */

import { zipSync } from "fflate";
import { unzipArchive } from "./archive.js";
import type { NormalizationMode } from "./calibration.js";
import type { Zpcr } from "./types.js";

/** The archive entry name. Fixed — it is how a file announces that zpcrweb has state in it. */
export const ZPCRWEB_SETTINGS_NAME = "zpcrweb.json";

/** Schema version written by this build. Bumped only for a change old readers can't degrade
 * through on their own (field-level unknowns already degrade — see the module comment). */
export const ZPCRWEB_SETTINGS_VERSION = 1;

/**
 * The analysis parameters a run carries with it — the inputs to `threshold.md`'s Cq pipeline and
 * `calibration.md`'s solve that the UI lets a user change. Every field is optional: absent means
 * "this run has no opinion", and the app's default applies.
 */
export interface ZpcrwebAnalysisSettings {
  /**
   * Manual per-fluorophore threshold overrides in RFU, keyed by fluorophore name (`threshold.md`
   * §5.1's group key — see `RunAnalysis.thresholdGroupOf` for why thresholds group by dye and
   * never by target). An entry pins that group's threshold; a group with no entry keeps the
   * automatic one.
   */
  thresholdOverrides?: Record<string, number>;
  /**
   * Manual per-**curve** threshold overrides in RFU, keyed by `"row,col,fluor"` (0-based row and
   * column — the app's `curveKey`), i.e. one well's one dye. Outranks
   * {@link thresholdOverrides}, which outranks the automatic value.
   */
  curveThresholdOverrides?: Record<string, number>;
  /** §5.1's auto-threshold multiplier: `threshold = k × median baseline noise`. */
  thresholdMultiplier?: number;
  /**
   * Whether the LED-off `DARKDATA` was subtracted before colour separation.
   *
   * **Retired.** The stage is gone: subtracting the per-cycle dark level makes the reconstruction
   * of CFX's own curves 260× worse (`calibration.md` §4.2a), and a *constant* background cannot
   * change any reported number because baselining removes it first. The key is still read and
   * written so files that carry it keep round-tripping, and nothing consumes it.
   *
   * @deprecated Ignored by the analysis pipeline.
   */
  subtractDark?: boolean;
  /** Calibration matrix column normalization (`calibration.md` §3). */
  calibrationNormalization?: NormalizationMode;
}

/** The whole `zpcrweb.json` document. */
export interface ZpcrwebSettings {
  version: number;
  /** Free-form provenance, for a human who unzips the archive and wonders what wrote this. */
  generator?: string;
  /** ISO-8601 timestamp of the last write. */
  updatedAt?: string;
  analysis?: ZpcrwebAnalysisSettings;
}

const NORMALIZATION_MODES: NormalizationMode[] = ["none", "column", "global"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Finite numbers only — `NaN`/`Infinity` survive `JSON.parse` via `null` handling elsewhere and
 * would poison every downstream comparison. */
function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseAnalysis(raw: unknown): ZpcrwebAnalysisSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ZpcrwebAnalysisSettings = {};

  // A non-positive threshold can never be crossed from below, so it isn't a threshold — treat
  // one as corruption rather than as a way to disable the group.
  const overridesOf = (raw: unknown): Record<string, number> | undefined => {
    if (!isRecord(raw)) return undefined;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      const n = finiteNumber(value);
      if (key && n !== undefined && n > 0) out[key] = n;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const groupOverrides = overridesOf(raw.thresholdOverrides);
  if (groupOverrides) out.thresholdOverrides = groupOverrides;
  const curveOverrides = overridesOf(raw.curveThresholdOverrides);
  if (curveOverrides) out.curveThresholdOverrides = curveOverrides;

  const multiplier = finiteNumber(raw.thresholdMultiplier);
  if (multiplier !== undefined && multiplier > 0) out.thresholdMultiplier = multiplier;

  if (typeof raw.subtractDark === "boolean") out.subtractDark = raw.subtractDark;

  if (
    typeof raw.calibrationNormalization === "string" &&
    (NORMALIZATION_MODES as string[]).includes(raw.calibrationNormalization)
  ) {
    out.calibrationNormalization = raw.calibrationNormalization as NormalizationMode;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a `zpcrweb.json` document. Returns `null` for anything that isn't a usable object —
 * malformed JSON, a JSON array, a bare string. Unknown top-level keys are preserved by neither
 * side: this reads the fields it knows and forgets the rest (see {@link writeZpcrwebSettings}
 * for why that is safe).
 */
export function parseZpcrwebSettingsJson(text: string): ZpcrwebSettings | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const settings: ZpcrwebSettings = { version: finiteNumber(raw.version) ?? ZPCRWEB_SETTINGS_VERSION };
  if (typeof raw.generator === "string") settings.generator = raw.generator;
  if (typeof raw.updatedAt === "string") settings.updatedAt = raw.updatedAt;
  const analysis = parseAnalysis(raw.analysis);
  if (analysis) settings.analysis = analysis;
  return settings;
}

/**
 * Read the settings a parsed run carries, or `null` when it carries none (the normal case for a
 * file straight off the instrument). Reads through the already-decompressed
 * {@link Zpcr.archive}, so it costs a `JSON.parse` of a few hundred bytes, not a second unzip.
 */
export function parseZpcrwebSettings(zpcr: Zpcr): ZpcrwebSettings | null {
  if (!zpcr.archive.entries.includes(ZPCRWEB_SETTINGS_NAME)) return null;
  try {
    return parseZpcrwebSettingsJson(zpcr.archive.text(ZPCRWEB_SETTINGS_NAME));
  } catch {
    return null;
  }
}

/** Serialize to the exact bytes stored in the archive: pretty-printed with a trailing newline,
 * so `unzip -p file.zpcr zpcrweb.json` reads like a config file and diffs line by line. */
export function formatZpcrwebSettings(settings: ZpcrwebSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Return new `.zpcr` bytes carrying `settings` as their `zpcrweb.json` entry, replacing any
 * existing one. Every other entry is copied through untouched.
 *
 * The document is rewritten rather than merged, so a key this build doesn't understand is
 * dropped on write. That is the deliberate trade: the alternative — round-tripping unknown keys
 * — makes the file a shared mutable namespace between versions, where an old build silently
 * preserves state it can't honor and the two disagree about what the run means. Losing an
 * unknown key is visible; honoring half of one isn't.
 *
 * Throws if `zpcrBytes` isn't a valid ZIP.
 */
export function writeZpcrwebSettings(
  zpcrBytes: Uint8Array,
  settings: ZpcrwebSettings,
): Uint8Array {
  const files = unzipArchive(zpcrBytes);
  files[ZPCRWEB_SETTINGS_NAME] = new TextEncoder().encode(formatZpcrwebSettings(settings));
  return zipSync(files);
}

/** True once a settings document holds anything worth writing — used to avoid adding an entry
 * to a file whose analysis state is entirely default. */
export function hasZpcrwebSettings(settings: ZpcrwebSettings): boolean {
  return !!settings.analysis && Object.keys(settings.analysis).length > 0;
}
