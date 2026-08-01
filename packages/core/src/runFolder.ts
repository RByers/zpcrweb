/**
 * Assemble a `.zpcr` from an instrument run directory's loose files.
 *
 * A `.zpcr` is a plain ZIP of exactly what the instrument keeps in `\Storage Card\CurrentRun`
 * (see `archive.ts` and `usb.md` §7): `RunInfo.xml`, the `Read*.Plateread` series, the `.Dcal`
 * set, the marker files, and whatever plate/protocol the run carried. So there is no format
 * conversion here — the files that come off the wire are the archive's entries verbatim, and
 * zipping them is the whole job.
 *
 * The counterpart to `attachPlate.ts`: both write a `.zpcr` with `fflate`'s `zipSync`, already a
 * dependency for reading.
 */

import { zipSync } from "fflate";
import { parseRunInfoRaw } from "./runinfo.js";

const RUNINFO_NAME = "RunInfo.xml";
const textDecoder = new TextDecoder("utf-8");

/**
 * The two marker files the instrument writes around a run, and the whole of how "is this run
 * still going?" is answered.
 *
 * `begun` appears the moment `RemoteRun` is accepted; `ended` appears when the run finishes.
 * Measured from the reference capture, where successive `LISTALLFILES \Storage Card\CurrentRun`
 * responses show `begun` present from the start and `ended` arriving only in the final listing,
 * alongside the last plate read and the `.alf` report. Every committed `.zpcr` sample — all of
 * them complete runs — carries both.
 *
 * Both are zero-content markers: only their presence means anything.
 */
export const RUN_BEGUN_MARKER = "begun";
export const RUN_ENDED_MARKER = "ended";

/** How far along a run is, read from nothing but which files exist. */
export interface RunProgress {
  /** The run has started. */
  begun: boolean;
  /** The run has finished — successfully or by being cancelled; the markers don't distinguish. */
  ended: boolean;
  /** Started and not yet finished. */
  inProgress: boolean;
  /** How many `Read*.Plateread` files exist, i.e. how many cycles have been read so far. */
  plateReads: number;
}

/**
 * Read a run's progress from a directory listing (or an archive's entry names).
 *
 * Deliberately derived rather than stored. A run's in-progress-ness is a fact about an instrument
 * at a moment, and the moment the app writes it down somewhere it can be wrong — a browser
 * reloaded mid-run, a file copied to another machine, a run cancelled while the tab was closed.
 * Since the answer is already present in the files themselves, and travels with them into the
 * assembled `.zpcr`, there is nothing to keep in sync.
 */
export function runProgressFromNames(names: readonly string[]): RunProgress {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const begun = set.has(RUN_BEGUN_MARKER);
  const ended = set.has(RUN_ENDED_MARKER);
  return {
    begun,
    ended,
    inProgress: begun && !ended,
    plateReads: names.filter((n) => /\.Plateread$/i.test(n)).length,
  };
}

/** Strip any directory part from a Windows or POSIX path, so `RunInfo.xml`'s `DataFile` (which
 * the instrument may write as a full `\Storage Card\…` path) yields a plain file name. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * The name the run calls itself: `RunInfo.xml`'s `DataFile`, which is already the `.zpcr` name
 * CFX Manager would save this run under (e.g. `20260720_211747_CT019138_Luna_noRT.zpcr`) — so a
 * run pulled off the instrument lands under the same name as the same run exported by hand.
 * Falls back to `CurrentRun.zpcr` when the field is absent or empty.
 */
export function zpcrNameFromRunFiles(files: Record<string, Uint8Array>): string {
  const runInfo = files[RUNINFO_NAME];
  if (runInfo === undefined) return "CurrentRun.zpcr";
  let dataFile = "";
  try {
    dataFile = parseRunInfoRaw(textDecoder.decode(runInfo))["DataFile"] ?? "";
  } catch {
    // A `RunInfo.xml` this app can't read is the caller's problem to report, via parseZpcr.
  }
  const name = baseName(dataFile.trim());
  if (name === "") return "CurrentRun.zpcr";
  return /\.zpcr$/i.test(name) ? name : `${name}.zpcr`;
}

/**
 * Zip a run directory's files into `.zpcr` bytes, named after the run (see
 * {@link zpcrNameFromRunFiles}). The result parses straight back through `parseZpcr`.
 *
 * Throws when `RunInfo.xml` is absent: without it there is no run metadata and `parseZpcr` would
 * reject the result anyway, so failing here names the actual problem — an incomplete set of
 * files — rather than handing back an archive that cannot be opened.
 */
export function zpcrFromRunFiles(files: Record<string, Uint8Array>): {
  name: string;
  bytes: Uint8Array;
} {
  if (files[RUNINFO_NAME] === undefined) {
    throw new Error(`Can't assemble a .zpcr: no ${RUNINFO_NAME} among the run's files`);
  }
  return { name: zpcrNameFromRunFiles(files), bytes: zipSync(files) };
}
