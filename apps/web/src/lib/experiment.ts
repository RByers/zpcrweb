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
import { resolveExperimentName } from "@zpcrweb/core";
import type { LoadedFile, RunResult } from "../state/useZpcrStore";

export interface ExperimentIdentity {
  /** The run's short name — never empty for a file with a name (see `resolveExperimentName`). */
  name: string;
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
    date,
    dateText: date ? formatCompactDateTime(date) : "",
    fileName: file.name,
  };
}
