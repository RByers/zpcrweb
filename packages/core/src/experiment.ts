/**
 * What a run is *called* — the short label a person recognizes it by, as opposed to the file it
 * happens to be stored in.
 *
 * None of the Bio-Rad formats have a field for this. `RunInfo.xml` carries `DataFile`
 * (a filename), `SampleId`, `NickName` and `Notes` — and on every committed sample the last
 * three are empty; a `.pcrd` likewise names itself only by its own path
 * (`creationFullyQualifiedName`). The instrument's convention is to encode the name *into* the
 * filename instead, as `<date>_<time>_<serial>_<name>`, which is why the fallback below is a
 * filename derivation rather than a shrug. The Biomeme export is the exception: it has a real
 * `name`, so that format answers for itself (`biomeme.ts` puts it in
 * {@link RunMetadata.experimentName}).
 *
 * A user-set name therefore has to be stored somewhere of our own, and that is `zpcrweb.json`'s
 * top-level `experimentName` (see `zpcrweb-json.md` §4) — top-level rather than under
 * `analysis`, because it changes no reported number.
 *
 * The three sources, in precedence order, are resolved by {@link resolveExperimentName}:
 *
 * | Source | Wins because |
 * |--------|--------------|
 * | `zpcrweb.json`'s `experimentName` | somebody typed it |
 * | {@link RunMetadata.experimentName} | the format itself states it (Biomeme only, today) |
 * | the filename (see {@link deriveExperimentName}) | last resort, and usually right |
 */

import type { RunMetadata } from "./types.js";

/** Extensions this project loads, longest-first so `.plt.csv` isn't read as `.csv`. */
const EXTENSIONS = [".prcl.txt", ".plt.csv", ".zpcr", ".pcrd", ".pltd", ".json", ".csv"];

/** Strip one known extension, or (for anything else) whatever follows the last dot. */
function stripExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const ext of EXTENSIONS) {
    if (lower.endsWith(ext)) return fileName.slice(0, -ext.length);
  }
  return fileName.replace(/\.[^./\\]+$/, "");
}

/**
 * The run name encoded in an instrument-written filename.
 *
 * The instrument names a run `<YYYYMMDD>[_<HHMMSS>][_<serial>]_<name>`, with `_` where the user
 * typed a space — so `20260726_S183-S185_RVP.zpcr` is the run "S183-S185 RVP", and
 * `20190516_122922_CT019138_SHORT_QUALIF.zpcr` is "SHORT QUALIF". Each leading part is removed
 * only when it is unambiguously *not* name text: an 8-digit date, a 6-digit time after one, and
 * a segment equal to this run's own block serial (`opts.serial`) — never a serial-*shaped*
 * segment, since a real name could look like one and there is no way to tell them apart without
 * the run to compare against.
 *
 * A leading date may also be joined by a dash — `20260802-S183-S185_RVP` — which is the form
 * {@link runFileBaseName} writes, and is read back the same way.
 *
 * Returns the whole base name when stripping would leave nothing, so a file called
 * `20260726.zpcr` is "20260726" rather than blank.
 */
export function deriveExperimentName(fileName: string, opts?: { serial?: string }): string {
  const base = stripExtension(fileName.split(/[/\\]/).pop() ?? fileName).trim();
  if (!base) return "";
  const parts = base.replace(/^(\d{8})-/, "$1_").split("_");
  let i = 0;
  if (/^\d{8}$/.test(parts[i] ?? "")) {
    i++;
    if (/^\d{6}$/.test(parts[i] ?? "")) i++;
  }
  const serial = opts?.serial?.trim().toLowerCase();
  if (serial && (parts[i] ?? "").toLowerCase() === serial) i++;
  const rest = parts.slice(i).filter((p) => p !== "");
  return rest.length > 0 ? rest.join(" ") : base;
}

/**
 * The inverse of {@link deriveExperimentName}: the file base name a run of this name should be
 * saved under, `<YYYYMMDD>-<name, spaces as underscores>` — so "S183-S185 RVP" run on 2 Aug 2026
 * becomes `20260802-S183-S185_RVP`.
 *
 * The date is the run's **local** date, matching how the app renders every other run timestamp
 * (`lib/experiment.ts`), so the name a person sees offered is the day they are having. The
 * separator between date and name is a dash rather than the instrument's own underscore because
 * `_` is what a space becomes inside the name, so a dash keeps the two parts distinguishable by
 * eye; {@link deriveExperimentName} strips a leading date under either separator, so the two
 * functions round-trip.
 *
 * Characters a filesystem or a `RemoteRun` operand would object to are replaced (the same set as
 * `usb/runPlan.ts`); an empty name yields `""`, which callers turn into their own fallback.
 */
export function runFileBaseName(experimentName: string, date: Date = new Date()): string {
  const name = experimentName
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/['",;]+/g, "_")
    .replace(/[\\/:*?<>|]+/g, "_")
    // Two adjacent replacements (`RVP "fast"` → `RVP__fast_`) read as a typo rather than as a
    // name, so runs of underscores collapse. Nothing reads them back individually — a `_` is a
    // space to `deriveExperimentName` however many there were.
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  if (!name) return "";
  const stamp =
    `${date.getFullYear()}` +
    `${String(date.getMonth() + 1).padStart(2, "0")}` +
    `${String(date.getDate()).padStart(2, "0")}`;
  return `${stamp}-${name}`;
}

/**
 * The name to show for a run: the stored one, else what the format states, else the filename's
 * (see the module comment for why that order). Total — every argument is optional, and a run
 * with nothing at all still gets its file's base name.
 */
export function resolveExperimentName(args: {
  /** `zpcrweb.json`'s `experimentName`, or whatever the app is holding in its place. */
  stored?: string | null;
  metadata?: Pick<RunMetadata, "experimentName" | "baseSerialNumber"> | null;
  fileName: string;
}): string {
  const stored = args.stored?.trim();
  if (stored) return stored;
  const stated = args.metadata?.experimentName?.trim();
  if (stated) return stated;
  return deriveExperimentName(args.fileName, { serial: args.metadata?.baseSerialNumber });
}
