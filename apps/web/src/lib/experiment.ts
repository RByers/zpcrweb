/**
 * What a loaded file is *called*, and when it was run — the two things the file bar and the
 * Overview view lead with, in place of the filename.
 *
 * A filename like `20260726_S183-S185_RVP.zpcr` is three facts glued together (a date, a
 * machine, a name) in a form that is wide, hard to scan, and mostly redundant with the tiles
 * right beside it. So the app shows the name and a compact local timestamp instead, and keeps
 * the filename where it is still the answer to something: the hover card, the Overview header's
 * second line, and the download button.
 *
 * The resolution rules live in `@zpcrweb/core`'s `experiment.ts` (stored name → the format's own
 * → derived from the filename); this module only adds the app's side — where the stored name
 * comes from, and how a `Date` is rendered.
 */
import {
  deriveExperimentName,
  resolveExperimentName,
  runFileBaseName,
  runProgressFromNames,
  type FileKind,
  type Zpcr,
} from "@zpcrweb/core";
import type { LoadedFile, RunResult } from "../state/useZpcrStore";

export interface ExperimentIdentity {
  /** The run's short name — never empty for a file with a name (see `resolveExperimentName`). */
  name: string;
  /**
   * True when {@link name} was actually *given* — a stored `zpcrweb.json` name, or (Biomeme) the
   * format's own — as opposed to merely derived from the file name. This is what tells Overview a
   * pending experiment still needs a real name typed in, as distinct from an ordinary finished run
   * that legitimately has no stored name because its filename already says enough.
   */
  named: boolean;
  /** Run start, when the file records one. Null for a standalone plate or protocol file. */
  date: Date | null;
  /** {@link date} through {@link formatCompactDateTime}, or `""` when there is none. */
  dateText: string;
  /** The file on disk. Still shown — just no longer as the headline. */
  fileName: string;
}

/**
 * `7/26/26 9:12pm` — a timestamp narrow enough to sit under a file chip, **in local time**.
 *
 * The instrument writes `RunStartTime` in GMT (`Mon, 27 Jul 2026 01:12:47 GMT`), which is the
 * wrong answer to "when did I run this?" by a whole day for anyone west of the meridian in the
 * evening. Everything here is the browser's own locale-independent formatting of local fields,
 * so it renders identically wherever it is read and never surprises with a different order.
 */
export function formatCompactDateTime(date: Date): string {
  const hours = date.getHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const mm = String(date.getMinutes()).padStart(2, "0");
  const yy = String(date.getFullYear() % 100).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()}/${yy} ${h12}:${mm}${hours < 12 ? "am" : "pm"}`;
}

/**
 * Identify one loaded file. `storedName` is the app's live copy of `zpcrweb.json`'s
 * `experimentName` (`FileSettings.experimentName`) rather than the archive's, so a name typed a
 * moment ago is already on the chip — the archive itself is only rewritten once a minute (see
 * `analysisPersist.ts`).
 */
export function experimentIdentity(
  file: LoadedFile,
  run: RunResult | undefined,
  storedName: string | undefined,
): ExperimentIdentity {
  const metadata = run?.zpcr?.metadata ?? null;
  const date = metadata?.runStartDate ?? null;
  return {
    name: resolveExperimentName({ stored: storedName, metadata, fileName: file.name }),
    named: !!storedName?.trim() || !!metadata?.experimentName?.trim(),
    date,
    dateText: date ? formatCompactDateTime(date) : "",
    fileName: file.name,
  };
}

/**
 * A `.zpcr` with no results yet and no instrument ever accepted a start for it — the on-disk
 * analog of what a seed file used to be (`core/runSeed.ts`, since removed), except created
 * explicitly and by name rather than as a side effect of starting. This covers both a
 * freshly-created/cloned file and one that's had a protocol/plate attached but never started.
 *
 * `zpcr.reads.length > 0` is impossible for a pending experiment by definition — a read only
 * arrives once a run is under way — which is exactly what "clone before starting a fresh run"
 * enforces: once there's a plate read, Start is unreachable on purpose (`activeRun.zpcr.reads`,
 * not a separate flag). The `kind === "zpcr"` check is what a `.pcrd`/Biomeme run's own
 * finished-by-construction nature already implies (see `runFolder.ts`'s `runCompleteness`), and
 * is checked here explicitly since only a `.zpcr` archive can carry the `begun` marker at all.
 */
export function isPendingExperiment(kind: FileKind, zpcr: Zpcr): boolean {
  return (
    kind === "zpcr" &&
    zpcr.reads.length === 0 &&
    !runProgressFromNames(zpcr.archive.entries).begun
  );
}

/**
 * Rebuild a `.zpcr` file name with today's date, if its base is already in the
 * `<YYYYMMDD>-<name>`/`<YYYYMMDD>_<name>` form `runFileBaseName` writes — what "Start experiment"
 * applies once, so a pending experiment cloned or created days ago and started today gets today's
 * date rather than the day it was made (`state/useZpcrStore.ts`'s `beginExperiment`).
 *
 * Returns `null` when there's nothing to restamp: no leading date to begin with (a name typed
 * over the auto-generated one, or a file renamed by hand), or the date is already today's —
 * either way the caller keeps the file's current name.
 */
export function restampExperimentDate(fileName: string, date: Date = new Date()): string | null {
  const m = /^(.*)(\.zpcr)$/i.exec(fileName);
  const ext = m ? m[2]! : "";
  const base = m ? m[1]! : fileName;
  if (!/^\d{8}[-_]/.test(base)) return null;
  const restamped = runFileBaseName(deriveExperimentName(fileName), date);
  if (!restamped) return null;
  const next = `${restamped}${ext}`;
  return next === fileName ? null : next;
}
